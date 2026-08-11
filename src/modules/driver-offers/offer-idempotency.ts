import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";

export type IdempotencyRecord = {
  requestHash: string;
  status: "IN_PROGRESS" | "COMPLETED";
  httpStatus: number | null;
  responsePayload: Record<string, unknown> | null;
};

const parsePayload = (value: unknown): Record<string, unknown> | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
};

/**
 * Begin an idempotent operation under row lock.
 * Concurrent callers with the same key wait on FOR UPDATE of the same row.
 */
export async function beginOfferIdempotency(
  tx: SQL,
  input: {
    scope: string;
    actorAccountId: string;
    cityId: string;
    idempotencyKey: string;
    requestHash: string;
    inProgressTtlSeconds?: number;
  },
): Promise<
  | { kind: "replay"; httpStatus: number; payload: Record<string, unknown> }
  | { kind: "proceed" }
> {
  const key = input.idempotencyKey.trim();
  if (!key)
    throw new AppError(422, "VALIDATION_FAILED", "Idempotency-Key is required");
  const ttl = input.inProgressTtlSeconds ?? 120;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const inserted = await tx<IdempotencyRecord[]>`
    insert into offer_idempotency_keys (
      scope, actor_account_id, city_id, idempotency_key, request_hash,
      status, expires_at
    ) values (
      ${input.scope}, ${input.actorAccountId}, ${input.cityId}, ${key},
      ${input.requestHash}, 'IN_PROGRESS', ${expiresAt}
    )
    on conflict (scope, actor_account_id, city_id, idempotency_key) do nothing
    returning request_hash, status::text as status, http_status, response_payload`;

  if (inserted[0]) return { kind: "proceed" };

  const [existing] = await tx<
    {
      request_hash: string;
      status: string;
      http_status: number | null;
      response_payload: unknown;
      expires_at: Date | null;
    }[]
  >`select request_hash, status::text as status, http_status, response_payload, expires_at
    from offer_idempotency_keys
    where scope = ${input.scope}
      and actor_account_id = ${input.actorAccountId}
      and city_id = ${input.cityId}
      and idempotency_key = ${key}
    for update`;

  if (!existing)
    throw new AppError(500, "INTERNAL_ERROR", "Idempotency reservation failed");

  if (existing.request_hash !== input.requestHash)
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was reused with a different payload",
    );

  if (existing.status === "COMPLETED") {
    const payload = parsePayload(existing.response_payload);
    if (!payload || existing.http_status == null)
      throw new AppError(500, "INTERNAL_ERROR", "Corrupt idempotency record");
    return {
      kind: "replay",
      httpStatus: Number(existing.http_status),
      payload,
    };
  }

  // Stale IN_PROGRESS (crashed worker) — reclaim for retry.
  if (
    existing.expires_at &&
    new Date(existing.expires_at).getTime() < Date.now()
  ) {
    await tx`
      update offer_idempotency_keys
      set request_hash = ${input.requestHash},
          status = 'IN_PROGRESS',
          http_status = null,
          response_payload = null,
          completed_at = null,
          expires_at = ${expiresAt},
          updated_at = now()
      where scope = ${input.scope}
        and actor_account_id = ${input.actorAccountId}
        and city_id = ${input.cityId}
        and idempotency_key = ${key}`;
    return { kind: "proceed" };
  }

  throw new AppError(
    409,
    "IDEMPOTENCY_IN_PROGRESS",
    "A request with this Idempotency-Key is still in progress",
  );
}

export async function completeOfferIdempotency(
  tx: SQL,
  input: {
    scope: string;
    actorAccountId: string;
    cityId: string;
    idempotencyKey: string;
    httpStatus: number;
    payload: Record<string, unknown>;
  },
) {
  const now = new Date();
  await tx`
    update offer_idempotency_keys
    set status = 'COMPLETED',
        http_status = ${input.httpStatus},
        response_payload = ${input.payload},
        completed_at = ${now},
        expires_at = null,
        updated_at = ${now}
    where scope = ${input.scope}
      and actor_account_id = ${input.actorAccountId}
      and city_id = ${input.cityId}
      and idempotency_key = ${input.idempotencyKey.trim()}
      and status = 'IN_PROGRESS'`;
}

/** Abort in-progress reservation so a later retry can proceed. */
export async function abortOfferIdempotency(
  tx: SQL,
  input: {
    scope: string;
    actorAccountId: string;
    cityId: string;
    idempotencyKey: string;
  },
) {
  try {
    await tx`
      delete from offer_idempotency_keys
      where scope = ${input.scope}
        and actor_account_id = ${input.actorAccountId}
        and city_id = ${input.cityId}
        and idempotency_key = ${input.idempotencyKey.trim()}
        and status = 'IN_PROGRESS'`;
  } catch {
    // Transaction may already be aborted; outer rollback clears the reservation.
  }
}
