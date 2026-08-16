# Dashboard list contract (frontend migration)

Dashboard GET list endpoints now always return nested pagination. There is no dual/compatibility shape.

## Response before → after

| Before | After |
|---|---|
| Raw array `T[]` (offer rounds for one order, delivery pricing versions) | `{ data: T[], pagination: { page, limit, total, totalPages } }` |
| Flat page `{ data, page, limit, total }` (merchants, some catalog lists) | `{ data, pagination: { page, limit, total, totalPages } }` |

Defaults: `page=1`, `limit=25`, max `limit=100`. Pages past the last result return `data: []` with the same `total`.

## Shared query

Every Dashboard LIST GET accepts `search`, `page`, `limit`, `sortBy`, `sortOrder`. Resource filters are documented per endpoint in OpenAPI. Excel `/export` uses the same `search` / filters / `sortBy` / `sortOrder` and **does not** accept `page`/`limit`.

## Scope

- City lists: city comes only from the signed token. `SUPER_ADMIN` is blocked.
- Global lists (governorates, cities, admins, delivery-pricing versions): `SUPER_ADMIN` only. City employees receive 403.
- Mobile / Merchant / Public contracts are unchanged (merchant catalog still uses `{ data }` or flat page helpers).

## Date filters

Date-only values are **Asia/Baghdad** calendar days. `from` is inclusive start of day (`T00:00:00.000+03:00`). `to` is inclusive end of day (`T23:59:59.999+03:00`). Offset date-times are used as sent. `from > to` is 422.

## Intentionally not implemented

- Assignment candidates: `eligibilityStatus`, `workStatus`, `hasLocation`, `lastSeen*` are Redis runtime fields, not PostgreSQL filters. Redis is not the list source of truth.
- Order returns: no `trigger` column; no trigger filter.

## Consumers

Update dashboard clients that treated list bodies as arrays or read `body.page`. Search this repo’s tests under `test/integration` for `.data` + `.pagination`. Do not change mobile/merchant clients.
