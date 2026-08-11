# M4-A: Orders Core

## Lifecycle

Operational states:

```text
UNDER_STORE_REVIEW
→ APPROVED_BY_STORE
→ SEARCHING_DRIVER
→ DRIVER_ASSIGNED
→ READY_FOR_PICKUP
→ ACCEPTED_BY_DRIVER
→ PICKED_UP
→ ARRIVED_AT_CUSTOMER
→ DELIVERED
```

Terminal cancel state: `CANCELLED` (single status; actor/source live in `order_cancellations`).

There is no `PENDING_STORE_REVIEW` and no per-actor cancel statuses. Allowed transitions are centralized in `order-state-machine.ts`. Invalid transitions raise `ORDER_INVALID_STATE`. Concurrent transitions use `SELECT … FOR UPDATE` plus optimistic `orders.version`.

## Actors and actions

| Action | Customer | Merchant (own store) | City ADMIN | Employee | SUPER_ADMIN |
|---|---|---|---|---|---|
| Create | yes | — | — | — | — |
| Read own / city / store | own only | store only | city (`orders.read` implicit) | `orders.read` | blocked |
| Cancel | only `UNDER_STORE_REVIEW`, own order | **no endpoint** | yes | `orders.cancel` + reason | blocked |
| Approve | — | yes | yes | `orders.approve` | blocked |
| Replace item | — | yes | yes | `orders.items.replace` | blocked |

Driver endpoints are deferred.

## Cancellation

- Customer: only `UNDER_STORE_REVIEW`; otherwise `ORDER_CANCELLATION_NOT_ALLOWED`.
- Dashboard: any non-terminal state; mandatory non-empty reason; cross-city IDs → `ORDER_NOT_FOUND`.
- Atomic: status → `CANCELLED`, close/open history, insert cancellation audit.

## Product replacement

Allowed only while `UNDER_STORE_REVIEW`. Customer agreement is by phone (`customerAgreedByPhone: true`); no electronic approval workflow and no `ITEM_REPLACEMENT_PENDING` state.

Atomic steps: mark original `REPLACED`, insert new item with `replacesOrderItemId`, write `order_item_replacements` audit, recalculate product subtotal + total. Delivery fee and delivery-pricing snapshot are never mutated. Already-replaced items → `ORDER_ITEM_ALREADY_REPLACED`.

## Status history durations

On create: one open history row (`fromStatus=null`, `toStatus=UNDER_STORE_REVIEW`, `exitedAt=null`). On transition: lock order + open row, set `exitedAt` and non-negative `durationSeconds` from one transaction clock, insert the next open row, update `orders.status` / `statusChangedAt` / `version`. Partial unique index enforces at most one open row. Live current-state duration = `now - statusChangedAt` (client must not send durations). Replacement does not write history.

## Snapshots

Order creation persists immutable product lines, address snapshot, and delivery-pricing snapshot from `DeliveryPricingService.estimate` (server-side). Later catalog/address/pricing changes do not alter historical orders. Clients never supply fees, prices, zone IDs, or routing results.

## Payment boundary

Schema supports `CASH` and `ONLINE` payment methods and payment statuses (`UNPAID`, `AWAITING_PAYMENT`, `PAID`, `FAILED`).

Operational creation in M4-A:

- `CASH` orders are created as `UNPAID` and enter `UNDER_STORE_REVIEW`.
- `ONLINE` creation is rejected with `ORDER_ONLINE_PAYMENT_NOT_CONFIRMED`. No order, items, snapshots, status history, or idempotency-success row is written. ONLINE remains schema-supported for a future trusted payment-provider / webhook confirmation flow; until that exists, ONLINE must not become an operational order.

Approve and item-replace independently reject any non-`CASH` order whose `paymentStatus` is not `PAID` (same `ORDER_ONLINE_PAYMENT_NOT_CONFIRMED`), so unverified online rows cannot be mutated even if inserted outside the create API. Card data and payment credentials are never stored.

## Idempotency

`POST /api/v1/mobile/customer/orders` requires `idempotencyKey`. Scoped by customer + city; same payload replays the original order; different payload → `ORDER_IDEMPOTENCY_CONFLICT`. Concurrent duplicates are serialized with a transactional advisory lock.

## Deferred (next milestones)

- Online payment-provider integration, webhook confirmation, and operational ONLINE order creation
- Refunds
- Driver search / dispatch (`SEARCHING_DRIVER` and later transitions)
- Driver acceptance, pickup, arrival, delivery actions
- Real-time tracking / Socket.IO
- Notifications
- Automatic system cancellation
- Order edits other than controlled item replacement
