import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { parseGeoJsonPolygonal, type GeoJsonPolygonal } from "../geometry";
import type {
  AuthIdentity,
  SessionService,
} from "../../auth/sessions/session-service";
import {
  beginWithGeographyRetry,
  lockCityGeography,
  lockCityReassignment,
  readCityOperability,
} from "../geography-locks";
import { revokeDashboardSessionsForCities } from "../operational-sessions";
import { clean, dateValue, numberOrNull, numberValue, pageOf } from "../shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalDateRange,
  parseOptionalSearch,
  parseSortOrder,
  sqlDir,
} from "../../dashboard-lists/query";
import { activeLocales, translationsInput, upsertNameTranslations, validateTranslationInput } from "../../../localization/database";
import { negotiateLocale, parseRequestLocales, resolveLocalizedText } from "../../../localization/localization";

/** Exact City → Governorate FK name from drizzle/0008_simple_nehzno.sql */
export const CITY_GOVERNORATE_FK_CONSTRAINT =
  "cities_governorate_id_governorates_id_fk";

const readPostgresField = (
  error: unknown,
  field: "errno" | "code" | "constraint",
): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const value = record[field];
  if (typeof value === "string") return value;
  return readPostgresField(record.cause, field);
};

/** Maps only the City→Governorate FK violation; other 23503 errors are not remapped. */
export const isCityGovernorateForeignKeyViolation = (
  error: unknown,
): boolean => {
  const sqlState =
    readPostgresField(error, "errno") ?? readPostgresField(error, "code");
  const constraint = readPostgresField(error, "constraint");
  return sqlState === "23503" && constraint === CITY_GOVERNORATE_FK_CONSTRAINT;
};

const governorateSummary = (row: Record<string, unknown>) => ({
  id: row.governorate_id,
  nameAr: row.governorate_name_ar,
  nameEn: row.governorate_name_en,
  translations: Array.isArray(row.governorate_translations)
    ? row.governorate_translations
    : [
        { locale: "ar", name: row.governorate_name_ar },
        { locale: "en", name: row.governorate_name_en },
      ],
  status: row.governorate_status,
});

export const cityListDto = (row: Record<string, unknown>): any => ({
  id: row.id,
  governorateId: row.governorate_id,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  translations: Array.isArray(row.translations) ? row.translations : [
    { locale: "ar", name: row.name_ar },
    { locale: "en", name: row.name_en },
  ],
  latitude: numberValue(row.latitude),
  longitude: numberValue(row.longitude),
  status: row.status,
  displayOrder: row.display_order,
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
  hasBoundary: Boolean(row.has_boundary),
  governorate: governorateSummary(row),
});

export const cityDetailDto = (row: Record<string, unknown>): any => ({
  ...cityListDto(row),
  boundary: row.boundary_geojson ? JSON.parse(String(row.boundary_geojson)) : null,
});

const CITY_COLUMNS = `c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,(c.boundary is not null) has_boundary,g.name_ar governorate_name_ar,g.name_en governorate_name_en,g.status governorate_status,coalesce((select jsonb_agg(jsonb_build_object('locale',ct.locale,'name',ct.name) order by ct.locale) from city_translations ct where ct.city_id=c.id),'[]'::jsonb) translations,coalesce((select jsonb_agg(jsonb_build_object('locale',gt.locale,'name',gt.name) order by gt.locale) from governorate_translations gt where gt.governorate_id=g.id),'[]'::jsonb) governorate_translations`;
const CITY_DETAIL_COLUMNS = `${CITY_COLUMNS},ST_AsGeoJSON(c.boundary)::text boundary_geojson`;

/** Pre-login selection DTO: no administrative or internal fields. */
export const publicCityDto = (
  row: Record<string, unknown>,
  locale: string,
  locales: Awaited<ReturnType<typeof activeLocales>>,
): any => {
  const governorateName = resolveLocalizedText(
    row.governorate_names as Record<string, string>,
    locale,
    locales,
  );
  return {
    id: row.id,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    governorate: {
      id: row.governorate_id,
      nameAr: row.governorate_name_ar,
      nameEn: row.governorate_name_en,
      name: governorateName.value ?? row.governorate_name_ar,
      resolvedLocale: governorateName.resolvedLocale ?? locale,
    },
  };
};

