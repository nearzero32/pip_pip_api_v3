# M2 — Authentication and Security Readiness Plan

- **Status:** Historical pre-implementation assessment; superseded by the confirmed decisions and implementation in this worktree
- **Prepared:** 2026-08-03
- **Repository:** `nearzero32/pip_pip_api_v3`
- **Verified public revision:** `9e63c54` (`Split database schema by domain`)
- **Source of truth:** Approved Identity & Access documentation and ADRs, subject to the explicit decision conflicts recorded below

## 1. Verified M1 status

This file preserves the verified M1 baseline and threat analysis. Its earlier unresolved recommendations are not current API contracts. Current confirmed decisions are recorded in `m2-confirmed-decisions.md` and the project README.

| Check against public `9e63c54` | Result |
|---|---|
| `bun install --frozen-lockfile` | PASS |
| `bun run typecheck` | PASS |
| `bun run test:unit` | PASS — 18 tests, 31 assertions |
| `bun run build` | PASS |
| `bun run db:check` with development `DATABASE_URL` | PASS |
| `docker compose config` | PASS |
| PostgreSQL integration suite | PASS — 10 groups, 41 assertions |

The first integration attempt failed with `ERR_POSTGRES_CONNECTION_CLOSED` because `docker compose up -d postgres` returned before PostgreSQL became healthy. Repeating with `docker compose up -d --wait postgres` passed. PostgreSQL was stopped afterward without deleting its volume.

M1 is substantively runnable. Two foundation issues should be corrected before or at the start of M2:

1. The integration workflow must explicitly wait for PostgreSQL health.
2. `password_reset_tokens.account_id` and `password_credential_id` are independently foreign-keyed but are not constrained to describe the same account.

## 2. Existing security foundations

The database already provides:

- unified accounts with independent global status;
- unique E.164 phones and normalized emails;
- Argon2id password credential storage;
- password-reset verifier, expiry, consumption, and invalidation fields;
- MFA credentials and hashed recovery-code storage;
- independent customer, driver, and staff profiles;
- five seeded staff role identities without an invented permission matrix;
- application/device sessions;
- refresh-token generations and successor links;
- OTP challenge verifier, expiry, attempts, replacement, and consumption fields;
- constrained textual request IDs in audit logs;
- non-cascading identity/security foreign keys; and
- one unrevoked driver-app session per account.

No authentication application flows exist yet.

## 3. Code and documentation gaps

### Confirmed gaps

- The public repository does not contain the canonical Identity & Access documents or ADRs. The README refers to `../docs`, which is unavailable in a normal clone.
- The README integration sequence does not wait for PostgreSQL health.
- Password-reset account/credential ownership is not jointly constrained.
- OTP challenge `account_id`, `account_phone_id`, and `phone_e164` can be mutually inconsistent unless validated atomically or constrained more strongly.
- Driver profile and approved application ownership are not database-enforced as the same account. This is outside M2 but remains an integrity limitation.
- The one-driver-session index means one *unrevoked* session, not one unrevoked-and-unexpired session. Login must revoke the previous row before replacement.
- No general rate-limit persistence exists.
- Access-token invalidation/current-state enforcement is not implemented.
- Audit metadata redaction is documented but not code-enforced by an allowlist.
- The logger accepts arbitrary records and has no central recursive credential redactor.
- No password, token, contact-normalization, or cryptographic application services exist.

### Requirements conflict requiring owner resolution

The accepted documentation and database enforce:

- refresh-session maximum lifetime of 30 days;
- OTP lifetime of 5 minutes;
- maximum 5 OTP attempts;
- 60-second OTP resend cooldown; and
- mandatory staff TOTP before dashboard access.

The latest M2 direction lists these as unresolved. M2 must therefore treat them as requiring renewed approval and must not silently change the existing constraints.

## 4. Proposed M2 boundaries

M2 should implement only:

