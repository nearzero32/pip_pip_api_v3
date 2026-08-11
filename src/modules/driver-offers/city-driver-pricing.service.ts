import type { SQL } from "bun";
import { createHash } from "crypto";
import { AppError } from "../../errors/app-error";
import type { DriverPricingStage } from "../../db/schema/driver-offers";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireSuperAdmin } from "../auth/staff/authorization";
import { dateValue } from "../geography/shared";
import { validatePricingStages } from "./driver-fee";
import {
  abortOfferIdempotency,
  beginOfferIdempotency,
  completeOfferIdempotency,
} from "./offer-idempotency";

export type CityDriverPricingInput = {
  pricingBase: number;
  roundingUnit: number;
  pricingStages: DriverPricingStage[];
};

export type CityDriverPricingRow = CityDriverPricingInput & {
  id: string;
  cityId: string;
  version: number;
  updatedByAccountId: string;
  createdAt: string;
  updatedAt: string;
};

const hashPayload = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const requireIdempotencyKey = (idempotencyKey: string | null | undefined) => {
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim())
    throw new AppError(422, "VALIDATION_FAILED", "Idempotency-Key is required");
  return idempotencyKey.trim();
};

const mapRow = (row: Record<string, unknown>): CityDriverPricingRow => ({
  id: String(row.id),
  cityId: String(row.city_id),
  version: Number(row.version),
  pricingBase: Number(row.pricing_base),
  roundingUnit: Number(row.rounding_unit),
  pricingStages: ((): DriverPricingStage[] => {
    let value: unknown = row.pricing_stages;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        value = [];
      }
    }
    return Array.isArray(value) ? (value as DriverPricingStage[]) : [];
  })(),
  updatedByAccountId: String(row.updated_by_account_id),
  createdAt: dateValue(row.created_at)!,
  updatedAt: dateValue(row.updated_at)!,
});

export class CityDriverPricingService {
  constructor(private client: SQL) {}

  async get(
    identity: AuthIdentity,
    cityId: string,
  ): Promise<CityDriverPricingRow> {
    requireSuperAdmin(identity);
    const [row] = await this.client<Record<string, unknown>[]>`
      select id::text, city_id::text, version, pricing_base, rounding_unit,
             pricing_stages, updated_by_account_id::text, created_at, updated_at
      from city_driver_pricing where city_id = ${cityId}`;
    if (!row)
      throw new AppError(
        404,
        "CITY_DRIVER_PRICING_NOT_FOUND",
        "City driver pricing not found",
      );
    return mapRow(row);
  }

  async put(
    identity: AuthIdentity,
    cityId: string,
    input: CityDriverPricingInput,
    requestId: string | null = null,
    idempotencyKey?: string | null,
  ): Promise<CityDriverPricingRow> {
    requireSuperAdmin(identity);
    if (
      !Number.isSafeInteger(input.pricingBase) ||
      input.pricingBase <= 0 ||
      !Number.isSafeInteger(input.roundingUnit) ||
      input.roundingUnit <= 0
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid pricing values");
    }
    const pricingStages = validatePricingStages(input.pricingStages);
    const canonical = {
      pricingBase: input.pricingBase,
      roundingUnit: input.roundingUnit,
      pricingStages,
    };
    const requestHash = hashPayload(canonical);
    const key = requireIdempotencyKey(idempotencyKey);
    const scope = "v1:city_driver_pricing.put";

    return this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`city-driver-pricing:${cityId}`}, 0))`;

      const [city] = await tx<{ status: string }[]>`
        select status::text from cities where id = ${cityId} for update`;
      if (!city || city.status === "ARCHIVED")
        throw new AppError(404, "CITY_NOT_FOUND", "City not found");

      const gate = await beginOfferIdempotency(tx, {
        scope,
        actorAccountId: identity.accountId,
        cityId,
        idempotencyKey: key,
        requestHash,
      });
      if (gate.kind === "replay")
        return gate.payload as unknown as CityDriverPricingRow;

      try {
        const [current] = await tx<{ version: number }[]>`
          select version from city_driver_pricing where city_id = ${cityId} for update`;
        const nextVersion = (current?.version ?? 0) + 1;

        const rows = await tx<Record<string, unknown>[]>`
          insert into city_driver_pricing (
            city_id, version, pricing_base, rounding_unit, pricing_stages,
            updated_by_account_id
          ) values (
            ${cityId}, ${nextVersion}, ${input.pricingBase}, ${input.roundingUnit},
            ${pricingStages}, ${identity.accountId}
          )
          on conflict (city_id) do update set
            version = excluded.version,
            pricing_base = excluded.pricing_base,
            rounding_unit = excluded.rounding_unit,
            pricing_stages = excluded.pricing_stages,
            updated_by_account_id = excluded.updated_by_account_id,
            updated_at = now()
          returning id::text, city_id::text, version, pricing_base, rounding_unit,
                    pricing_stages, updated_by_account_id::text, created_at, updated_at`;
        const row = mapRow(rows[0]!);

        await tx`
          insert into audit_logs (
            event_type, actor_account_id, actor_session_id, target_type, target_id,
            outcome, request_correlation_id, redacted_metadata
          ) values (
            'CITY_DRIVER_PRICING_UPSERTED', ${identity.accountId}, ${identity.sessionId || null},
            'CITY_DRIVER_PRICING', ${row.id}, 'SUCCESS', ${requestId},
            ${JSON.stringify({ cityId, version: row.version })}::jsonb
          )`;

        await completeOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
          httpStatus: 200,
          payload: row as unknown as Record<string, unknown>,
        });

        return row;
      } catch (error) {
        await abortOfferIdempotency(tx, {
          scope,
          actorAccountId: identity.accountId,
          cityId,
          idempotencyKey: key,
        });
        throw error;
      }
    });
  }
}
