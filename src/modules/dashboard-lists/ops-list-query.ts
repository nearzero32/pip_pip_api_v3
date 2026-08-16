import {
  likeContains,
  parseAllowlistedSort,
  parseOptionalDateRange,
  parseOptionalIntRange,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
} from "./query";

export type OpsListInput = {
  search?: string;
  orderId?: string;
  driverId?: string;
  fromDriverId?: string;
  toDriverId?: string;
  assignmentId?: string;
  actorAccountId?: string;
  eventType?: string;
  source?: string;
  status?: string;
  roundKind?: string;
  closingReason?: string;
  confirmationSource?: string;
  createdFrom?: string;
  createdTo?: string;
  assignedFrom?: string;
  assignedTo?: string;
  openedFrom?: string;
  openedTo?: string;
  collectedFrom?: string;
  collectedTo?: string;
  expectedMin?: string | number;
  expectedMax?: string | number;
  collectedMin?: string | number;
  collectedMax?: string | number;
  differenceMin?: string | number;
  differenceMax?: string | number;
  sortBy?: string;
  sortOrder?: string;
};

const dates = (
  from?: string,
  to?: string,
): { from: Date | null; to: Date | null } =>
  parseOptionalDateRange({ from, to });

export function parseEventListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const created = dates(input.createdFrom, input.createdTo);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["createdAt"] as const,
    "createdAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    eventType: input.eventType?.trim() || null,
    source: input.source?.trim() || null,
    actorAccountId: parseOptionalUuid(input.actorAccountId),
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql: `e.created_at ${sqlDir(sortOrder)}, e.id ${sqlDir(sortOrder)}`,
  };
}

