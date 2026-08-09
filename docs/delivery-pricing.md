# Routing and versioned delivery pricing

## Lifecycle and cache

Pricing values are immutable. SUPER_ADMIN creates a DRAFT and explicitly activates it; activation atomically retires the previous ACTIVE version. INACTIVE is terminal. PostgreSQL enforces one ACTIVE version per City.

Active reads use Redis cache-aside with key `delivery-pricing:active:v1:{cityId}`. The validated server-side payload contains only pricing, fallback, provider name, timeout, currency, lifecycle, and IDs—never Customer/Store/address data, credentials, URLs, headers, or secrets. `DELIVERY_PRICING_CACHE_TTL_SECONDS` defaults to 21600 seconds and receives deterministic ±10% jitter.

PostgreSQL remains authoritative. Cache miss/corruption reloads DB; Redis failure logs a sanitized event and falls back to DB. Activation writes through only after commit, with one quick retry. Migration 0024 adds a globally monotonic `activationRevision`. A Redis Lua CAS writes only when the incoming revision is not older, preventing a pre-activation cache-miss reader from overwriting the newly activated value.

Lua CAS alone is not sufficient: if every post-commit Redis write fails, Redis can recover while still holding the old value until TTL. Therefore every otherwise-valid cache hit performs one lightweight PostgreSQL query for the City's current ACTIVE `activation_revision`. Only an exact match is accepted. A mismatch loads the full ACTIVE row once through the existing single-flight path and attempts CAS refill. The returned pricing object is frozen and remains unchanged for the whole quote.

This revision validation is the cross-instance consistency barrier. It uses durable PostgreSQL state rather than process memory or Redis availability. On activation success, the revision and pricing change commit together before write-through. On rollback, neither revision nor cache value changes and no activation audit success exists. If post-commit write-through fails—or Redis later recovers with an old value—the next read detects the revision mismatch and uses PostgreSQL. A reader that loaded the old row before activation cannot republish it over the newer revision because Lua CAS still rejects the older revision.

The trade-off is one indexed scalar PostgreSQL read on each cache hit; the full pricing configuration remains cached and is not reread when the revision matches. TTL is cleanup/refresh only, never the consistency mechanism. In-process promise deduplication reduces full-row reload stampedes and its entry is removed in `finally` on success and failure.

## Routing and fallback

OSRM is behind `RoutingProvider`; tests use fakes. `OSRM_PROFILE` is strictly `driving`. Each request has at most two independent timed attempts. Retry is limited to timeout/network errors and HTTP 408/429/502/503/504, with a small bounded jitter and a bounded numeric `Retry-After` for 429. No retry occurs for NoRoute, cancellation, invalid coordinates/JSON/schema, permanent HTTP errors, or internal errors.

Typed classifications are `NO_ROUTE`, `TIMEOUT`, `NETWORK_ERROR`, `TEMPORARY_HTTP_ERROR`, `PERMANENT_HTTP_ERROR`, `INVALID_JSON`, `INVALID_PROVIDER_RESPONSE`, `INVALID_COORDINATES`, `REQUEST_CANCELLED`, and `INTERNAL_ERROR`.

NoRoute fallback requires `fallbackOnNoRoute`. Provider-failure fallback requires an exhausted transient classification and `fallbackOnProviderFailure`. Other classifications never fall back. Straight-line pricing uses `ceil(ST_DistanceSphere(...)) + fallbackExtraDistanceMeters`; routed OSRM meters remain unrounded until rational integer-safe pricing.

## Contracts and arithmetic

Outside Zone, NoRoute without fallback, and maximum-distance breaches are domain-unavailable HTTP 200 results with `deliveryFee=null`. Exhausted transient routing without fallback is sanitized `ROUTING_UNAVAILABLE`/503. Successful public results expose only safe UI fields. A separate internal snapshot includes coordinates, formula inputs, rational raw numerator/denominator, route/fallback evidence, version, and final integer IQD fee; it is not persisted or returned publicly.

Formula: billable meters are `max(0, pricingDistance-includedDistance)`, raw fee is `baseFee + billable*pricePerKm/1000`, and final fee is rounded upward to `roundingStep`. Configuration is bounded by PostgreSQL integer limits and rejects unsafe, contradictory, NaN, infinite, negative, overflow, and invalid maximum values.

Routing attempt logs contain sanitized host and typed metadata, never full URLs, coordinates, headers, provider bodies, or personal data. Pricing creation/activation uses the existing `audit_logs` table and records success inside the DB transaction.

No OSRM container is bundled because it requires a prepared dataset. Configure `OSRM_BASE_URL`, `OSRM_TIMEOUT_MS`, and the fixed driving profile. Suggested future metrics—without IDs as labels—are request/success/NoRoute/failure/fallback counts, latency, and unavailable quotes; no metrics dependency is added now.
