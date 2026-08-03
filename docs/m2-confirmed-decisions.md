# M2 Confirmed Authentication Decisions

All application endpoints use `/api/v1`; infrastructure health routes remain unprefixed. Customer and driver authentication uses six-digit, five-minute phone OTP with five attempts and a 60-second resend cooldown. Customer sessions are limited to five; driver sessions to one. Dashboard authentication is password-only with Argon2id and at most three active sessions. Access tokens are Ed25519 JWTs valid for ten minutes. Opaque refresh tokens use versioned HMAC-SHA-256 verifiers, rotate on every refresh, and have a 30-day absolute session lifetime. Redis is the temporary abuse-counter authority; PostgreSQL remains authoritative for challenges and sessions.

MFA, TOTP behavior, recovery codes, password-reset behavior, invitation administration, real SMS delivery, cities, zones, PostGIS, Orders, and Carts are explicitly deferred. Existing foundation tables remain but are unused.
