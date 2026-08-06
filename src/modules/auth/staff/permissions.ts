/** Grantable City-operational permission codes. */
export const GRANTABLE_PERMISSION_CODES = [
  "zones.read",
  "zones.create",
  "zones.update",
  "zones.archive",
  "media.read",
  "media.create",
  "media.delete",
  "main_categories.read",
  "main_categories.create",
  "main_categories.update",
  "main_categories.archive",
  "subcategories.read",
  "subcategories.create",
  "subcategories.update",
  "subcategories.archive",
  "stores.read",
  "stores.create",
  "stores.update",
  "stores.archive",
  "store_categories.read",
  "store_categories.create",
  "store_categories.update",
  "store_categories.archive",
  "products.read",
  "products.create",
  "products.update",
  "products.archive",
  "modifiers.read",
  "modifiers.create",
  "modifiers.update",
  "modifiers.archive",
] as const;

export type GrantablePermissionCode =
  (typeof GRANTABLE_PERMISSION_CODES)[number];

const grantableSet = new Set<string>(GRANTABLE_PERMISSION_CODES);

export const isGrantablePermissionCode = (
  value: string,
): value is GrantablePermissionCode => grantableSet.has(value);

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
