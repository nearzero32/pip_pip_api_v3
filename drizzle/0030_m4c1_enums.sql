-- M4-C1: rename statuses / assignment source; add enum values (committed before schema uses them).
ALTER TYPE "order_status" RENAME VALUE 'UNDER_STORE_REVIEW' TO 'PENDING_STORE_APPROVAL';--> statement-breakpoint
ALTER TYPE "assignment_source" RENAME VALUE 'DRIVER_CLAIM' TO 'OFFER_CLAIM';--> statement-breakpoint
ALTER TYPE "order_item_state" ADD VALUE IF NOT EXISTS 'REMOVED';--> statement-breakpoint
ALTER TYPE "order_action_source" ADD VALUE IF NOT EXISTS 'DASHBOARD_OVERRIDE';--> statement-breakpoint
ALTER TYPE "media_asset_purpose" ADD VALUE IF NOT EXISTS 'PICKUP_PROOF';--> statement-breakpoint
ALTER TYPE "media_asset_purpose" ADD VALUE IF NOT EXISTS 'DELIVERY_PROOF';--> statement-breakpoint
CREATE TYPE "order_custody_status" AS ENUM('WITH_STORE', 'WITH_DRIVER', 'WITH_CUSTOMER');--> statement-breakpoint
CREATE TYPE "assignment_lifecycle_status" AS ENUM('ASSIGNED', 'PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "order_event_type" AS ENUM(
  'ORDER_CREATED',
  'ORDER_ITEM_ADDED',
  'ORDER_ITEM_REMOVED',
  'ORDER_ITEM_REPLACED',
  'ORDER_ITEM_QUANTITY_CHANGED',
  'STORE_APPROVED',
  'DRIVER_ASSIGNED',
  'STORE_MARKED_READY',
  'DRIVER_PICKED_UP',
  'DRIVER_ARRIVED_AT_CUSTOMER',
  'ORDER_DELIVERED'
);--> statement-breakpoint
CREATE TYPE "order_proof_purpose" AS ENUM('PICKUP_PROOF', 'DELIVERY_PROOF');
