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
  parseAllowlistedSort,
  parseOptionalSearch,
  parseSortOrder,
  sqlDir,
} from "../dashboard-lists/query";
import { buildPublicMediaUrl } from "../media/object-key";
import type { MediaService } from "../media/media.service";
import { validateDisplayOrder } from "./arabic-name";
import { translationsInput, upsertNameTranslations, validateTranslationInput } from "../../localization/database";
import { activeLocales } from "../../localization/database";
import { negotiateLocale, parseRequestLocales, resolveLocalizedText } from "../../localization/localization";
import {
  assertAtLeastOnePatchField,
  assertPatchStatusNotArchived,
  parseImagePatch,
  parseOptionalCreateImage,
} from "./subcategory-patch";

type CategoryStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type SubcategoryRow = {
  id: string;
  city_id: string;
  main_category_id: string;
  main_category_name: string;
  name: string;
  image_asset_id: string | null;
  status: CategoryStatus;
  display_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  asset_object_key: string | null;
  asset_visibility: "PUBLIC" | "PRIVATE" | null;
  asset_status: string | null;
  translations?: Array<{ locale: string; name: string }>;
};

const SUBCATEGORY_SELECT = `
  s.id::text as id,
  s.city_id::text as city_id,
  s.main_category_id::text as main_category_id,
  mc.name as main_category_name,
  s.name,
  s.image_asset_id::text as image_asset_id,
  s.status::text as status,
  s.display_order,
  s.created_at,
  s.updated_at,
  s.archived_at,
  coalesce((select jsonb_agg(jsonb_build_object('locale', st.locale, 'name', st.name) order by st.locale) from subcategory_translations st where st.subcategory_id = s.id), '[]'::jsonb) as translations,
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

const imageDto = (row: SubcategoryRow, publicBaseUrl: string) => {
  if (!row.image_asset_id) return null;
  const url = buildPublicMediaUrl(
    publicBaseUrl,
    row.asset_object_key ?? "",
    (row.asset_visibility ?? "PRIVATE") as "PUBLIC" | "PRIVATE",
    row.asset_status ?? "PENDING_UPLOAD",
  );
  return { assetId: row.image_asset_id, url };
};

export const subcategoryDto = (
  row: SubcategoryRow,
  publicBaseUrl: string,
): any => ({
  id: row.id,
  mainCategory: { id: row.main_category_id, name: row.main_category_name },
  name: row.name,
  status: row.status,
  displayOrder: row.display_order,
  image: imageDto(row, publicBaseUrl),
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
  translations: row.translations ?? [{ locale: "ar", name: row.name }],
});

export const publicSubcategoryDto = (
  row: SubcategoryRow,
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

const sortUuidAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class SubcategoryService {
  constructor(
    private client: SQL,
    private media: MediaService,
    private config: MediaConfig,
  ) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "subcategories.read"
      | "subcategories.create"
      | "subcategories.update"
      | "subcategories.archive",
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
  ): Promise<SubcategoryRow> {
    const rows = (await db.unsafe(
      `select ${SUBCATEGORY_SELECT}
       from subcategories s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       left join media_assets m on m.id = s.image_asset_id
       where s.id = $1::uuid and s.city_id = $2::uuid`,
      [id, cityId],
    )) as SubcategoryRow[];
    const row = rows[0];
    if (!row)
      throw new AppError(404, "SUBCATEGORY_NOT_FOUND", "Subcategory not found");
    return row;
  }

  private mapUniqueViolation(constraint: string): never {
    if (constraint.includes("subcategories_image_asset_uidx")) {
      throw new AppError(
        409,
        "MEDIA_NOT_ATTACHABLE",
        "Media asset cannot be attached",
      );
    }
    throw new AppError(
      409,
      "SUBCATEGORY_NAME_CONFLICT",
      "Subcategory name already exists",
    );
  }

  /** Lock a Main Category in the signed City; serialize with parent archival. */
  private async lockParent(
    tx: SQL,
    mainCategoryId: string,
    cityId: string,
    options?: { allowArchived?: boolean },
  ): Promise<{ id: string; status: string; name: string }> {
    const [row] = await tx<{ id: string; status: string; name: string }[]>`
      select id::text as id, status::text as status, name
      from main_categories
      where id = ${mainCategoryId} and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(
        404,
        "MAIN_CATEGORY_NOT_FOUND",
        "Main category not found",
      );
    }
    if (!options?.allowArchived && row.status === "ARCHIVED") {
      throw new AppError(
        409,
        "MAIN_CATEGORY_ARCHIVED",
        "Main category is archived",
      );
    }
    return row;
  }

  /** Deterministic lock order for move (UUID ascending). */
  private async lockParentsForMove(
    tx: SQL,
    cityId: string,
    currentParentId: string,
    targetParentId: string,
  ): Promise<{
    current: { id: string; status: string };
    target: { id: string; status: string };
  }> {
    const ids = [currentParentId, targetParentId].sort(sortUuidAsc);
    const locked = new Map<string, { id: string; status: string }>();
    for (const id of ids) {
      const [row] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from main_categories
        where id = ${id} and city_id = ${cityId}
        for update`;
      if (!row) {
        throw new AppError(
          404,
          "MAIN_CATEGORY_NOT_FOUND",
          "Main category not found",
        );
      }
      locked.set(id, row);
    }
    const current = locked.get(currentParentId)!;
    const target = locked.get(targetParentId)!;
    if (target.status === "ARCHIVED") {
      throw new AppError(
        409,
        "MAIN_CATEGORY_ARCHIVED",
        "Main category is archived",
      );
    }
    return { current, target };
  }

  async create(identity: AuthIdentity, body: unknown, requestId: string) {
    const cityId = await this.authorize(identity, "subcategories.create");
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
      "createdAt",
      "updatedAt",
      "createdByAccountId",
      "imageUrl",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (
      typeof input.mainCategoryId !== "string" ||
      !input.mainCategoryId
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "mainCategoryId is required");
    }
    const mainCategoryId = input.mainCategoryId;
    const translations = translationsInput(input.translations, { required: true });
    const status = input.status ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(
        422,
        "SUBCATEGORY_INVALID_STATUS",
        "Invalid subcategory status",
      );
    }
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );
    const imageAssetId = parseOptionalCreateImage(input);

    let createdId: string;
    try {
      createdId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockParent(tx, mainCategoryId, cityId);
        await validateTranslationInput(tx, translations!, { requireAllRequired: true, maxName: 100 });
        const name = translations!.find((translation) => translation.locale === "ar")?.name;
        if (!name) throw new AppError(422, "REQUIRED_TRANSLATION_MISSING", "Arabic translation is required");
        if (imageAssetId) {
          await this.media.claimAsset(tx, {
            assetId: imageAssetId,
            cityId,
            purpose: "CATEGORY_IMAGE",
            visibility: "PUBLIC",
          });
        }
        const [inserted] = await tx<{ id: string }[]>`
          insert into subcategories (
            city_id, main_category_id, name, image_asset_id, status, display_order, created_by_account_id
          ) values (
            ${cityId},
            ${mainCategoryId},
            ${name},
            ${imageAssetId},
            ${status}::main_category_status,
            ${displayOrder},
            ${identity.accountId}
          )
          returning id::text as id`;
        await upsertNameTranslations(tx, "subcategory_translations", "subcategory_id", inserted!.id, { city_id: cityId, main_category_id: mainCategoryId }, translations!);
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
        'SUBCATEGORY_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({
          subcategoryId: createdId,
          mainCategoryId,
          imageAssetId,
          status,
          displayOrder,
        })}::jsonb
      )`;

    return subcategoryDto(
      await this.loadCityScoped(createdId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async list(
    identity: AuthIdentity,
    input: {
      mainCategoryId?: string;
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: string;
    },
  ) {
    const cityId = await this.authorize(identity, "subcategories.read");
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const searchRaw = parseOptionalSearch(input.search);
    const search = searchRaw ? likeContains(searchRaw) : null;
    const status = input.status?.trim() || null;
    const mainCategoryId = input.mainCategoryId?.trim() || null;
    if (
      status &&
      status !== "ACTIVE" &&
      status !== "INACTIVE" &&
      status !== "ARCHIVED"
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if (mainCategoryId) {
      const [parent] = await this.client<{ id: string }[]>`
        select id::text as id from main_categories
        where id = ${mainCategoryId} and city_id = ${cityId}`;
      if (!parent) {
        throw new AppError(
          404,
          "MAIN_CATEGORY_NOT_FOUND",
          "Main category not found",
        );
      }
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
      displayOrder: `s.main_category_id asc, s.display_order ${sqlDir(sortOrder)}, s.created_at asc, s.id asc`,
      name: `s.name ${sqlDir(sortOrder)}, s.id ${sqlDir(sortOrder)}`,
      createdAt: `s.created_at ${sqlDir(sortOrder)}, s.id ${sqlDir(sortOrder)}`,
    }[sortBy];

    const rows = (await this.client.unsafe(
      `select ${SUBCATEGORY_SELECT}
       from subcategories s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       left join media_assets m on m.id = s.image_asset_id
       where s.city_id = $1::uuid
         and ($2::uuid is null or s.main_category_id = $2::uuid)
         and ($3::text is null or s.status = $3::main_category_status)
         and ($3::text is not null or s.status <> 'ARCHIVED')
         and ($4::text is null or s.name ilike $4 escape '\\')
       order by ${orderSql}
       limit $5::int offset $6::int`,
      [cityId, mainCategoryId, status, search, limit, offset],
    )) as SubcategoryRow[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from subcategories s
       where s.city_id = $1::uuid
         and ($2::uuid is null or s.main_category_id = $2::uuid)
         and ($3::text is null or s.status = $3::main_category_status)
         and ($3::text is not null or s.status <> 'ARCHIVED')
         and ($4::text is null or s.name ilike $4 escape '\\')`,
      [cityId, mainCategoryId, status, search],
    )) as { total: string }[];

    return dashboardListResult(
      rows.map((row) => subcategoryDto(row, this.config.r2PublicBaseUrl)),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  async get(identity: AuthIdentity, subcategoryId: string) {
    const cityId = await this.authorize(identity, "subcategories.read");
    return subcategoryDto(
      await this.loadCityScoped(subcategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async update(
    identity: AuthIdentity,
    subcategoryId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "subcategories.update");
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
    assertAtLeastOnePatchField(input, [
      "mainCategoryId",
      "translations",
      "imageAssetId",
      "status",
      "displayOrder",
    ]);
    if ("status" in input) assertPatchStatusNotArchived(input.status);
    if (
      "status" in input &&
      input.status !== "ACTIVE" &&
      input.status !== "INACTIVE"
    ) {
      throw new AppError(
        422,
        "SUBCATEGORY_INVALID_STATUS",
        "Invalid subcategory status",
      );
    }

    const translations = translationsInput(input.translations, { required: false });
    const name = translations?.find((translation) => translation.locale === "ar")?.name ?? null;
    const nextStatus =
      "status" in input ? (input.status as "ACTIVE" | "INACTIVE") : null;
    const displayOrder =
      "displayOrder" in input ? validateDisplayOrder(input.displayOrder) : null;
    const nextParentId =
      "mainCategoryId" in input ? String(input.mainCategoryId) : null;
    const imagePatch = parseImagePatch(input);

    let auditAction = "SUBCATEGORY_UPDATED";
    let oldMainCategoryId: string | null = null;
    let newMainCategoryId: string | null = null;
    let oldImageAssetId: string | null = null;
    let newImageAssetId: string | null | undefined = undefined;

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);

        const [peek] = await tx<{
          id: string;
          status: string;
          main_category_id: string;
          image_asset_id: string | null;
        }[]>`
          select
            id::text as id,
            status::text as status,
            main_category_id::text as main_category_id,
            image_asset_id::text as image_asset_id
          from subcategories
          where id = ${subcategoryId} and city_id = ${cityId}`;
        if (!peek) {
          throw new AppError(
            404,
            "SUBCATEGORY_NOT_FOUND",
            "Subcategory not found",
          );
        }
        if (peek.status === "ARCHIVED") {
          throw new AppError(
            409,
            "SUBCATEGORY_ARCHIVED",
            "Subcategory is archived",
          );
        }

        const moving =
          nextParentId !== null && nextParentId !== peek.main_category_id;

        // Preferred lock order: Main Category row(s) before Subcategory row.
        if (moving) {
          await this.lockParentsForMove(
            tx,
            cityId,
            peek.main_category_id,
            nextParentId!,
          );
          auditAction = "SUBCATEGORY_MOVED";
        } else {
          await this.lockParent(tx, peek.main_category_id, cityId);
        }

        const [locked] = await tx<{
          id: string;
          status: string;
          main_category_id: string;
          image_asset_id: string | null;
        }[]>`
          select
            id::text as id,
            status::text as status,
            main_category_id::text as main_category_id,
            image_asset_id::text as image_asset_id
          from subcategories
          where id = ${subcategoryId} and city_id = ${cityId}
          for update`;
        if (!locked) {
          throw new AppError(
            404,
            "SUBCATEGORY_NOT_FOUND",
            "Subcategory not found",
          );
        }
        if (locked.status === "ARCHIVED") {
          throw new AppError(
            409,
            "SUBCATEGORY_ARCHIVED",
            "Subcategory is archived",
          );
        }
        if (locked.main_category_id !== peek.main_category_id) {
          throw new AppError(
            409,
            "MAIN_CATEGORY_NOT_FOUND",
            "Main category not found",
          );
        }
        if (translations) await validateTranslationInput(tx, translations, { requireAllRequired: false, maxName: 100 });

        oldMainCategoryId = locked.main_category_id;
        oldImageAssetId = locked.image_asset_id;
        newMainCategoryId = nextParentId ?? locked.main_category_id;
        if (moving) auditAction = "SUBCATEGORY_MOVED";

        let nextImageId: string | null = locked.image_asset_id;
        let releaseOld: string | null = null;
        if (imagePatch.kind === "set") {
          if (imagePatch.assetId !== locked.image_asset_id) {
            await this.media.claimAsset(tx, {
              assetId: imagePatch.assetId,
              cityId,
              purpose: "CATEGORY_IMAGE",
              visibility: "PUBLIC",
            });
            releaseOld = locked.image_asset_id;
            nextImageId = imagePatch.assetId;
            auditAction =
              locked.image_asset_id == null
                ? "SUBCATEGORY_IMAGE_ATTACHED"
                : "SUBCATEGORY_IMAGE_REPLACED";
          }
        } else if (imagePatch.kind === "clear") {
          if (locked.image_asset_id != null) {
            releaseOld = locked.image_asset_id;
            nextImageId = null;
            auditAction = "SUBCATEGORY_IMAGE_REMOVED";
          }
        }
        newImageAssetId = nextImageId;

        await tx`
          update subcategories set
            main_category_id = ${moving ? nextParentId! : locked.main_category_id},
            name = coalesce(${name}, name),
            status = coalesce(${nextStatus}::main_category_status, status),
            display_order = coalesce(${displayOrder}, display_order),
            image_asset_id = ${nextImageId},
            updated_at = now()
          where id = ${subcategoryId} and city_id = ${cityId}`;
        if (translations) await upsertNameTranslations(tx, "subcategory_translations", "subcategory_id", subcategoryId, { city_id: cityId, main_category_id: moving ? nextParentId! : locked.main_category_id }, translations);

        if (releaseOld) {
          await this.media.releaseAsset(tx, {
            assetId: releaseOld,
            cityId,
          });
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
        ${auditAction},
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({
          subcategoryId,
          oldMainCategoryId,
          newMainCategoryId,
          oldImageAssetId,
          newImageAssetId,
          newStatus: nextStatus,
          displayOrder,
        })}::jsonb
      )`;

    return subcategoryDto(
      await this.loadCityScoped(subcategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async archive(
    identity: AuthIdentity,
    subcategoryId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "subcategories.archive");
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);

      const [peek] = await tx<{
        id: string;
        status: string;
        main_category_id: string;
        image_asset_id: string | null;
      }[]>`
        select
          id::text as id,
          status::text as status,
          main_category_id::text as main_category_id,
          image_asset_id::text as image_asset_id
        from subcategories
        where id = ${subcategoryId} and city_id = ${cityId}`;
      await tx`update subcategory_translations set archived_at=now(),updated_at=now() where subcategory_id=${subcategoryId}`;
      if (!peek) {
        throw new AppError(
          404,
          "SUBCATEGORY_NOT_FOUND",
          "Subcategory not found",
        );
      }
      if (peek.status === "ARCHIVED") return;

      // Parent may already be archived — still allow child archive to release image.
      await this.lockParent(tx, peek.main_category_id, cityId, {
        allowArchived: true,
      });

      const [locked] = await tx<{
        id: string;
        status: string;
        image_asset_id: string | null;
      }[]>`
        select
          id::text as id,
          status::text as status,
          image_asset_id::text as image_asset_id
        from subcategories
        where id = ${subcategoryId} and city_id = ${cityId}
        for update`;
      if (!locked) {
        throw new AppError(
          404,
          "SUBCATEGORY_NOT_FOUND",
          "Subcategory not found",
        );
      }
      if (locked.status === "ARCHIVED") return;

      const previousImage = locked.image_asset_id;
      await tx`
        update subcategories set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now(),
          image_asset_id = null
        where id = ${subcategoryId} and city_id = ${cityId}`;

      if (previousImage) {
        await this.media.releaseAsset(tx, {
          assetId: previousImage,
          cityId,
        });
      }
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'SUBCATEGORY_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ subcategoryId })}::jsonb
      )`;

    return subcategoryDto(
      await this.loadCityScoped(subcategoryId, cityId),
      this.config.r2PublicBaseUrl,
    );
  }

  async listPublic(cityId: string, mainCategoryId: string, request?: Request) {
    const locales = await activeLocales(this.client);
    const locale = negotiateLocale(parseRequestLocales(request), locales);
    const [parent] = await this.client<
      { id: string; status: string; archived_at: Date | string | null }[]
    >`
      select id::text as id, status::text as status, archived_at
      from main_categories
      where id = ${mainCategoryId} and city_id = ${cityId}`;
    if (
      !parent ||
      parent.status !== "ACTIVE" ||
      parent.archived_at != null
    ) {
      throw new AppError(
        404,
        "MAIN_CATEGORY_NOT_FOUND",
        "Main category not found",
      );
    }

    const rows = (await this.client.unsafe(
      `select ${SUBCATEGORY_SELECT}
       from subcategories s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       left join media_assets m on m.id = s.image_asset_id
       where s.city_id = $1::uuid
         and s.main_category_id = $2::uuid
         and s.status = 'ACTIVE'
         and s.archived_at is null
         and mc.status = 'ACTIVE'
         and mc.archived_at is null
         and (
           s.image_asset_id is null
           or (m.status = 'READY' and m.visibility = 'PUBLIC')
         )
       order by s.display_order asc, s.created_at asc, s.id asc`,
      [cityId, mainCategoryId],
    )) as SubcategoryRow[];

    return {
      data: rows.map((row) =>
        publicSubcategoryDto(row, this.config.r2PublicBaseUrl, locale, locales),
      ),
    };
  }
}
