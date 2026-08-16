import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../geography/geography-locks";
import { dateValue } from "../geography/shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
} from "../dashboard-lists/query";
import { buildPublicMediaUrl } from "../media/object-key";
import type { MediaService } from "../media/media.service";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "./arabic-name";

type MainCategoryStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type CategoryRow = {
  id: string;
  city_id: string;
  name: string;
  image_asset_id: string;
  status: MainCategoryStatus;
  display_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  asset_object_key: string;
  asset_visibility: "PUBLIC" | "PRIVATE";
  asset_status: string;
};

const CATEGORY_SELECT = `
  c.id::text as id,
  c.city_id::text as city_id,
  c.name,
  c.image_asset_id::text as image_asset_id,
  c.status::text as status,
  c.display_order,
  c.created_at,
  c.updated_at,
  c.archived_at,
  m.object_key as asset_object_key,
  m.visibility::text as asset_visibility,
  m.status::text as asset_status
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

const imageDto = (row: CategoryRow, publicBaseUrl: string) => {
  const url = buildPublicMediaUrl(
    publicBaseUrl,
    row.asset_object_key,
    row.asset_visibility,
    row.asset_status,
  );
  return { assetId: row.image_asset_id, url };
};

export const mainCategoryDto = (
  row: CategoryRow,
  publicBaseUrl: string,
): any => ({
  id: row.id,
  name: row.name,
  status: row.status,
  displayOrder: row.display_order,
  image: imageDto(row, publicBaseUrl),
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
});

export const publicMainCategoryDto = (
  row: CategoryRow,
  publicBaseUrl: string,
): any => ({
  id: row.id,
  name: row.name,
  displayOrder: row.display_order,
  image: imageDto(row, publicBaseUrl),
});

export class MainCategoryService {
  constructor(
    private client: SQL,
    private media: MediaService,
    private config: MediaConfig,
  ) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "main_categories.read"
      | "main_categories.create"
      | "main_categories.update"
      | "main_categories.archive",
  ): Promise<string> {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private async loadCityScoped(
    id: string,
    cityId: string,
    db: SQL = this.client,
  ): Promise<CategoryRow> {
    const rows = (await db.unsafe(
      `select ${CATEGORY_SELECT}
       from main_categories c
       join media_assets m on m.id = c.image_asset_id
       where c.id = $1::uuid and c.city_id = $2::uuid`,
      [id, cityId],
    )) as CategoryRow[];
    const row = rows[0];
    if (!row)
      throw new AppError(
        404,
        "MAIN_CATEGORY_NOT_FOUND",
        "Main category not found",
      );
    return row;
  }

  private mapUniqueViolation(constraint: string): never {
    if (constraint.includes("main_categories_image_asset_uidx")) {
      throw new AppError(
        409,
        "MEDIA_NOT_ATTACHABLE",
        "Media asset cannot be attached",
      );
    }
    throw new AppError(
      409,
      "MAIN_CATEGORY_NAME_CONFLICT",
      "Main category name already exists",
    );
  }

  async create(identity: AuthIdentity, body: unknown, requestId: string) {
    const cityId = await this.authorize(identity, "main_categories.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "description",
      "descriptionAr",
      "descriptionEn",
      "nameEn",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
      "imageUrl",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (!("imageAssetId" in input) || input.imageAssetId == null) {
      throw new AppError(
        422,
        "MAIN_CATEGORY_IMAGE_REQUIRED",
        "Main category image is required",
      );
    }
    const imageAssetId = String(input.imageAssetId);
    const name = normalizeArabicCategoryName(input.name);
    const status = input.status ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(
        422,
        "MAIN_CATEGORY_INVALID_STATUS",
        "Invalid main category status",
      );
    }
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );

    let createdId: string;
    try {
      createdId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.media.claimAsset(tx, {
          assetId: imageAssetId,
          cityId,
          purpose: "CATEGORY_IMAGE",
          visibility: "PUBLIC",
        });
        const [inserted] = await tx<{ id: string }[]>`
          insert into main_categories (
            city_id, name, image_asset_id, status, display_order, created_by_account_id
          ) values (
            ${cityId},
            ${name},
            ${imageAssetId},
            ${status}::main_category_status,
            ${displayOrder},
            ${identity.accountId}
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
        'MAIN_CATEGORY_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({
          mainCategoryId: createdId,
          imageAssetId,
          status,
          displayOrder,
        })}::jsonb
      )`;

    return mainCategoryDto(
      await this.loadCityScoped(createdId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async list(
    identity: AuthIdentity,
    input: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const cityId = await this.authorize(identity, "main_categories.read");
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const searchRaw = input.search?.trim() || null;
    const search = searchRaw ? likeContains(searchRaw) : null;
    const status = input.status?.trim() || null;
    if (
      status &&
      status !== "ACTIVE" &&
      status !== "INACTIVE" &&
      status !== "ARCHIVED"
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }

    const rows = (await this.client.unsafe(
      `select ${CATEGORY_SELECT}
       from main_categories c
       join media_assets m on m.id = c.image_asset_id
       where c.city_id = $1::uuid
         and ($2::text is null or c.status = $2::main_category_status)
         and ($2::text is not null or c.status <> 'ARCHIVED')
         and ($3::text is null or c.name ilike $3 escape '\\')
       order by c.display_order asc, c.created_at asc, c.id asc
       limit $4::int offset $5::int`,
      [cityId, status, search, limit, offset],
    )) as CategoryRow[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from main_categories c
       where c.city_id = $1::uuid
         and ($2::text is null or c.status = $2::main_category_status)
         and ($2::text is not null or c.status <> 'ARCHIVED')
         and ($3::text is null or c.name ilike $3 escape '\\')`,
      [cityId, status, search],
    )) as { total: string }[];

    return dashboardListResult(
      rows.map((row) => mainCategoryDto(row, this.config.r2PublicBaseUrl)),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  async get(identity: AuthIdentity, mainCategoryId: string) {
    const cityId = await this.authorize(identity, "main_categories.read");
    return mainCategoryDto(
      await this.loadCityScoped(mainCategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async update(
    identity: AuthIdentity,
    mainCategoryId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "main_categories.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "description",
      "descriptionAr",
      "descriptionEn",
      "nameEn",
      "archivedAt",
      "imageUrl",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const hasName = "name" in input;
    const hasImage = "imageAssetId" in input;
    const hasStatus = "status" in input;
    const hasOrder = "displayOrder" in input;
    if (!hasName && !hasImage && !hasStatus && !hasOrder) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if (hasImage && input.imageAssetId == null) {
      throw new AppError(
        422,
        "MAIN_CATEGORY_IMAGE_REQUIRED",
        "Main category image is required",
      );
    }
    if (hasStatus && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "MAIN_CATEGORY_INVALID_STATUS",
        "Use DELETE to archive a main category",
      );
    }
    if (
      hasStatus &&
      input.status !== "ACTIVE" &&
      input.status !== "INACTIVE"
    ) {
      throw new AppError(
        422,
        "MAIN_CATEGORY_INVALID_STATUS",
        "Invalid main category status",
      );
    }

    const name = hasName ? normalizeArabicCategoryName(input.name) : null;
    const nextStatus = hasStatus
      ? (input.status as "ACTIVE" | "INACTIVE")
      : null;
    const displayOrder = hasOrder
      ? validateDisplayOrder(input.displayOrder)
      : null;
    const nextImageId = hasImage ? String(input.imageAssetId) : null;

    let imageReplaced = false;
    let oldImageAssetId: string | null = null;

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        const [locked] = await tx<{
          id: string;
          status: string;
          image_asset_id: string;
        }[]>`
          select id::text as id, status::text as status, image_asset_id::text as image_asset_id
          from main_categories
          where id = ${mainCategoryId} and city_id = ${cityId}
          for update`;
        if (!locked) {
          throw new AppError(
            404,
            "MAIN_CATEGORY_NOT_FOUND",
            "Main category not found",
          );
        }
        if (locked.status === "ARCHIVED") {
          throw new AppError(
            409,
            "MAIN_CATEGORY_ARCHIVED",
            "Main category is archived",
          );
        }

        oldImageAssetId = locked.image_asset_id;
        const replacing =
          nextImageId !== null && nextImageId !== locked.image_asset_id;
        if (replacing) {
          await this.media.claimAsset(tx, {
            assetId: nextImageId!,
            cityId,
            purpose: "CATEGORY_IMAGE",
            visibility: "PUBLIC",
          });
        }

        if (replacing) {
          await tx`
            update main_categories set
              name = coalesce(${name}, name),
              status = coalesce(${nextStatus}::main_category_status, status),
              display_order = coalesce(${displayOrder}, display_order),
              image_asset_id = ${nextImageId!},
              updated_at = now()
            where id = ${mainCategoryId} and city_id = ${cityId}`;
          await this.media.releaseAsset(tx, {
            assetId: locked.image_asset_id,
            cityId,
          });
          imageReplaced = true;
        } else {
          await tx`
            update main_categories set
              name = coalesce(${name}, name),
              status = coalesce(${nextStatus}::main_category_status, status),
              display_order = coalesce(${displayOrder}, display_order),
              updated_at = now()
            where id = ${mainCategoryId} and city_id = ${cityId}`;
        }
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
        ${imageReplaced ? "MAIN_CATEGORY_IMAGE_REPLACED" : "MAIN_CATEGORY_UPDATED"},
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({
          mainCategoryId,
          oldImageAssetId,
          newImageAssetId: nextImageId ?? oldImageAssetId,
          newStatus: nextStatus,
          displayOrder,
        })}::jsonb
      )`;

    return mainCategoryDto(
      await this.loadCityScoped(mainCategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async archive(
    identity: AuthIdentity,
    mainCategoryId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "main_categories.archive");
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [locked] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from main_categories
        where id = ${mainCategoryId} and city_id = ${cityId}
        for update`;
      if (!locked) {
        throw new AppError(
          404,
          "MAIN_CATEGORY_NOT_FOUND",
          "Main category not found",
        );
      }
      if (locked.status !== "ARCHIVED") {
        await tx`
          update main_categories set
            status = 'ARCHIVED',
            archived_at = now(),
            updated_at = now()
          where id = ${mainCategoryId} and city_id = ${cityId}`;
      }
      // Keep image_asset_id claimed — do not call releaseAsset.
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MAIN_CATEGORY_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ mainCategoryId })}::jsonb
      )`;

    return mainCategoryDto(
      await this.loadCityScoped(mainCategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async listPublic(cityId: string) {
    const rows = (await this.client.unsafe(
      `select ${CATEGORY_SELECT}
       from main_categories c
       join media_assets m on m.id = c.image_asset_id
       where c.city_id = $1::uuid
         and c.status = 'ACTIVE'
         and c.archived_at is null
         and m.status = 'READY'
         and m.visibility = 'PUBLIC'
       order by c.display_order asc, c.created_at asc, c.id asc`,
      [cityId],
    )) as CategoryRow[];
    return {
      data: rows.map((row) =>
        publicMainCategoryDto(row, this.config.r2PublicBaseUrl),
      ),
    };
  }
}
