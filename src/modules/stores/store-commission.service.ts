import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireCityPermission } from "../auth/staff/authorization";
import {
  beginOrderCommandIdempotency,
  completeOrderCommandIdempotency,
  abortOrderCommandIdempotency,
  hashOrderCommandPayload,
  requireOrderIdempotencyKey,
} from "../orders/order-command-idempotency";
import { dateValue } from "../geography/shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalSearch,
  parseSortOrder,
  sqlDir,
} from "../dashboard-lists/query";
import {
  COMMISSION_STORE_WHERE_SQL,
  parseStoreListQuery,
  commissionStoreParams,
} from "../dashboard-lists/store-list-query";

const STORE_COMMISSION_UPDATE_SCOPE = "v1:stores.commission.update";

const parseRate = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
    throw new AppError(422, "VALIDATION_FAILED", "platformCommissionRate must be an integer from 0 to 100");
  return value;
};

const parseReason = (value: unknown): string => {
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", "reason is required");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", "Invalid reason");
  return trimmed;
};

const optionalNote = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", "Invalid note");
  const trimmed = value.trim();
  if (trimmed.length > 1000)
    throw new AppError(422, "VALIDATION_FAILED", "Invalid note");
  return trimmed || null;
};

type CommissionRow = {
  id: string;
  name: string;
  status: string;
  city_id: string;
  city_name_ar: string;
  platform_commission_rate: number;
  updated_at: Date;
  last_commission_changed_at: Date | null;
  last_changed_by_account_id: string | null;
  last_changed_by_email: string | null;
};

const commissionDto = (row: CommissionRow) => ({
  storeId: row.id,
  storeName: row.name,
  status: row.status,
  cityId: row.city_id,
  cityNameAr: row.city_name_ar,
  platformCommissionRate: Number(row.platform_commission_rate),
  updatedAt: dateValue(row.updated_at)!,
  lastCommissionChangedAt: dateValue(row.last_commission_changed_at),
  lastChangedByAccountId: row.last_changed_by_account_id,
  lastChangedByEmail: row.last_changed_by_email,
});

const COMMISSION_SELECT = `
  s.id::text as id,
  s.name,
  s.status::text as status,
  s.city_id::text as city_id,
  c.name_ar as city_name_ar,
  s.platform_commission_rate,
  s.updated_at,
  h.changed_at as last_commission_changed_at,
  h.changed_by_account_id::text as last_changed_by_account_id,
  e.email_normalized as last_changed_by_email
`;

const COMMISSION_FROM = `
  from stores s
  join cities c on c.id = s.city_id
  left join lateral (
    select changed_at, changed_by_account_id
    from store_commission_rate_history
    where store_id = s.id and city_id = s.city_id
    order by changed_at desc, id desc
    limit 1
  ) h on true
  left join account_emails e
    on e.account_id = h.changed_by_account_id and e.is_primary = true
`;

export class StoreCommissionService {
  constructor(private client: SQL) {}

