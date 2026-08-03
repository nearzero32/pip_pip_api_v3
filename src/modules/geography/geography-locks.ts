import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";

/**
 * Shared geography locking protocol (M3-B1.2).
 *
 * Deterministic acquisition order (all transaction-scoped; multi-process safe):
 *   1. Governorate advisory locks — UUID ascending (`geo:gov:<id>`)
 *   2. City advisory locks — UUID ascending (`geo:city:<id>`)
 *   3. Zone overlap advisory lock — existing `zone:<cityId>` (Zone mutations only)
 *
 * All City transitions, Governorate transitions, City reassignment, and Zone
 * mutations MUST follow this order so concurrent operations serialize without
 * deadlock and re-read authoritative operability after waiting for locks.
 *
 * If a City's parent Governorate changes while waiting for locks, the transaction
 * aborts with GeographyLockStaleError and callers retry the whole BEGIN so locks
 * are always acquired in order (never Governorate-after-City).
 *
 * Effective City operability (single definition):
 *   City exists AND City.status = ACTIVE AND parent Governorate.status = ACTIVE
 */

export type CityOperability = {
  cityId: string;
  governorateId: string;
  cityStatus: string;
  governorateStatus: string;
  operational: boolean;
};

/** Thrown when parent geography changed mid-lock; retry the outer transaction. */
export class GeographyLockStaleError extends Error {
  constructor(message = "Geography parent changed during lock acquisition") {
    super(message);
    this.name = "GeographyLockStaleError";
  }
}

export const isCityOperational = (
  cityStatus: string,
  governorateStatus: string,
): boolean => cityStatus === "ACTIVE" && governorateStatus === "ACTIVE";

export const assertCityOperability = (state: CityOperability): void => {
  if (!state.operational)
    throw new AppError(409, "CITY_NOT_ACTIVE", "City is not active");
};

const sortUuids = (ids: string[]) =>
  [...new Set(ids.filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Step 1 of the lock protocol. */
export async function lockGovernorates(
  tx: SQL,
  governorateIds: string[],
): Promise<void> {
  for (const id of sortUuids(governorateIds)) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`geo:gov:${id}`}, 0))`;
  }
}

/** Step 2 of the lock protocol. */
export async function lockCities(tx: SQL, cityIds: string[]): Promise<void> {
  for (const id of sortUuids(cityIds)) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`geo:city:${id}`}, 0))`;
  }
}

/** Existing per-City Zone overlap lock (step 3 for Zone mutations). */
export async function lockZoneOverlap(tx: SQL, cityId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`zone:${cityId}`}, 0))`;
}

export async function readCityOperability(
  tx: SQL,
  cityId: string,
): Promise<CityOperability> {
  const [row] = await tx<
    {
      city_id: string;
      governorate_id: string;
      city_status: string;
      governorate_status: string;
    }[]
  >`select
      c.id::text as city_id,
      c.governorate_id::text as governorate_id,
      c.status::text as city_status,
      g.status::text as governorate_status
    from cities c
    join governorates g on g.id = c.governorate_id
    where c.id = ${cityId}`;
  if (!row) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
  return {
    cityId: row.city_id,
    governorateId: row.governorate_id,
    cityStatus: row.city_status,
    governorateStatus: row.governorate_status,
    operational: isCityOperational(row.city_status, row.governorate_status),
  };
}

/**
 * Retry an entire BEGIN when lock acquisition observes a parent change.
 * Keeps lock order strict across concurrent reassignment.
 */
export async function beginWithGeographyRetry<T>(
  client: SQL,
  fn: (tx: SQL) => Promise<T>,
  maxAttempts = 8,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.begin(fn);
    } catch (error) {
      lastError = error;
      if (error instanceof GeographyLockStaleError) continue;
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GeographyLockStaleError("Geography lock retry exhausted");
}

/**
 * Lock the City's current Governorate then the City, then re-read operability.
 * Used by Zone mutations and City status transitions.
 */
export async function lockCityGeography(
  tx: SQL,
  cityId: string,
): Promise<CityOperability> {
  const [peek] = await tx<{ governorate_id: string }[]>`
    select governorate_id::text as governorate_id from cities where id = ${cityId}`;
  if (!peek) throw new AppError(404, "CITY_NOT_FOUND", "City not found");

  await lockGovernorates(tx, [peek.governorate_id]);
  await lockCities(tx, [cityId]);

  const state = await readCityOperability(tx, cityId);
  if (state.governorateId !== peek.governorate_id) {
    throw new GeographyLockStaleError();
  }
  return state;
}

/**
 * Lock old + target Governorates (sorted) then the City for reassignment.
 */
export async function lockCityReassignment(
  tx: SQL,
  cityId: string,
  targetGovernorateId: string,
): Promise<{ before: CityOperability }> {
  const [peek] = await tx<{ governorate_id: string }[]>`
    select governorate_id::text as governorate_id from cities where id = ${cityId}`;
  if (!peek) throw new AppError(404, "CITY_NOT_FOUND", "City not found");

  await lockGovernorates(tx, [peek.governorate_id, targetGovernorateId]);
  await lockCities(tx, [cityId]);

  const before = await readCityOperability(tx, cityId);
  if (
    before.governorateId !== peek.governorate_id &&
    before.governorateId !== targetGovernorateId
  ) {
    throw new GeographyLockStaleError();
  }
  return { before };
}

/**
 * Lock a Governorate then all current child Cities (UUID order) for status change.
 * Child set is re-read after locks — the Governorate lock blocks concurrent
 * reassignment into/out of this Governorate for the transaction duration.
 */
export async function lockGovernorateAndCities(
  tx: SQL,
  governorateId: string,
): Promise<string[]> {
  await lockGovernorates(tx, [governorateId]);
  const initial = await tx<{ id: string }[]>`
    select id::text as id from cities where governorate_id = ${governorateId} order by id`;
  await lockCities(
    tx,
    initial.map((row) => row.id),
  );
  const cities = await tx<{ id: string }[]>`
    select id::text as id from cities where governorate_id = ${governorateId} order by id`;
  return cities.map((row) => row.id);
}
