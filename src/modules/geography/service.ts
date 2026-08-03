import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type {
  AuthIdentity,
  SessionService,
} from "../auth/sessions/session-service";

type Page = { page: number; limit: number };
const pageOf = (page = 1, limit = 20): Page => ({
  page: Math.max(1, Math.min(10_000, page)),
  limit: Math.max(1, Math.min(100, limit)),
});
const clean = (value: string, field: string) => {
  const result = value.trim();
  if (!result) throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return result;
};

export class GeographyService {
  constructor(
    private client: SQL,
    private sessions: SessionService,
  ) { }
  private async superAdmin(identity: AuthIdentity) {
    await this.sessions.requireSuperAdmin(identity);
  }
  async governorates(input: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const rows = await this.client<
      {
        id: string;
        name_ar: string;
        name_en: string;
        status: string;
        display_order: number;
        created_at: Date;
        updated_at: Date;
      }[]
    >`select id,name_ar,name_en,status,display_order,created_at,updated_at from governorates where (${search} is null or name_ar ilike ${`%${search}%`} or name_en ilike ${`%${search}%`}) and (${input.status ?? null} is null or status=${input.status ?? null}::governorate_status) order by display_order asc,name_en asc,id asc limit ${limit} offset ${offset}`;
    const [count] = await this.client<
      { total: string }[]
    >`select count(*)::text total from governorates where (${search} is null or name_ar ilike ${`%${search}%`} or name_en ilike ${`%${search}%`}) and (${input.status ?? null} is null or status=${input.status ?? null}::governorate_status)`;
    return { data: rows, page, limit, total: Number(count?.total ?? 0) };
  }
  async updateGovernorate(
    identity: AuthIdentity,
    id: string,
    input: { status?: "ACTIVE" | "INACTIVE"; displayOrder?: number },
  ) {
    await this.superAdmin(identity);
    if (input.status === undefined && input.displayOrder === undefined)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "At least one field is required",
      );
    if (
      input.displayOrder !== undefined &&
      (!Number.isInteger(input.displayOrder) || input.displayOrder < 0)
    )
      throw new AppError(422, "VALIDATION_FAILED", "Invalid display order");
    const [row] = await this
      .client`update governorates set status=coalesce(${input.status ?? null}::governorate_status,status),display_order=coalesce(${input.displayOrder ?? null},display_order),updated_at=now() where id=${id} returning id,name_ar,name_en,status,display_order,created_at,updated_at`;
    if (!row)
      throw new AppError(404, "GOVERNORATE_NOT_FOUND", "Governorate not found");
    return row;
  }
  async cities(input: {
    governorateId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
    mobile?: boolean;
  }) {
    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const rows = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,g.id governorate_id,g.name_ar governorate_name_ar,g.name_en governorate_name_en from cities c join governorates g on g.id=c.governorate_id where (${input.governorateId ?? null} is null or c.governorate_id=${input.governorateId ?? null}) and (${input.mobile ? "ACTIVE" : (input.status ?? null)} is null or c.status=${input.mobile ? "ACTIVE" : (input.status ?? null)}::city_status) and (${input.mobile ? "ACTIVE" : null} is null or g.status='ACTIVE') and (${search} is null or c.name_ar ilike ${`%${search}%`} or c.name_en ilike ${`%${search}%`}) order by c.display_order asc,c.name_en asc,c.id asc limit ${limit} offset ${offset}`;
    const [count] = await this
      .client`select count(*)::text total from cities c join governorates g on g.id=c.governorate_id where (${input.governorateId ?? null} is null or c.governorate_id=${input.governorateId ?? null}) and (${input.mobile ? "ACTIVE" : (input.status ?? null)} is null or c.status=${input.mobile ? "ACTIVE" : (input.status ?? null)}::city_status) and (${input.mobile ? "ACTIVE" : null} is null or g.status='ACTIVE') and (${search} is null or c.name_ar ilike ${`%${search}%`} or c.name_en ilike ${`%${search}%`})`;
    const data = rows.map((row: Record<string, unknown>) => {
      const value = row as Record<string, unknown>;
      const governorate = { id: value.governorate_id, nameAr: value.governorate_name_ar, nameEn: value.governorate_name_en };
      if (input.mobile) return { id: value.id, governorateId: value.governorate_id, nameAr: value.name_ar, nameEn: value.name_en, latitude: value.latitude, longitude: value.longitude, displayOrder: value.display_order, governorate };
      return { ...value, governorate };
    });
    return { data, page, limit, total: Number(count?.total ?? 0) };
  }
  async city(id: string) {
    const [row] = await this
      .client`select c.id,c.governorate_id,c.name_ar,c.name_en,c.latitude::text latitude,c.longitude::text longitude,c.status,c.display_order,c.created_at,c.updated_at,c.archived_at,json_build_object('id',g.id,'nameAr',g.name_ar,'nameEn',g.name_en,'status',g.status) governorate from cities c join governorates g on g.id=c.governorate_id where c.id=${id}`;
    if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    return row;
  }
  async createCity(
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
    await this.superAdmin(identity);
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
      return row;
    } catch (error) {
      if (String(error).includes("foreign key"))
        throw new AppError(422, "INVALID_GOVERNORATE", "Governorate not found");
      throw error;
    }
  }
  async updateCity(
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
    await this.superAdmin(identity);
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
    const [row] = await this
      .client`update cities set governorate_id=coalesce(${input.governorateId ?? null},governorate_id),name_ar=coalesce(${input.nameAr === undefined ? null : clean(input.nameAr, "Arabic name")},name_ar),name_en=coalesce(${input.nameEn === undefined ? null : clean(input.nameEn, "English name")},name_en),latitude=coalesce(${input.latitude ?? null},latitude),longitude=coalesce(${input.longitude ?? null},longitude),display_order=coalesce(${input.displayOrder ?? null},display_order),updated_at=now() where id=${id} and status<>'ARCHIVED' returning *`;
    if (!row)
      throw new AppError(
        404,
        "CITY_NOT_FOUND_OR_ARCHIVED",
        "City not found or archived",
      );
    return row;
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
    await this.superAdmin(identity);
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
      return row;
    });
  }
}
