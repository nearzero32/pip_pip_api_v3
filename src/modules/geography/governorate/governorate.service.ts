import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type {
  AuthIdentity,
  SessionService,
} from "../../auth/sessions/session-service";
import { dateValue, pageOf } from "../shared";
import { revokeDashboardSessionsForCities } from "../operational-sessions";

export const governorateDto = (row: Record<string, unknown>): any => ({
  id: row.id,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  status: row.status,
  displayOrder: row.display_order,
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
});

export class GovernorateService {
  constructor(
    private client: SQL,
    private sessions: SessionService,
  ) {}

  private superAdmin(identity: AuthIdentity) {
    this.sessions.requireSuperAdmin(identity);
  }

  async list(input: {
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
    >`select id,name_ar,name_en,status,display_order,created_at,updated_at from governorates where (${search}::text is null or name_ar ilike ${`%${search ?? ""}%`} or name_en ilike ${`%${search ?? ""}%`}) and (${input.status ?? null}::text is null or status=${input.status ?? null}::governorate_status) order by display_order asc,name_en asc,id asc limit ${limit} offset ${offset}`;
    const [count] = await this.client<
      { total: string }[]
    >`select count(*)::text total from governorates where (${search}::text is null or name_ar ilike ${`%${search ?? ""}%`} or name_en ilike ${`%${search ?? ""}%`}) and (${input.status ?? null}::text is null or status=${input.status ?? null}::governorate_status)`;
    return {
      data: rows.map((row) => governorateDto(row)),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  async update(
    identity: AuthIdentity,
    id: string,
    input: { status?: "ACTIVE" | "INACTIVE"; displayOrder?: number },
  ) {
    this.superAdmin(identity);
    if (Object.keys(input).length === 0)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "At least one field is required",
      );
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

    return this.client.begin(async (tx) => {
      const [current] = await tx<
        { status: string }[]
      >`select status::text as status from governorates where id=${id} for update`;
      if (!current)
        throw new AppError(404, "GOVERNORATE_NOT_FOUND", "Governorate not found");

      const [row] = await tx`
        update governorates set
          status=coalesce(${input.status ?? null}::governorate_status,status),
          display_order=coalesce(${input.displayOrder ?? null},display_order),
          updated_at=now()
        where id=${id}
        returning id,name_ar,name_en,status,display_order,created_at,updated_at`;
      if (!row)
        throw new AppError(404, "GOVERNORATE_NOT_FOUND", "Governorate not found");

      const becameUnavailable =
        current.status === "ACTIVE" && input.status === "INACTIVE";
      if (becameUnavailable) {
        const cities = await tx<{ id: string }[]>`
          select id::text as id from cities where governorate_id = ${id}`;
        await revokeDashboardSessionsForCities(
          this.sessions,
          tx,
          cities.map((city) => city.id),
          "GOVERNORATE_UNAVAILABLE",
        );
      }

      return governorateDto(row as Record<string, unknown>);
    });
  }
}
