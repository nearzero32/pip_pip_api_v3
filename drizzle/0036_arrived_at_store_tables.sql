-- Driver arrived-at-store: assignment timestamp, checks, custody uniqueness.
ALTER TABLE "order_driver_assignments"
  ADD COLUMN "arrived_at_store_at" timestamp with time zone;--> statement-breakpoint

DROP INDEX IF EXISTS "order_driver_assignments_custody_active_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_assignments_custody_active_uidx"
  ON "order_driver_assignments" ("order_id")
  WHERE "completed_at" IS NULL
    AND "cancelled_at" IS NULL
    AND "status" IN ('ASSIGNED', 'ARRIVED_AT_STORE', 'PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'RETURN_PENDING');--> statement-breakpoint

ALTER TABLE "order_driver_assignments" DROP CONSTRAINT IF EXISTS "order_driver_assignments_status_times_chk";--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_status_times_chk" CHECK (
  (
    ("cancelled_at" IS NOT NULL)
    OR (
      ("status" = 'ASSIGNED' AND "picked_up_at" IS NULL AND "arrived_at_store_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'ARRIVED_AT_STORE' AND "arrived_at_store_at" IS NOT NULL AND "picked_up_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'PICKED_UP' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'ARRIVED_AT_CUSTOMER' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'COMPLETED' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NOT NULL)
      OR ("status" = 'HANDOFF_PENDING' AND "picked_up_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'RETURN_PENDING' AND "picked_up_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" IN ('REMOVED_BEFORE_PICKUP', 'REPLACED_AFTER_PICKUP', 'RETURNED_TO_STORE', 'CANCELLED'))
    )
  )
);--> statement-breakpoint

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_status_custody_chk";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_custody_chk" CHECK (
  (
    ("status" IN ('PICKED_UP', 'ARRIVED_AT_CUSTOMER') AND "custody_status" = 'WITH_DRIVER' AND "custody_driver_id" IS NOT NULL)
    OR ("status" = 'DELIVERED' AND "custody_status" = 'WITH_CUSTOMER' AND "custody_driver_id" IS NULL)
    OR ("status" = 'ARRIVED_AT_STORE' AND "custody_status" = 'WITH_STORE' AND "custody_driver_id" IS NULL)
    OR ("status" NOT IN ('PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'DELIVERED', 'ARRIVED_AT_STORE'))
  )
);
