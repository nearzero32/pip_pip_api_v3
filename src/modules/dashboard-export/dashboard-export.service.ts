import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  requireCityAdmin,
  requireCityPermission,
  requireCityReadAndExport,
  requireSuperAdmin,
} from "../auth/staff/authorization";
import {
  buildExcelWorkbook,
  excelFileResponse,
  type ExcelColumn,
  type ExcelCell,
} from "./xlsx";

const iso = (value: unknown): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
};

const text = (value: unknown): string | null =>
  value == null ? null : String(value);

const int = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export class DashboardExportService {
  constructor(
    private client: SQL,
    private maxRows: number,
  ) {}

  private assertLimit(total: number) {
    if (total > this.maxRows) {
      throw new AppError(
        409,
        "EXPORT_RESULT_LIMIT_EXCEEDED",
        "Narrow the filters before exporting",
        undefined,
        undefined,
        { maxRows: this.maxRows, total },
      );
    }
  }

  private file(
    filename: string,
    sheetName: string,
    columns: ExcelColumn[],
    rows: Array<Record<string, ExcelCell>>,
  ) {
    return excelFileResponse(
      filename,
      buildExcelWorkbook({ sheetName, columns, rows }),
    );
  }

  private async audit(
    identity: AuthIdentity,
    resource: string,
    rowCount: number,
    requestId: string,
  ) {
    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, target_type, outcome,
        request_correlation_id, redacted_metadata
      ) values (
        'DASHBOARD_EXPORT', ${identity.accountId}, ${resource}, 'SUCCESS',
        ${requestId}, ${JSON.stringify({ resource, rowCount })}::jsonb
      )`;
  }

  async governorates(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    requireSuperAdmin(identity);
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from governorates
      where (${search}::text is null or name_ar ilike ${`%${search ?? ""}%`} or name_en ilike ${`%${search ?? ""}%`})
        and (${status}::text is null or status=${status}::governorate_status)`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select id::text, name_ar, name_en, status::text, display_order, created_at, updated_at
      from governorates
      where (${search}::text is null or name_ar ilike ${`%${search ?? ""}%`} or name_en ilike ${`%${search ?? ""}%`})
        and (${status}::text is null or status=${status}::governorate_status)
      order by display_order asc, name_en asc, id asc`;
    await this.audit(identity, "governorates", rows.length, requestId);
    return this.file("governorates.xlsx", "المحافظات", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "nameAr", header: "الاسم العربي", type: "text", width: 24 },
      { key: "nameEn", header: "الاسم الإنجليزي", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "updatedAt", header: "تاريخ التحديث", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id),
      nameAr: text(row.name_ar),
      nameEn: text(row.name_en),
      status: text(row.status),
      displayOrder: int(row.display_order),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })));
  }

  async cities(
    identity: AuthIdentity,
    query: { governorateId?: string; search?: string; status?: string },
    requestId: string,
  ) {
    requireSuperAdmin(identity);
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    const governorateId = query.governorateId?.trim() || null;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from cities c
      join governorates g on g.id = c.governorate_id
      where (${governorateId}::uuid is null or c.governorate_id = ${governorateId})
        and (${status}::text is null or c.status = ${status}::city_status)
        and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`})`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select c.id::text, c.governorate_id::text, c.name_ar, c.name_en, c.status::text,
             c.display_order, g.name_ar as governorate_name_ar, c.created_at, c.updated_at, c.archived_at
      from cities c join governorates g on g.id = c.governorate_id
      where (${governorateId}::uuid is null or c.governorate_id = ${governorateId})
        and (${status}::text is null or c.status = ${status}::city_status)
        and (${search}::text is null or c.name_ar ilike ${`%${search ?? ""}%`} or c.name_en ilike ${`%${search ?? ""}%`})
      order by c.display_order asc, c.name_en asc, c.id asc`;
    await this.audit(identity, "cities", rows.length, requestId);
    return this.file("cities.xlsx", "المدن", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "nameAr", header: "الاسم العربي", type: "text", width: 24 },
      { key: "nameEn", header: "الاسم الإنجليزي", type: "text", width: 24 },
      { key: "governorate", header: "المحافظة", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "updatedAt", header: "تاريخ التحديث", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id),
      nameAr: text(row.name_ar),
      nameEn: text(row.name_en),
      governorate: text(row.governorate_name_ar),
      status: text(row.status),
      displayOrder: int(row.display_order),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })));
  }

  async zones(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "zones.read", "zones.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from zones z
       where z.city_id = $1::uuid
         and ($2::text is null or z.status = $2::zone_status)
         and ($3::text is null or z.name ilike ('%' || $3 || '%'))`,
      [cityId, status, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select z.id::text, z.name, z.status::text, z.created_at, z.updated_at, z.archived_at
       from zones z
       where z.city_id = $1::uuid
         and ($2::text is null or z.status = $2::zone_status)
         and ($3::text is null or z.name ilike ('%' || $3 || '%'))
       order by z.name asc, z.id asc`,
      [cityId, status, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "zones", rows.length, requestId);
    return this.file("zones.xlsx", "المناطق", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "updatedAt", header: "تاريخ التحديث", type: "datetime", width: 24 },
      { key: "archivedAt", header: "تاريخ الأرشفة", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), status: text(row.status),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: iso(row.archived_at),
    })));
  }

  async stores(
    identity: AuthIdentity,
    query: { search?: string; status?: string; mainCategoryId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "stores.read", "stores.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    const mainCategoryId = query.mainCategoryId?.trim() || null;
    if (status && !["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from stores s
       where s.city_id = $1::uuid
         and ($2::text is null or s.status = $2::store_status)
         and ($2::text is not null or s.status <> 'ARCHIVED')
         and ($3::uuid is null or s.main_category_id = $3::uuid)
         and ($4::text is null or s.name ilike ('%' || $4 || '%'))`,
      [cityId, status, mainCategoryId, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select s.id::text, s.name, s.phone, s.address, s.status::text,
              s.order_acceptance_status::text, s.display_order, mc.name as main_category_name,
              s.created_at, s.updated_at, s.archived_at
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       where s.city_id = $1::uuid
         and ($2::text is null or s.status = $2::store_status)
         and ($2::text is not null or s.status <> 'ARCHIVED')
         and ($3::uuid is null or s.main_category_id = $3::uuid)
         and ($4::text is null or s.name ilike ('%' || $4 || '%'))
       order by s.display_order asc, s.created_at asc, s.id asc`,
      [cityId, status, mainCategoryId, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "stores", rows.length, requestId);
    return this.file("stores.xlsx", "المتاجر", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "phone", header: "الهاتف", type: "text", width: 16 },
      { key: "address", header: "العنوان", type: "text", width: 32 },
      { key: "mainCategory", header: "التصنيف الرئيسي", type: "text", width: 20 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "orderAcceptance", header: "قبول الطلبات", type: "text", width: 16 },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "updatedAt", header: "تاريخ التحديث", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), phone: text(row.phone), address: text(row.address),
      mainCategory: text(row.main_category_name), status: text(row.status),
      orderAcceptance: text(row.order_acceptance_status), displayOrder: int(row.display_order),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    })));
  }

  async storeCommissions(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "stores.commission.read", "stores.commission.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    if (status && !["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from stores s
       where s.city_id = $1::uuid
         and ($2::text is null or s.status = $2::store_status)
         and ($2::text is not null or s.status <> 'ARCHIVED')
         and ($3::text is null or s.name ilike ('%' || $3 || '%'))`,
      [cityId, status, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select s.id::text, s.name, s.status::text, c.name_ar as city_name_ar,
              s.platform_commission_rate, s.updated_at,
              h.changed_at as last_commission_changed_at,
              e.email_normalized as last_changed_by_email
       from stores s
       join cities c on c.id = s.city_id
       left join lateral (
         select changed_at, changed_by_account_id
         from store_commission_rate_history
         where store_id = s.id and city_id = s.city_id
         order by changed_at desc, id desc limit 1
       ) h on true
       left join account_emails e on e.account_id = h.changed_by_account_id and e.is_primary = true
       where s.city_id = $1::uuid
         and ($2::text is null or s.status = $2::store_status)
         and ($2::text is not null or s.status <> 'ARCHIVED')
         and ($3::text is null or s.name ilike ('%' || $3 || '%'))
       order by s.display_order asc, s.created_at asc, s.id asc`,
      [cityId, status, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "store-commissions", rows.length, requestId);
    return this.file("store-commissions.xlsx", "نسب الاستقطاع", [
      { key: "storeId", header: "معرف المتجر", type: "text", width: 38 },
      { key: "storeName", header: "اسم المتجر", type: "text", width: 24 },
      { key: "city", header: "المدينة", type: "text", width: 18 },
      { key: "status", header: "حالة المتجر", type: "text" },
      { key: "rate", header: "نسبة الاستقطاع", type: "percent", width: 16 },
      { key: "lastChangedAt", header: "آخر تغيير", type: "datetime", width: 24 },
      { key: "lastChangedBy", header: "الجهة المنفذة", type: "text", width: 28 },
      { key: "updatedAt", header: "تحديث السجل", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      storeId: text(row.id), storeName: text(row.name), city: text(row.city_name_ar),
      status: text(row.status), rate: int(row.platform_commission_rate),
      lastChangedAt: iso(row.last_commission_changed_at),
      lastChangedBy: text(row.last_changed_by_email),
      updatedAt: iso(row.updated_at),
    })));
  }

  async storeCommissionHistory(
    identity: AuthIdentity,
    query: { storeId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "stores.commission.read", "stores.commission.export",
    );
    const storeId = query.storeId?.trim() || null;
    if (storeId) {
      const [store] = await this.client<{ id: string }[]>`
        select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
      if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    }
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from store_commission_rate_history
      where city_id = ${cityId} and (${storeId}::uuid is null or store_id = ${storeId})`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select h.id::text, s.name as store_name, h.previous_rate, h.new_rate, h.reason,
             e.email_normalized as changed_by_email, h.changed_at
      from store_commission_rate_history h
      join stores s on s.id = h.store_id and s.city_id = h.city_id
      left join account_emails e on e.account_id = h.changed_by_account_id and e.is_primary = true
      where h.city_id = ${cityId} and (${storeId}::uuid is null or h.store_id = ${storeId})
      order by h.changed_at desc, h.id desc`;
    await this.audit(identity, "store-commission-history", rows.length, requestId);
    return this.file("store-commission-history.xlsx", "تاريخ النسب", [
      { key: "storeName", header: "المتجر", type: "text", width: 24 },
      { key: "previousRate", header: "النسبة السابقة", type: "percent", width: 16 },
      { key: "newRate", header: "النسبة الجديدة", type: "percent", width: 16 },
      { key: "reason", header: "السبب", type: "text", width: 36 },
      { key: "changedBy", header: "الحساب المنفذ", type: "text", width: 28 },
      { key: "changedAt", header: "وقت التغيير", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      storeName: text(row.store_name), previousRate: int(row.previous_rate),
      newRate: int(row.new_rate), reason: text(row.reason),
      changedBy: text(row.changed_by_email), changedAt: iso(row.changed_at),
    })));
  }

  async mainCategories(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "main_categories.read", "main_categories.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from main_categories c
       where c.city_id = $1::uuid
         and ($2::text is null or c.status = $2::main_category_status)
         and ($2::text is not null or c.status <> 'ARCHIVED')
         and ($3::text is null or c.name ilike ('%' || $3 || '%'))`,
      [cityId, status, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select c.id::text, c.name, c.status::text, c.display_order, c.created_at, c.updated_at
       from main_categories c
       where c.city_id = $1::uuid
         and ($2::text is null or c.status = $2::main_category_status)
         and ($2::text is not null or c.status <> 'ARCHIVED')
         and ($3::text is null or c.name ilike ('%' || $3 || '%'))
       order by c.display_order asc, c.created_at asc, c.id asc`,
      [cityId, status, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "main-categories", rows.length, requestId);
    return this.file("main-categories.xlsx", "التصنيفات الرئيسية", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), status: text(row.status),
      displayOrder: int(row.display_order), createdAt: iso(row.created_at),
    })));
  }

  async subcategories(
    identity: AuthIdentity,
    query: { search?: string; status?: string; mainCategoryId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "subcategories.read", "subcategories.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    const mainCategoryId = query.mainCategoryId?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    if (mainCategoryId) {
      const [parent] = await this.client<{ id: string }[]>`
        select id::text from main_categories where id = ${mainCategoryId} and city_id = ${cityId}`;
      if (!parent) throw new AppError(404, "MAIN_CATEGORY_NOT_FOUND", "Main category not found");
    }
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from subcategories s
       where s.city_id = $1::uuid
         and ($2::uuid is null or s.main_category_id = $2::uuid)
         and ($3::text is null or s.status = $3::main_category_status)
         and ($3::text is not null or s.status <> 'ARCHIVED')
         and ($4::text is null or s.name ilike ('%' || $4 || '%'))`,
      [cityId, mainCategoryId, status, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select s.id::text, s.name, s.status::text, s.display_order, mc.name as main_category_name, s.created_at
       from subcategories s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       where s.city_id = $1::uuid
         and ($2::uuid is null or s.main_category_id = $2::uuid)
         and ($3::text is null or s.status = $3::main_category_status)
         and ($3::text is not null or s.status <> 'ARCHIVED')
         and ($4::text is null or s.name ilike ('%' || $4 || '%'))
       order by s.main_category_id asc, s.display_order asc, s.created_at asc, s.id asc`,
      [cityId, mainCategoryId, status, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "subcategories", rows.length, requestId);
    return this.file("subcategories.xlsx", "التصنيفات الفرعية", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "mainCategory", header: "التصنيف الرئيسي", type: "text", width: 20 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), mainCategory: text(row.main_category_name),
      status: text(row.status), displayOrder: int(row.display_order), createdAt: iso(row.created_at),
    })));
  }

  async storeCategories(
    identity: AuthIdentity,
    storeId: string,
    query: { status?: string; parentCategoryId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "store_categories.read", "store_categories.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const parentFilter =
      query.parentCategoryId === undefined
        ? null
        : query.parentCategoryId === "null" || query.parentCategoryId === ""
          ? "ROOT"
          : query.parentCategoryId;
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from store_categories c
       where c.store_id = $1::uuid and c.city_id = $2::uuid
         and ($3::text is null or c.status = $3::main_category_status)
         and ($3::text is not null or c.status <> 'ARCHIVED')
         and ($4::text is null or ($4::text = 'ROOT' and c.parent_category_id is null) or c.parent_category_id = $4::uuid)`,
      [storeId, cityId, status, parentFilter],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select c.id::text, c.name, c.status::text, c.display_order, c.parent_category_id::text, c.created_at
       from store_categories c
       where c.store_id = $1::uuid and c.city_id = $2::uuid
         and ($3::text is null or c.status = $3::main_category_status)
         and ($3::text is not null or c.status <> 'ARCHIVED')
         and ($4::text is null or ($4::text = 'ROOT' and c.parent_category_id is null) or c.parent_category_id = $4::uuid)
       order by c.display_order asc, c.created_at asc, c.id asc`,
      [storeId, cityId, status, parentFilter],
    )) as Record<string, unknown>[];
    await this.audit(identity, "store-categories", rows.length, requestId);
    return this.file("store-categories.xlsx", "تصنيفات المتجر", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "parentId", header: "التصنيف الأب", type: "text", width: 38 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), parentId: text(row.parent_category_id),
      status: text(row.status), displayOrder: int(row.display_order), createdAt: iso(row.created_at),
    })));
  }

  async products(
    identity: AuthIdentity,
    storeId: string,
    query: { status?: string; categoryId?: string; search?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "products.read", "products.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const categoryId =
      query.categoryId === undefined || query.categoryId === ""
        ? null
        : query.categoryId === "null"
          ? "NULL"
          : query.categoryId;
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from products p
       where p.store_id = $1::uuid and p.city_id = $2::uuid
         and ($3::text is null or p.status = $3::product_status)
         and ($3::text is not null or p.status <> 'ARCHIVED')
         and ($4::text is null or ($4::text = 'NULL' and p.category_id is null) or p.category_id = $4::uuid)
         and ($5::text is null or p.name ilike ('%' || $5 || '%'))`,
      [storeId, cityId, status, categoryId, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select p.id::text, p.name, p.status::text, p.base_price, p.display_order, p.created_at
       from products p
       where p.store_id = $1::uuid and p.city_id = $2::uuid
         and ($3::text is null or p.status = $3::product_status)
         and ($3::text is not null or p.status <> 'ARCHIVED')
         and ($4::text is null or ($4::text = 'NULL' and p.category_id is null) or p.category_id = $4::uuid)
         and ($5::text is null or p.name ilike ('%' || $5 || '%'))
       order by p.display_order asc, p.created_at asc, p.id asc`,
      [storeId, cityId, status, categoryId, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "products", rows.length, requestId);
    return this.file("products.xlsx", "المنتجات", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "basePrice", header: "السعر (د.ع)", type: "integer", width: 14 },
      { key: "displayOrder", header: "الترتيب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), status: text(row.status),
      basePrice: int(row.base_price), displayOrder: int(row.display_order), createdAt: iso(row.created_at),
    })));
  }

  async modifierGroups(
    identity: AuthIdentity,
    storeId: string,
    query: { status?: string; search?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "modifiers.read", "modifiers.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from modifier_groups g
       where g.store_id = $1::uuid and g.city_id = $2::uuid
         and ($3::text is null or g.status = $3::product_status)
         and ($3::text is not null or g.status <> 'ARCHIVED')
         and ($4::text is null or g.name ilike ('%' || $4 || '%'))`,
      [storeId, cityId, status, search],
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select g.id::text, g.name, g.status::text, g.min_select, g.max_select, g.created_at
       from modifier_groups g
       where g.store_id = $1::uuid and g.city_id = $2::uuid
         and ($3::text is null or g.status = $3::product_status)
         and ($3::text is not null or g.status <> 'ARCHIVED')
         and ($4::text is null or g.name ilike ('%' || $4 || '%'))
       order by g.created_at asc, g.id asc`,
      [storeId, cityId, status, search],
    )) as Record<string, unknown>[];
    await this.audit(identity, "modifiers", rows.length, requestId);
    return this.file("modifier-groups.xlsx", "المعدّلات", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "name", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "minSelect", header: "الحد الأدنى", type: "integer" },
      { key: "maxSelect", header: "الحد الأقصى", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), name: text(row.name), status: text(row.status),
      minSelect: int(row.min_select), maxSelect: int(row.max_select), createdAt: iso(row.created_at),
    })));
  }

  async merchants(
    identity: AuthIdentity,
    query: { status?: string; storeId?: string; search?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "merchants.read", "merchants.export",
    );
    const status = query.status?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "SUSPENDED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const storeId = query.storeId && query.storeId !== "null" ? query.storeId : null;
    const search = query.search?.trim() || null;
    const rows = (await this.client.unsafe(
      `select distinct on (m.account_id)
         a.id::text as account_id, ph.phone_e164, m.display_name, m.status::text as merchant_status,
         s.name as store_name, m.created_at, m.updated_at
       from merchant_profiles m
       join accounts a on a.id = m.account_id
       join stores s on s.id = m.store_id and s.city_id = m.city_id
       join account_phones ph on ph.account_id = a.id and ph.verified_at is not null
       where m.city_id = $1::uuid
         and ($2::text is null or m.status = $2::merchant_profile_status)
         and ($3::uuid is null or m.store_id = $3::uuid)
         and ($4::text is null or ph.phone_e164 ilike ('%' || $4 || '%') or coalesce(m.display_name, '') ilike ('%' || $4 || '%'))
       order by m.account_id, ph.is_primary desc, ph.created_at asc`,
      [cityId, status, storeId, search],
    )) as Record<string, unknown>[];
    rows.sort((a, b) => {
      const ac = String(a.created_at);
      const bc = String(b.created_at);
      if (ac !== bc) return ac < bc ? -1 : 1;
      return String(a.account_id) < String(b.account_id) ? -1 : 1;
    });
    this.assertLimit(rows.length);
    await this.audit(identity, "merchants", rows.length, requestId);
    return this.file("merchants.xlsx", "التجار", [
      { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
      { key: "phone", header: "الهاتف", type: "text", width: 16 },
      { key: "displayName", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "storeName", header: "المتجر", type: "text", width: 24 },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      accountId: text(row.account_id), phone: text(row.phone_e164),
      displayName: text(row.display_name), status: text(row.merchant_status),
      storeName: text(row.store_name), createdAt: iso(row.created_at),
    })));
  }

  async orders(identity: AuthIdentity, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.export",
    );
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from orders where city_id = ${cityId}`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select o.id::text, o.order_number, s.name as store_name, o.status::text,
             o.payment_method::text, o.payment_status::text, o.products_subtotal,
             o.delivery_fee, o.total, o.store_commission_rate_snapshot, o.created_at
      from orders o join stores s on s.id = o.store_id
      where o.city_id = ${cityId}
      order by o.created_at desc, o.id desc`;
    await this.audit(identity, "orders", rows.length, requestId);
    return this.file("orders.xlsx", "الطلبات", [
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "storeName", header: "المتجر", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text", width: 22 },
      { key: "paymentMethod", header: "طريقة الدفع", type: "text", width: 14 },
      { key: "paymentStatus", header: "حالة الدفع", type: "text", width: 16 },
      { key: "productsSubtotal", header: "مجموع المنتجات (د.ع)", type: "integer", width: 18 },
      { key: "deliveryFee", header: "أجرة التوصيل (د.ع)", type: "integer", width: 18 },
      { key: "total", header: "الإجمالي (د.ع)", type: "integer", width: 16 },
      { key: "commissionRate", header: "نسبة الاستقطاع", type: "percent", width: 16 },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      orderNumber: text(row.order_number), storeName: text(row.store_name),
      status: text(row.status), paymentMethod: text(row.payment_method),
      paymentStatus: text(row.payment_status), productsSubtotal: int(row.products_subtotal),
      deliveryFee: int(row.delivery_fee), total: int(row.total),
      commissionRate: int(row.store_commission_rate_snapshot), createdAt: iso(row.created_at),
    })));
  }

  async orderEvents(identity: AuthIdentity, query: { orderId?: string }, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.events.export",
    );
    const orderId = query.orderId?.trim() || null;
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_events e
      join orders o on o.id = e.order_id
      where o.city_id = ${cityId} and (${orderId}::uuid is null or e.order_id = ${orderId})`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select e.id::text, o.order_number, e.event_type::text, e.actor_type::text,
             e.source::text, e.reason, e.created_at
      from order_events e join orders o on o.id = e.order_id
      where o.city_id = ${cityId} and (${orderId}::uuid is null or e.order_id = ${orderId})
      order by e.created_at desc, e.id desc`;
    await this.audit(identity, "order-events", rows.length, requestId);
    return this.file("order-events.xlsx", "أحداث الطلبات", [
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "eventType", header: "نوع الحدث", type: "text", width: 28 },
      { key: "actorType", header: "المنفذ", type: "text" },
      { key: "source", header: "المصدر", type: "text", width: 18 },
      { key: "reason", header: "السبب", type: "text", width: 32 },
      { key: "createdAt", header: "الوقت", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      orderNumber: text(row.order_number), eventType: text(row.event_type),
      actorType: text(row.actor_type), source: text(row.source),
      reason: text(row.reason), createdAt: iso(row.created_at),
    })));
  }

  async orderAssignments(identity: AuthIdentity, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.assignments.export",
    );
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_driver_assignments a
      join orders o on o.id = a.order_id where o.city_id = ${cityId}`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select a.id::text, o.order_number, a.driver_id::text, a.status::text,
             a.assignment_sequence, a.assigned_at, a.completed_at, a.cancelled_at
      from order_driver_assignments a
      join orders o on o.id = a.order_id
      where o.city_id = ${cityId}
      order by a.assigned_at desc, a.id desc`;
    await this.audit(identity, "order-assignments", rows.length, requestId);
    return this.file("order-assignments.xlsx", "التعيينات", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "driverId", header: "السائق", type: "text", width: 38 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "sequence", header: "التسلسل", type: "integer" },
      { key: "assignedAt", header: "وقت التعيين", type: "datetime", width: 24 },
      { key: "completedAt", header: "وقت الإكمال", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), orderNumber: text(row.order_number), driverId: text(row.driver_id),
      status: text(row.status), sequence: int(row.assignment_sequence),
      assignedAt: iso(row.assigned_at), completedAt: iso(row.completed_at),
    })));
  }

  async orderOfferRounds(
    identity: AuthIdentity,
    query: { orderId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "order_offers.read", "order_offers.export",
    );
    const orderId = query.orderId?.trim() || null;
    if (orderId) {
      const [order] = await this.client<{ id: string }[]>`
        select id::text from orders where id = ${orderId} and city_id = ${cityId}`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    }
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_offer_rounds
      where city_id = ${cityId} and (${orderId}::uuid is null or order_id = ${orderId})`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select r.id::text, o.order_number, r.status::text, r.opened_at, r.closed_at, r.final_driver_fee
      from order_offer_rounds r join orders o on o.id = r.order_id
      where r.city_id = ${cityId} and (${orderId}::uuid is null or r.order_id = ${orderId})
      order by r.opened_at desc, r.id desc`;
    await this.audit(identity, "order-offer-rounds", rows.length, requestId);
    return this.file("order-offer-rounds.xlsx", "جولات العروض", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "finalDriverFee", header: "أجرة السائق (د.ع)", type: "integer", width: 18 },
      { key: "openedAt", header: "وقت الفتح", type: "datetime", width: 24 },
      { key: "closedAt", header: "وقت الإغلاق", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), orderNumber: text(row.order_number), status: text(row.status),
      finalDriverFee: int(row.final_driver_fee), openedAt: iso(row.opened_at), closedAt: iso(row.closed_at),
    })));
  }

  async orderHandoffs(identity: AuthIdentity, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.handoffs.export",
    );
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_driver_handoffs h
      join orders o on o.id = h.order_id where o.city_id = ${cityId}`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select h.id::text, o.order_number, h.status::text, h.from_driver_id::text,
             h.to_driver_id::text, h.created_at, h.completed_at
      from order_driver_handoffs h join orders o on o.id = h.order_id
      where o.city_id = ${cityId}
      order by h.created_at desc, h.id desc`;
    await this.audit(identity, "order-handoffs", rows.length, requestId);
    return this.file("order-handoffs.xlsx", "تسليم السائقين", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "fromDriverId", header: "من سائق", type: "text", width: 38 },
      { key: "toDriverId", header: "إلى سائق", type: "text", width: 38 },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "completedAt", header: "وقت الإكمال", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), orderNumber: text(row.order_number), status: text(row.status),
      fromDriverId: text(row.from_driver_id), toDriverId: text(row.to_driver_id),
      createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
    })));
  }

  async orderReturns(identity: AuthIdentity, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.returns.export",
    );
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_return_workflows w
      join orders o on o.id = w.order_id where o.city_id = ${cityId}`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select w.id::text, o.order_number, w.status::text, w.created_at, w.completed_at
      from order_return_workflows w join orders o on o.id = w.order_id
      where o.city_id = ${cityId}
      order by w.created_at desc, w.id desc`;
    await this.audit(identity, "order-returns", rows.length, requestId);
    return this.file("order-returns.xlsx", "الإرجاع", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "completedAt", header: "وقت الإكمال", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), orderNumber: text(row.order_number), status: text(row.status),
      createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
    })));
  }

  async orderCollections(identity: AuthIdentity, requestId: string) {
    const cityId = await requireCityReadAndExport(
      this.client, identity, "orders.read", "orders.collections.export",
    );
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int total from order_collections c
      join orders o on o.id = c.order_id where o.city_id = ${cityId}`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select c.id::text, o.order_number, c.collecting_driver_id::text,
             c.expected_amount, c.collected_amount, c.difference_amount, c.collected_at
      from order_collections c join orders o on o.id = c.order_id
      where o.city_id = ${cityId}
      order by c.collected_at desc, c.id desc`;
    await this.audit(identity, "order-collections", rows.length, requestId);
    return this.file("order-collections.xlsx", "التحصيلات", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
      { key: "driverId", header: "السائق", type: "text", width: 38 },
      { key: "expectedAmount", header: "المبلغ المتوقع (د.ع)", type: "integer", width: 18 },
      { key: "collectedAmount", header: "المبلغ المحصّل (د.ع)", type: "integer", width: 18 },
      { key: "differenceAmount", header: "الفرق (د.ع)", type: "integer", width: 14 },
      { key: "collectedAt", header: "وقت التحصيل", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), orderNumber: text(row.order_number), driverId: text(row.collecting_driver_id),
      expectedAmount: int(row.expected_amount), collectedAmount: int(row.collected_amount),
      differenceAmount: int(row.difference_amount), collectedAt: iso(row.collected_at),
    })));
  }

  async drivers(identity: AuthIdentity, requestId: string) {
    await requireCityPermission(this.client, identity, "orders.assign");
    const cityId = await requireCityPermission(this.client, identity, "drivers.export");
    const [count] = await this.client<{ total: number }[]>`
      select count(*)::int as total
      from driver_profiles dp join accounts a on a.id = dp.account_id
      where dp.city_id = ${cityId}
        and dp.approval_status = 'APPROVED'
        and dp.operational_status = 'ACTIVE'
        and a.status = 'ACTIVE'`;
    this.assertLimit(count?.total ?? 0);
    const rows = await this.client<Record<string, unknown>[]>`
      select dp.account_id::text, dp.approval_status::text, dp.operational_status::text,
             coalesce((select ap.phone_e164 from account_phones ap
                       where ap.account_id = dp.account_id and ap.is_primary = true limit 1), '') as phone
      from driver_profiles dp join accounts a on a.id = dp.account_id
      where dp.city_id = ${cityId}
        and dp.approval_status = 'APPROVED'
        and dp.operational_status = 'ACTIVE'
        and a.status = 'ACTIVE'
      order by dp.account_id asc`;
    await this.audit(identity, "drivers", rows.length, requestId);
    return this.file("drivers.xlsx", "السائقون", [
      { key: "driverId", header: "معرف السائق", type: "text", width: 38 },
      { key: "phone", header: "الهاتف", type: "text", width: 16 },
      { key: "approvalStatus", header: "حالة الاعتماد", type: "text", width: 16 },
      { key: "operationalStatus", header: "الحالة التشغيلية", type: "text", width: 16 },
    ], rows.map((row) => ({
      driverId: text(row.account_id), phone: text(row.phone),
      approvalStatus: text(row.approval_status), operationalStatus: text(row.operational_status),
    })));
  }

  async employees(identity: AuthIdentity, requestId: string) {
    requireCityAdmin(identity);
    const cityId = await requireCityPermission(this.client, identity, "staff.export");
    const rows = await this.client<Record<string, unknown>[]>`
      select a.id::text as account_id, e.email_normalized, sp.display_name,
             sp.status::text as staff_status, sp.created_at
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where sp.managed_by_account_id = ${identity.accountId}
        and s.scope_reference_id = ${cityId}
      order by e.email_normalized asc, a.id asc`;
    this.assertLimit(rows.length);
    await this.audit(identity, "employees", rows.length, requestId);
    return this.file("employees.xlsx", "الموظفون", [
      { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
      { key: "email", header: "البريد", type: "text", width: 28 },
      { key: "displayName", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      accountId: text(row.account_id), email: text(row.email_normalized),
      displayName: text(row.display_name), status: text(row.staff_status),
      createdAt: iso(row.created_at),
    })));
  }

  async admins(identity: AuthIdentity, requestId: string) {
    requireSuperAdmin(identity);
    const rows = await this.client<Record<string, unknown>[]>`
      select a.id::text as account_id, e.email_normalized, sp.display_name,
             sp.status::text as staff_status, s.scope_reference_id::text as city_id, sp.created_at
      from staff_profiles sp
      join accounts a on a.id = sp.account_id
      join account_emails e on e.account_id = a.id and e.is_primary = true
      join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
      join roles r on r.id = ar.role_id and r.code = 'ADMIN'
      join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
      where sp.managed_by_account_id is null
      order by e.email_normalized asc, a.id asc`;
    this.assertLimit(rows.length);
    await this.audit(identity, "admins", rows.length, requestId);
    return this.file("admins.xlsx", "مديرو المدن", [
      { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
      { key: "email", header: "البريد", type: "text", width: 28 },
      { key: "displayName", header: "الاسم", type: "text", width: 24 },
      { key: "status", header: "الحالة", type: "text" },
      { key: "cityId", header: "المدينة", type: "text", width: 38 },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      accountId: text(row.account_id), email: text(row.email_normalized),
      displayName: text(row.display_name), status: text(row.staff_status),
      cityId: text(row.city_id), createdAt: iso(row.created_at),
    })));
  }

  async deliveryPricingVersions(
    identity: AuthIdentity,
    cityId: string,
    requestId: string,
  ) {
    requireSuperAdmin(identity);
    const rows = await this.client<Record<string, unknown>[]>`
      select id::text, version, status::text, base_fee, included_distance_meters,
             price_per_km, rounding_step, created_at, activated_at
      from city_delivery_pricing_versions
      where city_id = ${cityId}
      order by version desc`;
    this.assertLimit(rows.length);
    await this.audit(identity, "delivery-pricing-versions", rows.length, requestId);
    return this.file("delivery-pricing-versions.xlsx", "تسعير التوصيل", [
      { key: "id", header: "المعرف", type: "text", width: 38 },
      { key: "version", header: "الإصدار", type: "integer" },
      { key: "status", header: "الحالة", type: "text" },
      { key: "baseFee", header: "الأجرة الأساسية (د.ع)", type: "integer", width: 18 },
      { key: "includedDistance", header: "المسافة المشمولة (م)", type: "integer", width: 18 },
      { key: "pricePerKm", header: "سعر الكيلومتر (د.ع)", type: "integer", width: 18 },
      { key: "roundingStep", header: "خطوة التقريب", type: "integer" },
      { key: "createdAt", header: "تاريخ الإنشاء", type: "datetime", width: 24 },
      { key: "activatedAt", header: "تاريخ التفعيل", type: "datetime", width: 24 },
    ], rows.map((row) => ({
      id: text(row.id), version: int(row.version), status: text(row.status),
      baseFee: int(row.base_fee), includedDistance: int(row.included_distance_meters),
      pricePerKm: int(row.price_per_km), roundingStep: int(row.rounding_step),
      createdAt: iso(row.created_at), activatedAt: iso(row.activated_at),
    })));
  }
}
