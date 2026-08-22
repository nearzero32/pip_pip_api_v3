import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import type {
  AuthIdentity,
  SessionService,
} from "../../auth/sessions/session-service";
import { beginWithGeographyRetry, lockGovernorateAndCities } from "../geography-locks";
import { revokeDashboardSessionsForCities } from "../operational-sessions";
import { dateValue } from "../shared";
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

export const governorateDto = (row: Record<string, unknown>): any => ({
  id: row.id,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  translations: Array.isArray(row.translations) ? row.translations : [
    { locale: "ar", name: row.name_ar },
    { locale: "en", name: row.name_en },
  ],
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

  async list(
    identity: AuthIdentity,
    input: {
    search?: string;
    status?: string;
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
      displayOrder: `display_order ${sqlDir(sortOrder)}, name_en asc, id asc`,
      nameEn: `name_en ${sqlDir(sortOrder)}, id ${sqlDir(sortOrder)}`,
      nameAr: `name_ar ${sqlDir(sortOrder)}, id ${sqlDir(sortOrder)}`,
      status: `status ${sqlDir(sortOrder)}, display_order asc, id asc`,
      createdAt: `created_at ${sqlDir(sortOrder)}, id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const rows = await this.client.unsafe(
      `select id,name_ar,name_en,status,display_order,created_at,updated_at,
         coalesce((select jsonb_agg(jsonb_build_object('locale',gt.locale,'name',gt.name) order by gt.locale) from governorate_translations gt where gt.governorate_id=governorates.id),'[]'::jsonb) translations
       from governorates
       where ($1::text is null or name_ar ilike $1 escape '\\' or name_en ilike $1 escape '\\')
         and ($2::text is null or status=$2::governorate_status)
         and ($3::timestamptz is null or created_at >= $3)
         and ($4::timestamptz is null or created_at < $4)
       order by ${orderSql}
       limit $5::int offset $6::int`,
      [pattern, input.status ?? null, created.from, created.to, limit, offset],
    );
    const [count] = await this.client.unsafe(
      `select count(*)::text total from governorates
       where ($1::text is null or name_ar ilike $1 escape '\\' or name_en ilike $1 escape '\\')
         and ($2::text is null or status=$2::governorate_status)
         and ($3::timestamptz is null or created_at >= $3)
         and ($4::timestamptz is null or created_at < $4)`,
      [pattern, input.status ?? null, created.from, created.to],
    ) as { total: string }[];
    return dashboardListResult(
      (rows as Record<string, unknown>[]).map((row) => governorateDto(row)),
      page,
      limit,
      Number(count?.total ?? 0),
    );
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

    return beginWithGeographyRetry(this.client, async (tx) => {
      const cityIds =
        input.status !== undefined
          ? await lockGovernorateAndCities(tx, id)
          : [];

      const [current] = await tx<
        { status: string }[]
      >`select status::text as status from governorates where id=${id}`;
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
        await revokeDashboardSessionsForCities(
          this.sessions,
          tx,
          cityIds,
          "GOVERNORATE_UNAVAILABLE",
        );
      }

      const [localized] = await tx`
        select id, name_ar, name_en, status::text, display_order, created_at, updated_at,
          coalesce((select jsonb_agg(jsonb_build_object('locale', gt.locale, 'name', gt.name) order by gt.locale)
            from governorate_translations gt where gt.governorate_id = governorates.id), '[]'::jsonb) translations
        from governorates where id = ${String((row as Record<string, unknown>).id)}`;
      return governorateDto(localized as Record<string, unknown>);
    });
  }
}