  async list(
    identity: AuthIdentity,
    input: {
      search?: string;
      status?: string;
      commissionRateMin?: string | number;
      commissionRateMax?: string | number;
      createdFrom?: string;
      createdTo?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "stores.commission.read",
    );
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const filters = parseStoreListQuery(input);
    const params = commissionStoreParams(cityId, filters);
    const rows = (await this.client.unsafe(
      `select ${COMMISSION_SELECT}
       ${COMMISSION_FROM}
       where ${COMMISSION_STORE_WHERE_SQL}
       order by ${filters.orderSql}
       limit $${params.length + 1}::int offset $${params.length + 2}::int`,
      [...params, limit, offset],
    )) as CommissionRow[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from stores s
       where ${COMMISSION_STORE_WHERE_SQL}`,
      params,
    )) as { total: string }[];
    return dashboardListResult(
      rows.map(commissionDto),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  async get(identity: AuthIdentity, storeId: string) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "stores.commission.read",
    );
    const [row] = (await this.client.unsafe(
      `select ${COMMISSION_SELECT}
       ${COMMISSION_FROM}
       where s.id = $1::uuid and s.city_id = $2::uuid`,
      [storeId, cityId],
    )) as CommissionRow[];
    if (!row) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return commissionDto(row);
  }

  async listHistory(
    identity: AuthIdentity,
    storeId: string,
    input: {
      search?: string;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: string;
    },
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "stores.commission.read",
    );
    const [store] = await this.client<{ id: string }[]>`
      select id::text from stores where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = parseOptionalSearch(input.search);
    const pattern = search ? likeContains(search) : null;
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["changedAt", "newRate"] as const,
      "changedAt",
    );
    const sortOrder = parseSortOrder(input.sortOrder, "desc");
    const orderSql = {
      changedAt: `h.changed_at ${sqlDir(sortOrder)}, h.id ${sqlDir(sortOrder)}`,
      newRate: `h.new_rate ${sqlDir(sortOrder)}, h.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const rows = (await this.client.unsafe(
      `select h.id::text, h.store_id::text, s.name as store_name,
             h.city_id::text, h.previous_rate, h.new_rate, h.reason, h.note,
             h.changed_by_account_id::text, e.email_normalized as changed_by_email,
             h.changed_at
      from store_commission_rate_history h
      join stores s on s.id = h.store_id and s.city_id = h.city_id
      left join account_emails e
        on e.account_id = h.changed_by_account_id and e.is_primary = true
      where h.store_id = $1::uuid and h.city_id = $2::uuid
        and (
          $3::text is null
          or h.reason ilike $3 escape '\\'
          or coalesce(h.note, '') ilike $3 escape '\\'
        )
      order by ${orderSql}
      limit $4::int offset $5::int`,
      [storeId, cityId, pattern, limit, offset],
    )) as Record<string, unknown>[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
      from store_commission_rate_history h
      where h.store_id = $1::uuid and h.city_id = $2::uuid
        and (
          $3::text is null
          or h.reason ilike $3 escape '\\'
          or coalesce(h.note, '') ilike $3 escape '\\'
        )`,
      [storeId, cityId, pattern],
    )) as { total: string }[];
    return dashboardListResult(
      rows.map((row) => ({
        id: String(row.id),
        storeId: String(row.store_id),
        storeName: String(row.store_name),
        cityId: String(row.city_id),
        previousRate: Number(row.previous_rate),
        newRate: Number(row.new_rate),
        reason: String(row.reason),
        note: row.note == null ? null : String(row.note),
        changedByAccountId: String(row.changed_by_account_id),
        changedByEmail: row.changed_by_email == null ? null : String(row.changed_by_email),
        changedAt: dateValue(row.changed_at)!,
      })),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  async update(
    identity: AuthIdentity,
    storeId: string,
    body: unknown,
    idempotencyKeyInput: string,
    requestId: string,
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      "stores.commission.update",
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!["platformCommissionRate", "reason", "note"].includes(key))
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if (!("platformCommissionRate" in input))
      throw new AppError(422, "VALIDATION_FAILED", "platformCommissionRate is required");
    const rate = parseRate(input.platformCommissionRate);
    const reason = parseReason(input.reason);
    const note = optionalNote(input.note);
    const idempotencyKey = requireOrderIdempotencyKey(idempotencyKeyInput);
    const requestHash = hashOrderCommandPayload({
      storeId,
      platformCommissionRate: rate,
      reason,
      note,
    });
    return this.client.begin(async (tx) => {
      const idempotency = {
        scope: STORE_COMMISSION_UPDATE_SCOPE,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey,
      };
      const gate = await beginOrderCommandIdempotency(tx, {
        ...idempotency,
        requestHash,
      });
      if (gate.kind === "replay") return gate.payload as ReturnType<typeof commissionDto>;
      try {
        const [locked] = await tx<
          { id: string; platform_commission_rate: number }[]
        >`select id::text, platform_commission_rate
          from stores
          where id = ${storeId} and city_id = ${cityId}
          for update`;
        if (!locked)
          throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
        const previous = Number(locked.platform_commission_rate);
        if (previous !== rate) {
          await tx`
            update stores
            set platform_commission_rate = ${rate}, updated_at = now()
            where id = ${storeId} and city_id = ${cityId}`;
          await tx`
            insert into store_commission_rate_history (
              store_id, city_id, previous_rate, new_rate, reason, note,
              changed_by_account_id
            ) values (
              ${storeId}, ${cityId}, ${previous}, ${rate}, ${reason}, ${note},
              ${identity.accountId}
            )`;
          await tx`
            insert into audit_logs (
              event_type, actor_account_id, target_type, target_id, outcome,
              request_correlation_id, redacted_metadata
            ) values (
              'STORE_COMMISSION_RATE_CHANGED', ${identity.accountId}, 'STORE',
              ${storeId}, 'SUCCESS', ${requestId},
              ${JSON.stringify({ previousRate: previous, newRate: rate })}::jsonb
            )`;
        }
        const [row] = (await tx.unsafe(
          `select ${COMMISSION_SELECT}
           ${COMMISSION_FROM}
           where s.id = $1::uuid and s.city_id = $2::uuid`,
          [storeId, cityId],
        )) as CommissionRow[];
        const payload = commissionDto(row!);
        await completeOrderCommandIdempotency(tx, {
          ...idempotency,
          httpStatus: 200,
          payload,
        });
        return payload;
      } catch (error) {
        await abortOrderCommandIdempotency(tx, idempotency);
        throw error;
      }
    });
  }
}
