import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "../catalog/arabic-name";
import { archiveProductsForCategory } from "./product.service";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../geography/geography-locks";
import { dateValue } from "../geography/shared";

type CategoryStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type StoreCategoryRow = {
  id: string;
  store_id: string;
  city_id: string;
  parent_category_id: string | null;
  name: string;
  status: CategoryStatus;
  display_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

const CATEGORY_SELECT = `
  c.id::text as id,
  c.store_id::text as store_id,
  c.city_id::text as city_id,
  c.parent_category_id::text as parent_category_id,
  c.name,
  c.status::text as status,
  c.display_order,
  c.created_at,
  c.updated_at,
  c.archived_at
`;

const uniqueViolationConstraint = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const code = String(record.errno ?? record.code ?? "");
  const constraint = String(record.constraint ?? "");
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : null;
  const causeCode = cause ? String(cause.errno ?? cause.code ?? "") : "";
  const causeConstraint = cause ? String(cause.constraint ?? "") : "";
  if (code !== "23505" && causeCode !== "23505") return null;
  return constraint || causeConstraint || "unknown";
};

export const storeCategoryDto = (row: StoreCategoryRow): any => ({
  id: row.id,
  storeId: row.store_id,
  parentCategoryId: row.parent_category_id,
  name: row.name,
  status: row.status,
  displayOrder: row.display_order,
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
});

export class StoreCategoryService {
  constructor(private client: SQL) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "store_categories.read"
      | "store_categories.create"
      | "store_categories.update"
      | "store_categories.archive",
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private mapUniqueViolation(constraint: string): never {
    if (
      constraint.includes("store_categories_store_root_name_active_uidx") ||
      constraint.includes("store_categories_store_parent_name_active_uidx")
    ) {
      throw new AppError(
        409,
        "STORE_CATEGORY_NAME_CONFLICT",
        "Store category name already exists",
      );
    }
    throw new AppError(
      409,
      "STORE_CATEGORY_NAME_CONFLICT",
      "Store category name already exists",
    );
  }

