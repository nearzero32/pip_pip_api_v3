# M2 Authentication & Security — Implementation Report

Date: 2026-08-03

## Baseline

- Branch: `main`.
- Baseline commit: `a0e7c1f`.
- The worktree was clean before this implementation pass.
- The previous incomplete M2 implementation exposed `/api/v1/auth` routes and Driver OTP. Both conflicted with the final requirements and were replaced.
- Legacy v2 was not modified.

## Implemented architecture

Authentication is separated into three public adapters while sharing internal hashing, token, session, rate-limit, audit, and redaction primitives:

| Consumer | Boundary | Authentication | Application | JWT audience | Session maximum |
|---|---|---|---|---|---:|
| Customer Mobile | `/api/v1/mobile/customer` | Phone + OTP | `CUSTOMER_APP` | `customer-app` | 5 |
| Driver Mobile | `/api/v1/mobile/driver` | Phone + numeric access code | `DRIVER_APP` | `driver-app` | 1 |
| Dashboard | `/api/v1/dashboard` | Email + password | `DASHBOARD` | `dashboard` | 3 |

Application type and JWT audience are constructed from server-owned route context. Authentication request bodies cannot select them.

### Customer endpoints

```text
POST   /api/v1/mobile/customer/auth/otp/request
POST   /api/v1/mobile/customer/auth/otp/verify
POST   /api/v1/mobile/customer/auth/token/refresh
POST   /api/v1/mobile/customer/auth/logout
POST   /api/v1/mobile/customer/auth/logout-all
GET    /api/v1/mobile/customer/auth/sessions
DELETE /api/v1/mobile/customer/auth/sessions/:sessionId
```

### Driver endpoints

```text
POST   /api/v1/mobile/driver/auth/login
POST   /api/v1/mobile/driver/auth/token/refresh
POST   /api/v1/mobile/driver/auth/logout
GET    /api/v1/mobile/driver/auth/sessions
DELETE /api/v1/mobile/driver/auth/sessions/:sessionId
```

Driver authentication uses a normalized phone number and a permanent access code represented as an ASCII-digit string of 6–12 characters. Leading zeroes are preserved. Only an Argon2id hash is stored. Missing hashes, unknown phones, invalid codes, blocked accounts, and ineligible Drivers return the same generic failure. A successful login transactionally replaces the previous Driver session without revoking Customer sessions.

Driver OTP and Driver `logout-all` were not implemented.

### Dashboard endpoints

```text
POST   /api/v1/dashboard/auth/login
POST   /api/v1/dashboard/auth/token/refresh
POST   /api/v1/dashboard/auth/logout
POST   /api/v1/dashboard/auth/logout-all
GET    /api/v1/dashboard/auth/sessions
DELETE /api/v1/dashboard/auth/sessions/:sessionId
```

## Security controls

- Customer OTP is six numeric digits, valid for five minutes, single-use, limited to five verification attempts, and subject to a 60-second resend cooldown.
- PostgreSQL advisory and row locks serialize challenge replacement, challenge consumption, account creation, session limits, and refresh rotation.
- Driver access codes and Dashboard passwords use configurable Argon2id hashes.
- Unknown Driver and Dashboard identities use dummy Argon2id verification based on the configured parameters.
- Access tokens are Ed25519/EdDSA JWTs with a ten-minute lifetime and strict issuer, key ID, audience, application, subject, session, issued-at, expiry, and token-ID validation.
- Protected operations revalidate applicable account, profile/staff, role, and session state in PostgreSQL.
- Refresh tokens contain 256 random bits. Only versioned HMAC-SHA-256 verifiers are stored.
- Refresh rotation has one transactional winner. Cross-application refresh attempts do not consume or rotate the valid token.
- Confirmed Customer or Driver reuse revokes the affected application session. Dashboard reuse revokes the account's Dashboard sessions.
- Session listing, targeted revocation, and logout-all are ownership- and application-scoped.
- Redis counters use separate Customer, Driver, and Dashboard namespaces and atomic TTL-backed operations.
- Authentication-context selector fields are rejected.
- Recursive redaction covers passwords, access codes and hashes, OTPs and verifiers, tokens, Authorization headers, cookies, keys, credentials, and nested error metadata.
- Audit metadata is allowlisted and preserves constrained textual request IDs.
- Rate-limit responses include `Retry-After` when applicable.
- Production errors do not expose stack traces or infrastructure details.

## Database migrations

### `drizzle/0006_square_gertrude_yorkes.sql`

Adds `DRIVER_ACCESS_CODE` to the PostgreSQL `authentication_method` enum. It is isolated because PostgreSQL requires a commit before a newly added enum value is used.

### `drizzle/0007_driver_access_code_foundation.sql`

- Adds nullable `driver_profiles.access_code_hash` for safe M1-to-M2 upgrades.
- Adds `sessions_account_application_active_idx`.
- Revokes and retires legacy Driver sessions recorded with `PHONE_OTP`.
- Enforces the following database-level authentication-method combinations:
  - Customer → `PHONE_OTP`.
  - Driver → `DRIVER_ACCESS_CODE`.
  - Dashboard → `PASSWORD`.

