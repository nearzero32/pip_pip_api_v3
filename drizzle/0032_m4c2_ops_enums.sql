-- M4-C2 enums: assignment lifecycle, events, proofs, handoff, return, offer round kind.
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'REMOVED_BEFORE_PICKUP';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'HANDOFF_PENDING';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'REPLACED_AFTER_PICKUP';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'RETURN_PENDING';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'RETURNED_TO_STORE';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'CANCELLED';--> statement-breakpoint

ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'DRIVER_REMOVAL_REQUESTED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'DRIVER_REMOVED_BEFORE_PICKUP';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'ORDER_REOFFERED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'DRIVER_MANUALLY_ASSIGNED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'HANDOFF_STARTED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'HANDOFF_COMPLETED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'HANDOFF_CANCELLED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED_BY_DASHBOARD';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'RETURN_STARTED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'DRIVER_RETURN_PROOF_SUBMITTED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'STORE_CONFIRMED_RETURN';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'RETURN_COMPLETED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'ORDER_REOPENED';--> statement-breakpoint

ALTER TYPE "order_proof_purpose" ADD VALUE IF NOT EXISTS 'HANDOFF_PROOF';--> statement-breakpoint
ALTER TYPE "order_proof_purpose" ADD VALUE IF NOT EXISTS 'RETURN_PROOF';--> statement-breakpoint
ALTER TYPE "media_asset_purpose" ADD VALUE IF NOT EXISTS 'HANDOFF_PROOF';--> statement-breakpoint
ALTER TYPE "media_asset_purpose" ADD VALUE IF NOT EXISTS 'RETURN_PROOF';--> statement-breakpoint

CREATE TYPE "assignment_closing_reason" AS ENUM (
  'ORDER_CANCELLED',
  'REMOVED_BEFORE_PICKUP',
  'REPLACED_AFTER_HANDOFF',
  'HANDOFF_CANCELLED',
  'RETURNED_TO_STORE',
  'SUPERSEDED_BY_REASSIGN'
);--> statement-breakpoint

CREATE TYPE "driver_handoff_status" AS ENUM (
  'PENDING',
  'COMPLETED',
  'CANCELLED'
);--> statement-breakpoint

CREATE TYPE "order_return_workflow_status" AS ENUM (
  'WAITING_FOR_DRIVER_RETURN',
  'WAITING_FOR_STORE_CONFIRMATION',
  'COMPLETED',
  'CANCELLED'
);--> statement-breakpoint

CREATE TYPE "offer_round_kind" AS ENUM (
  'INITIAL',
  'DRIVER_REPLACEMENT'
);