export const EVENT_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::uuid is null or e.order_id = $2::uuid)
  and ($3::text is null or e.event_type::text = $3::text)
  and ($4::text is null or e.source::text = $4::text)
  and ($5::uuid is null or e.actor_account_id = $5::uuid)
  and ($6::timestamptz is null or e.created_at >= $6::timestamptz)
  and ($7::timestamptz is null or e.created_at <= $7::timestamptz)
  and (
    $8::text is null
    or o.order_number ilike $8 escape '\\'
    or e.event_type::text ilike $8 escape '\\'
    or ($9::uuid is not null and (e.id = $9::uuid or e.order_id = $9::uuid))
  )`;

export function eventListParams(
  cityId: string,
  f: ReturnType<typeof parseEventListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.eventType,
    f.source,
    f.actorAccountId,
    f.createdFrom,
    f.createdTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseAssignmentListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const assigned = dates(input.assignedFrom, input.assignedTo);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["assignedAt", "createdAt", "status"] as const,
    "assignedAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  const orderSql = {
    assignedAt: `a.assigned_at ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
    createdAt: `a.created_at ${sqlDir(sortOrder)}, a.id ${sqlDir(sortOrder)}`,
    status: `a.status ${sqlDir(sortOrder)}, a.assigned_at desc, a.id desc`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    driverId: parseOptionalUuid(input.driverId),
    status: input.status?.trim() || null,
    source: input.source?.trim() || null,
    closingReason: input.closingReason?.trim() || null,
    assignedFrom: assigned.from,
    assignedTo: assigned.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const ASSIGNMENT_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::uuid is null or a.order_id = $2::uuid)
  and ($3::uuid is null or a.driver_id = $3::uuid)
  and ($4::text is null or a.status::text = $4::text)
  and ($5::text is null or a.assignment_source::text = $5::text)
  and ($6::text is null or a.closing_reason::text = $6::text)
  and ($7::timestamptz is null or a.assigned_at >= $7::timestamptz)
  and ($8::timestamptz is null or a.assigned_at <= $8::timestamptz)
  and (
    $9::text is null
    or o.order_number ilike $9 escape '\\'
    or exists (
      select 1 from account_phones ph
      where ph.account_id = a.driver_id
        and ph.phone_e164 ilike $9 escape '\\'
    )
    or ($10::uuid is not null and (
      a.id = $10::uuid or a.order_id = $10::uuid or a.driver_id = $10::uuid
    ))
  )`;

export function assignmentListParams(
  cityId: string,
  f: ReturnType<typeof parseAssignmentListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.driverId,
    f.status,
    f.source,
    f.closingReason,
    f.assignedFrom,
    f.assignedTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseOfferRoundListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const opened = dates(input.openedFrom, input.openedTo);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["openedAt", "createdAt", "status"] as const,
    "openedAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  const orderSql = {
    openedAt: `r.opened_at ${sqlDir(sortOrder)}, r.id ${sqlDir(sortOrder)}`,
    createdAt: `r.created_at ${sqlDir(sortOrder)}, r.id ${sqlDir(sortOrder)}`,
    status: `r.status ${sqlDir(sortOrder)}, r.opened_at desc, r.id desc`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    status: input.status?.trim() || null,
    roundKind: input.roundKind?.trim() || null,
    closingReason: input.closingReason?.trim() || null,
    openedFrom: opened.from,
    openedTo: opened.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const OFFER_ROUND_LIST_WHERE_SQL = `
  r.city_id = $1::uuid
  and ($2::uuid is null or r.order_id = $2::uuid)
  and ($3::text is null or r.status::text = $3::text)
  and ($4::text is null or r.round_kind::text = $4::text)
  and ($5::text is null or coalesce(r.stop_reason, '') = $5::text)
  and ($6::timestamptz is null or r.opened_at >= $6::timestamptz)
  and ($7::timestamptz is null or r.opened_at <= $7::timestamptz)
  and (
    $8::text is null
    or o.order_number ilike $8 escape '\\'
    or ($9::uuid is not null and (r.id = $9::uuid or r.order_id = $9::uuid))
  )`;

export function offerRoundListParams(
  cityId: string,
  f: ReturnType<typeof parseOfferRoundListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.status,
    f.roundKind,
    f.closingReason,
    f.openedFrom,
    f.openedTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseHandoffListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const created = dates(input.createdFrom, input.createdTo);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["createdAt", "status"] as const,
    "createdAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    fromDriverId: parseOptionalUuid(input.fromDriverId),
    toDriverId: parseOptionalUuid(input.toDriverId),
    status: input.status?.trim() || null,
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql: `h.created_at ${sqlDir(sortOrder)}, h.id ${sqlDir(sortOrder)}`,
  };
}

export const HANDOFF_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::uuid is null or h.order_id = $2::uuid)
  and ($3::uuid is null or h.from_driver_id = $3::uuid)
  and ($4::uuid is null or h.to_driver_id = $4::uuid)
  and ($5::text is null or h.status::text = $5::text)
  and ($6::timestamptz is null or h.created_at >= $6::timestamptz)
  and ($7::timestamptz is null or h.created_at <= $7::timestamptz)
  and (
    $8::text is null
    or o.order_number ilike $8 escape '\\'
    or ($9::uuid is not null and (
      h.id = $9::uuid or h.order_id = $9::uuid
      or h.from_driver_id = $9::uuid or h.to_driver_id = $9::uuid
    ))
  )`;

export function handoffListParams(
  cityId: string,
  f: ReturnType<typeof parseHandoffListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.fromDriverId,
    f.toDriverId,
    f.status,
    f.createdFrom,
    f.createdTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseReturnListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const created = dates(input.createdFrom, input.createdTo);
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    ["createdAt", "status"] as const,
    "createdAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    driverId: parseOptionalUuid(input.driverId),
    status: input.status?.trim() || null,
    createdFrom: created.from,
    createdTo: created.to,
    sortBy,
    sortOrder,
    orderSql: `w.created_at ${sqlDir(sortOrder)}, w.id ${sqlDir(sortOrder)}`,
  };
}

