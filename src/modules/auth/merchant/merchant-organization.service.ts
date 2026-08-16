import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { requireCityPermission } from "../staff/authorization";
import { assertActiveCity } from "../staff/dashboard-scope";
import type { AuthIdentity } from "../sessions/session-service";
import type { Argon2PasswordHasher } from "../staff/password";
import { normalizePhone } from "../shared/normalization";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../../geography/geography-locks";
import { dateValue } from "../../geography/shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalAllowlisted,
  parseOptionalDateRange,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
} from "../../dashboard-lists/query";

type MerchantStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";
const MERCHANT_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;

const cleanDisplayName = (raw: unknown): string | null => {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid display name");
  }
  const name = raw.trim();
  if (!name) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid display name");
  }
  if (name.length > 100) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid display name");
  }
  return name;
};

const assertPassword = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 12 || raw.length > 128) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  return raw;
};

export class MerchantOrganizationService {
  constructor(
    private client: SQL,
    private password: Argon2PasswordHasher,
  ) {}

  private async authorize(
    identity: AuthIdentity,
    permission: "merchants.read" | "merchants.create" | "merchants.update",
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private async revokeMerchantSessions(
    tx: SQL,
    accountId: string,
    reason: string,
  ) {
    await tx`
      update sessions set
        revoked_at = now(),
        revocation_reason = ${reason},
        updated_at = now()
      where account_id = ${accountId}
        and application_type = 'MERCHANT_APP'
        and revoked_at is null`;
  }

  private merchantDto(row: Record<string, unknown>): any {
    return {
      accountId: row.account_id,
      phone: row.phone_e164,
      displayName: row.display_name ?? null,
      status: row.merchant_status,
      storeId: row.store_id,
      storeName: row.store_name ?? null,
      cityId: row.city_id,
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      statusChangedAt: dateValue(row.status_changed_at),
    };
  }

  private async loadMerchant(
    accountId: string,
    cityId: string,
    db: SQL = this.client,
  ) {
    const rows = await db<Record<string, unknown>[]>`
      select
        a.id::text as account_id,
        ph.phone_e164,
        m.display_name,
        m.status::text as merchant_status,
        m.store_id::text as store_id,
        s.name as store_name,
        m.city_id::text as city_id,
        m.created_at,
        m.updated_at,
        m.status_changed_at
      from merchant_profiles m
      join accounts a on a.id = m.account_id
      join stores s on s.id = m.store_id and s.city_id = m.city_id
      join account_phones ph on ph.account_id = a.id and ph.verified_at is not null
      where m.account_id = ${accountId}
        and m.city_id = ${cityId}
      order by ph.is_primary desc, ph.created_at asc
      limit 1`;
    const row = rows[0];
    if (!row) {
      throw new AppError(404, "MERCHANT_NOT_FOUND", "Merchant not found");
    }
    return row;
  }

  async create(
    identity: AuthIdentity,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "merchants.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "accountId"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (typeof input.storeId !== "string") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid storeId");
    }
    const storeId = input.storeId;
    const phone = normalizePhone(String(input.phone ?? ""));
    const password = assertPassword(input.password);
    const displayName =
      "displayName" in input ? cleanDisplayName(input.displayName) : null;
    const status = (input.status as MerchantStatus | undefined) ?? "ACTIVE";
    if (!["ACTIVE", "INACTIVE", "SUSPENDED"].includes(status)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid merchant status");
    }

