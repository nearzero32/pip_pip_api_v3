import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type {
  AuthIdentity,
  SessionService,
} from "../../auth/sessions/session-service";
import { clean, dateValue, numberOrNull, numberValue, pageOf } from "../shared";
import { revokeDashboardSessionsForCities } from "../operational-sessions";

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
  status: row.governorate_status,
});

export const cityDto = (row: Record<string, unknown>): any => ({
  id: row.id,
  governorateId: row.governorate_id,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  latitude: numberValue(row.latitude),
  longitude: numberValue(row.longitude),
  status: row.status,
  displayOrder: row.display_order,
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
  governorate: governorateSummary(row),
});

/** Pre-login selection DTO: no administrative or internal fields. */
export const publicCityDto = (row: Record<string, unknown>): any => ({
  id: row.id,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  latitude: numberOrNull(row.latitude),
  longitude: numberOrNull(row.longitude),
  governorate: {
    id: row.governorate_id,
    nameAr: row.governorate_name_ar,
    nameEn: row.governorate_name_en,
  },
});

export class CityService {
  constructor(
    private client: SQL,
    private sessions: SessionService,
  ) {}

  private superAdmin(identity: AuthIdentity) {
    this.sessions.requireSuperAdmin(identity);
  }

  async list(input: {
    governorateId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const rows = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,g.name_ar governorate_name_ar,g.name_en governorate_name_en,g.status governorate_status from cities c join governorates g on g.id=c.governorate_id where (${input.governorateId ?? null}::uuid is null or c.governorate_id=${input.governorateId ?? null}) and (${input.status ?? null}::text is null or c.status=${input.status ?? null}::city_status) and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`}) order by c.display_order asc,c.name_en asc,c.id asc limit ${limit} offset ${offset}`;
    const [count] = await this
      .client`select count(*)::text total from cities c join governorates g on g.id=c.governorate_id where (${input.governorateId ?? null}::uuid is null or c.governorate_id=${input.governorateId ?? null}) and (${input.status ?? null}::text is null or c.status=${input.status ?? null}::city_status) and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`})`;
    return {
      data: rows.map((row: Record<string, unknown>) => cityDto(row)),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  /**
   * Public pre-login City selection.
   * Always restricted to ACTIVE cities under ACTIVE governorates.
   * Query params cannot widen visibility.
   */
  async listPublic(input: { search?: string; page?: number; limit?: number }) {
    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const rows = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,g.name_ar governorate_name_ar,g.name_en governorate_name_en,g.display_order governorate_display_order,c.display_order city_display_order from cities c join governorates g on g.id=c.governorate_id where c.status='ACTIVE' and g.status='ACTIVE' and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`}) order by g.display_order asc,c.display_order asc,c.name_en asc,c.id asc limit ${limit} offset ${offset}`;
    const [count] = await this
      .client`select count(*)::text total from cities c join governorates g on g.id=c.governorate_id where c.status='ACTIVE' and g.status='ACTIVE' and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`})`;
    return {
      data: rows.map((row: Record<string, unknown>) => publicCityDto(row)),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  async get(id: string) {
    const [row] = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,g.name_ar governorate_name_ar,g.name_en governorate_name_en,g.status governorate_status from cities c join governorates g on g.id=c.governorate_id where c.id=${id}`;
    if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    return cityDto(row as Record<string, unknown>);
  }

  async create(
    identity: AuthIdentity,
    input: {
      governorateId: string;
      nameAr: string;
      nameEn: string;
      latitude: number;
      longitude: number;
      displayOrder: number;
    },
  ) {
    this.superAdmin(identity);
    this.validateCoordinates(
      input.latitude,
      input.longitude,
      input.displayOrder,
    );
    const nameAr = clean(input.nameAr, "Arabic name"),
      nameEn = clean(input.nameEn, "English name");
    try {
      const [row] = await this
        .client`insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order,archived_at) values(${input.governorateId},${nameAr},${nameEn},${input.latitude},${input.longitude},'DRAFT',${input.displayOrder},null) returning *`;
      return this.get(String((row as Record<string, unknown>).id));
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
      nameAr?: string;
      nameEn?: string;
      latitude?: number;
      longitude?: number;
      displayOrder?: number;
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
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await this
        .client`update cities set governorate_id=coalesce(${input.governorateId ?? null},governorate_id),name_ar=coalesce(${input.nameAr === undefined ? null : clean(input.nameAr, "Arabic name")},name_ar),name_en=coalesce(${input.nameEn === undefined ? null : clean(input.nameEn, "English name")},name_en),latitude=coalesce(${input.latitude ?? null},latitude),longitude=coalesce(${input.longitude ?? null},longitude),display_order=coalesce(${input.displayOrder ?? null},display_order),updated_at=now() where id=${id} and status<>'ARCHIVED' returning *`;
    } catch (error) {
      if (isCityGovernorateForeignKeyViolation(error))
        throw new AppError(422, "INVALID_GOVERNORATE", "Governorate not found");
      throw error;
    }
    if (!row)
      throw new AppError(
        404,
        "CITY_NOT_FOUND_OR_ARCHIVED",
        "City not found or archived",
      );
    return this.get(String((row as Record<string, unknown>).id));
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

  async transition(
    identity: AuthIdentity,
    id: string,
    target: "ACTIVE" | "SUSPENDED" | "ARCHIVED",
  ) {
    this.superAdmin(identity);
    return this.client.begin(async (tx) => {
      const [current] = await tx<
        { status: string }[]
      >`select status from cities where id=${id} for update`;
      if (!current) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
      const allowed: Record<string, string[]> = {
        DRAFT: ["ACTIVE", "ARCHIVED"],
        ACTIVE: ["SUSPENDED", "ARCHIVED"],
        SUSPENDED: ["ACTIVE", "ARCHIVED"],
        ARCHIVED: [],
      };
      if (!allowed[current.status]?.includes(target))
        throw new AppError(
          409,
          "INVALID_CITY_STATUS_TRANSITION",
          "Invalid city status transition",
        );
      const [row] =
        await tx`update cities set status=${target}::city_status,archived_at=${target === "ARCHIVED" ? new Date() : null},updated_at=now() where id=${id} returning *`;
      const becameUnavailable =
        current.status === "ACTIVE" &&
        (target === "SUSPENDED" || target === "ARCHIVED");
      if (becameUnavailable) {
        await revokeDashboardSessionsForCities(
          this.sessions,
          tx,
          [id],
          "CITY_UNAVAILABLE",
        );
      }
      const [full] =
        await tx`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,g.name_ar governorate_name_ar,g.name_en governorate_name_en,g.status governorate_status from cities c join governorates g on g.id=c.governorate_id where c.id=${String((row as Record<string, unknown>).id)}`;
      return cityDto(full as Record<string, unknown>);
    });
  }
}
