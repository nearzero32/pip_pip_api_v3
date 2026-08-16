import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  requireCityAdmin,
  requireCityPermission,
  requireCityReadAndExport,
  requireSuperAdminExport,
} from "../auth/staff/authorization";
import {
  likeContains,
  parseAllowlistedSort,
  parseOptionalAllowlisted,
  parseOptionalDateRange,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
  dashboardPageOf,
  dashboardListResult,
} from "../dashboard-lists/query";

const STAFF_PROFILE_STATUSES = [
  "INVITED",
  "ACTIVE",
  "DISABLED",
  "CLOSED",
] as const;
const MERCHANT_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
import {
  ASSIGNMENT_LIST_WHERE_SQL,
  assignmentListParams,
  COLLECTION_LIST_WHERE_SQL,
  collectionListParams,
  EVENT_LIST_WHERE_SQL,
  eventListParams,
  HANDOFF_LIST_WHERE_SQL,
  handoffListParams,
  OFFER_ROUND_LIST_WHERE_SQL,
  offerRoundListParams,
  opsPublicFilters,
  parseAssignmentListQuery,
  parseCollectionListQuery,
  parseEventListQuery,
  parseHandoffListQuery,
  parseOfferRoundListQuery,
  parseReturnListQuery,
  RETURN_LIST_WHERE_SQL,
  returnListParams,
  type OpsListInput,
} from "../dashboard-lists/ops-list-query";
import {
  DELIVERY_PRICING_LIST_WHERE_SQL,
  deliveryPricingListParams,
  parseCandidateListQuery,
  parseDeliveryPricingListQuery,
  parseProductListQuery,
  parseStoreCategoryListQuery,
  PRODUCT_LIST_WHERE_SQL,
  productListParams,
  STORE_CATEGORY_LIST_WHERE_SQL,
  storeCategoryListParams,
} from "../dashboard-lists/product-list-query";
import {
  parseOrderListQuery,
  ORDER_LIST_WHERE_SQL,
  orderListParams,
  orderListPublicFilters,
  type OrderListQuery,
} from "../dashboard-lists/order-list-query";
import {
  parseStoreListQuery,
  storeListParams,
  storeListPublicFilters,
  STORE_LIST_WHERE_SQL,
  COMMISSION_STORE_WHERE_SQL,
  commissionStoreParams,
} from "../dashboard-lists/store-list-query";
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

  private publicFilters(filters: Record<string, unknown>) {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (value == null || value === "") {
        out[key] = null;
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        out[key] = value;
    }
    return out;
  }

  private async file(
    identity: AuthIdentity,
    meta: {
      resource: string;
      endpoint: string;
      permission: string;
      filename: string;
      filters: Record<string, unknown>;
      cityId: string | null;
    },
    sheetName: string,
    columns: ExcelColumn[],
    rows: Array<Record<string, ExcelCell>>,
    requestId: string,
  ) {
    const bytes = buildExcelWorkbook({ sheetName, columns, rows });
    const metadata = JSON.stringify({
      resource: meta.resource,
      endpoint: meta.endpoint,
      exportType: "xlsx",
      permission: meta.permission,
      filename: meta.filename,
      rowCount: rows.length,
      filters: this.publicFilters(meta.filters),
      scope: meta.cityId ? "CITY" : "GLOBAL",
      cityId: meta.cityId,
    });
    await this.client.unsafe(
      `insert into audit_logs (
         event_type, actor_account_id, actor_session_id, target_type, outcome,
         request_correlation_id, redacted_metadata
       ) values (
         'DASHBOARD_EXPORT', $1::uuid, $2::uuid, $3, 'SUCCESS', $4, $5::text::jsonb
       )`,
      [
        identity.accountId,
        identity.sessionId,
        meta.resource,
        requestId,
        metadata,
      ],
    );
    return excelFileResponse(meta.filename, bytes);
  }

  async governorates(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    await requireSuperAdminExport(this.client, identity, "governorates.export");
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
    return this.file(
      identity,
      {
        resource: "governorates",
        endpoint: "/api/v1/dashboard/governorates/export",
        permission: "governorates.export",
        filename: "governorates.xlsx",
        filters: { search, status },
        cityId: null,
      },
      "المحافظات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "nameAr", header: "الاسم العربي", type: "text", width: 24 },
        { key: "nameEn", header: "الاسم الإنجليزي", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "updatedAt",
          header: "تاريخ التحديث",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        nameAr: text(row.name_ar),
        nameEn: text(row.name_en),
        status: text(row.status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      requestId,
    );
  }

  async cities(
    identity: AuthIdentity,
    query: { governorateId?: string; search?: string; status?: string },
    requestId: string,
  ) {
    await requireSuperAdminExport(this.client, identity, "cities.export");
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
    return this.file(
      identity,
      {
        resource: "cities",
        endpoint: "/api/v1/dashboard/cities/export",
        permission: "cities.export",
        filename: "cities.xlsx",
        filters: { search, status, governorateId },
        cityId: null,
      },
      "المدن",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "nameAr", header: "الاسم العربي", type: "text", width: 24 },
        { key: "nameEn", header: "الاسم الإنجليزي", type: "text", width: 24 },
        { key: "governorate", header: "المحافظة", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "updatedAt",
          header: "تاريخ التحديث",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        nameAr: text(row.name_ar),
        nameEn: text(row.name_en),
        governorate: text(row.governorate_name_ar),
        status: text(row.status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      requestId,
    );
  }

  async zones(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "zones.read",
      "zones.export",
    );
    const search = query.search?.trim() || null;
    const status = parseOptionalAllowlisted(
      query.status,
      ["ACTIVE", "INACTIVE", "ARCHIVED"] as const,
      "status",
    );
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
    return this.file(
      identity,
      {
        resource: "zones",
        endpoint: "/api/v1/dashboard/zones/export",
        permission: "zones.export",
        filename: "zones.xlsx",
        filters: { search, status },
        cityId: cityId,
      },
      "المناطق",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "updatedAt",
          header: "تاريخ التحديث",
          type: "datetime",
          width: 24,
        },
        {
          key: "archivedAt",
          header: "تاريخ الأرشفة",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        status: text(row.status),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        archivedAt: iso(row.archived_at),
      })),
      requestId,
    );
  }

  async stores(
    identity: AuthIdentity,
    query: Record<string, string | undefined>,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "stores.read",
      "stores.export",
    );
    const filters = parseStoreListQuery(query);
    const params = storeListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from stores s
       where ${STORE_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select s.id::text, s.name, s.phone, s.address, s.status::text,
              s.order_acceptance_status::text, s.display_order, mc.name as main_category_name,
              s.created_at, s.updated_at, s.archived_at
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       where ${STORE_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "stores",
        endpoint: "/api/v1/dashboard/stores/export",
        permission: "stores.export",
        filename: "stores.xlsx",
        filters: storeListPublicFilters(filters),
        cityId: cityId,
      },
      "المتاجر",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "phone", header: "الهاتف", type: "text", width: 16 },
        { key: "address", header: "العنوان", type: "text", width: 32 },
        {
          key: "mainCategory",
          header: "التصنيف الرئيسي",
          type: "text",
          width: 20,
        },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "orderAcceptance",
          header: "قبول الطلبات",
          type: "text",
          width: 16,
        },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "updatedAt",
          header: "تاريخ التحديث",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        phone: text(row.phone),
        address: text(row.address),
        mainCategory: text(row.main_category_name),
        status: text(row.status),
        orderAcceptance: text(row.order_acceptance_status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      })),
      requestId,
    );
  }

  async storeCommissions(
    identity: AuthIdentity,
    query: Record<string, string | undefined>,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "stores.commission.read",
      "stores.commission.export",
    );
    const filters = parseStoreListQuery(query);
    const params = commissionStoreParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from stores s
       where ${COMMISSION_STORE_WHERE_SQL}`,
      params,
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
       where ${COMMISSION_STORE_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "store-commissions",
        endpoint: "/api/v1/dashboard/store-commissions/export",
        permission: "stores.commission.export",
        filename: "store-commissions.xlsx",
        filters: storeListPublicFilters(filters),
        cityId: cityId,
      },
      "نسب الاستقطاع",
      [
        { key: "storeId", header: "معرف المتجر", type: "text", width: 38 },
        { key: "storeName", header: "اسم المتجر", type: "text", width: 24 },
        { key: "city", header: "المدينة", type: "text", width: 18 },
        { key: "status", header: "حالة المتجر", type: "text" },
        { key: "rate", header: "نسبة الاستقطاع", type: "percent", width: 16 },
        {
          key: "lastChangedAt",
          header: "آخر تغيير",
          type: "datetime",
          width: 24,
        },
        {
          key: "lastChangedBy",
          header: "الجهة المنفذة",
          type: "text",
          width: 28,
        },
        {
          key: "updatedAt",
          header: "تحديث السجل",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        storeId: text(row.id),
        storeName: text(row.name),
        city: text(row.city_name_ar),
        status: text(row.status),
        rate: int(row.platform_commission_rate),
        lastChangedAt: iso(row.last_commission_changed_at),
        lastChangedBy: text(row.last_changed_by_email),
        updatedAt: iso(row.updated_at),
      })),
      requestId,
    );
  }

  async storeCommissionHistory(
    identity: AuthIdentity,
    query: { storeId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "stores.commission.read",
      "stores.commission.history.export",
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
    return this.file(
      identity,
      {
        resource: "store-commission-history",
        endpoint: "/api/v1/dashboard/store-commission-history/export",
        permission: "stores.commission.history.export",
        filename: "store-commission-history.xlsx",
        filters: { storeId },
        cityId: cityId,
      },
      "تاريخ النسب",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "storeName", header: "المتجر", type: "text", width: 24 },
        {
          key: "previousRate",
          header: "النسبة السابقة",
          type: "percent",
          width: 16,
        },
        {
          key: "newRate",
          header: "النسبة الجديدة",
          type: "percent",
          width: 16,
        },
        { key: "reason", header: "السبب", type: "text", width: 36 },
        { key: "changedBy", header: "الحساب المنفذ", type: "text", width: 28 },
        {
          key: "changedAt",
          header: "وقت التغيير",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        storeName: text(row.store_name),
        previousRate: int(row.previous_rate),
        newRate: int(row.new_rate),
        reason: text(row.reason),
        changedBy: text(row.changed_by_email),
        changedAt: iso(row.changed_at),
      })),
      requestId,
    );
  }

  async mainCategories(
    identity: AuthIdentity,
    query: { search?: string; status?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "main_categories.read",
      "main_categories.export",
    );
    const search = query.search?.trim() || null;
    const status = parseOptionalAllowlisted(
      query.status,
      ["ACTIVE", "INACTIVE", "ARCHIVED"] as const,
      "status",
    );
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
    return this.file(
      identity,
      {
        resource: "main-categories",
        endpoint: "/api/v1/dashboard/main-categories/export",
        permission: "main_categories.export",
        filename: "main-categories.xlsx",
        filters: { search, status },
        cityId: cityId,
      },
      "التصنيفات الرئيسية",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        status: text(row.status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async subcategories(
    identity: AuthIdentity,
    query: { search?: string; status?: string; mainCategoryId?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "subcategories.read",
      "subcategories.export",
    );
    const search = query.search?.trim() || null;
    const status = query.status?.trim() || null;
    const mainCategoryId = query.mainCategoryId?.trim() || null;
    if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    if (mainCategoryId) {
      const [parent] = await this.client<{ id: string }[]>`
        select id::text from main_categories where id = ${mainCategoryId} and city_id = ${cityId}`;
      if (!parent)
        throw new AppError(
          404,
          "MAIN_CATEGORY_NOT_FOUND",
          "Main category not found",
        );
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
    return this.file(
      identity,
      {
        resource: "subcategories",
        endpoint: "/api/v1/dashboard/subcategories/export",
        permission: "subcategories.export",
        filename: "subcategories.xlsx",
        filters: { search, status, mainCategoryId },
        cityId: cityId,
      },
      "التصنيفات الفرعية",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        {
          key: "mainCategory",
          header: "التصنيف الرئيسي",
          type: "text",
          width: 20,
        },
        { key: "status", header: "الحالة", type: "text" },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        mainCategory: text(row.main_category_name),
        status: text(row.status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async storeCategories(
    identity: AuthIdentity,
    storeId: string,
    query: Record<string, string | undefined>,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "store_categories.read",
      "store_categories.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const filters = parseStoreCategoryListQuery(query);
    const params = storeCategoryListParams(storeId, cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from store_categories c where ${STORE_CATEGORY_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select c.id::text, c.name, c.status::text, c.display_order, c.parent_category_id::text, c.created_at
       from store_categories c
       left join store_categories p
         on p.id = c.parent_category_id and p.store_id = c.store_id
       where ${STORE_CATEGORY_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "store-categories",
        endpoint: "/api/v1/dashboard/stores/:storeId/categories/export",
        permission: "store_categories.export",
        filename: "store-categories.xlsx",
        filters: {
          storeId,
          ...opsPublicFilters(filters as unknown as Record<string, unknown>),
        },
        cityId: cityId,
      },
      "تصنيفات المتجر",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "parentId", header: "التصنيف الأب", type: "text", width: 38 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        parentId: text(row.parent_category_id),
        status: text(row.status),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async products(
    identity: AuthIdentity,
    storeId: string,
    query: Record<string, string | undefined>,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "products.read",
      "products.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const filters = parseProductListQuery(query);
    const params = productListParams(storeId, cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from products p where ${PRODUCT_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select p.id::text, p.name, p.status::text, p.base_price, p.display_order, p.created_at
       from products p
       where ${PRODUCT_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "products",
        endpoint: "/api/v1/dashboard/stores/:storeId/products/export",
        permission: "products.export",
        filename: "products.xlsx",
        filters: {
          storeId,
          ...opsPublicFilters(filters as unknown as Record<string, unknown>),
        },
        cityId: cityId,
      },
      "المنتجات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "basePrice", header: "السعر (د.ع)", type: "integer", width: 14 },
        { key: "displayOrder", header: "الترتيب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        status: text(row.status),
        basePrice: int(row.base_price),
        displayOrder: int(row.display_order),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async modifierGroups(
    identity: AuthIdentity,
    storeId: string,
    query: { status?: string; search?: string },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "modifiers.read",
      "modifiers.export",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const search = query.search?.trim() || null;
    const status = parseOptionalAllowlisted(
      query.status,
      ["ACTIVE", "INACTIVE", "ARCHIVED"] as const,
      "status",
    );
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
    return this.file(
      identity,
      {
        resource: "modifiers",
        endpoint: "/api/v1/dashboard/stores/:storeId/modifier-groups/export",
        permission: "modifiers.export",
        filename: "modifier-groups.xlsx",
        filters: { storeId, search, status },
        cityId: cityId,
      },
      "المعدّلات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "name", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "minSelect", header: "الحد الأدنى", type: "integer" },
        { key: "maxSelect", header: "الحد الأقصى", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        name: text(row.name),
        status: text(row.status),
        minSelect: int(row.min_select),
        maxSelect: int(row.max_select),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async merchants(
    identity: AuthIdentity,
    query: {
      status?: string;
      storeId?: string;
      search?: string;
      createdFrom?: string;
      createdTo?: string;
      sortBy?: string;
      sortOrder?: string;
    },
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "merchants.read",
      "merchants.export",
    );
    const status = parseOptionalAllowlisted(
      query.status,
      MERCHANT_STATUSES,
      "status",
    );
    const storeId =
      !query.storeId?.trim() || query.storeId === "null"
        ? null
        : parseOptionalUuid(query.storeId, "storeId");
    const search = parseOptionalSearch(query.search);
    const pattern = search ? likeContains(search) : null;
    const uuid = searchUuid(search);
    const created = parseOptionalDateRange({
      from: query.createdFrom,
      to: query.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const sortBy = parseAllowlistedSort(
      query.sortBy,
      ["createdAt", "displayName", "phone"] as const,
      "createdAt",
    );
    const sortOrder = parseSortOrder(query.sortOrder, "desc");
    const orderSql = {
      createdAt: `m.created_at ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      displayName: `coalesce(m.display_name, '') ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      phone: `ph.phone_e164 ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const where = `
      m.city_id = $1::uuid
      and ($2::text is null or m.status = $2::merchant_profile_status)
      and ($3::uuid is null or m.store_id = $3::uuid)
      and ($4::timestamptz is null or m.created_at >= $4::timestamptz)
      and ($5::timestamptz is null or m.created_at < $5::timestamptz)
      and (
        $6::text is null
        or ph.phone_e164 ilike $6 escape '\\'
        or coalesce(m.display_name, '') ilike $6 escape '\\'
        or s.name ilike $6 escape '\\'
        or ($7::uuid is not null and (a.id = $7::uuid or m.store_id = $7::uuid))
      )`;
    const params = [
      cityId,
      status,
      storeId,
      created.from,
      created.to,
      pattern,
      uuid,
    ];
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total
       from merchant_profiles m
       join accounts a on a.id = m.account_id
       join stores s on s.id = m.store_id and s.city_id = m.city_id
       join lateral (
         select phone_e164 from account_phones
         where account_id = a.id and verified_at is not null
         order by is_primary desc, created_at asc
         limit 1
       ) ph on true
       where ${where}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select a.id::text as account_id, ph.phone_e164, m.display_name, m.status::text as merchant_status,
              s.name as store_name, m.created_at
       from merchant_profiles m
       join accounts a on a.id = m.account_id
       join stores s on s.id = m.store_id and s.city_id = m.city_id
       join lateral (
         select phone_e164 from account_phones
         where account_id = a.id and verified_at is not null
         order by is_primary desc, created_at asc
         limit 1
       ) ph on true
       where ${where}
       order by ${orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "merchants",
        endpoint: "/api/v1/dashboard/merchants/export",
        permission: "merchants.export",
        filename: "merchants.xlsx",
        filters: { search, status, storeId, sortBy, sortOrder },
        cityId: cityId,
      },
      "التجار",
      [
        { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
        { key: "phone", header: "الهاتف", type: "text", width: 16 },
        { key: "displayName", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "storeName", header: "المتجر", type: "text", width: 24 },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        accountId: text(row.account_id),
        phone: text(row.phone_e164),
        displayName: text(row.display_name),
        status: text(row.merchant_status),
        storeName: text(row.store_name),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async orders(
    identity: AuthIdentity,
    query: OrderListQuery,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.export",
    );
    const filters = parseOrderListQuery(query);
    const params = orderListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from orders o where ${ORDER_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select o.id::text, o.order_number, s.name as store_name, o.status::text,
             o.payment_method::text, o.payment_status::text, o.products_subtotal,
             o.delivery_fee, o.total, o.store_commission_rate_snapshot, o.created_at
      from orders o join stores s on s.id = o.store_id
      where ${ORDER_LIST_WHERE_SQL}
      order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "orders",
        endpoint: "/api/v1/dashboard/orders/export",
        permission: "orders.export",
        filename: "orders.xlsx",
        filters: orderListPublicFilters(filters),
        cityId: cityId,
      },
      "الطلبات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "storeName", header: "المتجر", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text", width: 22 },
        {
          key: "paymentMethod",
          header: "طريقة الدفع",
          type: "text",
          width: 14,
        },
        { key: "paymentStatus", header: "حالة الدفع", type: "text", width: 16 },
        {
          key: "productsSubtotal",
          header: "مجموع المنتجات (د.ع)",
          type: "integer",
          width: 18,
        },
        {
          key: "deliveryFee",
          header: "أجرة التوصيل (د.ع)",
          type: "integer",
          width: 18,
        },
        { key: "total", header: "الإجمالي (د.ع)", type: "integer", width: 16 },
        {
          key: "commissionRate",
          header: "نسبة الاستقطاع",
          type: "percent",
          width: 16,
        },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        storeName: text(row.store_name),
        status: text(row.status),
        paymentMethod: text(row.payment_method),
        paymentStatus: text(row.payment_status),
        productsSubtotal: int(row.products_subtotal),
        deliveryFee: int(row.delivery_fee),
        total: int(row.total),
        commissionRate: int(row.store_commission_rate_snapshot),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async orderEvents(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.events.export",
    );
    const filters = parseEventListQuery(query);
    const params = eventListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_events e join orders o on o.id = e.order_id where ${EVENT_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select e.id::text, o.order_number, e.event_type::text, e.actor_type::text,
              e.source::text, e.reason, e.created_at
       from order_events e join orders o on o.id = e.order_id
       where ${EVENT_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-events",
        endpoint: "/api/v1/dashboard/order-events/export",
        permission: "orders.events.export",
        filename: "order-events.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "أحداث الطلبات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "eventType", header: "نوع الحدث", type: "text", width: 28 },
        { key: "actorType", header: "المنفذ", type: "text" },
        { key: "source", header: "المصدر", type: "text", width: 18 },
        { key: "reason", header: "السبب", type: "text", width: 32 },
        { key: "createdAt", header: "الوقت", type: "datetime", width: 24 },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        eventType: text(row.event_type),
        actorType: text(row.actor_type),
        source: text(row.source),
        reason: text(row.reason),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async orderAssignments(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.assignments.export",
    );
    const filters = parseAssignmentListQuery(query);
    const params = assignmentListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_driver_assignments a join orders o on o.id = a.order_id where ${ASSIGNMENT_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select a.id::text, o.order_number, a.driver_id::text, a.status::text,
              a.assignment_sequence, a.assigned_at, a.completed_at
       from order_driver_assignments a join orders o on o.id = a.order_id
       where ${ASSIGNMENT_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-assignments",
        endpoint: "/api/v1/dashboard/order-assignments/export",
        permission: "orders.assignments.export",
        filename: "order-assignments.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "التعيينات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "driverId", header: "السائق", type: "text", width: 38 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "sequence", header: "التسلسل", type: "integer" },
        {
          key: "assignedAt",
          header: "وقت التعيين",
          type: "datetime",
          width: 24,
        },
        {
          key: "completedAt",
          header: "وقت الإكمال",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        driverId: text(row.driver_id),
        status: text(row.status),
        sequence: int(row.assignment_sequence),
        assignedAt: iso(row.assigned_at),
        completedAt: iso(row.completed_at),
      })),
      requestId,
    );
  }

  async orderOfferRounds(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "order_offers.read",
      "order_offers.export",
    );
    const filters = parseOfferRoundListQuery(query);
    if (filters.orderId) {
      const [order] = await this.client<{ id: string }[]>`
        select id::text from orders where id = ${filters.orderId} and city_id = ${cityId}`;
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    }
    const params = offerRoundListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_offer_rounds r join orders o on o.id = r.order_id where ${OFFER_ROUND_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select r.id::text, o.order_number, r.status::text, r.opened_at, r.closed_at, r.final_driver_fee
       from order_offer_rounds r join orders o on o.id = r.order_id
       where ${OFFER_ROUND_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-offer-rounds",
        endpoint: "/api/v1/dashboard/order-offer-rounds/export",
        permission: "order_offers.export",
        filename: "order-offer-rounds.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "جولات العروض",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "finalDriverFee",
          header: "أجرة السائق (د.ع)",
          type: "integer",
          width: 18,
        },
        { key: "openedAt", header: "وقت الفتح", type: "datetime", width: 24 },
        { key: "closedAt", header: "وقت الإغلاق", type: "datetime", width: 24 },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        finalDriverFee: int(row.final_driver_fee),
        openedAt: iso(row.opened_at),
        closedAt: iso(row.closed_at),
      })),
      requestId,
    );
  }

  async orderHandoffs(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.handoffs.export",
    );
    const filters = parseHandoffListQuery(query);
    const params = handoffListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_driver_handoffs h join orders o on o.id = h.order_id where ${HANDOFF_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select h.id::text, o.order_number, h.status::text, h.from_driver_id::text,
              h.to_driver_id::text, h.created_at, h.completed_at
       from order_driver_handoffs h join orders o on o.id = h.order_id
       where ${HANDOFF_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-handoffs",
        endpoint: "/api/v1/dashboard/order-handoffs/export",
        permission: "orders.handoffs.export",
        filename: "order-handoffs.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "تسليم السائقين",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "fromDriverId", header: "من سائق", type: "text", width: 38 },
        { key: "toDriverId", header: "إلى سائق", type: "text", width: 38 },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "completedAt",
          header: "وقت الإكمال",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        fromDriverId: text(row.from_driver_id),
        toDriverId: text(row.to_driver_id),
        createdAt: iso(row.created_at),
        completedAt: iso(row.completed_at),
      })),
      requestId,
    );
  }

  async orderReturns(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.returns.export",
    );
    const filters = parseReturnListQuery(query);
    const params = returnListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_return_workflows w join orders o on o.id = w.order_id where ${RETURN_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select w.id::text, o.order_number, w.status::text, w.created_at, w.completed_at
       from order_return_workflows w join orders o on o.id = w.order_id
       where ${RETURN_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-returns",
        endpoint: "/api/v1/dashboard/order-returns/export",
        permission: "orders.returns.export",
        filename: "order-returns.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "الإرجاع",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "completedAt",
          header: "وقت الإكمال",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        createdAt: iso(row.created_at),
        completedAt: iso(row.completed_at),
      })),
      requestId,
    );
  }

  async orderCollections(
    identity: AuthIdentity,
    query: OpsListInput,
    requestId: string,
  ) {
    const cityId = await requireCityReadAndExport(
      this.client,
      identity,
      "orders.read",
      "orders.collections.export",
    );
    const filters = parseCollectionListQuery(query);
    const params = collectionListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_collections c join orders o on o.id = c.order_id where ${COLLECTION_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select c.id::text, o.order_number, c.collecting_driver_id::text,
              c.expected_amount, c.collected_amount, c.difference_amount, c.collected_at
       from order_collections c join orders o on o.id = c.order_id
       where ${COLLECTION_LIST_WHERE_SQL}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "order-collections",
        endpoint: "/api/v1/dashboard/order-collections/export",
        permission: "orders.collections.export",
        filename: "order-collections.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "التحصيلات",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "orderNumber", header: "رقم الطلب", type: "text", width: 16 },
        { key: "driverId", header: "السائق", type: "text", width: 38 },
        {
          key: "expectedAmount",
          header: "المبلغ المتوقع (د.ع)",
          type: "integer",
          width: 18,
        },
        {
          key: "collectedAmount",
          header: "المبلغ المحصّل (د.ع)",
          type: "integer",
          width: 18,
        },
        {
          key: "differenceAmount",
          header: "الفرق (د.ع)",
          type: "integer",
          width: 14,
        },
        {
          key: "collectedAt",
          header: "وقت التحصيل",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        driverId: text(row.collecting_driver_id),
        expectedAmount: int(row.expected_amount),
        collectedAmount: int(row.collected_amount),
        differenceAmount: int(row.difference_amount),
        collectedAt: iso(row.collected_at),
      })),
      requestId,
    );
  }

  async drivers(
    identity: AuthIdentity,
    query: OpsListInput & { activeOrderCount?: string },
    requestId: string,
  ) {
    await requireCityPermission(this.client, identity, "orders.assign");
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "drivers.export",
    );
    const filters = parseCandidateListQuery(query);
    const where = `
      dp.city_id = $1::uuid and dp.approval_status = 'APPROVED'
      and dp.operational_status = 'ACTIVE' and a.status = 'ACTIVE'
      and ($2::text is null or coalesce(ph.phone_e164,'') ilike $2 escape '\\' or ($3::uuid is not null and dp.account_id = $3::uuid))
      and ($4::int is null or (select count(*)::int from order_driver_assignments oda where oda.driver_id = dp.account_id and oda.completed_at is null and oda.cancelled_at is null) = $4::int)`;
    const params = [
      cityId,
      filters.pattern,
      filters.searchUuid,
      filters.activeOrderCount,
    ];
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from driver_profiles dp join accounts a on a.id = dp.account_id
       left join lateral (select phone_e164 from account_phones where account_id = dp.account_id order by is_primary desc limit 1) ph on true
       where ${where}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select dp.account_id::text, dp.approval_status::text, dp.operational_status::text,
              coalesce(ph.phone_e164,'') as phone,
              coalesce(ph.phone_e164,'Driver') as display_name,
              dp.created_at,
              (
                select count(*)::int from order_driver_assignments oda
                where oda.driver_id = dp.account_id and oda.completed_at is null and oda.cancelled_at is null
              ) as active_order_count
       from driver_profiles dp join accounts a on a.id = dp.account_id
       left join lateral (select phone_e164 from account_phones where account_id = dp.account_id order by is_primary desc limit 1) ph on true
       where ${where}
       order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "drivers",
        endpoint: "/api/v1/dashboard/drivers/assignment-candidates/export",
        permission: "drivers.export",
        filename: "drivers.xlsx",
        filters: opsPublicFilters(
          filters as unknown as Record<string, unknown>,
        ),
        cityId: cityId,
      },
      "السائقون",
      [
        { key: "driverId", header: "معرف السائق", type: "text", width: 38 },
        { key: "phone", header: "الهاتف", type: "text", width: 16 },
        {
          key: "approvalStatus",
          header: "حالة الاعتماد",
          type: "text",
          width: 16,
        },
        {
          key: "operationalStatus",
          header: "الحالة التشغيلية",
          type: "text",
          width: 16,
        },
      ],
      rows.map((row) => ({
        driverId: text(row.account_id),
        phone: text(row.phone),
        approvalStatus: text(row.approval_status),
        operationalStatus: text(row.operational_status),
      })),
      requestId,
    );
  }

  async employees(
    identity: AuthIdentity,
    query: {
      search?: string;
      status?: string;
      role?: string;
      permission?: string;
      createdFrom?: string;
      createdTo?: string;
      sortBy?: string;
      sortOrder?: string;
    },
    requestId: string,
  ) {
    requireCityAdmin(identity);
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "staff.export",
    );
    const search = parseOptionalSearch(query.search);
    const pattern = search ? likeContains(search) : null;
    const uuid = searchUuid(search);
    const created = parseOptionalDateRange({
      from: query.createdFrom,
      to: query.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const status = parseOptionalAllowlisted(
      query.status,
      STAFF_PROFILE_STATUSES,
      "status",
    );
    const role = query.role?.trim() || null;
    const permission = query.permission?.trim() || null;
    const sortBy = parseAllowlistedSort(
      query.sortBy,
      ["createdAt", "displayName", "email"] as const,
      "email",
    );
    const sortOrder = parseSortOrder(query.sortOrder, "asc");
    const orderSql = {
      createdAt: `sp.created_at ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      displayName: `coalesce(sp.display_name,'') ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      email: `e.email_normalized ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const where = `sp.managed_by_account_id = $1::uuid and s.scope_reference_id = $2::uuid
      and ($3::text is null or e.email_normalized ilike $3 escape '\\' or coalesce(sp.display_name,'') ilike $3 escape '\\' or ($4::uuid is not null and a.id = $4::uuid))
      and ($5::text is null or sp.status = $5::staff_profile_status)
      and ($6::text is null or exists (select 1 from account_roles ar3 join roles r3 on r3.id = ar3.role_id where ar3.account_id = a.id and ar3.revoked_at is null and r3.code = $6::staff_role_code))
      and ($7::text is null or exists (select 1 from account_permission_grants g join permissions p on p.id = g.permission_id where g.account_id = a.id and g.revoked_at is null and p.code = $7))
      and ($8::timestamptz is null or sp.created_at >= $8) and ($9::timestamptz is null or sp.created_at < $9)`;
    const params = [
      identity.accountId,
      cityId,
      pattern,
      uuid,
      status,
      role,
      permission,
      created.from,
      created.to,
    ];
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from staff_profiles sp join accounts a on a.id = sp.account_id
       join account_emails e on e.account_id = a.id and e.is_primary = true
       join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
       join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
       where ${where}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select a.id::text as account_id, e.email_normalized, sp.display_name, sp.status::text as staff_status, sp.created_at
       from staff_profiles sp join accounts a on a.id = sp.account_id
       join account_emails e on e.account_id = a.id and e.is_primary = true
       join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
       join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
       where ${where} order by ${orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "employees",
        endpoint: "/api/v1/dashboard/employees/export",
        permission: "staff.export",
        filename: "employees.xlsx",
        filters: { search, status, role, permission, sortBy, sortOrder },
        cityId: cityId,
      },
      "الموظفون",
      [
        { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
        { key: "email", header: "البريد", type: "text", width: 28 },
        { key: "displayName", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        accountId: text(row.account_id),
        email: text(row.email_normalized),
        displayName: text(row.display_name),
        status: text(row.staff_status),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async admins(
    identity: AuthIdentity,
    query: {
      search?: string;
      cityId?: string;
      status?: string;
      createdFrom?: string;
      createdTo?: string;
      sortBy?: string;
      sortOrder?: string;
    },
    requestId: string,
  ) {
    await requireSuperAdminExport(this.client, identity, "admins.export");
    const search = parseOptionalSearch(query.search);
    const pattern = search ? likeContains(search) : null;
    const uuid = searchUuid(search);
    const cityId = parseOptionalUuid(query.cityId, "cityId");
    const status = parseOptionalAllowlisted(
      query.status,
      STAFF_PROFILE_STATUSES,
      "status",
    );
    const created = parseOptionalDateRange({
      from: query.createdFrom,
      to: query.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const sortBy = parseAllowlistedSort(
      query.sortBy,
      ["createdAt", "displayName", "email"] as const,
      "email",
    );
    const sortOrder = parseSortOrder(query.sortOrder, "asc");
    const orderSql = {
      createdAt: `sp.created_at ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      displayName: `coalesce(sp.display_name,'') ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
      email: `e.email_normalized ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const where = `sp.managed_by_account_id is null
      and ($1::text is null or e.email_normalized ilike $1 escape '\\' or coalesce(sp.display_name,'') ilike $1 escape '\\' or ($2::uuid is not null and a.id = $2::uuid))
      and ($3::uuid is null or s.scope_reference_id = $3::uuid)
      and ($4::text is null or sp.status = $4::staff_profile_status)
      and ($5::timestamptz is null or sp.created_at >= $5) and ($6::timestamptz is null or sp.created_at < $6)`;
    const params = [pattern, uuid, cityId, status, created.from, created.to];
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from staff_profiles sp join accounts a on a.id = sp.account_id
       join account_emails e on e.account_id = a.id and e.is_primary = true
       join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
       join roles r on r.id = ar.role_id and r.code = 'ADMIN'
       join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
       where ${where}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select a.id::text as account_id, e.email_normalized, sp.display_name, sp.status::text as staff_status, s.scope_reference_id::text as city_id, sp.created_at
       from staff_profiles sp join accounts a on a.id = sp.account_id
       join account_emails e on e.account_id = a.id and e.is_primary = true
       join account_roles ar on ar.account_id = a.id and ar.revoked_at is null
       join roles r on r.id = ar.role_id and r.code = 'ADMIN'
       join account_role_scopes s on s.account_role_id = ar.id and s.scope_type = 'CITY'
       where ${where} order by ${orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "admins",
        endpoint: "/api/v1/dashboard/admins/export",
        permission: "admins.export",
        filename: "admins.xlsx",
        filters: { search, cityId, status, sortBy, sortOrder },
        cityId: null,
      },
      "مديرو المدن",
      [
        { key: "accountId", header: "معرف الحساب", type: "text", width: 38 },
        { key: "email", header: "البريد", type: "text", width: 28 },
        { key: "displayName", header: "الاسم", type: "text", width: 24 },
        { key: "status", header: "الحالة", type: "text" },
        { key: "cityId", header: "المدينة", type: "text", width: 38 },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        accountId: text(row.account_id),
        email: text(row.email_normalized),
        displayName: text(row.display_name),
        status: text(row.staff_status),
        cityId: text(row.city_id),
        createdAt: iso(row.created_at),
      })),
      requestId,
    );
  }

  async deliveryPricingVersions(
    identity: AuthIdentity,
    cityId: string,
    query: Record<string, string | undefined>,
    requestId: string,
  ) {
    await requireSuperAdminExport(
      this.client,
      identity,
      "delivery_pricing.versions.export",
    );
    const filters = parseDeliveryPricingListQuery(query);
    const params = deliveryPricingListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total from city_delivery_pricing_versions where ${DELIVERY_PRICING_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    this.assertLimit(count?.total ?? 0);
    const rows = (await this.client.unsafe(
      `select id::text, version, status::text, base_fee, included_distance_meters, price_per_km, rounding_step, created_at, activated_at
       from city_delivery_pricing_versions where ${DELIVERY_PRICING_LIST_WHERE_SQL} order by ${filters.orderSql}`,
      params,
    )) as Record<string, unknown>[];
    return this.file(
      identity,
      {
        resource: "delivery-pricing-versions",
        endpoint:
          "/api/v1/dashboard/cities/:cityId/delivery-pricing/versions/export",
        permission: "delivery_pricing.versions.export",
        filename: "delivery-pricing-versions.xlsx",
        filters: {
          cityId,
          ...opsPublicFilters(filters as unknown as Record<string, unknown>),
        },
        cityId: null,
      },
      "تسعير التوصيل",
      [
        { key: "id", header: "المعرف", type: "text", width: 38 },
        { key: "version", header: "الإصدار", type: "integer" },
        { key: "status", header: "الحالة", type: "text" },
        {
          key: "baseFee",
          header: "الأجرة الأساسية (د.ع)",
          type: "integer",
          width: 18,
        },
        {
          key: "includedDistance",
          header: "المسافة المشمولة (م)",
          type: "integer",
          width: 18,
        },
        {
          key: "pricePerKm",
          header: "سعر الكيلومتر (د.ع)",
          type: "integer",
          width: 18,
        },
        { key: "roundingStep", header: "خطوة التقريب", type: "integer" },
        {
          key: "createdAt",
          header: "تاريخ الإنشاء",
          type: "datetime",
          width: 24,
        },
        {
          key: "activatedAt",
          header: "تاريخ التفعيل",
          type: "datetime",
          width: 24,
        },
      ],
      rows.map((row) => ({
        id: text(row.id),
        version: int(row.version),
        status: text(row.status),
        baseFee: int(row.base_fee),
        includedDistance: int(row.included_distance_meters),
        pricePerKm: int(row.price_per_km),
        roundingStep: int(row.rounding_step),
        createdAt: iso(row.created_at),
        activatedAt: iso(row.activated_at),
      })),
      requestId,
    );
  }

  async listOrderEvents(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const filters = parseEventListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = eventListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_events e join orders o on o.id = e.order_id where ${EVENT_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select e.id::text, o.order_number, e.event_type::text, e.actor_type::text, e.source::text, e.reason, e.created_at
       from order_events e join orders o on o.id = e.order_id
       where ${EVENT_LIST_WHERE_SQL} order by ${filters.orderSql} limit $10::int offset $11::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        eventType: text(row.event_type),
        actorType: text(row.actor_type),
        source: text(row.source),
        reason: text(row.reason),
        createdAt: iso(row.created_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async listOrderAssignments(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const filters = parseAssignmentListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = assignmentListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_driver_assignments a join orders o on o.id = a.order_id where ${ASSIGNMENT_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select a.id::text, o.order_number, a.driver_id::text, a.status::text, a.assignment_sequence, a.assigned_at, a.completed_at
       from order_driver_assignments a join orders o on o.id = a.order_id
       where ${ASSIGNMENT_LIST_WHERE_SQL} order by ${filters.orderSql} limit $11::int offset $12::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        driverId: text(row.driver_id),
        status: text(row.status),
        sequence: int(row.assignment_sequence),
        assignedAt: iso(row.assigned_at),
        completedAt: iso(row.completed_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async listOrderOfferRounds(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "order_offers.read",
    );
    const filters = parseOfferRoundListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = offerRoundListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_offer_rounds r join orders o on o.id = r.order_id where ${OFFER_ROUND_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select r.id::text, o.order_number, r.status::text, r.opened_at, r.closed_at, r.final_driver_fee
       from order_offer_rounds r join orders o on o.id = r.order_id
       where ${OFFER_ROUND_LIST_WHERE_SQL} order by ${filters.orderSql} limit $10::int offset $11::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        finalDriverFee: int(row.final_driver_fee),
        openedAt: iso(row.opened_at),
        closedAt: iso(row.closed_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async listOrderHandoffs(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const filters = parseHandoffListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = handoffListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_driver_handoffs h join orders o on o.id = h.order_id where ${HANDOFF_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select h.id::text, o.order_number, h.status::text, h.from_driver_id::text, h.to_driver_id::text, h.created_at, h.completed_at
       from order_driver_handoffs h join orders o on o.id = h.order_id
       where ${HANDOFF_LIST_WHERE_SQL} order by ${filters.orderSql} limit $10::int offset $11::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        fromDriverId: text(row.from_driver_id),
        toDriverId: text(row.to_driver_id),
        createdAt: iso(row.created_at),
        completedAt: iso(row.completed_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async listOrderReturns(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const filters = parseReturnListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = returnListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_return_workflows w join orders o on o.id = w.order_id where ${RETURN_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select w.id::text, o.order_number, w.status::text, w.created_at, w.completed_at
       from order_return_workflows w join orders o on o.id = w.order_id
       where ${RETURN_LIST_WHERE_SQL} order by ${filters.orderSql} limit $9::int offset $10::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        status: text(row.status),
        createdAt: iso(row.created_at),
        completedAt: iso(row.completed_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async listOrderCollections(
    identity: AuthIdentity,
    query: OpsListInput & { page?: number; limit?: number },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "orders.read",
    );
    const filters = parseCollectionListQuery(query);
    const p = dashboardPageOf(query.page, query.limit);
    const params = collectionListParams(cityId, filters);
    const [count] = (await this.client.unsafe(
      `select count(*)::int total from order_collections c join orders o on o.id = c.order_id where ${COLLECTION_LIST_WHERE_SQL}`,
      params,
    )) as { total: number }[];
    const rows = (await this.client.unsafe(
      `select c.id::text, o.order_number, c.collecting_driver_id::text, c.expected_amount, c.collected_amount, c.difference_amount, c.collected_at
       from order_collections c join orders o on o.id = c.order_id
       where ${COLLECTION_LIST_WHERE_SQL} order by ${filters.orderSql} limit $16::int offset $17::int`,
      [...params, p.limit, (p.page - 1) * p.limit],
    )) as Record<string, unknown>[];
    return dashboardListResult(
      rows.map((row) => ({
        id: text(row.id),
        orderNumber: text(row.order_number),
        driverId: text(row.collecting_driver_id),
        expectedAmount: int(row.expected_amount),
        collectedAmount: int(row.collected_amount),
        differenceAmount: int(row.difference_amount),
        collectedAt: iso(row.collected_at),
      })),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }
}
