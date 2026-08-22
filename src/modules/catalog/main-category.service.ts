import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { requireSuperAdmin } from "../auth/staff/authorization";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { dateValue } from "../geography/shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalSearch,
  parseSortOrder,
  sqlDir,
} from "../dashboard-lists/query";
import { buildPublicMediaUrl } from "../media/object-key";
import type { MediaService } from "../media/media.service";
import { validateDisplayOrder } from "./arabic-name";
import { activeLocales, translationsInput, upsertNameTranslations, validateTranslationInput } from "../../localization/database";
import { negotiateLocale, parseAcceptLanguage, resolveLocalizedText, type LocalizedTranslation } from "../../localization/localization";

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
  created_by_account_id?: string;
  updated_by_account_id?: string | null;
  archived_by_account_id?: string | null;
  asset_object_key: string;
  asset_visibility: "PUBLIC" | "PRIVATE";
  asset_status: string;
  translations?: LocalizedTranslation[];
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
  c.created_by_account_id::text as created_by_account_id,
  c.updated_by_account_id::text as updated_by_account_id,
  c.archived_by_account_id::text as archived_by_account_id,
  coalesce((select jsonb_agg(jsonb_build_object('locale', mt.locale, 'name', mt.name) order by mt.locale) from main_category_translations mt where mt.main_category_id = c.id), '[]'::jsonb) as translations,
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
  cityId: row.city_id,
  name: row.name,
  status: row.status,
  displayOrder: row.display_order,
  image: imageDto(row, publicBaseUrl),
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
  createdByAccountId: row.created_by_account_id ?? null,
  updatedByAccountId: row.updated_by_account_id ?? null,
  archivedByAccountId: row.archived_by_account_id ?? null,
  translations: row.translations ?? [{ locale: "ar", name: row.name }],
});

export const publicMainCategoryDto = (
  row: CategoryRow,
  publicBaseUrl: string,
  locale = "ar",
  locales: Awaited<ReturnType<typeof activeLocales>> = [],
): any => ({
  id: row.id,
  name: resolveLocalizedText(
    Object.fromEntries((row.translations ?? [{ locale: "ar", name: row.name }]).map((translation) => [translation.locale, translation.name])),
    locale,
    locales,
  ).value ?? row.name,
  resolvedLocale: resolveLocalizedText(
    Object.fromEntries((row.translations ?? [{ locale: "ar", name: row.name }]).map((translation) => [translation.locale, translation.name])),
    locale,
    locales,
  ).resolvedLocale ?? locale,
  displayOrder: row.display_order,
  image: imageDto(row, publicBaseUrl),
});

export class MainCategoryService {
  constructor(
    private client: SQL,
    private media: MediaService,
    private config: MediaConfig,
  ) {}

