import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accountPhones, accounts } from "./accounts";
import { instant } from "./columns";
import { applicationType, authenticationMethod } from "./enums";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    applicationType: applicationType("application_type").notNull(),
    authenticationMethod: authenticationMethod("authentication_method").notNull(),
    tokenFamilyId: uuid("token_family_id").notNull().defaultRandom().unique(),
    deviceId: text("device_id"),
    deviceName: text("device_name").notNull(),
    userAgentSummary: text("user_agent_summary"),
    createdIpCoarse: text("created_ip_coarse"),
    lastSeenIpCoarse: text("last_seen_ip_coarse"),
    lastUsedAt: instant("last_used_at"),
    absoluteExpiresAt: instant("absolute_expires_at").notNull(),
    revokedAt: instant("revoked_at"),
    revocationReason: text("revocation_reason"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_one_driver_session_uidx").on(table.accountId).where(sql`${table.applicationType} = 'DRIVER_APP' and ${table.revokedAt} is null`),
    index("sessions_account_active_expiry_idx").on(table.accountId, table.revokedAt, table.absoluteExpiresAt),
    index("sessions_account_application_active_idx").on(table.accountId, table.applicationType, table.revokedAt, table.createdAt),
    index("sessions_expiry_idx").on(table.absoluteExpiresAt),
    index("sessions_account_device_idx").on(table.accountId, table.deviceId),
    check("sessions_expiry_after_creation_chk", sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    check("sessions_max_lifetime_chk", sql`${table.absoluteExpiresAt} <= ${table.createdAt} + interval '30 days'`),
    check("sessions_auth_method_chk", sql`(${table.applicationType} = 'DASHBOARD' and ${table.authenticationMethod} = 'PASSWORD') or (${table.applicationType} = 'CUSTOMER_APP' and ${table.authenticationMethod} = 'PHONE_OTP') or (${table.applicationType} = 'DRIVER_APP' and ${table.authenticationMethod} = 'DRIVER_ACCESS_CODE') or (${table.applicationType} = 'MERCHANT_APP' and ${table.authenticationMethod} = 'PASSWORD')`),
    check("sessions_revocation_reason_chk", sql`${table.revokedAt} is null or ${table.revocationReason} is not null`),
  ],
);

export const sessionRefreshTokens = pgTable(
  "session_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id),
    generation: integer("generation").notNull(),
    tokenVerifier: text("token_verifier").notNull().unique(),
    verifierKeyVersion: text("verifier_key_version").notNull().default("v1"),
    issuedAt: instant("issued_at").notNull().defaultNow(),
    rotatedAt: instant("rotated_at"),
    revokedAt: instant("revoked_at"),
    replacedById: uuid("replaced_by_id"),
  },
  (table) => [
    foreignKey({
      name: "session_refresh_tokens_replaced_by_id_fk",
      columns: [table.replacedById],
      foreignColumns: [table.id],
    }),
    uniqueIndex("session_refresh_generation_uidx").on(table.sessionId, table.generation),
    uniqueIndex("session_refresh_current_uidx").on(table.sessionId).where(sql`${table.rotatedAt} is null and ${table.revokedAt} is null`),
    uniqueIndex("session_refresh_replaced_by_uidx").on(table.replacedById).where(sql`${table.replacedById} is not null`),
    check("session_refresh_generation_nonnegative_chk", sql`${table.generation} >= 0`),
    check("session_refresh_replacement_state_chk", sql`${table.replacedById} is null or ${table.rotatedAt} is not null`),
  ],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").notNull(),
    applicationType: applicationType("application_type").notNull(),
    phoneE164: text("phone_e164").notNull(),
    accountId: uuid("account_id").references(() => accounts.id),
    accountPhoneId: uuid("account_phone_id").references(() => accountPhones.id),
    otpKeyedVerifier: text("otp_keyed_verifier").notNull(),
    verifierKeyVersion: text("verifier_key_version").notNull(),
    expiresAt: instant("expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastSentAt: instant("last_sent_at").notNull().defaultNow(),
    resendAvailableAt: instant("resend_available_at").notNull(),
    consumedAt: instant("consumed_at"),
    invalidatedAt: instant("invalidated_at"),
    replacementChallengeId: uuid("replacement_challenge_id"),
    resultingSessionId: uuid("resulting_session_id").references(() => sessions.id),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "otp_challenges_replacement_challenge_id_fk",
      columns: [table.replacementChallengeId],
      foreignColumns: [table.id],
    }),
    uniqueIndex("otp_current_phone_purpose_uidx").on(table.phoneE164, table.purpose).where(sql`${table.consumedAt} is null and ${table.invalidatedAt} is null`),
    index("otp_phone_purpose_created_idx").on(table.phoneE164, table.purpose, table.createdAt),
    index("otp_account_created_idx").on(table.accountId, table.createdAt),
    index("otp_expires_idx").on(table.expiresAt),
    index("otp_replacement_challenge_idx").on(table.replacementChallengeId),
    index("otp_resulting_session_idx").on(table.resultingSessionId),
    check("otp_phone_e164_format_chk", sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{1,14}$'`),
    check("otp_attempts_chk", sql`${table.maxAttempts} = 5 and ${table.attemptCount} between 0 and ${table.maxAttempts}`),
    check("otp_expiry_window_chk", sql`${table.expiresAt} = ${table.createdAt} + interval '5 minutes'`),
    check("otp_resend_window_chk", sql`${table.resendAvailableAt} = ${table.lastSentAt} + interval '60 seconds'`),
  ],
);
