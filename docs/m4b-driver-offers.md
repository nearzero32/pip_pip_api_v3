# M4-B — Driver Order Offers, Claiming, Redis Runtime, Manual Peak Assignment

## Scope

- City driver pricing (SUPER_ADMIN control plane)
- Offer rounds (OPEN → CLAIMED | MANUALLY_ASSIGNED | STOPPED | CANCELLED)
- Driver spin (≤5 cards: `offerId` + `offeredDriverFee` only)
- Atomic driver claim and dashboard peak assignment (max 2 active orders)
- Redis runtime / open-offer index / distributed rate limits
- PostgreSQL remains source of truth

## Migrations

Apply journal through `0026_small_sunset_bain`:

```bash
bun run db:migrate
# or Compose one-shot migrate service
```

## Fee formula

```text
rawFee = pricingBase + (pricingBase × increasePercentage / 100)
offeredDriverFee = round half-up to nearest roundingUnit
```

Stage is derived at read/claim time from `now - openedAt` against the round snapshot. The last stage never expires.

## Redis keys (`pip-pip:{NODE_ENV}:…`)

| Key | Purpose | TTL |
|---|---|---|
| `driver:runtime:{driverId}` | Eligibility / workStatus / activeOrderCount | 86400s |
| `driver:runtime:hydrate:{driverId}` | Stampede lock | 5s |
| `city:{cityId}:open-offers` | ZSET of open offer ids by openedAt | none (reconciled) |
| `offer:{offerId}` | Offer summary JSON | 86400s |
| `driver:location:{driverId}` | Optional realtime write contract | 120s freshness |
| `rate-limit:{scope}:{identity}` | Distributed limits | window seconds |

Cache miss: hydrate runtime once under lock from PostgreSQL. Stale open-offer ZSET members are removed after PG OPEN verification on spin. Redis write failures after commit invalidate keys and log; claim always re-checks PostgreSQL.

## Endpoints

| Method | Path | Auth / permission |
|---|---|---|
| GET/PUT | `/api/v1/dashboard/cities/:cityId/driver-pricing` | SUPER_ADMIN |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/open` | `order_offers.manage` |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/stop` | `order_offers.manage` |
| POST | `/api/v1/dashboard/orders/:orderId/offer-rounds/reopen` | `order_offers.manage` |
| GET | `/api/v1/dashboard/orders/:orderId/offer-rounds` | `order_offers.read` |
| POST | `/api/v1/dashboard/orders/:orderId/assign-driver` | `orders.assign` |
| GET | `/api/v1/dashboard/drivers/assignment-candidates` | `orders.assign` |
| POST | `/api/v1/mobile/driver/order-offers/spin` | DRIVER_APP |
| POST | `/api/v1/mobile/driver/order-offers/:offerId/claim` | DRIVER_APP + Idempotency-Key |
| POST | `/api/v1/mobile/driver/runtime/availability` | DRIVER_APP |

SUPER_ADMIN cannot run city order-offer or assign operations.

## Out of scope

Driver cancel/reoffer, >2 active orders, GPS eligibility, auto-assign, Socket.IO in this API, push notifications, driver reordering.
