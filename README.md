# pip_pip_api_v3

M1 provides the executable API and Identity & Access database foundation. M2 adds Customer phone OTP, Driver phone plus permanent numeric access-code authentication, Dashboard password authentication, Ed25519 access tokens, rotating refresh sessions, Redis abuse controls, and application-scoped session management. Legacy v2 is migration evidence only.

## Requirements

- Bun 1.3.14
- Docker with Compose, or PostgreSQL 17 and Redis 7.4 for local execution

## Local development

```bash
cp .env.example .env
docker compose up -d --wait postgres redis
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Compose publishes PostgreSQL on host port `5433` and Redis on `6380` to avoid conventional local ports; containers use `postgres:5432` and `redis:6379` internally. The one-shot `migrate` service runs after PostgreSQL is healthy. The API starts only after PostgreSQL and Redis are healthy and migrations succeed.

The local API is available at:

- Liveness: `http://localhost:3000/health/live`
- Readiness: `http://localhost:3000/health/ready`
- OpenAPI UI: `http://localhost:3000/openapi`
- OpenAPI JSON: `http://localhost:3000/openapi/json`

All public application APIs use one of the authoritative server-owned boundaries below. No shared `/api/v1/auth`, unprefixed, or compatibility aliases are exposed, and request input cannot select an application or JWT audience.

### M2 authentication endpoints

Customer Mobile (`CUSTOMER_APP`, audience `customer-app`, maximum five sessions):

- `POST /api/v1/mobile/customer/auth/otp/request`
- `POST /api/v1/mobile/customer/auth/otp/verify`
- `POST /api/v1/mobile/customer/auth/token/refresh`
- `POST /api/v1/mobile/customer/auth/logout`
- `POST /api/v1/mobile/customer/auth/logout-all`
- `GET /api/v1/mobile/customer/auth/sessions`
- `DELETE /api/v1/mobile/customer/auth/sessions/:sessionId`

Driver Mobile (`DRIVER_APP`, audience `driver-app`, one replaceable session):

- `POST /api/v1/mobile/driver/auth/login`
- `POST /api/v1/mobile/driver/auth/token/refresh`
- `POST /api/v1/mobile/driver/auth/logout`
- `GET /api/v1/mobile/driver/auth/sessions`
- `DELETE /api/v1/mobile/driver/auth/sessions/:sessionId`

Dashboard (`DASHBOARD`, audience `dashboard`, maximum three sessions):

- `POST /api/v1/dashboard/auth/login`
- `POST /api/v1/dashboard/auth/token/refresh`
- `POST /api/v1/dashboard/auth/logout`
- `POST /api/v1/dashboard/auth/logout-all`
- `GET /api/v1/dashboard/auth/sessions`
- `DELETE /api/v1/dashboard/auth/sessions/:sessionId`

Driver login accepts a normalized phone and an ASCII-digit string `code` of 6–12 characters. Leading zeroes are significant. The nullable legacy-upgrade field stores only its Argon2id hash; Drivers without a hash fail with the same public error as unknown phones and wrong codes. Driver OTP and Driver `logout-all` do not exist.

The development OTP adapter never returns or logs an OTP. Automated tests inject a capture-only adapter. No production SMS adapter is included, so production startup intentionally rejects the unsafe development/test adapters.

Liveness is process-only. Readiness checks PostgreSQL and Redis independently and returns `503` with a non-sensitive component status when either dependency is unavailable.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Watch-mode development server |
| `bun run start` | Run the production bundle |
| `bun run build` | Build to `dist/` with Bun |
| `bun run typecheck` | Strict TypeScript check |
| `bun test` / `bun run test:unit` | Unit tests; PostgreSQL is not required |
| `bun run test:integration` | Real temporary-PostgreSQL integration tests |
| `bun run db:generate` | Generate deterministic SQL migrations from Drizzle schema |
| `bun run db:migrate` | Apply generated migrations from source |
| `bun run db:migrate:prod` | Apply generated migrations from the production bundle |
| `bun run db:check` | Check Drizzle migration snapshot consistency |

Integration tests require explicit local PostgreSQL and Redis URLs:

```bash
TEST_ADMIN_DATABASE_URL=postgresql://pip_pip_dev:pip_pip_dev_only@localhost:5433/pip_pip_v3 \
TEST_REDIS_URL=redis://localhost:6380 \
bun run test:integration
```

The test runner refuses non-local services and production-looking database names. Each run creates only a cryptographically random `pip_pip_v3_test_*` database, applies the full migration history, and removes that isolated database afterward. It never falls back to the application `DATABASE_URL`.

## Configuration

All variables are startup-validated:

