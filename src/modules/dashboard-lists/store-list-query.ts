import { AppError } from "../../errors/app-error";
import {
  likeContains,
  parseAllowlistedSort,
  parseOptionalDateRange,
  parseOptionalInt,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
} from "./query";

const STORE_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export const STORE_SORT_FIELDS = [
  "displayOrder",
  "name",
  "status",
  "createdAt",
  "platformCommissionRate",
] as const;

export type StoreListInput = {
  search?: string;
  status?: string;
  mainCategoryId?: string;
  zoneId?: string;
  commissionRateMin?: string | number;
  commissionRateMax?: string | number;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
};

export function parseStoreStatusFilter(status?: string): string | null {
  const value = status?.trim() || null;
  if (value && !STORE_STATUSES.includes(value as (typeof STORE_STATUSES)[number]))
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  return value;
}

export function parseStoreListQuery(input: StoreListInput) {
  const search = parseOptionalSearch(input.search);
  const created = parseOptionalDateRange({
    from: input.createdFrom,
    to: input.createdTo,
  });
  const rateMin = parseOptionalInt(input.commissionRateMin, { min: 0, max: 100 });
  const rateMax = parseOptionalInt(input.commissionRateMax, { min: 0, max: 100 });
  if (rateMin != null && rateMax != null && rateMin > rateMax) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    STORE_SORT_FIELDS,
    "displayOrder",
  );
  const sortOrder = parseSortOrder(
    input.sortOrder,
    sortBy === "displayOrder" || sortBy === "name" ? "asc" : "desc",
  );
  const orderSql = {
    displayOrder: `s.display_order ${sqlDir(sortOrder)}, s.created_at asc, s.id asc`,
    name: `s.name ${sqlDir(sortOrder)}, s.id ${sqlDir(sortOrder)}`,
    status: `s.status ${sqlDir(sortOrder)}, s.display_order asc, s.id asc`,
    createdAt: `s.created_at ${sqlDir(sortOrder)}, s.id ${sqlDir(sortOrder)}`,
    platformCommissionRate: `s.platform_commission_rate ${sqlDir(sortOrder)}, s.id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    status: parseStoreStatusFilter(input.status),
    mainCategoryId: parseOptionalUuid(input.mainCategoryId),
    zoneId: parseOptionalUuid(input.zoneId),
    rateMin,
    rateMax,
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export type StoreListFilters = ReturnType<typeof parseStoreListQuery>;

export const STORE_LIST_WHERE_SQL = `
  s.city_id = $1::uuid
  and ($2::text is null or s.status = $2::store_status)
  and ($2::text is not null or s.status <> 'ARCHIVED')
  and ($3::uuid is null or s.main_category_id = $3::uuid)
  and ($4::text is null or s.name ilike $4 escape '\\' or ($5::uuid is not null and s.id = $5::uuid))
  and ($6::uuid is null or exists (
        select 1 from store_zones sz
        where sz.store_id = s.id and sz.city_id = s.city_id and sz.zone_id = $6::uuid
      ))
  and ($7::int is null or s.platform_commission_rate >= $7::int)
  and ($8::int is null or s.platform_commission_rate <= $8::int)
  and ($9::timestamptz is null or s.created_at >= $9::timestamptz)
  and ($10::timestamptz is null or s.created_at <= $10::timestamptz)
`;

export const COMMISSION_STORE_WHERE_SQL = `
  s.city_id = $1::uuid
  and ($2::text is null or s.status = $2::store_status)
  and ($2::text is not null or s.status <> 'ARCHIVED')
  and ($3::text is null or s.name ilike $3 escape '\\' or ($4::uuid is not null and s.id = $4::uuid))
  and ($5::int is null or s.platform_commission_rate >= $5::int)
  and ($6::int is null or s.platform_commission_rate <= $6::int)
  and ($7::timestamptz is null or s.created_at >= $7::timestamptz)
  and ($8::timestamptz is null or s.created_at <= $8::timestamptz)
`;

export function storeListParams(cityId: string, f: StoreListFilters) {
  return [
    cityId,
    f.status,
    f.mainCategoryId,
    f.pattern,
    f.searchUuid,
    f.zoneId,
    f.rateMin,
    f.rateMax,
    f.createdFrom,
    f.createdTo,
  ];
}

export function commissionStoreParams(
  cityId: string,
  f: Pick<
    StoreListFilters,
    | "status"
    | "pattern"
    | "searchUuid"
    | "rateMin"
    | "rateMax"
    | "createdFrom"
    | "createdTo"
  >,
) {
  return [
    cityId,
    f.status,
    f.pattern,
    f.searchUuid,
    f.rateMin,
    f.rateMax,
    f.createdFrom,
    f.createdTo,
  ];
}

export function storeListPublicFilters(f: StoreListFilters) {
  return {
    search: f.search,
    status: f.status,
    mainCategoryId: f.mainCategoryId,
    zoneId: f.zoneId,
    commissionRateMin: f.rateMin,
    commissionRateMax: f.rateMax,
    createdFrom: f.createdFrom?.toISOString() ?? null,
    createdTo: f.createdTo?.toISOString() ?? null,
    sortBy: f.sortBy,
    sortOrder: f.sortOrder,
  };
}