- phone OTP challenge and verification for customer/driver applications;
- concurrency-safe account/contact resolution after verification;
- staff email/password authentication;
- access-token issuance and validation;
- opaque refresh-token creation, rotation, reuse detection, revocation, and expiry;
- logout for one session and all sessions;
- layered authentication rate limiting;
- typed authentication audit events;
- enumeration-safe errors;
- central secret redaction;
- security-sensitive configuration validation;
- generated migrations, OpenAPI contracts, and tests.

Customer registration, driver onboarding, staff invitation administration, MFA enrollment/recovery, business authorization endpoints, and unrelated domains remain excluded unless separately approved.

## 5. Recommended authentication architecture

Use feature-oriented modules:

```text
src/modules/auth/
├── phone/
├── staff/
├── sessions/
├── tokens/
├── rate-limit/
├── audit/
└── shared/
```

Recommended boundaries:

- `PhoneNormalizer`: strict E.164 normalization.
- `EmailNormalizer`: one canonical normalization rule.
- `OtpGenerator`: cryptographically secure numeric OTP generation.
- `SecretVerifier`: versioned keyed HMAC verifiers for OTP, refresh, and reset tokens.
- `PasswordHasher`: Argon2id adapter with encoded parameters and rehash detection.
- `AccessTokenService`: format-independent interface pending approval.
- `SessionService`: transactional creation, replacement, rotation, and revocation.
- `AuthorizationStateLoader`: current account/profile/session/staff validation.
- `RateLimiter`: Redis-backed at runtime and replaceable with a deterministic in-memory test implementation.
- `SecurityAuditWriter`: typed events with allowlisted metadata.
- `RedactingLogger`: recursive removal of prohibited keys.
- `OtpDeliveryPort`: provider-neutral delivery interface.

OTP consumption, refresh rotation, and driver-device replacement must be single database transactions with concurrency control.

## 6. Proposed endpoints

All errors use a stable shape with `request_id`. Public responses must not disclose account existence.

### Phone OTP

#### `POST /api/v1/auth/phone/otp/request`

Request contains phone, application type, optional stable device ID, and user-facing device name. Return generic `202 Accepted` regardless of account/profile existence.

#### `POST /api/v1/auth/phone/otp/verify`

Request contains challenge ID, OTP, application type, and device metadata. Success returns access token, refresh token, access expiry, and session ID. Driver verification additionally requires an approved, operationally active driver profile. A second driver login atomically revokes and replaces the prior driver session.

### Staff authentication

#### `POST /api/v1/auth/staff/login`

Accept normalized email input, password, and device information.

Successful password authentication issues a Dashboard session after current account, staff-profile, verified-email, credential, and role state checks. MFA is deferred.

MFA/TOTP endpoints are explicitly deferred and are not part of M2.

Conditional on MFA inclusion. Consume the authentication transaction and TOTP, then issue a dashboard session.

### Tokens and logout

- `POST /api/v1/auth/token/refresh`: rotate the refresh token atomically and return a successor pair.
- `POST /api/v1/auth/logout`: idempotently revoke the current session.
- `POST /api/v1/auth/logout-all`: revoke every session belonging to the account.

Staff password-reset endpoints and delivery are explicitly deferred and are not part of M2.

## 7. Proposed schema changes

1. Add composite password-reset ownership integrity between credential ID and account ID.
2. Replace free-form OTP purpose with a closed state set such as `LOGIN` and `PHONE_VERIFICATION` after confirming final purposes.
3. Add transactional authentication rate-limit buckets.
5. Add a session/account security-version mechanism or require current-state database checks for protected requests.
6. Add verifier key-version fields where missing, especially refresh-token verifiers.
7. Add typed security reason sets only when stable; do not overuse database enums.

Do not add driver-application or TOTP-authenticator cardinality constraints.

## 8. Threat model and abuse controls