export const RETURN_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::uuid is null or w.order_id = $2::uuid)
  and ($3::uuid is null or w.driver_id = $3::uuid)
  and ($4::text is null or w.status::text = $4::text)
  and ($5::timestamptz is null or w.created_at >= $5::timestamptz)
  and ($6::timestamptz is null or w.created_at <= $6::timestamptz)
  and (
    $7::text is null
    or o.order_number ilike $7 escape '\\'
    or ($8::uuid is not null and (
      w.id = $8::uuid or w.order_id = $8::uuid or w.driver_id = $8::uuid
    ))
  )`;

export function returnListParams(
  cityId: string,
  f: ReturnType<typeof parseReturnListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.driverId,
    f.status,
    f.createdFrom,
    f.createdTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function parseCollectionListQuery(input: OpsListInput) {
  const search = parseOptionalSearch(input.search);
  const collected = dates(input.collectedFrom, input.collectedTo);
  const expected = parseOptionalIntRange(input.expectedMin, input.expectedMax);
  const collectedAmt = parseOptionalIntRange(
    input.collectedMin,
    input.collectedMax,
  );
  const difference = parseOptionalIntRange(
    input.differenceMin,
    input.differenceMax,
  );
  const sortBy = parseAllowlistedSort(
    input.sortBy,
    [
      "collectedAt",
      "expectedAmount",
      "collectedAmount",
      "differenceAmount",
    ] as const,
    "collectedAt",
  );
  const sortOrder = parseSortOrder(input.sortOrder, "desc");
  const orderSql = {
    collectedAt: `c.collected_at ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    expectedAmount: `c.expected_amount ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    collectedAmount: `c.collected_amount ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
    differenceAmount: `c.difference_amount ${sqlDir(sortOrder)}, c.id ${sqlDir(sortOrder)}`,
  }[sortBy];
  return {
    search,
    pattern: search ? likeContains(search) : null,
    searchUuid: searchUuid(search),
    orderId: parseOptionalUuid(input.orderId),
    assignmentId: parseOptionalUuid(input.assignmentId),
    driverId: parseOptionalUuid(input.driverId),
    confirmationSource: input.confirmationSource?.trim() || null,
    expectedMin: expected.min,
    expectedMax: expected.max,
    collectedMin: collectedAmt.min,
    collectedMax: collectedAmt.max,
    differenceMin: difference.min,
    differenceMax: difference.max,
    collectedFrom: collected.from,
    collectedTo: collected.to,
    sortBy,
    sortOrder,
    orderSql,
  };
}

export const COLLECTION_LIST_WHERE_SQL = `
  o.city_id = $1::uuid
  and ($2::uuid is null or c.order_id = $2::uuid)
  and ($3::uuid is null or c.assignment_id = $3::uuid)
  and ($4::uuid is null or c.collecting_driver_id = $4::uuid)
  and ($5::text is null or c.confirmation_source::text = $5::text)
  and ($6::int is null or c.expected_amount >= $6::int)
  and ($7::int is null or c.expected_amount <= $7::int)
  and ($8::int is null or c.collected_amount >= $8::int)
  and ($9::int is null or c.collected_amount <= $9::int)
  and ($10::int is null or c.difference_amount >= $10::int)
  and ($11::int is null or c.difference_amount <= $11::int)
  and ($12::timestamptz is null or c.collected_at >= $12::timestamptz)
  and ($13::timestamptz is null or c.collected_at <= $13::timestamptz)
  and (
    $14::text is null
    or o.order_number ilike $14 escape '\\'
    or ($15::uuid is not null and (
      c.id = $15::uuid or c.order_id = $15::uuid
      or c.assignment_id = $15::uuid or c.collecting_driver_id = $15::uuid
    ))
  )`;

export function collectionListParams(
  cityId: string,
  f: ReturnType<typeof parseCollectionListQuery>,
) {
  return [
    cityId,
    f.orderId,
    f.assignmentId,
    f.driverId,
    f.confirmationSource,
    f.expectedMin,
    f.expectedMax,
    f.collectedMin,
    f.collectedMax,
    f.differenceMin,
    f.differenceMax,
    f.collectedFrom,
    f.collectedTo,
    f.pattern,
    f.searchUuid,
  ];
}

export function opsPublicFilters(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value == null ||
      key === "pattern" ||
      key === "searchUuid" ||
      key === "orderSql"
    ) {
      continue;
    }
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
