# Routing and versioned delivery pricing

Delivery pricing versions are immutable. A SUPER_ADMIN creates a DRAFT for a non-archived City and explicitly activates it; activation atomically retires the previous ACTIVE version. INACTIVE versions are terminal and historical values can only be reused by creating a new version. PostgreSQL enforces one ACTIVE version per City and guards value immutability.

The Customer estimate endpoint requires Customer authentication, `X-City-Id`, a public ACTIVE Store (ACCEPTING or PAUSED), and exactly one of an owned same-City `addressId` or destination coordinates. The destination must be covered by an ACTIVE Zone assigned to the Store. Otherwise it returns `deliveryAvailable=false`, `reason=ADDRESS_OUTSIDE_DELIVERY_ZONE`, and no fee, without invoking routing.

OSRM implements the replaceable routing-provider interface and is configured using `OSRM_BASE_URL`, `OSRM_PROFILE`, and `OSRM_TIMEOUT_MS`. No OSRM container is bundled because a usable instance requires a prepared dataset. Tests use the fake provider.

OSRM meters are priced without whole-meter pre-rounding. When an enabled policy permits fallback, PostGIS `ST_DistanceSphere` is rounded upward with `ceil` to the next whole meter, then `fallbackExtraDistanceMeters` is added. Sources are exactly `ROUTE` and `STRAIGHT_LINE_FALLBACK`. Coordinates and provider response bodies are excluded from structured logs.

Only `deliveryFee` in integer IQD is calculated. No Cart/Order snapshot, delivery promotion, discount, coupon, or Checkout behavior is included.
