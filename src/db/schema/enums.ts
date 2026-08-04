import { pgEnum } from "drizzle-orm/pg-core";

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
export const authenticationMethod = pgEnum("authentication_method", ["PHONE_OTP", "PASSWORD_TOTP", "PASSWORD", "DRIVER_ACCESS_CODE"]);
export const auditOutcome = pgEnum("audit_outcome", ["SUCCESS", "FAILURE", "DENIED"]);
export const governorateStatus = pgEnum("governorate_status", ["ACTIVE", "INACTIVE"]);
export const cityStatus = pgEnum("city_status", ["DRAFT", "ACTIVE", "SUSPENDED", "ARCHIVED"]);
export const zoneStatus = pgEnum("zone_status", ["ACTIVE", "INACTIVE", "ARCHIVED"]);
export const mediaAssetPurpose = pgEnum("media_asset_purpose", [
  "CATEGORY_IMAGE",
  "STORE_LOGO",
  "STORE_IMAGE",
  "PRODUCT_IMAGE",
  "DRIVER_PHOTO",
  "DRIVER_DOCUMENT",
  "USER_AVATAR",
  "BANNER_IMAGE",
]);
export const mediaAssetVisibility = pgEnum("media_asset_visibility", ["PUBLIC", "PRIVATE"]);
export const mediaAssetStatus = pgEnum("media_asset_status", [
  "PENDING_UPLOAD",
  "READY",
  "DELETE_PENDING",
  "DELETED",
]);