- `NODE_ENV`: `development`, `test`, or `production`
- `HOST`
- `PORT`: 1–65535
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`
- `DATABASE_URL`: PostgreSQL URL; never logged
- `DATABASE_POOL_SIZE`: 1–100
- `DATABASE_CONNECTION_TIMEOUT_MS`
- `GRACEFUL_SHUTDOWN_TIMEOUT_MS`
- `REDIS_URL`: Redis/Valkey URL; never logged
- `OTP_DELIVERY_ADAPTER`: only `development` or `test` exist; both are rejected in production
- `SECRET_VERIFIER_KEY` and `SECRET_VERIFIER_KEY_VERSION`: versioned HMAC key material
- `JWT_ISSUER`, `JWT_KEY_ID`, `JWT_PRIVATE_KEY_BASE64`, `JWT_PUBLIC_KEY_BASE64`
- `ACCESS_TOKEN_LIFETIME_SECONDS`: fixed to the validated maximum of 600 seconds
- `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`

`.env.example` contains local placeholders and a development-only signing key only. Generate and protect deployment keys outside the repository. Production rejects placeholder database credentials, unsafe Argon2 settings, and the development/test OTP adapters. Argon2 values require benchmarking on the actual production hardware; the checked-in development values are not claimed to be universally optimal.

## Database safety boundaries

- Generated SQL migrations are the deployment workflow; `drizzle-kit push` is not used. The runner takes a PostgreSQL advisory lock and commits each journaled migration file independently, which supplies the required commit boundary for safe enum additions.
- Compose runs a one-shot migration service after PostgreSQL becomes healthy and starts the API only after migrations succeed.
- Identity/audit foreign keys use `ON DELETE NO ACTION`; routine flows change logical status rather than physically deleting records.
- `CUSTOMER` and `DRIVER` are profiles, never staff-role rows.
- Only the five staff role identities are seeded. The unresolved permission catalog and role-permission mappings are intentionally empty.
- Driver application documents use provider-neutral object keys and only the evidenced document type/side combinations.
- Driver `ACTIVE` status requires a photo object key.
- A partial unique index permits only one unrevoked driver-app session per account. Driver login revokes the old device and inserts its replacement in one transaction.
- The final-active-SUPER_ADMIN rule and ADMIN city-scope/role consistency require atomic service/database enforcement in a later milestone; M1 stores the necessary assignments/scopes but does not implement those workflows.
- PostgreSQL email uniqueness is applied to required `email_normalized` values. The display/original email is not unique; PostgreSQL's multiple-NULL behavior is irrelevant because normalized email is non-null on every email row.

## Request IDs

`X-Request-Id` may contain 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`, and must start with a letter or digit. Missing or invalid values are replaced with a cryptographically random UUID. The same constrained textual representation is returned in the response header, used in structured logs, and stored as `audit_logs.request_correlation_id`; user-controlled values are never logged unbounded.

## Sensitive data and audit metadata

No schema column stores plaintext passwords, OTPs, raw access/refresh/reset tokens, raw recovery codes, authorization headers, or unencrypted MFA secrets. Verifier/hash/encrypted columns are explicit.

`audit_logs.redacted_metadata` and `password_reset_tokens.request_security_metadata` accept **allowlisted, minimized, redacted keys only**. Passwords, OTPs, tokens, recovery codes, Authorization headers, document contents, and MFA secrets are prohibited. JSON schemas/allowlists belong with the future event-producing application flows.

## Security boundaries

- PostgreSQL is authoritative for OTP attempts, challenge consumption, session state, expiry, and refresh-token generations. Redis holds only temporary abuse counters.
- Raw passwords, OTPs, access/refresh tokens, Authorization headers, cookies, HMAC keys, signing keys, and provider credentials are prohibited from logs and audit metadata. Logging uses recursive central redaction; authentication audit metadata is allowlisted.
- Access tokens are Ed25519/EdDSA JWTs with strict issuer, audience, application, key ID, session, and expiry validation. Every protected request revalidates account/profile/session state in PostgreSQL.
- Refresh tokens contain 256 random bits and only versioned HMAC-SHA-256 verifiers are stored. Each successful refresh rotates once; reuse revokes the affected session, or all Dashboard sessions for Dashboard reuse.
- Generated SQL migrations are the production workflow. Schema push is not used.

## Intentionally deferred

MFA, TOTP application behavior, recovery codes, password reset, forgot-password, staff invitations, real SMS delivery, driver onboarding/submission/review, cities, zones, PostGIS, Orders, Carts, Merchants, Wallets, Notifications, object storage, v2 migration, queues, background jobs, and frontend code are not implemented. Existing M1 tables for deferred MFA/reset foundations remain unused.
