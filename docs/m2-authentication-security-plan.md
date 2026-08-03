# M2 Authentication & Security Implementation

The authoritative decisions are recorded in [m2-confirmed-decisions.md](./m2-confirmed-decisions.md). This file describes the implemented boundary and deliberately does not preserve obsolete draft routes.

M2 separates three public route adapters—Customer Mobile, Driver Mobile, and Dashboard—while sharing internal token, session, hashing, HMAC, rate-limit, redaction, and audit primitives. Trusted route modules inject the application type and JWT audience; no public request field can choose either value.

Customer authentication alone uses the PostgreSQL OTP challenge workflow and a provider-neutral delivery port. Driver authentication uses an existing approved and operational Driver profile plus a nullable Argon2id `access_code_hash`. Dashboard authentication uses an active staff profile, verified normalized email, valid staff role assignment, and Argon2id password credential.

Each boundary has its own login/verification, refresh, logout, session-list, and owned-session-revocation routes. Customer and Dashboard additionally expose application-scoped logout-all. Driver login atomically replaces its one previous Driver session and never revokes Customer sessions.

Access JWTs use Ed25519 with strict issuer, key ID, audience, application, expiry, subject, session, and algorithm validation. Protected operations also revalidate PostgreSQL account, profile/staff, role, and session state. Refresh tokens are opaque, rotated transactionally, stored only as versioned HMAC verifiers, and application-bound before rotation. Confirmed reuse revokes the affected Customer or Driver session; Dashboard reuse revokes that account's Dashboard sessions.

Redis implements atomic, TTL-backed, application-namespaced abuse counters. PostgreSQL remains authoritative for OTP challenges and session/token state. Authentication logs and allowlisted audit records exclude raw credentials, OTPs, tokens, hashes, headers, cookies, and key material.

Generated migrations `0006` and `0007` add the Driver access-code authentication method and nullable hash foundation without rewriting M1 history. The second migration retires any legacy Driver OTP session state during upgrade and installs the application/authentication-method constraint.

The complete route contract and local commands are listed in the project [README](../README.md). Driver access-code administration and all explicitly deferred features remain outside M2.