Historical migrations were not rewritten. Clean-database and M1-to-M2 upgrade tests passed. A final `db:generate` reported no schema changes, confirming no unexplained migration drift.

## Files created

```text
drizzle/0006_square_gertrude_yorkes.sql
drizzle/0007_driver_access_code_foundation.sql
drizzle/meta/0006_snapshot.json
drizzle/meta/0007_snapshot.json
src/modules/auth/auth-module.ts
src/modules/auth/core/context.ts
src/modules/auth/dashboard/dashboard-auth.routes.ts
src/modules/auth/dashboard/dashboard-auth.service.ts
src/modules/auth/http/shared.ts
src/modules/auth/mobile/customer/customer-auth.routes.ts
src/modules/auth/mobile/customer/customer-auth.service.ts
src/modules/auth/mobile/driver/driver-auth.routes.ts
src/modules/auth/mobile/driver/driver-auth.service.ts
src/modules/auth/sessions/session-service.ts
```

The previous oversized `src/modules/auth/auth-service.ts` was removed and replaced by consumer-specific services plus shared security primitives.

## Tests

Unit result:

```text
32 passed
0 failed
207 assertions
```

PostgreSQL/Redis integration result:

```text
23 passed
0 failed
89 assertions
```

Coverage includes configuration, normalization, OTP and refresh entropy, HMAC verification, Argon2id, EdDSA validation, recursive redaction, request IDs, safe errors, exact routes, obsolete-route rejection, OpenAPI security, Redis atomic TTL behavior, clean migration, M1-to-M2 upgrade, OTP replacement/exhaustion/concurrent consumption, Customer and Dashboard limits, Driver access-code behavior and session replacement, refresh concurrency/reuse, application isolation, ownership, and audit redaction.

## Verification results

| Command/check | Result |
|---|---|
| `bun install --frozen-lockfile` | PASS |
| `bun run typecheck` | PASS |
| `bun run test:unit` | PASS |
| `bun run test:integration` | PASS |
| `bun run db:check` | PASS |
| `bun run db:generate` | PASS — no drift |
| `bun run build` | PASS |
| `docker compose config --quiet` | PASS |
| `docker compose build` | PASS |
| `docker compose up -d --wait api` | PASS |
| `GET /health/live` | PASS |
| `GET /health/ready` | PASS |
| `GET /openapi/json` | PASS |
| OpenAPI exact authentication route check | PASS — 18 routes |
| OpenAPI Bearer security check | PASS |
| Obsolete Driver OTP request | PASS — returned 404 |

Temporary failures encountered and resolved:

- An additional `applicationType` field was initially stripped by Elysia before a hook could inspect it. Schema-level rejection was added.
- One integration test used a phone number containing `+` as a request ID, correctly triggering the database request-ID constraint. The test data was corrected.
- Initial Docker and localhost HTTP attempts were denied by the execution sandbox. They were rerun with the required local permission and passed; this was environmental, not a code failure.

No final verification command remains failed or unexecuted.

## Runtime and dependency versions

```text
Bun / @types/bun: 1.3.14
Elysia: 1.4.29
@elysiajs/openapi: 1.4.15
drizzle-orm: 0.45.2
drizzle-kit: 0.31.10
TypeScript: 7.0.2
PostgreSQL image: postgres:17.6-alpine
Redis image: redis:7.4.2-alpine
Bun image: oven/bun:1.3.14-alpine
```

The existing production model remains `bun build` to `dist/`; M2 did not rewrite deployment architecture. Generated SQL migrations remain available in the runtime image.

## Live development URLs

```text
http://localhost:3000/health/live
http://localhost:3000/health/ready
http://localhost:3000/openapi
http://localhost:3000/openapi/json
```

After verification, the API and Redis services started during this pass were stopped. The pre-existing PostgreSQL service and persistent volume were left intact.

## Remaining risks and owner decisions

- A real production OTP/SMS adapter is not selected. Production startup intentionally rejects development/test adapters.
- Driver access-code assignment through Dashboard is deferred.
- Argon2id production parameters require benchmarking on deployment hardware.
- The 30-day absolute session lifetime follows the approved Identity & Access design; inactivity-expiry policy remains unresolved.
- Production signing/HMAC key storage and operational rotation require deployment infrastructure.
- Device/IP privacy and retention policy remains unresolved.
- The complete staff permission matrix and atomic final-active-SUPER_ADMIN protection remain deferred.

## Explicit exclusions

The following were not implemented:

- Driver OTP.
- Driver access-code Dashboard management.
- MFA, TOTP, Recovery Codes, Password Reset, or forgot-password.
- Cities, Zones, Geographic Service Areas, or PostGIS.
- Stores, Orders, or Carts.
- Driver onboarding or Driver application submission.
- Production SMS integration or production deployment.

## Worktree handoff

All reviewed changes remain uncommitted in the worktree for owner inspection. No commit, push, pull request, production access, or legacy-v2 modification was performed during this implementation pass.