  /** Lock Store in signed City. Cross-City storeId → STORE_NOT_FOUND. */
  private async lockStore(
    tx: SQL,
    storeId: string,
    cityId: string,
    options?: { allowArchived?: boolean },
  ) {
    const [row] = await tx<{ id: string; status: string }[]>`
      select id::text as id, status::text as status
      from stores
      where id = ${storeId} and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    }
    if (!options?.allowArchived && row.status === "ARCHIVED") {
      throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
    }
    return row;
  }

  /**
   * Lock a prospective parent. Must be a non-archived root in the same Store.
   * Cross-store / missing parent → STORE_CATEGORY_NOT_FOUND (no leak).
   */
  private async lockParentRoot(
    tx: SQL,
    storeId: string,
    cityId: string,
    parentCategoryId: string,
  ) {
    const [row] = await tx<{
      id: string;
      status: string;
      parent_category_id: string | null;
    }[]>`
      select
        id::text as id,
        status::text as status,
        parent_category_id::text as parent_category_id
      from store_categories
      where id = ${parentCategoryId}
        and store_id = ${storeId}
        and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(
        404,
        "STORE_CATEGORY_NOT_FOUND",
        "Store category not found",
      );
    }
    if (row.status === "ARCHIVED") {
      throw new AppError(
        409,
        "STORE_CATEGORY_ARCHIVED",
        "Store category is archived",
      );
    }
    if (row.parent_category_id != null) {
      throw new AppError(
        422,
        "STORE_CATEGORY_HIERARCHY_INVALID",
        "Parent category must be a main Store category",
      );
    }
    return row;
  }

  private async loadScoped(
    storeId: string,
    categoryId: string,
    cityId: string,
    db: SQL = this.client,
  ) {
    const rows = (await db.unsafe(
      `select ${CATEGORY_SELECT}
       from store_categories c
       where c.id = $1::uuid
         and c.store_id = $2::uuid
         and c.city_id = $3::uuid`,
      [categoryId, storeId, cityId],
    )) as StoreCategoryRow[];
    const row = rows[0];
    if (!row) {
      throw new AppError(
        404,
        "STORE_CATEGORY_NOT_FOUND",
        "Store category not found",
      );
    }
    return row;
  }

  private async assertNoNonArchivedChildren(
    tx: SQL,
    storeId: string,
    categoryId: string,
  ) {
    const [child] = await tx<{ id: string }[]>`
      select id::text as id from store_categories
      where store_id = ${storeId}
        and parent_category_id = ${categoryId}
        and status <> 'ARCHIVED'
      limit 1`;
    if (child) {
      throw new AppError(
        409,
        "STORE_CATEGORY_HAS_CHILDREN",
        "Archive or move child categories before archiving this category",
      );
    }
  }

  async create(
    identity: AuthIdentity,
    storeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "store_categories.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const name = normalizeArabicCategoryName(input.name);
    const status = (input.status as CategoryStatus | undefined) ?? "ACTIVE";
    if (!["ACTIVE", "INACTIVE"].includes(status)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid category status");
    }
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );
    let parentCategoryId: string | null = null;
    if ("parentCategoryId" in input && input.parentCategoryId != null) {
      if (typeof input.parentCategoryId !== "string") {
        throw new AppError(422, "VALIDATION_FAILED", "Invalid parentCategoryId");
      }
      parentCategoryId = input.parentCategoryId;
    }

    let categoryId = "";
    try {
      categoryId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        if (parentCategoryId) {
          await this.lockParentRoot(tx, storeId, cityId, parentCategoryId);
        }
        const [inserted] = await tx<{ id: string }[]>`
          insert into store_categories (
            store_id, city_id, parent_category_id, name, status,
            display_order, created_by_account_id
          ) values (
            ${storeId},
            ${cityId},
            ${parentCategoryId},
            ${name},
            ${status}::main_category_status,
            ${displayOrder},
            ${identity.accountId}
          )
          returning id::text as id`;
        return inserted!.id;
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_CATEGORY_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, categoryId, parentCategoryId })}::jsonb
      )`;

    return storeCategoryDto(await this.loadScoped(storeId, categoryId, cityId));
  }

  async list(
    identity: AuthIdentity,
    storeId: string,
    input: { status?: string; parentCategoryId?: string },
  ) {
    const cityId = await this.authorize(identity, "store_categories.read");
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");

    const status = input.status?.trim() || null;
    if (
      status &&
      !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status)
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const parentFilter =
      input.parentCategoryId === undefined
        ? null
        : input.parentCategoryId === "null" || input.parentCategoryId === ""
          ? "ROOT"
          : input.parentCategoryId;

    const rows = (await this.client.unsafe(
      `select ${CATEGORY_SELECT}
       from store_categories c
       left join store_categories p
         on p.id = c.parent_category_id and p.store_id = c.store_id
       where c.store_id = $1::uuid
         and c.city_id = $2::uuid
         and ($3::text is null or c.status = $3::main_category_status)
         and ($3::text is not null or c.status <> 'ARCHIVED')
         and (
           $4::text is null
           or ($4::text = 'ROOT' and c.parent_category_id is null)
           or c.parent_category_id = $4::uuid
         )
       order by
         coalesce(p.display_order, c.display_order) asc,
         coalesce(p.created_at, c.created_at) asc,
         coalesce(p.id, c.id) asc,
         (c.parent_category_id is not null) asc,
         c.display_order asc,
         c.created_at asc,
         c.id asc`,
      [storeId, cityId, status, parentFilter],
    )) as StoreCategoryRow[];

    return { data: rows.map(storeCategoryDto) };
  }

  async get(identity: AuthIdentity, storeId: string, categoryId: string) {
    const cityId = await this.authorize(identity, "store_categories.read");
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return storeCategoryDto(await this.loadScoped(storeId, categoryId, cityId));
  }

  async update(
    identity: AuthIdentity,
    storeId: string,
    categoryId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "store_categories.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const keys = ["name", "status", "displayOrder", "parentCategoryId"];
    if (!keys.some((key) => key in input)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Use DELETE to archive a store category",
      );
    }
    if (
      "status" in input &&
      input.status !== undefined &&
      !["ACTIVE", "INACTIVE"].includes(String(input.status))
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid category status");
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);

        const parentChanging = "parentCategoryId" in input;
        let requestedParent: string | null | undefined;
        if (parentChanging) {
          if (input.parentCategoryId === null) {
            requestedParent = null;
          } else if (typeof input.parentCategoryId === "string") {
            requestedParent = input.parentCategoryId;
          } else {
            throw new AppError(
              422,
              "VALIDATION_FAILED",
              "Invalid parentCategoryId",
            );
          }
          if (requestedParent === categoryId) {
            throw new AppError(
              422,
              "STORE_CATEGORY_HIERARCHY_INVALID",
              "A category cannot be its own parent",
            );
          }
        }

        // Lock prospective parent root and the category row in UUID order.
        if (requestedParent && requestedParent < categoryId) {
          await this.lockParentRoot(tx, storeId, cityId, requestedParent);
        }

        const [locked] = await tx<{
          id: string;
          status: string;
          parent_category_id: string | null;
          name: string;
          display_order: number;
        }[]>`
          select
            id::text as id,
            status::text as status,
            parent_category_id::text as parent_category_id,
            name,
            display_order
          from store_categories
          where id = ${categoryId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!locked) {
          throw new AppError(
            404,
            "STORE_CATEGORY_NOT_FOUND",
            "Store category not found",
          );
        }
        if (locked.status === "ARCHIVED") {
          throw new AppError(
            409,
            "STORE_CATEGORY_ARCHIVED",
            "Store category is archived",
          );
        }

        if (requestedParent && requestedParent > categoryId) {
          await this.lockParentRoot(tx, storeId, cityId, requestedParent);
        }

        let nextParent = locked.parent_category_id;
        if (parentChanging) {
          nextParent = requestedParent ?? null;
        }

        if (
          nextParent !== locked.parent_category_id &&
          locked.parent_category_id == null &&
          nextParent != null
        ) {
          await this.assertNoNonArchivedChildren(tx, storeId, categoryId);
        }

        const name =
          "name" in input ? normalizeArabicCategoryName(input.name) : null;
        const status =
          "status" in input ? (input.status as CategoryStatus) : null;
        const displayOrder =
          "displayOrder" in input
            ? validateDisplayOrder(input.displayOrder)
            : null;

        await tx`
          update store_categories set
            parent_category_id = ${nextParent},
            name = coalesce(${name}, name),
            status = coalesce(${status}::main_category_status, status),
            display_order = coalesce(${displayOrder}, display_order),
            updated_at = now()
          where id = ${categoryId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_CATEGORY_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, categoryId })}::jsonb
      )`;

    return storeCategoryDto(await this.loadScoped(storeId, categoryId, cityId));
  }

  async archive(
    identity: AuthIdentity,
    storeId: string,
    categoryId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "store_categories.archive");
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId, { allowArchived: true });

      const [locked] = await tx<{
        id: string;
        status: string;
        parent_category_id: string | null;
      }[]>`
        select
          id::text as id,
          status::text as status,
          parent_category_id::text as parent_category_id
        from store_categories
        where id = ${categoryId}
          and store_id = ${storeId}
          and city_id = ${cityId}
        for update`;
      if (!locked) {
        throw new AppError(
          404,
          "STORE_CATEGORY_NOT_FOUND",
          "Store category not found",
        );
      }
      if (locked.status === "ARCHIVED") return;

      if (locked.parent_category_id == null) {
        await this.assertNoNonArchivedChildren(tx, storeId, categoryId);
      }

      await tx`
        update store_categories set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now()
        where id = ${categoryId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;

      // Soft-archive products in this category (status+archived_at only).
      await archiveProductsForCategory(tx, storeId, cityId, categoryId);
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_CATEGORY_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, categoryId })}::jsonb
      )`;

    return storeCategoryDto(await this.loadScoped(storeId, categoryId, cityId));
  }
}
