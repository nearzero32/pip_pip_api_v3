import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accountStatus = pgEnum("account_status", ["ACTIVE", "SUSPENDED", "CLOSED"]);
export const customerProfileStatus = pgEnum("customer_profile_status", ["ACTIVE", "SUSPENDED", "CLOSED"]);
export const driverApprovalStatus = pgEnum("driver_approval_status", ["APPROVED"]);
export const driverOperationalStatus = pgEnum("driver_operational_status", [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
]);
export const staffProfileStatus = pgEnum("staff_profile_status", ["INVITED", "ACTIVE", "DISABLED", "CLOSED"]);
export const driverApplicationStatus = pgEnum("driver_application_status", [
  "DRAFT",
  "SUBMITTED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
]);
export const driverDocumentType = pgEnum("driver_document_type", ["NATIONAL_ID", "RESIDENCE_CARD", "CONTRACT"]);
export const documentSide = pgEnum("document_side", ["FRONT", "BACK", "SINGLE"]);
export const driverReviewAction = pgEnum("driver_review_action", ["REVIEWED", "CHANGES_REQUESTED", "APPROVED", "REJECTED"]);
export const recordStatus = pgEnum("record_status", ["ACTIVE", "RETIRED"]);
export const staffRoleCode = pgEnum("staff_role_code", ["SUPER_ADMIN", "ADMIN", "OPERATIONS", "ACCOUNTANT", "SUPPORT"]);
export const roleScopeType = pgEnum("role_scope_type", ["GLOBAL", "CITY"]);
export const mfaMethod = pgEnum("mfa_method", ["TOTP"]);
export const mfaCredentialStatus = pgEnum("mfa_credential_status", ["PENDING", "ACTIVE", "RESET", "REMOVED"]);
export const applicationType = pgEnum("application_type", ["CUSTOMER_APP", "DRIVER_APP", "DASHBOARD"]);
export const authenticationMethod = pgEnum("authentication_method", ["PHONE_OTP", "PASSWORD_TOTP"]);
export const auditOutcome = pgEnum("audit_outcome", ["SUCCESS", "FAILURE", "DENIED"]);

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
});

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    tokenVerifier: text("token_verifier").notNull().unique(),
    verifierKeyVersion: text("verifier_key_version"),
    expiresAt: instant("expires_at").notNull(),
    consumedAt: instant("consumed_at"),
    invalidatedAt: instant("invalidated_at"),
    requestedAt: instant("requested_at").notNull().defaultNow(),
    requestSecurityMetadata: jsonb("request_security_metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("password_reset_account_requested_idx").on(table.accountId, table.requestedAt),
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

export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
    status: staffProfileStatus("status").notNull().default("INVITED"),
    displayName: text("display_name"),
    employeeReference: text("employee_reference").unique(),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [index("staff_profiles_status_idx").on(table.status)],
);

export const driverApplications = pgTable(
  "driver_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    status: driverApplicationStatus("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    legacyVehicleDescription: text("legacy_vehicle_description"),
    contractInformation: text("contract_information"),
    submittedAt: instant("submitted_at"),
    decidedAt: instant("decided_at"),
    decidedByAccountId: uuid("decided_by_account_id").references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_applications_account_created_idx").on(table.accountId, table.createdAt),
    index("driver_applications_status_submitted_idx").on(table.status, table.submittedAt),
    index("driver_applications_decider_decided_idx").on(table.decidedByAccountId, table.decidedAt),
    check("driver_applications_version_positive_chk", sql`${table.version} > 0`),
    check("driver_applications_decision_fields_chk", sql`(${table.status} not in ('APPROVED', 'REJECTED')) or (${table.decidedAt} is not null and ${table.decidedByAccountId} is not null)`),
  ],
);

export const driverProfiles = pgTable(
  "driver_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
    approvalStatus: driverApprovalStatus("approval_status").notNull().default("APPROVED"),
    operationalStatus: driverOperationalStatus("operational_status").notNull().default("PENDING_ACTIVATION"),
    approvedApplicationId: uuid("approved_application_id").notNull().unique().references(() => driverApplications.id),
    legacyVehicleDescription: text("legacy_vehicle_description"),
    driverPhotoObjectKey: text("driver_photo_object_key"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_profiles_operational_status_idx").on(table.operationalStatus),
    check("driver_profiles_active_photo_chk", sql`${table.operationalStatus} <> 'ACTIVE' or ${table.driverPhotoObjectKey} is not null`),
  ],
);

