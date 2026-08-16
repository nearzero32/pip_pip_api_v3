import { AppError } from "../../errors/app-error";
import {
  likeContains,
  parseAllowlistedSort,
  parseOptionalBool,
  parseOptionalDateRange,
  parseOptionalInt,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
} from "./query";

export function parseProductListQuery(input: {
  status?: string;
  categoryId?: string;
  search?: string;
  isAvailable?: string | boolean;
  hasSizes?: string | boolean;
  modifierGroupId?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const search = parseOptionalSearch(input.search);
  const status = input.status?.trim() || null;
  if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status)) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  const categoryId =
    input.categoryId === undefined ||
    input.categoryId === "null" ||
    input.categoryId === ""
      ? input.categoryId === "null"
        ? "NULL"
        : null
      : input.categoryId;
  const created = parseOptionalDateRange({
    from: input.createdFrom,
    to: input.createdTo,
  });
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
    displayOrder: `p.display_order ${sqlDir(sortOrder)}, p.id asc`,
    name: `p.name ${sqlDir(sortOrder)}, p.id ${sqlDir(sortOrder)}`,
    createdAt: `p.created_at ${sqlDir(sortOrder)}, p.id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    status,
    categoryId,
    isAvailable: parseOptionalBool(input.isAvailable),
    hasSizes: parseOptionalBool(input.hasSizes),
    modifierGroupId:
      !input.modifierGroupId?.trim() || input.modifierGroupId === "null"
        ? null
        : parseOptionalUuid(input.modifierGroupId),
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const PRODUCT_LIST_WHERE_SQL = `
  p.store_id = $1::uuid
  and p.city_id = $2::uuid
  and ($3::text is null or p.status = $3::product_status)
  and ($3::text is not null or p.status <> 'ARCHIVED')
  and (
    $4::text is null
    or ($4::text = 'NULL' and p.category_id is null)
    or p.category_id = $4::uuid
  )
  and ($5::boolean is null or p.is_available = $5::boolean)
  and (
    $6::boolean is null
    or ($6::boolean = exists (select 1 from product_sizes sz where sz.product_id = p.id))
  )
  and ($7::uuid is null or p.modifier_group_id = $7::uuid)
  and ($8::timestamptz is null or p.created_at >= $8::timestamptz)
  and ($9::timestamptz is null or p.created_at < $9::timestamptz)
  and (
    $10::text is null
    or p.name ilike $10 escape '\\'
    or ($11::uuid is not null and p.id = $11::uuid)
  )`;

export function productListParams(
  storeId: string,
  cityId: string,
  f: ReturnType<typeof parseProductListQuery>,
) {
  return [
    storeId,
    cityId,
    f.status,
    f.categoryId,
    f.isAvailable,
    f.hasSizes,
    f.modifierGroupId,
    f.createdFrom,
    f.createdTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseStoreCategoryListQuery(input: {
  status?: string;
  parentCategoryId?: string;
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const status = input.status?.trim() || null;
  if (status && !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status)) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  const parentFilter =
    input.parentCategoryId === undefined
      ? null
      : input.parentCategoryId === "null" || input.parentCategoryId === ""
        ? "ROOT"
        : input.parentCategoryId;
  const search = parseOptionalSearch(input.search);
  const created = parseOptionalDateRange({
    from: input.createdFrom,
    to: input.createdTo,
  });
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
    displayOrder: `coalesce(p.display_order, c.display_order) asc, coalesce(p.created_at, c.created_at) asc, coalesce(p.id, c.id) asc, (c.parent_category_id is not null) asc, c.display_order asc, c.created_at asc, c.id asc`,
    name: `c.name ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    createdAt: `c.created_at ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    status,
    parentFilter,
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const STORE_CATEGORY_LIST_WHERE_SQL = `
  c.store_id = $1::uuid
  and c.city_id = $2::uuid
  and ($3::text is null or c.status = $3::main_category_status)
  and ($3::text is not null or c.status <> 'ARCHIVED')
  and (
    $4::text is null
    or ($4::text = 'ROOT' and c.parent_category_id is null)
    or c.parent_category_id = $4::uuid
  )
  and ($5::text is null or c.name ilike $5 escape '\\' or ($6::uuid is not null and c.id = $6::uuid))
  and ($7::timestamptz is null or c.created_at >= $7::timestamptz)
  and ($8::timestamptz is null or c.created_at < $8::timestamptz)`;

export function storeCategoryListParams(
  storeId: string,
  cityId: string,
  f: ReturnType<typeof parseStoreCategoryListQuery>,
) {
  return [
    storeId,
    cityId,
    f.status,
    f.parentFilter,
    f.pattern,
    f.searchUuid,
    f.createdFrom,
    f.createdTo,
  ];
}

export function parseDeliveryPricingListQuery(input: {
  search?: string;
  status?: string;
  createdByAccountId?: string;
  createdFrom?: string;
  createdTo?: string;
  activatedFrom?: string;
  activatedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const search = parseOptionalSearch(input.search);
  const created = parseOptionalDateRange({
    from: input.createdFrom,
    to: input.createdTo,
  });
  const activated = parseOptionalDateRange({
    from: input.activatedFrom,
    to: input.activatedTo,
  });
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["version", "createdAt", "activatedAt", "status"] as const,
    "version",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  const orderSql = {
    version: `version ${sqlDir(sortOrder)}, id ${sqlDir(sortOrder)}`,
    createdAt: `created_at ${sqlDir(sortOrder)}, id ${sqlDir(sortOrder)}`,
    activatedAt: `activated_at ${sqlDir(sortOrder)} nulls last, id ${sqlDir(sortOrder)}`,
    status: `status ${sqlDir(sortOrder)}, version desc, id desc`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    status: input.status?.trim() || null,
    createdByAccountId: parseOptionalUuid(input.createdByAccountId),
    createdFrom: created.from,
    createdTo: created.to,
    activatedFrom: activated.from,
    activatedTo: activated.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const DELIVERY_PRICING_LIST_WHERE_SQL = `
  city_id = $1::uuid
  and ($2::text is null or status::text = $2::text)
  and ($3::uuid is null or created_by_account_id = $3::uuid)
  and ($4::timestamptz is null or created_at >= $4::timestamptz)
  and ($5::timestamptz is null or created_at < $5::timestamptz)
  and ($6::timestamptz is null or activated_at >= $6::timestamptz)
  and ($7::timestamptz is null or activated_at < $7::timestamptz)
  and (
    $8::text is null
    or version::text ilike $8 escape '\\'
    or ($9::uuid is not null and (id = $9::uuid or created_by_account_id = $9::uuid))
  )`;

export function deliveryPricingListParams(
  cityId: string,
  f: ReturnType<typeof parseDeliveryPricingListQuery>,
) {
  return [
    cityId,
    f.status,
    f.createdByAccountId,
    f.createdFrom,
    f.createdTo,
    f.activatedFrom,
    f.activatedTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseCandidateListQuery(input: {
  search?: string;
  activeOrderCount?: string | number;
  sortBy?: string;
  sortOrder?: string;
}) {
  const search = parseOptionalSearch(input.search);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["driverName", "activeOrderCount", "createdAt"] as const,
    "driverName",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "asc");
  const orderSql = {
    driverName: `display_name ${sqlDir(sortOrder)}, account_id ${sqlDir(sortOrder)}`,
    activeOrderCount: `active_order_count ${sqlDir(sortOrder)}, account_id ${sqlDir(sortOrder)}`,
    createdAt: `created_at ${sqlDir(sortOrder)}, account_id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    activeOrderCount: parseOptionalInt(input.activeOrderCount, { min: 0 }),
    sortBy,
    sortOrder,
    orderSql,
  };
}