export class CityService {
  constructor(
    private client: SQL,
    private sessions: SessionService,
  ) {}

  private superAdmin(identity: AuthIdentity) {
    this.sessions.requireSuperAdmin(identity);
  }

  async list(
    identity: AuthIdentity,
    input: {
    governorateId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
    createdFrom?: string;
    createdTo?: string;
    sortBy?: string;
    sortOrder?: string;
  },
  ) {
    this.superAdmin(identity);
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = parseOptionalSearch(input.search);
    const pattern = search ? likeContains(search) : null;
    const created = parseOptionalDateRange({
      from: input.createdFrom,
      to: input.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["displayOrder", "nameEn", "nameAr", "status", "createdAt"] as const,
      "displayOrder",
    );
    const sortOrder = parseSortOrder(
      input.sortOrder,
      sortBy === "displayOrder" ? "asc" : "desc",
    );
    const orderSql = {
      displayOrder: `c.display_order ${sqlDir(sortOrder)}, c.name_en asc, c.id asc`,
      nameEn: `c.name_en ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
      nameAr: `c.name_ar ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
      status: `c.status ${sqlDir(sortOrder)}, c.display_order asc, c.id asc`,
      createdAt: `c.created_at ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const rows = await this.client.unsafe(
      `select ${CITY_COLUMNS}
       from cities c join governorates g on g.id=c.governorate_id
       where ($1::uuid is null or c.governorate_id=$1)
         and ($2::text is null or c.status=$2::city_status)
         and ($3::text is null or exists (select 1 from city_translations ct where ct.city_id = c.id and ct.name ilike $3 escape '\\') or c.name_ar ilike $3 escape '\\' or c.name_en ilike $3 escape '\\')
         and ($4::timestamptz is null or c.created_at >= $4)
         and ($5::timestamptz is null or c.created_at < $5)
       order by ${orderSql}
       limit $6::int offset $7::int`,
      [input.governorateId ?? null, input.status ?? null, pattern, created.from, created.to, limit, offset],
    );
    const [count] = (await this.client.unsafe(
      `select count(*)::text total from cities c join governorates g on g.id=c.governorate_id
       where ($1::uuid is null or c.governorate_id=$1)
         and ($2::text is null or c.status=$2::city_status)
         and ($3::text is null or exists (select 1 from city_translations ct where ct.city_id = c.id and ct.name ilike $3 escape '\\') or c.name_ar ilike $3 escape '\\' or c.name_en ilike $3 escape '\\')
         and ($4::timestamptz is null or c.created_at >= $4)
         and ($5::timestamptz is null or c.created_at < $5)`,
      [input.governorateId ?? null, input.status ?? null, pattern, created.from, created.to],
    )) as { total: string }[];
    return dashboardListResult(
      (rows as Record<string, unknown>[]).map((row) => cityListDto(row)),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  /**
   * Public pre-login City selection.
   * Always restricted to ACTIVE cities under ACTIVE governorates.
   * Query params cannot widen visibility.
   */
  async listPublic(input: { search?: string; page?: number; limit?: number }, request?: Request) {
    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const locales = await activeLocales(this.client);
    const locale = negotiateLocale(parseRequestLocales(request), locales);
    const rows = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,coalesce((select jsonb_object_agg(ct.locale,ct.name) from city_translations ct where ct.city_id=c.id),jsonb_build_object('ar',c.name_ar,'en',c.name_en)) names,c.latitude::text latitude,c.longitude::text longitude,g.name_ar governorate_name_ar,g.name_en governorate_name_en,coalesce((select jsonb_object_agg(gt.locale,gt.name) from governorate_translations gt where gt.governorate_id=g.id),jsonb_build_object('ar',g.name_ar,'en',g.name_en)) governorate_names,g.display_order governorate_display_order,c.display_order city_display_order from cities c join governorates g on g.id=c.governorate_id where c.status='ACTIVE' and g.status='ACTIVE' and (${search}::text is null or exists (select 1 from city_translations ct where ct.city_id=c.id and ct.name ilike ${`%${search ?? ""}%`}) or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`}) order by g.display_order asc,c.display_order asc,c.name_en asc,c.id asc limit ${limit} offset ${offset}`;
    const [count] = await this
      .client`select count(*)::text total from cities c join governorates g on g.id=c.governorate_id where c.status='ACTIVE' and g.status='ACTIVE' and (${search}::text is null or exists (select 1 from city_translations ct where ct.city_id=c.id and ct.name ilike ${`%${search ?? ""}%`}) or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`})`;
    return {
      data: rows.map((row: Record<string, unknown>) => ({ ...publicCityDto(row, locale, locales), name: resolveLocalizedText(row.names as Record<string, string>, locale, locales).value ?? row.name_ar, resolvedLocale: locale })),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  async get(id: string) {
    const [row] = await this
      .client.unsafe(`select ${CITY_DETAIL_COLUMNS} from cities c join governorates g on g.id=c.governorate_id where c.id=$1::uuid`, [id]);
    if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    return cityDetailDto(row as Record<string, unknown>);
  }

  async create(
    identity: AuthIdentity,
    input: {
      governorateId: string;
      translations?: unknown;
      nameAr?: string;
      nameEn?: string;
      latitude: number;
      longitude: number;
      displayOrder: number;
      boundary: unknown;
    },
  ) {
    this.superAdmin(identity);
    this.validateCoordinates(
      input.latitude,
      input.longitude,
      input.displayOrder,
    );
    const translations = translationsInput(input.translations, { required: false }) ?? [
      { locale: "ar", name: clean(input.nameAr ?? "", "Arabic name") },
      { locale: "en", name: clean(input.nameEn ?? "", "English name") },
    ];
    const boundary = this.parseCityBoundary(input.boundary);
    try {
      const geojson = JSON.stringify(boundary);
      const [valid] = await this.client<{ valid: boolean; covered: boolean }[]>`
        select ST_IsValid(g) and not ST_IsEmpty(g) and GeometryType(g)='MULTIPOLYGON' and ST_SRID(g)=4326 valid,
          ST_Covers(g,ST_SetSRID(ST_MakePoint(${input.longitude},${input.latitude}),4326)) covered
        from (select ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326)) g) x`;
      if (!valid?.valid) throw new AppError(400, "INVALID_CITY_BOUNDARY", "City boundary is invalid");
      if (!valid.covered) throw new AppError(422, "CITY_CENTER_OUTSIDE_BOUNDARY", "City center is outside the boundary");
      return await this.client.begin(async (tx) => {
        await validateTranslationInput(tx, translations, { requireAllRequired: true, maxName: 200 });
        const nameAr = translations.find((translation) => translation.locale === "ar")!.name;
        const nameEn = translations.find((translation) => translation.locale === "en")!.name;
        const [row] = await tx`insert into cities(governorate_id,name_ar,name_en,latitude,longitude,boundary,status,display_order,archived_at) values(${input.governorateId},${nameAr},${nameEn},${input.latitude},${input.longitude},ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326)),'DRAFT',${input.displayOrder},null) returning id::text as id`;
        await upsertNameTranslations(tx, "city_translations", "city_id", row!.id, {}, translations);
        const [full] = await tx.unsafe(`select ${CITY_DETAIL_COLUMNS} from cities c join governorates g on g.id=c.governorate_id where c.id=$1::uuid`, [row!.id]);
        return cityDetailDto(full as Record<string, unknown>);
      });
    } catch (error) {
      if (isCityGovernorateForeignKeyViolation(error))
        throw new AppError(422, "INVALID_GOVERNORATE", "Governorate not found");
      throw error;
    }
  }

  async update(
    identity: AuthIdentity,
    id: string,
    input: {
      governorateId?: string;
      translations?: unknown;
      nameAr?: string;
      nameEn?: string;
      latitude?: number;
      longitude?: number;
      displayOrder?: number;
      boundary?: unknown;
    },
  ) {
    this.superAdmin(identity);
    if (Object.keys(input).length === 0)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "At least one field is required",
      );
    if (
      input.latitude !== undefined ||
      input.longitude !== undefined ||
      input.displayOrder !== undefined
    )
      this.validateCoordinates(
        input.latitude ?? 0,
        input.longitude ?? 0,
        input.displayOrder ?? 0,
        input.latitude === undefined,
        input.longitude === undefined,
      );

    const translations = translationsInput(input.translations, { required: false });
    if ("boundary" in input && input.boundary === null)
      throw new AppError(422, "INVALID_CITY_BOUNDARY", "City boundary cannot be null");
    const boundary = input.boundary === undefined ? null : this.parseCityBoundary(input.boundary);
    const boundaryJson = boundary ? JSON.stringify(boundary) : null;

    return beginWithGeographyRetry(this.client, async (tx) => {
      try {
        if (translations) await validateTranslationInput(tx, translations, { requireAllRequired: false, maxName: 200 });
        const nameAr = translations?.find((translation) => translation.locale === "ar")?.name ?? null;
        const nameEn = translations?.find((translation) => translation.locale === "en")?.name ?? null;
        // Reassignment acquires both governorate locks before the City lock.
        // Do not pre-lock the City in that path or we would violate the shared order.
        if (input.governorateId === undefined) await lockCityGeography(tx, id);
        const [current] = await tx<{ latitude: string; longitude: string; boundary_geojson: string | null }[]>`select latitude::text latitude,longitude::text longitude,ST_AsGeoJSON(boundary)::text boundary_geojson from cities where id=${id} for update`;
        if (!current) throw new AppError(404, "CITY_NOT_FOUND_OR_ARCHIVED", "City not found or archived");
        const candidate = boundaryJson ?? current.boundary_geojson;
        if (candidate) {
          const [check] = await tx<{ valid: boolean; covered: boolean }[]>`select ST_IsValid(g) and not ST_IsEmpty(g) and GeometryType(g)='MULTIPOLYGON' and ST_SRID(g)=4326 valid,ST_Covers(g,ST_SetSRID(ST_MakePoint(${input.longitude ?? Number(current.longitude)},${input.latitude ?? Number(current.latitude)}),4326)) covered from (select ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${candidate}),4326)) g) x`;
          if (!check?.valid) throw new AppError(400, "INVALID_CITY_BOUNDARY", "City boundary is invalid");
          if (!check.covered) throw new AppError(422, "CITY_CENTER_OUTSIDE_BOUNDARY", "City center is outside the boundary");
          if (boundaryJson) {
            const [outside] = await tx<{ count: string }[]>`select count(*)::text count from zones where city_id=${id} and status <> 'ARCHIVED' and not ST_Covers(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${boundaryJson}),4326)),boundary)`;
            if (Number(outside?.count ?? 0)) throw new AppError(409, "CITY_BOUNDARY_EXCLUDES_ZONES", "City boundary excludes zones", undefined, undefined, { outsideZonesCount: Number(outside!.count) });
          }
        }
        if (input.governorateId !== undefined) {
          const { before } = await lockCityReassignment(
            tx,
            id,
            input.governorateId,
          );
          if (before.cityStatus === "ARCHIVED")
            throw new AppError(
              404,
              "CITY_NOT_FOUND_OR_ARCHIVED",
              "City not found or archived",
            );

          const [targetGov] = await tx<{ id: string; status: string }[]>`
            select id::text as id, status::text as status
            from governorates where id = ${input.governorateId}`;
          if (!targetGov)
            throw new AppError(422, "INVALID_GOVERNORATE", "Governorate not found");

          const [row] = await tx`
            update cities set
              governorate_id = ${input.governorateId},
              name_ar = coalesce(${nameAr}, name_ar),
              name_en = coalesce(${nameEn}, name_en),
              latitude = coalesce(${input.latitude ?? null}, latitude),
              longitude = coalesce(${input.longitude ?? null}, longitude),
              display_order = coalesce(${input.displayOrder ?? null}, display_order),
              boundary = coalesce(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${boundaryJson}),4326)), boundary),
              updated_at = now()
            where id = ${id} and status <> 'ARCHIVED'
            returning id`;
          if (!row)
            throw new AppError(
              404,
              "CITY_NOT_FOUND_OR_ARCHIVED",
              "City not found or archived",
            );

          const after = await readCityOperability(tx, id);
          if (before.operational && !after.operational) {
            await revokeDashboardSessionsForCities(
              this.sessions,
              tx,
              [id],
              "CITY_UNAVAILABLE",
            );
          }
        } else {
          const [row] = await tx`
            update cities set
              name_ar = coalesce(${nameAr}, name_ar),
              name_en = coalesce(${nameEn}, name_en),
              latitude = coalesce(${input.latitude ?? null}, latitude),
              longitude = coalesce(${input.longitude ?? null}, longitude),
              display_order = coalesce(${input.displayOrder ?? null}, display_order),
              boundary = coalesce(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${boundaryJson}),4326)), boundary),
              updated_at = now()
            where id = ${id} and status <> 'ARCHIVED'
            returning id`;
          if (!row)
            throw new AppError(
              404,
              "CITY_NOT_FOUND_OR_ARCHIVED",
              "City not found or archived",
            );
        }
        if (translations) await upsertNameTranslations(tx, "city_translations", "city_id", id, {}, translations);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (isCityGovernorateForeignKeyViolation(error))
          throw new AppError(422, "INVALID_GOVERNORATE", "Governorate not found");
        throw error;
      }

      const [full] = await tx.unsafe(`select ${CITY_DETAIL_COLUMNS} from cities c join governorates g on g.id=c.governorate_id where c.id=$1::uuid`, [id]);
      return cityDetailDto(full as Record<string, unknown>);
    });
  }

  private validateCoordinates(
    latitude: number,
    longitude: number,
    order: number,
    skipLatitude = false,
    skipLongitude = false,
  ) {
    if (
      (!skipLatitude && (latitude < -90 || latitude > 90)) ||
      (!skipLongitude && (longitude < -180 || longitude > 180)) ||
      !Number.isInteger(order) ||
      order < 0
    )
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Invalid city coordinates or display order",
      );
  }

  private parseCityBoundary(value: unknown): GeoJsonPolygonal {
    if (value === undefined || value === null)
      throw new AppError(422, "CITY_BOUNDARY_REQUIRED", "City boundary is required");
    return parseGeoJsonPolygonal(value, "INVALID_CITY_BOUNDARY");
  }

  async transition(
    identity: AuthIdentity,
    id: string,
    target: "ACTIVE" | "SUSPENDED" | "ARCHIVED",
  ) {
    this.superAdmin(identity);
    return beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, id);
      const allowed: Record<string, string[]> = {
        DRAFT: ["ACTIVE", "ARCHIVED"],
        ACTIVE: ["SUSPENDED", "ARCHIVED"],
        SUSPENDED: ["ACTIVE", "ARCHIVED"],
        ARCHIVED: ["ACTIVE"],
      };
      if (!allowed[state.cityStatus]?.includes(target))
        throw new AppError(
          409,
          "INVALID_CITY_STATUS_TRANSITION",
          "Invalid city status transition",
        );
      if (target === "ACTIVE") {
        const [boundary] = await tx<{ exists: boolean }[]>`select boundary is not null exists from cities where id=${id}`;
        if (!boundary?.exists) throw new AppError(409, "CITY_BOUNDARY_REQUIRED", "City boundary is required before activation");
      }
      const [row] =
        await tx`update cities set status=${target}::city_status,archived_at=${target === "ARCHIVED" ? new Date() : null},updated_at=now() where id=${id} returning *`;
      const becameUnavailable =
        state.cityStatus === "ACTIVE" &&
        (target === "SUSPENDED" || target === "ARCHIVED");
      if (becameUnavailable) {
        await revokeDashboardSessionsForCities(
          this.sessions,
          tx,
          [id],
          "CITY_UNAVAILABLE",
        );
      }
      const [full] = await tx.unsafe(`select ${CITY_DETAIL_COLUMNS} from cities c join governorates g on g.id=c.governorate_id where c.id=$1::uuid`, [String((row as Record<string, unknown>).id)]);
      return cityDetailDto(full as Record<string, unknown>);
    });
  }
}
