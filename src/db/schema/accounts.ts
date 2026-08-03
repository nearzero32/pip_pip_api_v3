import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { instant } from "./columns";
import { accountStatus, customerProfileStatus, mfaCredentialStatus, mfaMethod } from "./enums";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: accountStatus("status").notNull().default("ACTIVE"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [index("accounts_status_idx").on(table.status), index("accounts_created_at_idx").on(table.createdAt)],
);

export const accountPhones = pgTable(
  "account_phones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    phoneE164: text("phone_e164").notNull(),
    verifiedAt: instant("verified_at"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_phones_phone_e164_uidx").on(table.phoneE164),
    uniqueIndex("account_phones_one_primary_uidx").on(table.accountId).where(sql`${table.isPrimary} = true`),
    index("account_phones_account_idx").on(table.accountId),
    index("account_phones_account_verified_idx").on(table.accountId, table.verifiedAt),
    check("account_phones_e164_format_chk", sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{1,14}$'`),
  ],
);

export const accountEmails = pgTable(
  "account_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    emailOriginal: text("email_original").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    verifiedAt: instant("verified_at"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_emails_normalized_uidx").on(table.emailNormalized),
    uniqueIndex("account_emails_one_primary_uidx").on(table.accountId).where(sql`${table.isPrimary} = true`),
    index("account_emails_account_idx").on(table.accountId),
    index("account_emails_account_verified_idx").on(table.accountId, table.verifiedAt),
    check("account_emails_normalized_lower_chk", sql`${table.emailNormalized} = lower(${table.emailNormalized})`),
  ],
);

export const passwordCredentials = pgTable("password_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
  argon2idHash: text("argon2id_hash").notNull(),
  passwordChangedAt: instant("password_changed_at").notNull().defaultNow(),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table) => [uniqueIndex("password_credentials_id_account_uidx").on(table.id, table.accountId)]);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    passwordCredentialId: uuid("password_credential_id").notNull(),
    tokenVerifier: text("token_verifier").notNull().unique(),
    verifierKeyVersion: text("verifier_key_version"),
    expiresAt: instant("expires_at").notNull(),
    consumedAt: instant("consumed_at"),
    invalidatedAt: instant("invalidated_at"),
    requestedAt: instant("requested_at").notNull().defaultNow(),
    requestSecurityMetadata: jsonb("request_security_metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    foreignKey({
      name: "password_reset_tokens_credential_account_fk",
      columns: [table.passwordCredentialId, table.accountId],
      foreignColumns: [passwordCredentials.id, passwordCredentials.accountId],
    }),
    index("password_reset_account_requested_idx").on(table.accountId, table.requestedAt),
    index("password_reset_credential_requested_idx").on(table.passwordCredentialId, table.requestedAt),
    index("password_reset_expires_idx").on(table.expiresAt),
    check("password_reset_expiry_window_chk", sql`${table.expiresAt} = ${table.requestedAt} + interval '15 minutes'`),
  ],
);

export const mfaCredentials = pgTable(
  "mfa_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    method: mfaMethod("method").notNull().default("TOTP"),
    encryptedSecret: text("encrypted_secret").notNull(),
    encryptionKeyVersion: text("encryption_key_version").notNull(),
    status: mfaCredentialStatus("status").notNull().default("PENDING"),
    verifiedAt: instant("verified_at"),
    resetAt: instant("reset_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [index("mfa_credentials_account_status_idx").on(table.accountId, table.status)],
);

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mfaCredentialId: uuid("mfa_credential_id").notNull().references(() => mfaCredentials.id),
    codeVerifier: text("code_verifier").notNull().unique(),
    consumedAt: instant("consumed_at"),
    invalidatedAt: instant("invalidated_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [index("mfa_recovery_credential_consumed_idx").on(table.mfaCredentialId, table.consumedAt)],
);

export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
    status: customerProfileStatus("status").notNull().default("ACTIVE"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [index("customer_profiles_status_idx").on(table.status)],
);