    let accountId = "";
    try {
      accountId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await tx`select pg_advisory_xact_lock(hashtextextended(${`merchant-phone:${phone}`}, 0))`;

        const [store] = await tx<{ id: string; status: string }[]>`
          select id::text as id, status::text as status from stores
          where id = ${storeId} and city_id = ${cityId}
          for update`;
        if (!store) {
          throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
        }
        if (store.status === "ARCHIVED") {
          throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
        }

        const [existingPhone] = await tx<
          { account_id: string }[]
        >`select account_id::text as account_id from account_phones
          where phone_e164 = ${phone}
          for update`;

        let id = existingPhone?.account_id ?? "";
        if (id) {
          const [staff] = await tx`select 1 from staff_profiles where account_id = ${id}`;
          if (staff) {
            throw new AppError(
              409,
              "MERCHANT_PHONE_CONFLICT",
              "Phone cannot be used for Merchant",
            );
          }
          const [merchant] =
            await tx`select 1 from merchant_profiles where account_id = ${id}`;
          if (merchant) {
            throw new AppError(
              409,
              "MERCHANT_ALREADY_EXISTS",
              "Merchant already exists for this phone",
            );
          }
          await tx`
            update account_phones set
              verified_at = coalesce(verified_at, now()),
              updated_at = now()
            where account_id = ${id}
              and phone_e164 = ${phone}`;
        } else {
          const [account] = await tx<{ id: string }[]>`
            insert into accounts default values returning id::text as id`;
          id = account!.id;
          await tx`
            insert into account_phones (
              account_id, phone_e164, verified_at, is_primary
            ) values (
              ${id}, ${phone}, now(), true
            )`;
        }

        const hash = await this.password.hash(password);
        await tx`
          insert into password_credentials (account_id, argon2id_hash)
          values (${id}, ${hash})
          on conflict (account_id) do update set
            argon2id_hash = excluded.argon2id_hash,
            password_changed_at = now(),
            updated_at = now()`;

        await tx`
          insert into merchant_profiles (
            account_id, store_id, city_id, display_name, status, created_by_account_id
          ) values (
            ${id},
            ${storeId},
            ${cityId},
            ${displayName},
            ${status}::merchant_profile_status,
            ${identity.accountId}
          )`;

        if (status !== "ACTIVE") {
          await this.revokeMerchantSessions(tx, id, "MERCHANT_INACTIVE");
        }
        return id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MERCHANT_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ accountId, storeId, cityId })}::jsonb
      )`;

    return this.merchantDto(await this.loadMerchant(accountId, cityId));
  }

  async list(
    identity: AuthIdentity,
    input: {
      status?: string;
      storeId?: string;
      search?: string;
      createdFrom?: string;
      createdTo?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const cityId = await this.authorize(identity, "merchants.read");
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const status = parseOptionalAllowlisted(
      input.status,
      MERCHANT_STATUSES,
      "status",
    );
    const storeId =
      !input.storeId?.trim() || input.storeId === "null"
        ? null
        : parseOptionalUuid(input.storeId, "storeId");
    const search = parseOptionalSearch(input.search);
    const pattern = search ? likeContains(search) : null;
    const uuid = searchUuid(search);
    const created = parseOptionalDateRange({
      from: input.createdFrom,
      to: input.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["createdAt", "displayName", "phone"] as const,
      "createdAt",
    );
    const sortOrder = parseSortOrder(input.sortOrder, "desc");
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
    const rows = await this.client.unsafe(
      `select a.id::text as account_id, ph.phone_e164, m.display_name,
              m.status::text as merchant_status, m.store_id::text as store_id,
              s.name as store_name, m.city_id::text as city_id,
              m.created_at, m.updated_at, m.status_changed_at
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
       order by ${orderSql}
       limit $8::int offset $9::int`,
      [...params, limit, offset],
    );
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
    return dashboardListResult(
      (rows as Record<string, unknown>[]).map((row) => this.merchantDto(row)),
      page,
      limit,
      count?.total ?? 0,
    );
  }

  async get(identity: AuthIdentity, accountId: string) {
    const cityId = await this.authorize(identity, "merchants.read");
    return this.merchantDto(await this.loadMerchant(accountId, cityId));
  }

  async update(
    identity: AuthIdentity,
    accountId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "merchants.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "accountId", "phone", "password", "storeId"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (!("displayName" in input) && !("status" in input)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [row] = await tx<{ status: string }[]>`
        select status::text as status from merchant_profiles
        where account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!row) {
        throw new AppError(404, "MERCHANT_NOT_FOUND", "Merchant not found");
      }

      const displayName =
        "displayName" in input
          ? cleanDisplayName(input.displayName)
          : undefined;
      const status =
        "status" in input ? (input.status as MerchantStatus) : undefined;
      if (
        status !== undefined &&
        !["ACTIVE", "INACTIVE", "SUSPENDED"].includes(status)
      ) {
        throw new AppError(422, "VALIDATION_FAILED", "Invalid merchant status");
      }

      if (displayName !== undefined) {
        await tx`
          update merchant_profiles set
            display_name = ${displayName},
            updated_at = now()
          where account_id = ${accountId}
            and city_id = ${cityId}`;
      }
      if (status !== undefined && status !== row.status) {
        await tx`
          update merchant_profiles set
            status = ${status}::merchant_profile_status,
            status_changed_at = now(),
            updated_at = now()
          where account_id = ${accountId}
            and city_id = ${cityId}`;
        if (status === "INACTIVE" || status === "SUSPENDED") {
          await this.revokeMerchantSessions(
            tx,
            accountId,
            status === "SUSPENDED" ? "MERCHANT_SUSPENDED" : "MERCHANT_INACTIVE",
          );
        }
      }
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MERCHANT_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ accountId, cityId })}::jsonb
      )`;

    return this.merchantDto(await this.loadMerchant(accountId, cityId));
  }

  async resetPassword(
    identity: AuthIdentity,
    accountId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "merchants.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const password = assertPassword((body as Record<string, unknown>).password);

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [row] = await tx`select 1 from merchant_profiles
        where account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!row) {
        throw new AppError(404, "MERCHANT_NOT_FOUND", "Merchant not found");
      }
      const hash = await this.password.hash(password);
      await tx`
        insert into password_credentials (account_id, argon2id_hash)
        values (${accountId}, ${hash})
        on conflict (account_id) do update set
          argon2id_hash = excluded.argon2id_hash,
          password_changed_at = now(),
          updated_at = now()`;
      await this.revokeMerchantSessions(
        tx,
        accountId,
        "MERCHANT_PASSWORD_RESET",
      );
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MERCHANT_PASSWORD_RESET',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ accountId, cityId })}::jsonb
      )`;

    return { reset: true, request_id: requestId };
  }

  async transferStore(
    identity: AuthIdentity,
    accountId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "merchants.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const storeId = (body as Record<string, unknown>).storeId;
    if (typeof storeId !== "string") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid storeId");
    }

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [merchant] = await tx<{ store_id: string }[]>`
        select store_id::text as store_id from merchant_profiles
        where account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!merchant) {
        throw new AppError(404, "MERCHANT_NOT_FOUND", "Merchant not found");
      }
      const [store] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status from stores
        where id = ${storeId} and city_id = ${cityId}
        for update`;
      if (!store) {
        throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      }
      if (store.status === "ARCHIVED") {
        throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
      }
      if (merchant.store_id === storeId) return;

      await tx`
        update merchant_profiles set
          store_id = ${storeId},
          updated_at = now()
        where account_id = ${accountId}
          and city_id = ${cityId}`;
      await this.revokeMerchantSessions(
        tx,
        accountId,
        "MERCHANT_STORE_TRANSFERRED",
      );
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MERCHANT_STORE_TRANSFERRED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ accountId, storeId, cityId })}::jsonb
      )`;

    return this.merchantDto(await this.loadMerchant(accountId, cityId));
  }
}
