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
export const applicationType = pgEnum("application_type", [
  "CUSTOMER_APP",
  "DRIVER_APP",
  "DASHBOARD",
  "MERCHANT_APP",
]);
export const authenticationMethod = pgEnum("authentication_method", [
  "PHONE_OTP",
  "PASSWORD_TOTP",
  "PASSWORD",
  "DRIVER_ACCESS_CODE",
]);
export const merchantProfileStatus = pgEnum("merchant_profile_status", [
  "ACTIVE",
  "INACTIVE",
  "SUSPENDED",
]);
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
  "PICKUP_PROOF",
  "DELIVERY_PROOF",
  "HANDOFF_PROOF",
  "RETURN_PROOF",
]);
export const mediaAssetVisibility = pgEnum("media_asset_visibility", ["PUBLIC", "PRIVATE"]);
export const mediaAssetStatus = pgEnum("media_asset_status", [
  "PENDING_UPLOAD",
  "READY",
  "DELETE_PENDING",
  "DELETED",
]);
export const mainCategoryStatus = pgEnum("main_category_status", [
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
]);
export const storeStatus = pgEnum("store_status", [
  "DRAFT",
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
]);
export const storeOrderAcceptanceStatus = pgEnum(
  "store_order_acceptance_status",
  ["ACCEPTING", "PAUSED"],
);
export const weekday = pgEnum("weekday", [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
/** Product / product-size lifecycle — same semantics as catalog status. */
export const productStatus = pgEnum("product_status", [
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
]);
export const deliveryPricingStatus = pgEnum("delivery_pricing_status", [
  "DRAFT",
  "ACTIVE",
  "INACTIVE",
]);
export const orderStatus = pgEnum("order_status", [
  "PENDING_STORE_APPROVAL",
  "APPROVED_BY_STORE",
  "SEARCHING_DRIVER",
  "DRIVER_ASSIGNED",
  "READY_FOR_PICKUP",
  "ACCEPTED_BY_DRIVER",
  "PICKED_UP",
  "ARRIVED_AT_CUSTOMER",
  "DELIVERED",
  "CANCELLED",
]);
export const orderPaymentMethod = pgEnum("order_payment_method", [
  "CASH",
  "ONLINE",
]);
export const orderPaymentStatus = pgEnum("order_payment_status", [
  "UNPAID",
  "AWAITING_PAYMENT",
  "PAID",
  "FAILED",
]);
export const orderItemState = pgEnum("order_item_state", [
  "ACTIVE",
  "REPLACED",
  "REMOVED",
]);
export const orderActorType = pgEnum("order_actor_type", [
  "CUSTOMER",
  "MERCHANT",
  "STAFF",
  "SYSTEM",
  "DRIVER",
]);
export const orderActionSource = pgEnum("order_action_source", [
  "CUSTOMER_APP",
  "MERCHANT_APP",
  "DASHBOARD",
  "DASHBOARD_OVERRIDE",
  "SYSTEM",
  "DRIVER_APP",
]);
export const orderCustodyStatus = pgEnum("order_custody_status", [
  "WITH_STORE",
  "WITH_DRIVER",
  "WITH_CUSTOMER",
]);
export const assignmentLifecycleStatus = pgEnum("assignment_lifecycle_status", [
  "ASSIGNED",
  "PICKED_UP",
  "ARRIVED_AT_CUSTOMER",
  "COMPLETED",
  "REMOVED_BEFORE_PICKUP",
  "HANDOFF_PENDING",
  "REPLACED_AFTER_PICKUP",
  "RETURN_PENDING",
  "RETURNED_TO_STORE",
  "CANCELLED",
]);
export const assignmentClosingReason = pgEnum("assignment_closing_reason", [
  "ORDER_CANCELLED",
  "REMOVED_BEFORE_PICKUP",
  "REPLACED_AFTER_HANDOFF",
  "HANDOFF_CANCELLED",
  "RETURNED_TO_STORE",
  "SUPERSEDED_BY_REASSIGN",
]);
export const driverHandoffStatus = pgEnum("driver_handoff_status", [
  "PENDING",
  "COMPLETED",
  "CANCELLED",
]);
export const orderReturnWorkflowStatus = pgEnum("order_return_workflow_status", [
  "WAITING_FOR_DRIVER_RETURN",
  "WAITING_FOR_STORE_CONFIRMATION",
  "COMPLETED",
  "CANCELLED",
]);
export const offerRoundKind = pgEnum("offer_round_kind", [
  "INITIAL",
  "DRIVER_REPLACEMENT",
]);
export const orderEventType = pgEnum("order_event_type", [
  "ORDER_CREATED",
  "ORDER_ITEM_ADDED",
  "ORDER_ITEM_REMOVED",
  "ORDER_ITEM_REPLACED",
  "ORDER_ITEM_QUANTITY_CHANGED",
  "STORE_APPROVED",
  "DRIVER_ASSIGNED",
  "STORE_MARKED_READY",
  "DRIVER_PICKED_UP",
  "DRIVER_ARRIVED_AT_CUSTOMER",
  "ORDER_DELIVERED",
  "DRIVER_REMOVAL_REQUESTED",
  "DRIVER_REMOVED_BEFORE_PICKUP",
  "ORDER_REOFFERED",
  "DRIVER_MANUALLY_ASSIGNED",
  "HANDOFF_STARTED",
  "HANDOFF_COMPLETED",
  "HANDOFF_CANCELLED",
  "ORDER_CANCELLED_BY_DASHBOARD",
  "RETURN_STARTED",
  "DRIVER_RETURN_PROOF_SUBMITTED",
  "STORE_CONFIRMED_RETURN",
  "RETURN_COMPLETED",
  "ORDER_REOPENED",
]);
export const orderProofPurpose = pgEnum("order_proof_purpose", [
  "PICKUP_PROOF",
  "DELIVERY_PROOF",
  "HANDOFF_PROOF",
  "RETURN_PROOF",
]);
