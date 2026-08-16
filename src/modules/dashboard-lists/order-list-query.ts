import { AppError } from "../../errors/app-error";
import {
  likeContains,
  parseAllowlistedSort,
  parseOptionalDateRange,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  sqlDir,
  type DashboardSortOrder,
} from "./query";
import { ORDER_STATUSES } from "../orders/order-state-machine";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ORDER_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "deliveredAt",
  "status",
  "total",
  "orderNumber",
] as const;

export type OrderListQuery = {
  search?: string;
  status?: string;
  storeId?: string;
  customerId?: string;
  driverId?: string;
  assignmentId?: string;
  custodyStatus?: string;
  createdFrom?: string;
  createdTo?: string;
  deliveredFrom?: string;
  deliveredTo?: string;
  cancelledFrom?: string;
  cancelledTo?: string;
  hasActiveHandoff?: string | boolean;
  hasActiveReturn?: string | boolean;
  sortBy?: string;
  sortOrder?: string;
};

export type OrderListFilters = {
  search: string | null;
  pattern: string | null;
  searchUuid: string | null;
  status: string | null;
  storeId: string | null;
  customerId: string | null;
  driverId: string | null;
  assignmentId: string | null;
  custodyStatus: string | null;
  createdFrom: Date | null;
  createdTo: Date | null;
  deliveredFrom: Date | null;
  deliveredTo: Date | null;
  cancelledFrom: Date | null;
  cancelledTo: Date | null;
  hasActiveHandoff: boolean | null;
  hasActiveReturn: boolean | null;
  sortBy: (typeof ORDER_SORT_FIELDS)[number];
  sortOrder: DashboardSortOrder;
  orderSql: string;
};

const boolish = (value?: string | boolean): boolean | null => {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
};

export function parseOrderListQuery(input: OrderListQuery): OrderListFilters {
  const search = parseOptionalSearch(input.search);
  const status = input.status?.trim() || null;
  if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  const created = parseOptionalDateRange({
    from: input.createdFrom,
    to: input.createdTo,
  });
  const delivered = parseOptionalDateRange({
    from: input.deliveredFrom,
    to: input.deliveredTo,
  });
  const cancelled = parseOptionalDateRange({
    from: input.cancelledFrom,
    to: input.cancelledTo,
  });
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ORDER_SORT_FIELDS,
    "createdAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  const orderSql = {
    createdAt: `o.created_at ${sqlDir(sortOrder)}, o.id ${sqlDir(sortOrder)}`,
    updatedAt: `o.updated_at ${sqlDir(sortOrder)}, o.id ${sqlDir(sortOrder)}`,
    deliveredAt: `o.delivered_at ${sqlDir(sortOrder)} nulls last, o.id ${sqlDir(sortOrder)}`,
    status: `o.status ${sqlDir(sortOrder)}, o.created_at desc, o.id desc`,
    total: `o.total ${sqlDir(sortOrder)}, o.id ${sqlDir(sortOrder)}`,
    orderNumber: `o.order_number ${sqlDir(sortOrder)}, o.id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: search && UUID_RE.test(search) ? search : null,
    status,
    storeId: parseOptionalUuid(input.storeId),
    customerId: parseOptionalUuid(input.customerId),
    driverId: parseOptionalUuid(input.driverId),
    assignmentId: parseOptionalUuid(input.assignmentId),
    custodyStatus: input.custodyStatus?.trim() || null,
    createdFrom: created.from,
    createdTo: created.to,
    deliveredFrom: delivered.from,
    deliveredTo: delivered.to,
    cancelledFrom: cancelled.from,
    cancelledTo: cancelled.to,
    hasActiveHandoff: boolish(input.hasActiveHandoff),
    hasActiveReturn: boolish(input.hasActiveReturn),
    sortBy,
    sortOrder,
    orderSql,
  };
}

/** Parameterized WHERE shared by dashboard order list and Excel export. $1 = cityId. */
export const ORDER_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::text is null or o.status = $2::order_status)
  and ($3::uuid is null or o.store_id = $3::uuid)
  and ($4::uuid is null or o.customer_account_id = $4::uuid)
  and ($5::uuid is null or o.custody_driver_id = $5::uuid)
  and ($6::uuid is null or exists (
        select 1 from order_driver_assignments a
        where a.id = $6::uuid and a.order_id = o.id
      ))
  and ($7::text is null or o.custody_status = $7::order_custody_status)
  and ($8::timestamptz is null or o.created_at >= $8::timestamptz)
  and ($9::timestamptz is null or o.created_at <= $9::timestamptz)
  and ($10::timestamptz is null or o.delivered_at >= $10::timestamptz)
  and ($11::timestamptz is null or o.delivered_at <= $11::timestamptz)
  and ($12::timestamptz is null or o.cancelled_at >= $12::timestamptz)
  and ($13::timestamptz is null or o.cancelled_at <= $13::timestamptz)
  and ($14::boolean is null or ($14::boolean = exists (
        select 1 from order_driver_handoffs h
        where h.order_id = o.id and h.status = 'PENDING'
      )))
  and ($15::boolean is null or ($15::boolean = exists (
        select 1 from order_return_workflows r
        where r.order_id = o.id and r.status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')
      )))
  and (
    $16::text is null
    or o.order_number ilike $16 escape '\\'
    or ($17::uuid is not null and o.id = $17::uuid)
    or exists (
      select 1 from stores s
      where s.id = o.store_id and s.name ilike $16 escape '\\'
    )
    or exists (
      select 1 from order_address_snapshots addr
      where addr.order_id = o.id
        and (
          coalesce(addr.recipient_name, '') ilike $16 escape '\\'
          or coalesce(addr.recipient_phone, '') ilike $16 escape '\\'
        )
    )
  )
`;

export function orderListParams(cityId: string, filters: OrderListFilters) {
  return [
    cityId,
    filters.status,
    filters.storeId,
    filters.customerId,
    filters.driverId,
    filters.assignmentId,
    filters.custodyStatus,
    filters.createdFrom,
    filters.createdTo,
    filters.deliveredFrom,
    filters.deliveredTo,
    filters.cancelledFrom,
    filters.cancelledTo,
    filters.hasActiveHandoff,
    filters.hasActiveReturn,
    filters.pattern,
    filters.searchUuid,
  ];
}

export function orderListPublicFilters(filters: OrderListFilters) {
  return {
    search: filters.search,
    status: filters.status,
    storeId: filters.storeId,
    customerId: filters.customerId,
    driverId: filters.driverId,
    assignmentId: filters.assignmentId,
    custodyStatus: filters.custodyStatus,
    createdFrom: filters.createdFrom?.toISOString() ?? null,
    createdTo: filters.createdTo?.toISOString() ?? null,
    deliveredFrom: filters.deliveredFrom?.toISOString() ?? null,
    deliveredTo: filters.deliveredTo?.toISOString() ?? null,
    cancelledFrom: filters.cancelledFrom?.toISOString() ?? null,
    cancelledTo: filters.cancelledTo?.toISOString() ?? null,
    hasActiveHandoff: filters.hasActiveHandoff,
    hasActiveReturn: filters.hasActiveReturn,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  };
}
