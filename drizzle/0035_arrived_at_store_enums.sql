-- Driver arrived-at-store step: enum values (must commit before table use).
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'ARRIVED_AT_STORE' AFTER 'READY_FOR_PICKUP';--> statement-breakpoint
ALTER TYPE "assignment_lifecycle_status" ADD VALUE IF NOT EXISTS 'ARRIVED_AT_STORE' AFTER 'ASSIGNED';--> statement-breakpoint
ALTER TYPE "order_event_type" ADD VALUE IF NOT EXISTS 'DRIVER_ARRIVED_AT_STORE' AFTER 'STORE_MARKED_READY';
