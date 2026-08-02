# pip_pip_api_v3

M1 provides the executable API foundation and PostgreSQL Identity & Access schema. The approved design documents in `../docs/identity-access` and `../docs/adr` are the source of truth. Legacy v2 is migration evidence only.

## Requirements

- Bun 1.3.14
- Docker with Compose, or PostgreSQL 17 for local execution

## Local development

```bash
cp .env.example .env
docker compose up -d postgres
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Compose publishes PostgreSQL on host port `5433` to avoid colliding with a conventional local PostgreSQL on `5432`; containers use `postgres:5432` internally. `docker compose up -d` runs the one-shot `migrate` service after PostgreSQL is healthy and starts the API only after migration success.

The local API is available at:

- Liveness: `http://localhost:3000/health/live`
- Readiness: `http://localhost:3000/health/ready`
- OpenAPI UI: `http://localhost:3000/openapi`
- OpenAPI JSON: `http://localhost:3000/openapi/json`

Liveness is process-only. Readiness performs `select 1` against PostgreSQL and returns 503 when unavailable.

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

Integration tests require an explicit `TEST_ADMIN_DATABASE_URL` pointing to local/Compose PostgreSQL whose user can create/drop databases:

```bash
TEST_ADMIN_DATABASE_URL=postgresql://pip_pip_dev:pip_pip_dev_only@localhost:5433/pip_pip_v3 bun run test:integration
```

The test runner refuses non-local hosts and production-looking database names. Each run creates only a cryptographically random `pip_pip_v3_test_*` database, applies the full migration history, and removes that isolated database afterward. It never falls back to the application `DATABASE_URL`.

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

`.env.example` contains local placeholders only. Production rejects known placeholder database passwords.

## Database safety boundaries

- Generated SQL migrations are the deployment workflow; `drizzle-kit push` is not used.
- Compose runs a one-shot migration service after PostgreSQL becomes healthy and starts the API only after migrations succeed.
- Identity/audit foreign keys use `ON DELETE NO ACTION`; routine flows change logical status rather than physically deleting records.
- `CUSTOMER` and `DRIVER` are profiles, never staff-role rows.
- Only the five staff role identities are seeded. The unresolved permission catalog and role-permission mappings are intentionally empty.
- Driver application documents use provider-neutral object keys and only the evidenced document type/side combinations.
- Driver `ACTIVE` status requires a photo object key.
- A partial unique index permits only one unrevoked driver-app session per account. The future login transaction must revoke the old device before inserting its replacement.
- The final-active-SUPER_ADMIN rule and ADMIN city-scope/role consistency require atomic service/database enforcement in a later milestone; M1 stores the necessary assignments/scopes but does not implement those workflows.
- PostgreSQL email uniqueness is applied to required `email_normalized` values. The display/original email is not unique; PostgreSQL's multiple-NULL behavior is irrelevant because normalized email is non-null on every email row.

## Request IDs

`X-Request-Id` may contain 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`, and must start with a letter or digit. Missing or invalid values are replaced with a cryptographically random UUID. The same constrained textual representation is returned in the response header, used in structured logs, and stored as `audit_logs.request_correlation_id`; user-controlled values are never logged unbounded.

## Sensitive data and audit metadata

No schema column stores plaintext passwords, OTPs, raw access/refresh/reset tokens, raw recovery codes, authorization headers, or unencrypted MFA secrets. Verifier/hash/encrypted columns are explicit.

`audit_logs.redacted_metadata` and `password_reset_tokens.request_security_metadata` accept **allowlisted, minimized, redacted keys only**. Passwords, OTPs, tokens, recovery codes, Authorization headers, document contents, and MFA secrets are prohibited. JSON schemas/allowlists belong with the future event-producing application flows.

## Intentionally absent from M1

No authentication endpoints, SMS, token issuance/refresh, password login, MFA endpoints, staff invitation endpoints, driver workflow endpoints, object-storage integration, v2 migration, carts, orders, merchants, wallets, notifications, Redis, background jobs, or frontend code are implemented.