| Threat | Required control |
|---|---|
| OTP guessing | Short expiry, attempt ceiling, atomic increment and invalidation |
| OTP flooding | Phone, IP, device, purpose, and global delivery limits |
| Account enumeration | Equivalent public responses and similar timing |
| Credential stuffing | Email/IP/device limits, compromised-password blocking, audit alerts |
| Refresh-token theft | Opaque entropy, keyed verifier, rotation, reuse detection |
| Concurrent refresh | One transactional winner and one successor |
| Session fixation | New unpredictable session/family identifiers after authentication |
| Cross-application privilege | Audience/application type bound to token and session |
| Driver session duplication | Revoke old and create replacement atomically |
| Stale authorization | Current state or security-version enforcement |
| Reset-token theft | High entropy, verifier-only storage, single use, short expiry |
| Secret leakage | Central redaction and typed audit metadata |
| Timing oracle | Dummy Argon2 verification for unknown staff emails |
| Expensive hash abuse | Rate limit before Argon2 where safe |

Redis holds temporary rate-limit counters; PostgreSQL remains authoritative for OTP attempts, challenge state, and sessions.

## 9. Token and session lifecycle

1. Authenticate required factors.
2. Revalidate account and relevant profile/staff state.
3. Create a device-specific session and generation-zero refresh row transactionally.
4. For driver login, revoke the current driver session in the same transaction.
5. Return a short-lived access token and opaque refresh token; store only the keyed refresh verifier.
6. On refresh, lock and validate the current generation, rotate once, update last-use metadata, and audit.
7. On rotated-token reuse, create `TOKEN_REUSE_DETECTED` and revoke the affected session/family. Dashboard reuse additionally revokes all dashboard sessions for the account.
8. Logout-one revokes the current session.
9. Logout-all revokes every account session.
10. Password reset revokes all dashboard sessions.

Recommended opaque refresh/reset tokens contain at least 256 random bits and use HMAC-SHA-256 verifiers with versioned keys. This recommendation does not decide access-token format.

## 10. Test plan

### Unit tests

- Phone/email normalization.
- OTP generation and verifier behavior.
- Refresh/reset entropy and verifier-only persistence.
- Password policy, Unicode, spaces, and compromised-password handling.
- Dummy verification for unknown staff email.
- Enumeration-safe response mapping.
- Rate-limit window and key calculations.
- Recursive secret redaction.
- Token claim validation through a format-neutral interface.
- Account/profile/application authorization checks.
- Driver session replacement.
- Revocation boundary selection.
- Typed audit allowlists.
- Security configuration validation.
- Production-safe errors.

### PostgreSQL integration tests

- OTP issuance creates no account.
- Replacement invalidates the predecessor atomically.
- Only one concurrent request consumes a challenge.
- Attempts increment atomically.
- Concurrent phone verification cannot create duplicate accounts/contacts.
- Driver login replaces the existing driver session without affecting customer sessions.
- Refresh rotation creates exactly one successor.
- Concurrent refresh has one winner.
- Rotated-token reuse revokes the required session scope.
- Logout-one/all boundaries.
- Account/profile suspension blocks refresh correctly.
- Password-reset ownership, single use, expiry, and dashboard revocation.
- Concurrent rate-limit correctness.
- Audit request-ID preservation and secret exclusion.
- Empty-database migration and safe M1-to-M2 upgrade.

### API/OpenAPI tests

- Request/response schemas.
- Generic responses for known and unknown contacts.
- Invalid, expired, and consumed challenges.
- Access/refresh credential separation.
- Authentication requirements for logout.
- Request-ID propagation.
- Enumeration-safe throttling behavior.
- Complete OpenAPI route publication.

## 11. Explicit exclusions

- Customer registration/profile completion.
- Driver application submission/review/approval.
- Staff invitation administration.
- Role/permission administration.
- Complete business authorization matrix.
- Orders, Cart, Merchants, Wallets, and Notifications.
- Object storage and v2 migration.
- Account merge/contact recycling.
- Production SMS/email integration until selected.
- MFA enrollment/recovery unless explicitly approved.
- Redis, queues, and background jobs unless separately approved.

