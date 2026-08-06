import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import { authorizeMerchantStoreScope } from "../auth/merchant/merchant-access";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../geography/geography-locks";
import { dateValue, pageOf } from "../geography/shared";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "./arabic-name";
import {
  assertDefaultsWithinMaxSelect,
  parseIqdNonNegativePrice,
  parseMaxQuantity,
  parseMinMaxSelect,
} from "./modifier-validation";

type CatalogStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type GroupRow = {
  id: string;
  store_id: string;
  city_id: string;
  name: string;
  min_select: number;
  max_select: number;
  status: CatalogStatus;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

type OptionRow = {
  id: string;
  store_id: string;
  city_id: string;
  modifier_group_id: string;
  name: string;
  is_available: boolean;
  display_order: number;
  status: CatalogStatus;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

type ProductModifierRow = {
  id: string;
  product_id: string;
  modifier_option_id: string;
  price: number;
  is_available: boolean;
  is_default: boolean;
  max_quantity: number;
  option_name: string;
  option_is_available: boolean;
  option_status: CatalogStatus;
  option_display_order: number;
  option_group_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ParsedOptionInput = {
  name: string;
  isAvailable: boolean;
  displayOrder: number;
  status: CatalogStatus;
};

const GROUP_SELECT = `
  g.id::text as id,
  g.store_id::text as store_id,
  g.city_id::text as city_id,
  g.name,
  g.min_select,
  g.max_select,
  g.status::text as status,
  g.created_at,
  g.updated_at,
  g.archived_at
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
  const causeConstraint = cause ? String(cause.constraint ?? "") : "";
  if (code === "23505" || String(cause?.code ?? "") === "23505") {
    return constraint || causeConstraint || "unique";
  }
  return null;
};

const parseCreateOptions = (raw: unknown): ParsedOptionInput[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(
      422,
      "MODIFIER_GROUP_REQUIRES_OPTIONS",
      "At least one modifier option is required",
    );
  }
  const options: ParsedOptionInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid modifier option");
    }
    const row = item as Record<string, unknown>;
    const name = normalizeArabicCategoryName(row.name);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new AppError(
        409,
        "MODIFIER_OPTION_NAME_CONFLICT",
        "Modifier option name already exists",
      );
    }
    seen.add(key);
    const status = (row.status as CatalogStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid option status");
    }
    const isAvailable =
      row.isAvailable === undefined ? true : Boolean(row.isAvailable);
    const displayOrder =
      row.displayOrder === undefined
        ? i
        : validateDisplayOrder(row.displayOrder);
    options.push({ name, isAvailable, displayOrder, status });
  }
  return options;
};

export class ModifierService {
  constructor(private client: SQL) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "modifiers.read"
      | "modifiers.create"
      | "modifiers.update"
      | "modifiers.archive"
      | "products.read"
      | "products.update",
    storeId?: string,
  ) {
    if (identity.applicationType === "MERCHANT_APP") {
      return authorizeMerchantStoreScope(this.client, identity, storeId);
    }
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private mapUniqueViolation(constraint: string): never {
    if (constraint.includes("modifier_groups_store_name_active_uidx")) {
      throw new AppError(
        409,
        "MODIFIER_GROUP_NAME_CONFLICT",
        "Modifier group name already exists",
      );
    }
    if (constraint.includes("modifier_options_store_name_active_uidx")) {
      throw new AppError(
        409,
        "MODIFIER_OPTION_NAME_CONFLICT",
        "Modifier option name already exists",
      );
    }
    if (constraint.includes("product_modifier_options_product_option_uidx")) {
      throw new AppError(
        409,
        "PRODUCT_MODIFIER_OPTION_CONFLICT",
        "Product modifier option already configured",
      );
    }
    throw new AppError(409, "CONFLICT", "Resource conflict");
  }

  private async lockStore(tx: SQL, storeId: string, cityId: string) {
    const [store] = await tx<{ id: string; status: string }[]>`
      select id::text as id, status::text as status from stores
      where id = ${storeId} and city_id = ${cityId}
      for update`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    if (store.status === "ARCHIVED") {
      throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
    }
    return store;
  }

  private groupDto(row: GroupRow, options: OptionRow[] = []): any {
    return {
      id: row.id,
      storeId: row.store_id,
      name: row.name,
      minSelect: Number(row.min_select),
      maxSelect: Number(row.max_select),
      status: row.status,
      options: options.map((option) => this.optionDto(option)),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      archivedAt: dateValue(row.archived_at),
    };
  }

  private optionDto(row: OptionRow): any {
    return {
      id: row.id,
      modifierGroupId: row.modifier_group_id,
      name: row.name,
      isAvailable: Boolean(row.is_available),
      displayOrder: Number(row.display_order),
      status: row.status,
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      archivedAt: dateValue(row.archived_at),
    };
  }

  private productModifierDto(row: ProductModifierRow): any {
    return {
      id: row.id,
      productId: row.product_id,
      modifierOptionId: row.modifier_option_id,
      name: row.option_name,
      price: Number(row.price),
      isAvailable: Boolean(row.is_available),
      isDefault: Boolean(row.is_default),
      maxQuantity: Number(row.max_quantity),
      optionIsAvailable: Boolean(row.option_is_available),
      optionStatus: row.option_status,
      displayOrder: Number(row.option_display_order),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
    };
  }

  private async loadGroup(
    storeId: string,
    groupId: string,
    cityId: string,
    db: SQL = this.client,
  ): Promise<GroupRow> {
    const rows = (await db.unsafe(
      `select ${GROUP_SELECT}
       from modifier_groups g
       where g.id = $1::uuid
         and g.store_id = $2::uuid
         and g.city_id = $3::uuid`,
      [groupId, storeId, cityId],
    )) as GroupRow[];
    const row = rows[0];
    if (!row) {
      throw new AppError(
        404,
        "MODIFIER_GROUP_NOT_FOUND",
        "Modifier group not found",
      );
    }
    return row;
  }

  private async loadGroupOptions(
    groupId: string,
    db: SQL = this.client,
  ): Promise<OptionRow[]> {
    return (await db`
      select
        o.id::text as id,
        o.store_id::text as store_id,
        o.city_id::text as city_id,
        o.modifier_group_id::text as modifier_group_id,
        o.name,
        o.is_available,
        o.display_order,
        o.status::text as status,
        o.created_at,
        o.updated_at,
        o.archived_at
      from modifier_options o
      where o.modifier_group_id = ${groupId}
      order by o.display_order asc, o.id asc`) as OptionRow[];
  }

  private async getGroupDto(
    storeId: string,
    groupId: string,
    cityId: string,
  ) {
    const row = await this.loadGroup(storeId, groupId, cityId);
    const options = await this.loadGroupOptions(groupId);
    return this.groupDto(row, options);
  }

  async createGroup(
    identity: AuthIdentity,
    storeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.create", storeId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "storeId", "archivedAt"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const name = normalizeArabicCategoryName(input.name);
    const { minSelect, maxSelect } = parseMinMaxSelect(
      input.minSelect === undefined ? 0 : input.minSelect,
      input.maxSelect === undefined ? 1 : input.maxSelect,
    );
    const status = (input.status as CatalogStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid group status");
    }
    const options = parseCreateOptions(input.options);

    let groupId = "";
    try {
      groupId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [inserted] = await tx<{ id: string }[]>`
          insert into modifier_groups (
            store_id, city_id, name, min_select, max_select, status, created_by_account_id
          ) values (
            ${storeId},
            ${cityId},
            ${name},
            ${minSelect},
            ${maxSelect},
            ${status}::product_status,
            ${identity.accountId}
          )
          returning id::text as id`;
        const id = inserted!.id;
        for (const option of options) {
          await tx`
            insert into modifier_options (
              store_id, city_id, modifier_group_id, name, is_available, display_order, status
            ) values (
              ${storeId},
              ${cityId},
              ${id},
              ${option.name},
              ${option.isAvailable},
              ${option.displayOrder},
              ${option.status}::product_status
            )`;
        }
        return id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_GROUP_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async listGroups(
    identity: AuthIdentity,
    storeId: string,
    input: { status?: string; search?: string; page?: number; limit?: number },
  ) {
    const cityId = await this.authorize(identity, "modifiers.read", storeId);
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");

    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const status = input.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }

    const rows = (await this.client.unsafe(
      `select ${GROUP_SELECT}
       from modifier_groups g
       where g.store_id = $1::uuid
         and g.city_id = $2::uuid
         and ($3::text is null or g.status = $3::product_status)
         and ($3::text is not null or g.status <> 'ARCHIVED')
         and ($4::text is null or g.name ilike ('%' || $4 || '%'))
       order by g.created_at asc, g.id asc
       limit $5::int offset $6::int`,
      [storeId, cityId, status, search, limit, offset],
    )) as GroupRow[];

    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from modifier_groups g
       where g.store_id = $1::uuid
         and g.city_id = $2::uuid
         and ($3::text is null or g.status = $3::product_status)
         and ($3::text is not null or g.status <> 'ARCHIVED')
         and ($4::text is null or g.name ilike ('%' || $4 || '%'))`,
      [storeId, cityId, status, search],
    )) as { total: string }[];

    const groupIds = rows.map((row) => row.id);
    const options = await this.loadGroupOptionsBatch(groupIds);
    const byGroup = new Map<string, OptionRow[]>();
    for (const option of options) {
      const list = byGroup.get(option.modifier_group_id) ?? [];
      list.push(option);
      byGroup.set(option.modifier_group_id, list);
    }

    return {
      data: rows.map((row) =>
        this.groupDto(row, byGroup.get(row.id) ?? []),
      ),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  private async loadGroupOptionsBatch(groupIds: string[]) {
    if (groupIds.length === 0) return [] as OptionRow[];
    const ids = this.client.array(groupIds, "UUID");
    return (await this.client`
      select
        o.id::text as id,
        o.store_id::text as store_id,
        o.city_id::text as city_id,
        o.modifier_group_id::text as modifier_group_id,
        o.name,
        o.is_available,
        o.display_order,
        o.status::text as status,
        o.created_at,
        o.updated_at,
        o.archived_at
      from modifier_options o
      where o.modifier_group_id = any(${ids})
      order by o.display_order asc, o.id asc`) as OptionRow[];
  }

  async getGroup(identity: AuthIdentity, storeId: string, groupId: string) {
    const cityId = await this.authorize(identity, "modifiers.read", storeId);
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return this.getGroupDto(storeId, groupId, cityId);
  }

  async updateGroup(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.update", storeId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "storeId", "archivedAt", "options"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Use DELETE to archive a modifier group",
      );
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [group] = await tx<GroupRow[]>`
          select
            id::text as id,
            store_id::text as store_id,
            city_id::text as city_id,
            name,
            min_select,
            max_select,
            status::text as status,
            created_at,
            updated_at,
            archived_at
          from modifier_groups
          where id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!group) {
          throw new AppError(
            404,
            "MODIFIER_GROUP_NOT_FOUND",
            "Modifier group not found",
          );
        }
        if (group.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_GROUP_ARCHIVED",
            "Modifier group is archived",
          );
        }

        const name =
          "name" in input ? normalizeArabicCategoryName(input.name) : group.name;
        let minSelect = Number(group.min_select);
        let maxSelect = Number(group.max_select);
        if ("minSelect" in input || "maxSelect" in input) {
          const parsed = parseMinMaxSelect(
            "minSelect" in input ? input.minSelect : minSelect,
            "maxSelect" in input ? input.maxSelect : maxSelect,
          );
          minSelect = parsed.minSelect;
          maxSelect = parsed.maxSelect;
        }
        const status =
          "status" in input
            ? (input.status as CatalogStatus)
            : group.status;
        if (status !== "ACTIVE" && status !== "INACTIVE") {
          throw new AppError(422, "VALIDATION_FAILED", "Invalid group status");
        }

        await this.assertProductDefaultsWithinMax(
          tx,
          storeId,
          groupId,
          maxSelect,
        );

        await tx`
          update modifier_groups set
            name = ${name},
            min_select = ${minSelect},
            max_select = ${maxSelect},
            status = ${status}::product_status,
            updated_at = now()
          where id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_GROUP_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  private async assertProductDefaultsWithinMax(
    tx: SQL,
    storeId: string,
    groupId: string,
    maxSelect: number,
  ) {
    const rows = await tx<{ product_id: string; defaults: string }[]>`
      select p.id::text as product_id, count(*)::text as defaults
      from products p
      join product_modifier_options pmo on pmo.product_id = p.id
      join modifier_options o on o.id = pmo.modifier_option_id
      where p.store_id = ${storeId}
        and p.modifier_group_id = ${groupId}
        and o.modifier_group_id = ${groupId}
        and pmo.is_default = true
        and o.status <> 'ARCHIVED'
      group by p.id
      having count(*) > ${maxSelect}`;
    if (rows.length > 0) {
      throw new AppError(
        422,
        "INVALID_MODIFIER_DEFAULTS",
        "Default options exceed group maxSelect",
      );
    }
  }

  async archiveGroup(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.archive", storeId);
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId);
      const [group] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status from modifier_groups
        where id = ${groupId}
          and store_id = ${storeId}
          and city_id = ${cityId}
        for update`;
      if (!group) {
        throw new AppError(
          404,
          "MODIFIER_GROUP_NOT_FOUND",
          "Modifier group not found",
        );
      }
      if (group.status === "ARCHIVED") return;
      await tx`
        update modifier_groups set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now()
        where id = ${groupId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_GROUP_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async restoreGroup(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.update", storeId);
    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [group] = await tx<{ id: string; status: string; name: string }[]>`
          select id::text as id, status::text as status, name from modifier_groups
          where id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!group) {
          throw new AppError(
            404,
            "MODIFIER_GROUP_NOT_FOUND",
            "Modifier group not found",
          );
        }
        if (group.status !== "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_GROUP_NOT_ARCHIVED",
            "Modifier group is not archived",
          );
        }
        await tx`
          update modifier_groups set
            status = 'ACTIVE',
            archived_at = null,
            updated_at = now()
          where id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_GROUP_RESTORED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async addOption(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.create", storeId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "storeId", "modifierGroupId", "archivedAt"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const name = normalizeArabicCategoryName(input.name);
    const status = (input.status as CatalogStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid option status");
    }
    const isAvailable =
      input.isAvailable === undefined ? true : Boolean(input.isAvailable);
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );

    let optionId = "";
    try {
      optionId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [group] = await tx<{ id: string; status: string }[]>`
          select id::text as id, status::text as status from modifier_groups
          where id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!group) {
          throw new AppError(
            404,
            "MODIFIER_GROUP_NOT_FOUND",
            "Modifier group not found",
          );
        }
        if (group.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_GROUP_ARCHIVED",
            "Modifier group is archived",
          );
        }
        const [inserted] = await tx<{ id: string }[]>`
          insert into modifier_options (
            store_id, city_id, modifier_group_id, name, is_available, display_order, status
          ) values (
            ${storeId},
            ${cityId},
            ${groupId},
            ${name},
            ${isAvailable},
            ${displayOrder},
            ${status}::product_status
          )
          returning id::text as id`;
        return inserted!.id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_OPTION_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId, optionId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async updateOption(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    optionId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.update", storeId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "modifierGroupId",
      "archivedAt",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Use DELETE to archive a modifier option",
      );
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [option] = await tx<OptionRow[]>`
          select
            id::text as id,
            store_id::text as store_id,
            city_id::text as city_id,
            modifier_group_id::text as modifier_group_id,
            name,
            is_available,
            display_order,
            status::text as status,
            created_at,
            updated_at,
            archived_at
          from modifier_options
          where id = ${optionId}
            and modifier_group_id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!option) {
          throw new AppError(
            404,
            "MODIFIER_OPTION_NOT_FOUND",
            "Modifier option not found",
          );
        }
        if (option.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_OPTION_ARCHIVED",
            "Modifier option is archived",
          );
        }

        const name =
          "name" in input
            ? normalizeArabicCategoryName(input.name)
            : option.name;
        const status =
          "status" in input
            ? (input.status as CatalogStatus)
            : option.status;
        if (status !== "ACTIVE" && status !== "INACTIVE") {
          throw new AppError(422, "VALIDATION_FAILED", "Invalid option status");
        }
        const isAvailable =
          "isAvailable" in input
            ? Boolean(input.isAvailable)
            : Boolean(option.is_available);
        const displayOrder =
          "displayOrder" in input
            ? validateDisplayOrder(input.displayOrder)
            : Number(option.display_order);

        await tx`
          update modifier_options set
            name = ${name},
            is_available = ${isAvailable},
            display_order = ${displayOrder},
            status = ${status}::product_status,
            updated_at = now()
          where id = ${optionId}
            and modifier_group_id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_OPTION_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId, optionId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async archiveOption(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    optionId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.archive", storeId);
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId);
      const [option] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status from modifier_options
        where id = ${optionId}
          and modifier_group_id = ${groupId}
          and store_id = ${storeId}
          and city_id = ${cityId}
        for update`;
      if (!option) {
        throw new AppError(
          404,
          "MODIFIER_OPTION_NOT_FOUND",
          "Modifier option not found",
        );
      }
      if (option.status === "ARCHIVED") return;
      await tx`
        update modifier_options set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now()
        where id = ${optionId}
          and modifier_group_id = ${groupId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_OPTION_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId, optionId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async restoreOption(
    identity: AuthIdentity,
    storeId: string,
    groupId: string,
    optionId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "modifiers.update", storeId);
    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [option] = await tx<{ id: string; status: string }[]>`
          select id::text as id, status::text as status from modifier_options
          where id = ${optionId}
            and modifier_group_id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!option) {
          throw new AppError(
            404,
            "MODIFIER_OPTION_NOT_FOUND",
            "Modifier option not found",
          );
        }
        if (option.status !== "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_OPTION_NOT_ARCHIVED",
            "Modifier option is not archived",
          );
        }
        await tx`
          update modifier_options set
            status = 'ACTIVE',
            archived_at = null,
            updated_at = now()
          where id = ${optionId}
            and modifier_group_id = ${groupId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MODIFIER_OPTION_RESTORED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, groupId, optionId })}::jsonb
      )`;

    return this.getGroupDto(storeId, groupId, cityId);
  }

  async getProductModifiers(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
  ) {
    const cityId = await this.authorize(identity, "products.read", storeId);
    return this.loadProductModifiersDashboard(storeId, productId, cityId);
  }

  private async loadProductModifiersDashboard(
    storeId: string,
    productId: string,
    cityId: string,
  ): Promise<any> {
    const [product] = await this.client<
      {
        id: string;
        modifier_group_id: string | null;
        status: string;
        is_available: boolean;
      }[]
    >`
      select
        id::text as id,
        modifier_group_id::text as modifier_group_id,
        status::text as status,
        is_available
      from products
      where id = ${productId}
        and store_id = ${storeId}
        and city_id = ${cityId}`;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    }

    let group: any = null;
    let configured: any[] = [];

    if (product.modifier_group_id) {
      try {
        const groupRow = await this.loadGroup(
          storeId,
          product.modifier_group_id,
          cityId,
        );
        const options = await this.loadGroupOptions(product.modifier_group_id);
        group = this.groupDto(groupRow, options);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.publicCode !== "MODIFIER_GROUP_NOT_FOUND"
        ) {
          throw error;
        }
      }

      const rows = (await this.client`
        select
          pmo.id::text as id,
          pmo.product_id::text as product_id,
          pmo.modifier_option_id::text as modifier_option_id,
          pmo.price,
          pmo.is_available,
          pmo.is_default,
          pmo.max_quantity,
          o.name as option_name,
          o.is_available as option_is_available,
          o.status::text as option_status,
          o.display_order as option_display_order,
          o.modifier_group_id::text as option_group_id,
          pmo.created_at,
          pmo.updated_at
        from product_modifier_options pmo
        join modifier_options o on o.id = pmo.modifier_option_id
        where pmo.product_id = ${productId}
          and pmo.store_id = ${storeId}
          and pmo.city_id = ${cityId}
          and o.modifier_group_id = ${product.modifier_group_id}
        order by o.display_order asc, o.id asc`) as ProductModifierRow[];
      configured = rows.map((row) => this.productModifierDto(row));
    }

    return {
      productId: product.id,
      productStatus: product.status,
      productIsAvailable: Boolean(product.is_available),
      modifierGroupId: product.modifier_group_id,
      group,
      options: configured,
    };
  }

  async upsertProductModifierOption(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    optionId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update", storeId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "productId",
      "modifierOptionId",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }

    const price = parseIqdNonNegativePrice(
      input.price === undefined ? 0 : input.price,
    );
    const isAvailable =
      input.isAvailable === undefined ? true : Boolean(input.isAvailable);
    const isDefault =
      input.isDefault === undefined ? false : Boolean(input.isDefault);
    const maxQuantity = parseMaxQuantity(
      input.maxQuantity === undefined ? 1 : input.maxQuantity,
    );
    if (isDefault && price !== 0) {
      throw new AppError(
        422,
        "INVALID_MODIFIER_DEFAULT_PRICE",
        "Default modifier options must have price 0",
      );
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const [product] = await tx<
          {
            id: string;
            modifier_group_id: string | null;
            status: string;
          }[]
        >`
          select
            id::text as id,
            modifier_group_id::text as modifier_group_id,
            status::text as status
          from products
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
        }
        if (product.status === "ARCHIVED") {
          throw new AppError(409, "PRODUCT_ARCHIVED", "Product is archived");
        }
        if (!product.modifier_group_id) {
          throw new AppError(
            422,
            "PRODUCT_HAS_NO_MODIFIER_GROUP",
            "Product has no modifier group assigned",
          );
        }

        const [option] = await tx<
          {
            id: string;
            modifier_group_id: string;
            status: string;
          }[]
        >`
          select
            id::text as id,
            modifier_group_id::text as modifier_group_id,
            status::text as status
          from modifier_options
          where id = ${optionId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!option || option.modifier_group_id !== product.modifier_group_id) {
          throw new AppError(
            404,
            "MODIFIER_OPTION_NOT_FOUND",
            "Modifier option not found",
          );
        }
        if (option.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_OPTION_ARCHIVED",
            "Modifier option is archived",
          );
        }

        const [group] = await tx<{ max_select: number; status: string }[]>`
          select max_select, status::text as status from modifier_groups
          where id = ${product.modifier_group_id}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!group || group.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MODIFIER_GROUP_ARCHIVED",
            "Modifier group is archived",
          );
        }

        if (isDefault) {
          const [countRow] = await tx<{ n: string }[]>`
            select count(*)::text as n
            from product_modifier_options pmo
            join modifier_options o on o.id = pmo.modifier_option_id
            where pmo.product_id = ${productId}
              and o.modifier_group_id = ${product.modifier_group_id}
              and pmo.is_default = true
              and pmo.modifier_option_id <> ${optionId}
              and o.status <> 'ARCHIVED'`;
          assertDefaultsWithinMaxSelect(
            Number(countRow?.n ?? 0) + 1,
            Number(group.max_select),
          );
        }

        await tx`
          insert into product_modifier_options (
            product_id, store_id, city_id, modifier_option_id,
            price, is_available, is_default, max_quantity
          ) values (
            ${productId},
            ${storeId},
            ${cityId},
            ${optionId},
            ${price},
            ${isAvailable},
            ${isDefault},
            ${maxQuantity}
          )
          on conflict (product_id, modifier_option_id) do update set
            price = excluded.price,
            is_available = excluded.is_available,
            is_default = excluded.is_default,
            max_quantity = excluded.max_quantity,
            updated_at = now()`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_MODIFIER_OPTION_UPSERTED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId, optionId })}::jsonb
      )`;

    return this.loadProductModifiersDashboard(storeId, productId, cityId);
  }

  async removeProductModifierOption(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    optionId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update", storeId);
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId);
      const [product] = await tx<
        { id: string; modifier_group_id: string | null; status: string }[]
      >`
        select
          id::text as id,
          modifier_group_id::text as modifier_group_id,
          status::text as status
        from products
        where id = ${productId}
          and store_id = ${storeId}
          and city_id = ${cityId}
        for update`;
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
      }
      if (product.status === "ARCHIVED") {
        throw new AppError(409, "PRODUCT_ARCHIVED", "Product is archived");
      }
      if (!product.modifier_group_id) {
        throw new AppError(
          422,
          "PRODUCT_HAS_NO_MODIFIER_GROUP",
          "Product has no modifier group assigned",
        );
      }
      const [option] = await tx<{ id: string; modifier_group_id: string }[]>`
        select id::text as id, modifier_group_id::text as modifier_group_id
        from modifier_options
        where id = ${optionId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
      if (!option || option.modifier_group_id !== product.modifier_group_id) {
        throw new AppError(
          404,
          "PRODUCT_MODIFIER_OPTION_NOT_FOUND",
          "Product modifier option not found",
        );
      }
      const deleted = await tx<{ id: string }[]>`
        delete from product_modifier_options
        where product_id = ${productId}
          and modifier_option_id = ${optionId}
          and store_id = ${storeId}
          and city_id = ${cityId}
        returning id::text as id`;
      if (!deleted[0]) {
        throw new AppError(
          404,
          "PRODUCT_MODIFIER_OPTION_NOT_FOUND",
          "Product modifier option not found",
        );
      }
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_MODIFIER_OPTION_REMOVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId, optionId })}::jsonb
      )`;

    return this.loadProductModifiersDashboard(storeId, productId, cityId);
  }

  /** Public/mobile effective modifiers for the Product's CURRENT group only. */
  async publicProductModifiers(
    request: Request,
    storeId: string,
    productId: string,
  ): Promise<any> {
    const { city } = await requirePublicCityContext(this.client, request);
    const cityId = city.id;

    const [product] = await this.client<
      {
        id: string;
        modifier_group_id: string | null;
        status: string;
        is_available: boolean;
      }[]
    >`
      select
        p.id::text as id,
        p.modifier_group_id::text as modifier_group_id,
        p.status::text as status,
        p.is_available
      from products p
      join stores s on s.id = p.store_id and s.city_id = p.city_id
      where p.id = ${productId}
        and p.store_id = ${storeId}
        and p.city_id = ${cityId}
        and p.status = 'ACTIVE'
        and p.archived_at is null
        and s.status = 'ACTIVE'
        and s.archived_at is null`;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    }

    if (!product.modifier_group_id) {
      return {
        productId: product.id,
        group: null,
        options: [] as unknown[],
      };
    }

    const [group] = await this.client<
      {
        id: string;
        name: string;
        min_select: number;
        max_select: number;
        status: string;
      }[]
    >`
      select
        id::text as id,
        name,
        min_select,
        max_select,
        status::text as status
      from modifier_groups
      where id = ${product.modifier_group_id}
        and store_id = ${storeId}
        and city_id = ${cityId}
        and status = 'ACTIVE'
        and archived_at is null`;
    if (!group) {
      return {
        productId: product.id,
        group: null,
        options: [] as unknown[],
      };
    }

    const rows = await this.client<
      {
        modifier_option_id: string;
        name: string;
        price: number;
        is_default: boolean;
        max_quantity: number;
        display_order: number;
      }[]
    >`
      select
        o.id::text as modifier_option_id,
        o.name,
        pmo.price,
        pmo.is_default,
        pmo.max_quantity,
        o.display_order
      from product_modifier_options pmo
      join modifier_options o on o.id = pmo.modifier_option_id
      where pmo.product_id = ${productId}
        and pmo.store_id = ${storeId}
        and pmo.city_id = ${cityId}
        and o.modifier_group_id = ${product.modifier_group_id}
        and o.status = 'ACTIVE'
        and o.archived_at is null
        and o.is_available = true
        and pmo.is_available = true
      order by o.display_order asc, o.id asc`;

    return {
      productId: product.id,
      group: {
        id: group.id,
        name: group.name,
        minSelect: Number(group.min_select),
        maxSelect: Number(group.max_select),
      },
      options: rows.map((row) => ({
        modifierOptionId: row.modifier_option_id,
        name: row.name,
        price: Number(row.price),
        isDefault: Boolean(row.is_default),
        maxQuantity: Number(row.max_quantity),
        displayOrder: Number(row.display_order),
      })),
    };
  }
}
