# M4-B — Driver Order Offers, Claiming, Redis Runtime, Manual Peak Assignment

## Scope

- City driver pricing (SUPER_ADMIN control plane)
- Offer rounds (`OPEN` → `CLAIMED` | `MANUALLY_ASSIGNED` | `STOPPED` | `CANCELLED`)
- Driver spin (≤5 cards: `offerId` + `offeredDriverFee` only)
- Atomic driver claim and dashboard peak assignment (max 2 active orders)
- Redis runtime / open-offer index / distributed rate limits / hydrate lock
- Mandatory `Idempotency-Key` on mutating offer/pricing/claim/assign routes
- PostgreSQL remains source of truth

## Migrations

Apply journal through `0027_breezy_red_wolf`:

```bash
bun run db:migrate
```

`0027` adds:

- Assignment historical pricing snapshot columns + check when `offer_round_id` is null
- Offer-round status/field check constraints
- Pricing stages JSON array checks
- Idempotency `IN_PROGRESS` / `COMPLETED` lifecycle columns
- Active-driver assignment index includes `assignment_sequence`

## Fee formula

```text
rawFee = pricingBase + (pricingBase × increasePercentage / 100)
offeredDriverFee = round half-up to nearest roundingUnit
```

Stage is derived at read/claim time from `now - openedAt` against the round snapshot. The last stage never expires.

### Manual assignment without an open round

When the workflow allows direct assign and no `OPEN` round exists:

1. Load current city driver pricing inside the transaction
2. Freeze `driverFee` plus full pricing snapshot on `order_driver_assignments`
3. Later city pricing edits do not rewrite historical assignment rows

DB rejects assignments that have neither `offer_round_id` nor a complete snapshot.

## Cancellation → assignment lifecycle

When an assigned order moves to a cancelled/terminal path handled by M4-A cancel:

1. Single PostgreSQL transaction
2. Lock order → active assignment → driver (stable order)
3. Close active assignment with `cancelledAt` (never delete)
4. Cancel open offer rounds for that order
5. Count remaining active assignments for the driver
6. After commit only, update Redis runtime:
   - remaining > 0 → `BUSY`
   - remaining = 0 and runtime was `OFFLINE`/missing → stay `OFFLINE`
   - remaining = 0 and driver was online/available → `AVAILABLE`
7. Idempotent cancel does not re-close or duplicate audit

Driver-cancel → reoffer is out of scope.

## Runtime cache miss / OFFLINE

- PostgreSQL is truth for assignments, eligibility, account, profile
- Redis holds momentary work status + GPS
- Hydrate from PG: `activeOrderCount > 0` → `BUSY`, else **`OFFLINE`** (never invent `AVAILABLE`)
- Drivers become `AVAILABLE` only via the availability endpoint after PG eligibility + zero active orders
- Login does not mark `AVAILABLE`
- Continuous GPS is Redis-only (not written to PostgreSQL)
- Driver logout invalidates runtime cache
- Claim/spin/assign always re-check PostgreSQL eligibility and capacity

## Idempotency

Required header:

```http
Idempotency-Key: <unique-value>
```

On at least: claim, manual assign, open/stop/reopen offer round, city driver pricing PUT.

Scope: `API version + operation + authenticated actor + city + key`.

- Same key + same canonical payload hash → same status + body (replay)
- Same key + different payload → `IDEMPOTENCY_KEY_REUSED`
- Concurrent same key: unique constraint + `FOR UPDATE`; in-flight → `IDEMPOTENCY_IN_PROGRESS`
- Success response stored only after PG commit path completes inside the transaction
- Failed/aborted work deletes `IN_PROGRESS` reservation so retries are possible
- Full key values are not written to application logs

## Spin rotation

- Prefer older age buckets (`DRIVER_OFFER_SPIN_AGE_BUCKET_MS`, default 60s)
- Within a bucket, deterministic shuffle from driver id + offer id + rotation window (`DRIVER_OFFER_SPIN_ROTATION_WINDOW_MS`, default 15s)
- Same driver + same window → stable order; new window → deterministic reshuffle
- Different drivers diverge when eligible set > 5
- Cap 5; no `Math.random()`; older offers are not starved by newer ones
- Cards expose fee only until claim succeeds

## Hydration distributed lock

| Env | Default | Meaning |
|---|---|---|
| `DRIVER_RUNTIME_HYDRATE_LOCK_TTL_SECONDS` | 8 | Lock TTL (owner token + Lua compare-and-delete) |
| `DRIVER_RUNTIME_HYDRATE_WAIT_MS` | 2000 | Waiter budget |
| `DRIVER_RUNTIME_HYDRATE_POLL_MS` | 50 | Cache poll interval while waiting |

Waiters poll Redis for the owner-built cache; they do not immediately stampede PostgreSQL. Redis failure falls back to a single PG hydrate. Expired locks allow a new owner.

## Candidates read model

`GET /api/v1/dashboard/drivers/assignment-candidates` (`orders.assign`, city-scoped; SUPER_ADMIN blocked):

- `driverId`, `driverName`, `workStatus`, `eligibilityStatus`, `activeOrderCount`
- `currentOrderSummary` / `nextOrderSummary` (by `assignmentSequence`, max 2)
- `lastLocation`, `lastLocationAt`, `locationFreshness` (`FRESH` | `STALE` | `MISSING`)
- Fixed number of PG queries + Redis `MGET` (no per-driver loops)
- GPS never invented; missing location is null; GPS not required for claim/assign

Location freshness uses `DRIVER_LOCATION_FRESH_SECONDS` (default 120).

## Redis keys (`pip-pip:{NODE_ENV}:…`)

| Key | Purpose | TTL |
|---|---|---|
| `driver:runtime:{driverId}` | Eligibility / workStatus / activeOrderCount | 86400s |
| `driver:runtime:hydrate:{driverId}` | Stampede lock | hydrate lock TTL |
| `city:{cityId}:open-offers` | ZSET of open offer ids by openedAt | none (reconciled) |
| `offer:{offerId}` | Offer summary JSON | 86400s |
| `driver:location:{driverId}` | Optional realtime write contract | 120s freshness |
| `rate-limit:{scope}:{identity}` | Distributed limits | window seconds |

## Endpoints

| Method | Path | Auth / permission | Idempotency-Key |
|---|---|---|---|
| GET/PUT | `/api/v1/dashboard/cities/:cityId/driver-pricing` | SUPER_ADMIN | PUT required |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/open` | `order_offers.manage` | required |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/stop` | `order_offers.manage` | required |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/reopen` | `order_offers.manage` | required |
| GET | `/api/v1/dashboard/orders/:orderId/offer-rounds` | `order_offers.read` | |
| POST | `/api/v1/dashboard/orders/:orderId/assign-driver` | `orders.assign` | required |
| GET | `/api/v1/dashboard/drivers/assignment-candidates` | `orders.assign` | |
| POST | `/api/v1/mobile/driver/order-offers/spin` | DRIVER_APP | |
| POST | `/api/v1/mobile/driver/order-offers/:offerId/claim` | DRIVER_APP | required |
| POST | `/api/v1/mobile/driver/runtime/availability` | DRIVER_APP | |

SUPER_ADMIN cannot run city order-offer or assign operations (pricing only).

## Out of scope

Driver cancel/reoffer, >2 active orders, GPS eligibility, auto-assign, Socket.IO in this API, push notifications, driver reordering, final driver payout settlement.
