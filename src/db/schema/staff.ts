import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts";
import { instant } from "./columns";
import { recordStatus, roleScopeType, staffProfileStatus, staffRoleCode } from "./enums";

export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
    status: staffProfileStatus("status").notNull().default("INVITED"),
    displayName: text("display_name"),
    employeeReference: text("employee_reference").unique(),
    invitedByStaffId: uuid("invited_by_staff_id"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "staff_profiles_invited_by_staff_id_fk",
      columns: [table.invitedByStaffId],
      foreignColumns: [table.id],
    }),
    index("staff_profiles_status_idx").on(table.status),
    index("staff_profiles_invited_by_idx").on(table.invitedByStaffId),
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