  private async authorize(identity: AuthIdentity, cityId?: string): Promise<string> {
    requireSuperAdmin(identity);
    if (!cityId) throw new AppError(422, "CITY_ID_REQUIRED", "City selection is required");
    const [city] = await this.client<{ status: string }[]>`select status::text status from cities where id=${cityId}`;
    if (!city) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    if (city.status === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
    return cityId;
  }

  private async lockTargetCity(tx: SQL, cityId: string) {
    const [city] = await tx<{ status: string }[]>`select status::text status from cities where id=${cityId} for update`;
    if (!city) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    if (city.status === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
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

  async create(identity: AuthIdentity, requestedCityId: string, body: unknown, requestId: string) {
    const cityId = await this.authorize(identity, requestedCityId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "description",
      "descriptionAr",
      "descriptionEn",
      "name",
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
    const translations = translationsInput(input.translations, { required: true });
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
      createdId = await this.client.begin(async (tx) => {
        await this.lockTargetCity(tx, cityId);
        await validateTranslationInput(tx, translations!, { requireAllRequired: true, maxName: 100 });
        const name = translations!.find((translation) => translation.locale === "ar")?.name;
        if (!name) throw new AppError(422, "REQUIRED_TRANSLATION_MISSING", "Arabic translation is required");
        await this.media.claimAsset(tx, {
          assetId: imageAssetId,
          cityId,
          purpose: "CATEGORY_IMAGE",
          visibility: "PUBLIC",
        });
        const [inserted] = await tx<{ id: string }[]>`
          insert into main_categories (
            city_id, name, image_asset_id, status, display_order,
            created_by_account_id, updated_by_account_id
          ) values (
            ${cityId},
            ${name},
            ${imageAssetId},
            ${status}::main_category_status,
            ${displayOrder},
            ${identity.accountId},
            ${identity.accountId}
          )
          returning id::text as id`;
        await upsertNameTranslations(tx, "main_category_translations", "main_category_id", inserted!.id, { city_id: cityId }, translations!);
        await tx`insert into audit_logs(event_type,actor_account_id,outcome,request_correlation_id,redacted_metadata) values('MAIN_CATEGORY_CREATED',${identity.accountId},'SUCCESS',${requestId},${JSON.stringify({targetCityId:cityId,mainCategoryId:inserted!.id,changedFields:["name","imageAssetId","status","displayOrder"]})}::jsonb)`;
        return inserted!.id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

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
      sortBy?: string;
      sortOrder?: string;
      cityId?: string;
    },
  ) {
    const cityId = await this.authorize(identity, input.cityId);
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const searchRaw = parseOptionalSearch(input.search);
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
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["displayOrder", "name", "createdAt"] as const,
      "displayOrder",
    );
    const sortOrder = parseSortOrder(
      input.sortOrder,
      sortBy === "displayOrder" || sortBy === "name" ? "asc" : "desc",
    );
    const orderSql = {
      displayOrder: `c.display_order ${sqlDir(sortOrder)}, c.created_at asc, c.id asc`,
      name: `c.name ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
      createdAt: `c.created_at ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    }[sortBy];

    const rows = (await this.client.unsafe(
      `select ${CATEGORY_SELECT}
       from main_categories c
       join media_assets m on m.id = c.image_asset_id
       where c.city_id = $1::uuid
         and ($2::text is null or c.status = $2::main_category_status)
         and ($2::text is not null or c.status <> 'ARCHIVED')
         and ($3::text is null or c.name ilike $3 escape '\\')
       order by ${orderSql}
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

  async get(identity: AuthIdentity, mainCategoryId: string, requestedCityId?: string) {
    const cityId = await this.authorize(identity, requestedCityId);
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
    requestedCityId?: string,
  ) {
    const cityId = await this.authorize(identity, requestedCityId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "description",
      "descriptionAr",
      "descriptionEn",
      "name",
      "nameEn",
      "archivedAt",
      "imageUrl",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const hasTranslations = "translations" in input;
    const hasImage = "imageAssetId" in input;
    const hasStatus = "status" in input;
    const hasOrder = "displayOrder" in input;
    if (!hasTranslations && !hasImage && !hasStatus && !hasOrder) {
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

    const translations = translationsInput(input.translations, { required: false });
    const name = translations?.find((translation) => translation.locale === "ar")?.name ?? null;
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
      await this.client.begin(async (tx) => {
        await this.lockTargetCity(tx, cityId);
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
        if (translations) {
          await validateTranslationInput(tx, translations, { requireAllRequired: false, maxName: 100 });
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
              updated_by_account_id = ${identity.accountId},
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
              updated_by_account_id = ${identity.accountId},
              updated_at = now()
            where id = ${mainCategoryId} and city_id = ${cityId}`;
        }
        if (translations) await upsertNameTranslations(tx, "main_category_translations", "main_category_id", mainCategoryId, { city_id: cityId }, translations);
        await tx`insert into audit_logs(event_type,actor_account_id,outcome,request_correlation_id,redacted_metadata) values(${imageReplaced ? "MAIN_CATEGORY_IMAGE_REPLACED" : "MAIN_CATEGORY_UPDATED"},${identity.accountId},'SUCCESS',${requestId},${JSON.stringify({targetCityId:cityId,mainCategoryId,changedFields:[hasTranslations?"translations":null,hasStatus?"status":null,hasOrder?"displayOrder":null,hasImage?"imageAssetId":null].filter(Boolean),oldImageAssetId,newImageAssetId:nextImageId})}::jsonb)`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    return mainCategoryDto(
      await this.loadCityScoped(mainCategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async archive(
    identity: AuthIdentity,
    mainCategoryId: string,
    requestId: string,
    requestedCityId?: string,
  ) {
    const cityId = await this.authorize(identity, requestedCityId);
    await this.client.begin(async (tx) => {
      await this.lockTargetCity(tx, cityId);
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
            updated_by_account_id = ${identity.accountId},
            archived_by_account_id = ${identity.accountId},
            updated_at = now()
          where id = ${mainCategoryId} and city_id = ${cityId}`;
        await tx`update main_category_translations set archived_at=now(),updated_at=now() where main_category_id=${mainCategoryId}`;
        await tx`insert into audit_logs(event_type,actor_account_id,outcome,request_correlation_id,redacted_metadata) values('MAIN_CATEGORY_ARCHIVED',${identity.accountId},'SUCCESS',${requestId},${JSON.stringify({targetCityId:cityId,mainCategoryId,changedFields:["status","archivedAt"]})}::jsonb)`;
      }
      // Keep image_asset_id claimed — do not call releaseAsset.
    });

    return mainCategoryDto(
      await this.loadCityScoped(mainCategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async listPublic(cityId: string, request?: Request) {
    const locales = await activeLocales(this.client);
    const locale = negotiateLocale(parseAcceptLanguage(request?.headers.get("accept-language")), locales);
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
        publicMainCategoryDto(row, this.config.r2PublicBaseUrl, locale, locales),
      ),
    };
  }
}
