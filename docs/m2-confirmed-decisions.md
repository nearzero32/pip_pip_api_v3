# M2 Confirmed Authentication Decisions

This document records the final M2 decisions that supersede earlier M2 proposals where they conflict.

## Public boundaries

- Customer Mobile: `/api/v1/mobile/customer`, `CUSTOMER_APP`, JWT audience `customer-app`.
- Driver Mobile: `/api/v1/mobile/driver`, `DRIVER_APP`, JWT audience `driver-app`.
- Dashboard: `/api/v1/dashboard`, `DASHBOARD`, JWT audience `dashboard`.
- Application context is constructed only by server-owned route modules. Public input cannot select it.
- `/api/v1/auth`, `/v1/auth`, `/auth`, compatibility aliases, and Driver OTP routes do not exist.
- Infrastructure health and OpenAPI routes remain unprefixed.

## Credentials

- Customer uses normalized phone plus a six-digit OTP. OTP lifetime is five minutes, maximum attempts five, resend cooldown 60 seconds, and use is single-use. Requesting an OTP creates no account.
- Driver uses normalized phone plus a permanent ASCII numeric access code represented as a string of 6–12 digits. Leading zeroes are preserved. Only an Argon2id hash is stored. Driver OTP is prohibited.
- Dashboard uses normalized email plus password. Only an Argon2id hash is stored. M2 is password-only and does not use MFA.
- Unknown identities, missing credentials, ineligible profiles, and incorrect credentials use generic enumeration-safe failures and dummy Argon2 verification for Driver and Dashboard lookups.

## Tokens, sessions, and rate limits

- Access tokens are Ed25519/EdDSA JWTs valid for ten minutes with strict issuer, key ID, audience, application, subject, session ID, issued-at, expiry, and token ID validation.
- Opaque refresh tokens contain 256 random bits; only versioned HMAC-SHA-256 verifiers are stored. Rotation is atomic and reuse revokes the approved application scope.
- Current absolute session lifetime is 30 days, inherited from the approved Identity & Access design. Inactivity expiry remains an owner decision.
- Session maxima are Customer 5, Driver 1, and Dashboard 3. Oldest replacement is deterministic and transactional. Logout-all is application-scoped; Driver omits it because only one session is active.
- PostgreSQL is authoritative for OTP attempts/challenge state and sessions. Redis holds only application-namespaced temporary abuse counters and is never silently bypassed in production.

## Explicitly deferred

Driver access-code administration, MFA, TOTP, recovery codes, password reset, forgot-password, staff invitations, real SMS delivery, Driver onboarding/submission, full staff permissions, final SUPER_ADMIN protection, cities, zones, geographic areas, PostGIS, Stores, Orders, Carts, production deployment, and production-data access are not part of M2. Existing foundation tables for deferred security work remain unused.
