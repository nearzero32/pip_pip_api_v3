export type OfferLimitsConfig = {
  maxOffersPerSpin: number;
  spinLimit: number;
  spinWindowSeconds: number;
  claimLimit: number;
  claimWindowSeconds: number;
  runtimeMutationLimit: number;
  runtimeMutationWindowSeconds: number;
  dashboardManualAssignLimit: number;
  dashboardManualAssignWindowSeconds: number;
  spinAgeBucketMs: number;
  spinRotationWindowMs: number;
  hydrateLockTtlSeconds: number;
  hydrateWaitMs: number;
  hydratePollMs: number;
  locationFreshSeconds: number;
};

export const DEFAULT_OFFER_LIMITS: OfferLimitsConfig = {
  maxOffersPerSpin: 5,
  spinLimit: 30,
  spinWindowSeconds: 60,
  claimLimit: 20,
  claimWindowSeconds: 60,
  runtimeMutationLimit: 20,
  runtimeMutationWindowSeconds: 60,
  dashboardManualAssignLimit: 30,
  dashboardManualAssignWindowSeconds: 60,
  spinAgeBucketMs: 60_000,
  spinRotationWindowMs: 15_000,
  hydrateLockTtlSeconds: 8,
  hydrateWaitMs: 2_000,
  hydratePollMs: 50,
  locationFreshSeconds: 120,
};

const parseIntDefault = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fallback;
  return value;
};

/** Load offer rate-limit / spin caps from env with documented defaults. */
export function loadOfferLimits(
  env: Record<string, string | undefined> = process.env,
): OfferLimitsConfig {
  return {
    maxOffersPerSpin: 5,
    spinLimit: parseIntDefault(
      env,
      "DRIVER_OFFER_SPIN_LIMIT",
      DEFAULT_OFFER_LIMITS.spinLimit,
      1,
      10_000,
    ),
    spinWindowSeconds: parseIntDefault(
      env,
      "DRIVER_OFFER_SPIN_WINDOW",
      DEFAULT_OFFER_LIMITS.spinWindowSeconds,
      1,
      86_400,
    ),
    claimLimit: parseIntDefault(
      env,
      "DRIVER_OFFER_CLAIM_LIMIT",
      DEFAULT_OFFER_LIMITS.claimLimit,
      1,
      10_000,
    ),
    claimWindowSeconds: parseIntDefault(
      env,
      "DRIVER_OFFER_CLAIM_WINDOW",
      DEFAULT_OFFER_LIMITS.claimWindowSeconds,
      1,
      86_400,
    ),
    runtimeMutationLimit: parseIntDefault(
      env,
      "DRIVER_RUNTIME_MUTATION_LIMIT",
      DEFAULT_OFFER_LIMITS.runtimeMutationLimit,
      1,
      10_000,
    ),
    runtimeMutationWindowSeconds: parseIntDefault(
      env,
      "DRIVER_RUNTIME_MUTATION_WINDOW",
      DEFAULT_OFFER_LIMITS.runtimeMutationWindowSeconds,
      1,
      86_400,
    ),
    dashboardManualAssignLimit: parseIntDefault(
      env,
      "DASHBOARD_MANUAL_ASSIGN_LIMIT",
      DEFAULT_OFFER_LIMITS.dashboardManualAssignLimit,
      1,
      10_000,
    ),
    dashboardManualAssignWindowSeconds: parseIntDefault(
      env,
      "DASHBOARD_MANUAL_ASSIGN_WINDOW",
      DEFAULT_OFFER_LIMITS.dashboardManualAssignWindowSeconds,
      1,
      86_400,
    ),
    spinAgeBucketMs: parseIntDefault(
      env,
      "DRIVER_OFFER_SPIN_AGE_BUCKET_MS",
      DEFAULT_OFFER_LIMITS.spinAgeBucketMs,
      1_000,
      3_600_000,
    ),
    spinRotationWindowMs: parseIntDefault(
      env,
      "DRIVER_OFFER_SPIN_ROTATION_WINDOW_MS",
      DEFAULT_OFFER_LIMITS.spinRotationWindowMs,
      1_000,
      3_600_000,
    ),
    hydrateLockTtlSeconds: parseIntDefault(
      env,
      "DRIVER_RUNTIME_HYDRATE_LOCK_TTL_SECONDS",
      DEFAULT_OFFER_LIMITS.hydrateLockTtlSeconds,
      1,
      60,
    ),
    hydrateWaitMs: parseIntDefault(
      env,
      "DRIVER_RUNTIME_HYDRATE_WAIT_MS",
      DEFAULT_OFFER_LIMITS.hydrateWaitMs,
      50,
      30_000,
    ),
    hydratePollMs: parseIntDefault(
      env,
      "DRIVER_RUNTIME_HYDRATE_POLL_MS",
      DEFAULT_OFFER_LIMITS.hydratePollMs,
      10,
      5_000,
    ),
    locationFreshSeconds: parseIntDefault(
      env,
      "DRIVER_LOCATION_FRESH_SECONDS",
      DEFAULT_OFFER_LIMITS.locationFreshSeconds,
      1,
      86_400,
    ),
  };
}
