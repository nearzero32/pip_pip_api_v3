/** Grantable City-operational permission codes. */
export const GRANTABLE_PERMISSION_CODES = [
  "zones.read",
  "zones.create",
  "zones.update",
  "zones.archive",
  "zones.export",
  "media.read",
  "media.create",
  "media.delete",
  "main_categories.read",
  "main_categories.create",
  "main_categories.update",
  "main_categories.archive",
  "main_categories.export",
  "subcategories.read",
  "subcategories.create",
  "subcategories.update",
  "subcategories.archive",
  "subcategories.export",
  "stores.read",
  "stores.create",
  "stores.update",
  "stores.archive",
  "stores.export",
  "stores.commission.read",
  "stores.commission.update",
  "stores.commission.export",
  "stores.commission.history.export",
  "store_categories.read",
  "store_categories.create",
  "store_categories.update",
  "store_categories.archive",
  "store_categories.export",
  "products.read",
  "products.create",
  "products.update",
  "products.archive",
  "products.export",
  "modifiers.read",
  "modifiers.create",
  "modifiers.update",
  "modifiers.archive",
  "modifiers.export",
  "merchants.read",
  "merchants.create",
  "merchants.update",
  "merchants.export",
  "orders.read",
  "orders.cancel",
  "orders.approve",
  "orders.items.replace",
  "orders.items.mutate",
  "orders.lifecycle.override",
  "orders.assign",
  "orders.reoffer",
  "orders.handoff.manage",
  "orders.return.manage",
  "orders.export",
  "orders.events.export",
  "orders.assignments.export",
  "orders.handoffs.export",
  "orders.returns.export",
  "orders.collections.export",
  "order_offers.read",
  "order_offers.manage",
  "order_offers.export",
  "drivers.export",
  "staff.export",
] as const;

export type GrantablePermissionCode =
  (typeof GRANTABLE_PERMISSION_CODES)[number];

const grantableSet = new Set<string>(GRANTABLE_PERMISSION_CODES);

export const isGrantablePermissionCode = (
  value: string,
): value is GrantablePermissionCode => grantableSet.has(value);

/**
 * Global Excel-export catalog codes. Not grantable to city employees.
 * SUPER_ADMIN does not receive account_permission_grants; endpoints still
 * require the matching export code via requireSuperAdminExport so read ≠ export.
 */
export const SUPER_ADMIN_EXPORT_PERMISSION_CODES = [
  "governorates.export",
  "cities.export",
  "admins.export",
  "delivery_pricing.versions.export",
] as const;

export type SuperAdminExportPermissionCode =
  (typeof SUPER_ADMIN_EXPORT_PERMISSION_CODES)[number];

const superAdminExportSet = new Set<string>(SUPER_ADMIN_EXPORT_PERMISSION_CODES);

export const isSuperAdminExportPermissionCode = (
  value: string,
): value is SuperAdminExportPermissionCode => superAdminExportSet.has(value);

export const EMPLOYEE_ROLE_CODES = [
  "OPERATIONS",
  "ACCOUNTANT",
  "SUPPORT",
] as const;

export type EmployeeRoleCode = (typeof EMPLOYEE_ROLE_CODES)[number];

const employeeRoleSet = new Set<string>(EMPLOYEE_ROLE_CODES);

export const isEmployeeRoleCode = (
  value: string,
): value is EmployeeRoleCode => employeeRoleSet.has(value);