export const driverApplicationDocuments = pgTable(
  "driver_application_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverApplicationId: uuid("driver_application_id").notNull().references(() => driverApplications.id),
    applicationVersion: integer("application_version").notNull(),
    documentType: driverDocumentType("document_type").notNull(),
    side: documentSide("side").notNull(),
    objectKey: text("object_key").notNull(),
    mediaType: text("media_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    uploadedByAccountId: uuid("uploaded_by_account_id").notNull().references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    invalidatedAt: instant("invalidated_at"),
  },
  (table) => [
    uniqueIndex("driver_documents_current_slot_uidx").on(table.driverApplicationId, table.applicationVersion, table.documentType, table.side).where(sql`${table.invalidatedAt} is null`),
    index("driver_documents_application_version_idx").on(table.driverApplicationId, table.applicationVersion),
    index("driver_documents_object_key_idx").on(table.objectKey),
    check("driver_documents_version_positive_chk", sql`${table.applicationVersion} > 0`),
    check("driver_documents_slot_chk", sql`(${table.documentType} in ('NATIONAL_ID', 'RESIDENCE_CARD') and ${table.side} in ('FRONT', 'BACK')) or (${table.documentType} = 'CONTRACT' and ${table.side} = 'SINGLE')`),
    check("driver_documents_size_positive_chk", sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`),
  ],
);

export const driverApplicationReviews = pgTable(
  "driver_application_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverApplicationId: uuid("driver_application_id").notNull().references(() => driverApplications.id),
    applicationVersion: integer("application_version").notNull(),
    actorAccountId: uuid("actor_account_id").notNull().references(() => accounts.id),
    action: driverReviewAction("action").notNull(),
    reasonCode: text("reason_code").notNull(),
    internalReason: text("internal_reason"),
    applicantFeedback: text("applicant_feedback"),
    occurredAt: instant("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_reviews_application_occurred_idx").on(table.driverApplicationId, table.occurredAt),
    index("driver_reviews_actor_occurred_idx").on(table.actorAccountId, table.occurredAt),
    index("driver_reviews_action_occurred_idx").on(table.action, table.occurredAt),
    check("driver_reviews_version_positive_chk", sql`${table.applicationVersion} > 0`),
  ],
);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: staffRoleCode("code").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(true),
  status: recordStatus("status").notNull().default("ACTIVE"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  description: text("description").notNull(),
  status: recordStatus("status").notNull().default("ACTIVE"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

export const accountRoles = pgTable(
  "account_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    grantedAt: instant("granted_at").notNull().defaultNow(),
    grantedByAccountId: uuid("granted_by_account_id").notNull().references(() => accounts.id),
    validFrom: instant("valid_from").notNull().defaultNow(),
    validUntil: instant("valid_until"),
    revokedAt: instant("revoked_at"),
    revokedByAccountId: uuid("revoked_by_account_id").references(() => accounts.id),
    reason: text("reason"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("account_roles_active_assignment_uidx").on(table.accountId, table.roleId).where(sql`${table.revokedAt} is null`),
    index("account_roles_account_effective_idx").on(table.accountId, table.revokedAt, table.validFrom, table.validUntil),
    index("account_roles_role_revoked_idx").on(table.roleId, table.revokedAt),
    check("account_roles_valid_window_chk", sql`${table.validUntil} is null or ${table.validUntil} > ${table.validFrom}`),
  ],
);

export const accountRoleScopes = pgTable(
  "account_role_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountRoleId: uuid("account_role_id").notNull().references(() => accountRoles.id),
    scopeType: roleScopeType("scope_type").notNull(),
    scopeReferenceId: uuid("scope_reference_id"),
    createdAt: instant("created_at").notNull().defaultNow(),
    createdByAccountId: uuid("created_by_account_id").notNull().references(() => accounts.id),
  },
  (table) => [
    uniqueIndex("account_role_scopes_global_uidx").on(table.accountRoleId).where(sql`${table.scopeType} = 'GLOBAL'`),
    uniqueIndex("account_role_scopes_city_uidx").on(table.accountRoleId, table.scopeReferenceId).where(sql`${table.scopeType} = 'CITY'`),
    index("account_role_scopes_lookup_idx").on(table.scopeType, table.scopeReferenceId),
    check("account_role_scopes_reference_chk", sql`(${table.scopeType} = 'GLOBAL' and ${table.scopeReferenceId} is null) or (${table.scopeType} = 'CITY' and ${table.scopeReferenceId} is not null)`),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id),
    permissionId: uuid("permission_id").notNull().references(() => permissions.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    createdByAccountId: uuid("created_by_account_id").references(() => accounts.id),
  },
  (table) => [
    primaryKey({ name: "role_permissions_pk", columns: [table.roleId, table.permissionId] }),
    index("role_permissions_permission_role_idx").on(table.permissionId, table.roleId),
  ],
);

export const staffInvitations = pgTable(
  "staff_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailNormalized: text("email_normalized").notNull(),
    accountId: uuid("account_id").references(() => accounts.id),
    invitedByAccountId: uuid("invited_by_account_id").notNull().references(() => accounts.id),
    invitationVerifier: text("invitation_verifier").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    acceptedAt: instant("accepted_at"),
    revokedAt: instant("revoked_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("staff_invitations_email_state_idx").on(table.emailNormalized, table.acceptedAt, table.revokedAt),
    index("staff_invitations_expires_idx").on(table.expiresAt),
    check("staff_invitations_email_lower_chk", sql`${table.emailNormalized} = lower(${table.emailNormalized})`),
  ],
);

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
    index("sessions_expiry_idx").on(table.absoluteExpiresAt),
    index("sessions_account_device_idx").on(table.accountId, table.deviceId),
    check("sessions_expiry_after_creation_chk", sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    check("sessions_max_lifetime_chk", sql`${table.absoluteExpiresAt} <= ${table.createdAt} + interval '30 days'`),
    check("sessions_auth_method_chk", sql`(${table.applicationType} = 'DASHBOARD' and ${table.authenticationMethod} = 'PASSWORD_TOTP') or (${table.applicationType} in ('CUSTOMER_APP', 'DRIVER_APP') and ${table.authenticationMethod} = 'PHONE_OTP')`),
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
    issuedAt: instant("issued_at").notNull().defaultNow(),
    rotatedAt: instant("rotated_at"),
    revokedAt: instant("revoked_at"),
  },
  (table) => [
    uniqueIndex("session_refresh_generation_uidx").on(table.sessionId, table.generation),
    uniqueIndex("session_refresh_current_uidx").on(table.sessionId).where(sql`${table.rotatedAt} is null and ${table.revokedAt} is null`),
    check("session_refresh_generation_nonnegative_chk", sql`${table.generation} >= 0`),
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
    uniqueIndex("otp_current_phone_purpose_uidx").on(table.phoneE164, table.purpose).where(sql`${table.consumedAt} is null and ${table.invalidatedAt} is null`),
    index("otp_phone_purpose_created_idx").on(table.phoneE164, table.purpose, table.createdAt),
    index("otp_account_created_idx").on(table.accountId, table.createdAt),
    index("otp_expires_idx").on(table.expiresAt),
    check("otp_phone_e164_format_chk", sql`${table.phoneE164} ~ '^\\+[1-9][0-9]{1,14}$'`),
    check("otp_attempts_chk", sql`${table.maxAttempts} = 5 and ${table.attemptCount} between 0 and ${table.maxAttempts}`),
    check("otp_expiry_window_chk", sql`${table.expiresAt} = ${table.createdAt} + interval '5 minutes'`),
    check("otp_resend_window_chk", sql`${table.resendAvailableAt} = ${table.lastSentAt} + interval '60 seconds'`),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: instant("occurred_at").notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id),
    actorSessionId: uuid("actor_session_id").references(() => sessions.id),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: auditOutcome("outcome").notNull(),
    reasonCode: text("reason_code"),
    requestCorrelationId: text("request_correlation_id"),
    ipAddressCoarse: text("ip_address_coarse"),
    userAgentSummary: text("user_agent_summary"),
    redactedMetadata: jsonb("redacted_metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index("audit_logs_occurred_idx").on(table.occurredAt),
    index("audit_logs_actor_occurred_idx").on(table.actorAccountId, table.occurredAt),
    index("audit_logs_target_occurred_idx").on(table.targetType, table.targetId, table.occurredAt),
    index("audit_logs_event_occurred_idx").on(table.eventType, table.occurredAt),
    index("audit_logs_correlation_idx").on(table.requestCorrelationId),
  ],
);