## 12. Decisions requiring approval

1. **Access-token format/algorithm** — Recommend signed JWT with Ed25519/EdDSA, strict issuer/audience, and `kid`. Alternatives: ES256, RS256, or opaque tokens. Interfaces can begin; issuance cannot finalize.
2. **Signing-key custody/rotation** — Recommend versioned asymmetric keys outside environment files, with signing/verification overlap. Production issuance is blocked.
3. **Refresh-session lifetime** — Recommend reaffirming the existing 30-day maximum. Rotation logic can begin; expiry behavior needs approval.
4. **OTP parameters** — Recommend reaffirming six digits, 5 minutes, 5 attempts, and 60-second cooldown. Infrastructure can begin; endpoint behavior must await reconciliation.
5. **OTP provider/failure behavior** — Recommend a provider-neutral port and generic public failures. Production phone authentication remains blocked.
6. **MFA in M2** — Recommend including TOTP verification because accepted documentation requires it. Password verification can begin; dashboard session issuance depends on this decision.
7. **Argon2id parameters** — Recommend deployment-environment benchmarking. Interfaces can begin; production configuration remains blocked.
8. **Compromised-password source** — Recommend a local minimum blocklist plus an abstract breach-check port.
9. **Rate-limit authority** — Recommend PostgreSQL atomic buckets for M2 behind a replaceable interface.
10. **Immediate access-token invalidation** — Recommend current session/account/profile checks initially; alternative is a security-version/cache design.
11. **Multiple TOTP authenticators** — Recommend one active authenticator initially, without adding a database cardinality constraint before approval.
12. **Multiple driver applications** — Recommend preserving the unconstrained historical model; unrelated to M2 authentication.
13. **RBAC/city/final-SUPER_ADMIN decisions** — Defer without adding grants or city-domain foreign keys.

## 13. Proposed implementation sequence

1. **M2.0 — Foundation corrections:** synchronize with public `main`, add canonical docs to the repository, fix the integration health wait, and enforce reset ownership.
2. **M2.1 — Security primitives:** normalizers, cryptographic verifiers, password adapter, redaction, typed audit writer, and configuration.
3. **M2.2 — Rate limits:** PostgreSQL schema, migration, and transactional service.
4. **M2.3 — Phone OTP:** request/verification, delivery port, atomic identity resolution, and driver-session replacement.
5. **M2.4 — Sessions/tokens:** access-token adapter, refresh rotation/reuse, logout, and current-state enforcement.
6. **M2.5 — Staff password/reset:** enumeration-safe login and reset flows.
7. **M2.6 — MFA continuation:** only if approved.
8. **M2.7 — Hardening:** OpenAPI, concurrency tests, Docker/config validation, documentation, and drift checks.

## 14. Expected implementation files

Likely additions:

```text
docs/identity-access/*
docs/adr/*
src/modules/auth/index.ts
src/modules/auth/routes.ts
src/modules/auth/phone/*
src/modules/auth/staff/*
src/modules/auth/sessions/*
src/modules/auth/tokens/*
src/modules/auth/rate-limit/*
src/modules/auth/audit/*
src/modules/auth/shared/*
src/config/security.ts
src/shared/crypto/*
src/shared/redaction/*
test/unit/auth/*
test/integration/authentication.test.ts
drizzle/0004_*.sql
drizzle/meta/0004_snapshot.json
```

Likely modifications:

```text
package.json
bun.lock
.env.example
README.md
Dockerfile
compose.yaml
src/app.ts
src/index.ts
src/config/env.ts
src/db/schema/accounts.ts
src/db/schema/sessions.ts
src/db/schema/index.ts
src/observability/logger.ts
drizzle/meta/_journal.json
```
