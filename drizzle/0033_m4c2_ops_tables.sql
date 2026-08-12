-- M4-C2 tables and constraints for handoff, return, driver replacement.
ALTER TABLE "orders"
  ADD COLUMN "store_ready_marked_at" timestamp with time zone,
  ADD COLUMN "locked_driver_fee" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_locked_driver_fee_chk" CHECK (
  ("locked_driver_fee" IS NULL) OR ("locked_driver_fee" > 0)
);--> statement-breakpoint

ALTER TABLE "order_offer_rounds"
  ADD COLUMN "round_kind" "offer_round_kind" DEFAULT 'INITIAL' NOT NULL,
  ADD COLUMN "reoffer_reason" text,
  ADD COLUMN "opened_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_opened_by_fk"
  FOREIGN KEY ("opened_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "order_driver_assignments"
  ADD COLUMN "replaces_assignment_id" uuid,
  ADD COLUMN "replaced_by_assignment_id" uuid,
  ADD COLUMN "closing_reason" "assignment_closing_reason",
  ADD COLUMN "original_driver_fee" integer,
  ADD COLUMN "fee_locked_from_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_replaces_fk"
  FOREIGN KEY ("replaces_assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_replaced_by_fk"
  FOREIGN KEY ("replaced_by_assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_fee_locked_from_fk"
  FOREIGN KEY ("fee_locked_from_assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

DROP INDEX IF EXISTS "order_driver_assignments_active_order_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_assignments_custody_active_uidx"
  ON "order_driver_assignments" ("order_id")
  WHERE "completed_at" IS NULL
    AND "cancelled_at" IS NULL
    AND "status" IN ('ASSIGNED', 'PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'RETURN_PENDING');--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_assignments_handoff_pending_uidx"
  ON "order_driver_assignments" ("order_id")
  WHERE "completed_at" IS NULL
    AND "cancelled_at" IS NULL
    AND "status" = 'HANDOFF_PENDING';--> statement-breakpoint

ALTER TABLE "order_driver_assignments" DROP CONSTRAINT IF EXISTS "order_driver_assignments_status_times_chk";--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_status_times_chk" CHECK (
  (
    ("cancelled_at" IS NOT NULL)
    OR (
      ("status" = 'ASSIGNED' AND "picked_up_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'PICKED_UP' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'ARRIVED_AT_CUSTOMER' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'COMPLETED' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NOT NULL)
      OR ("status" = 'HANDOFF_PENDING' AND "picked_up_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'RETURN_PENDING' AND "picked_up_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" IN ('REMOVED_BEFORE_PICKUP', 'REPLACED_AFTER_PICKUP', 'RETURNED_TO_STORE', 'CANCELLED'))
    )
  )
);--> statement-breakpoint

ALTER TABLE "order_proofs"
  ADD COLUMN "handoff_id" uuid,
  ADD COLUMN "return_workflow_id" uuid;--> statement-breakpoint

CREATE TABLE "order_driver_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "city_id" uuid NOT NULL,
  "from_assignment_id" uuid NOT NULL,
  "to_assignment_id" uuid NOT NULL,
  "from_driver_id" uuid NOT NULL,
  "to_driver_id" uuid NOT NULL,
  "status" "driver_handoff_status" DEFAULT 'PENDING' NOT NULL,
  "reason" text NOT NULL,
  "started_by_account_id" uuid NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "proof_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_order_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_city_id_fk"
  FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_from_assignment_fk"
  FOREIGN KEY ("from_assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_to_assignment_fk"
  FOREIGN KEY ("to_assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_from_driver_fk"
  FOREIGN KEY ("from_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_to_driver_fk"
  FOREIGN KEY ("to_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_started_by_fk"
  FOREIGN KEY ("started_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_order_city_fk"
  FOREIGN KEY ("order_id", "city_id") REFERENCES "public"."orders"("id", "city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_reason_chk" CHECK (length(btrim("reason")) > 0);--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_drivers_diff_chk" CHECK ("from_driver_id" <> "to_driver_id");--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_assignments_diff_chk" CHECK ("from_assignment_id" <> "to_assignment_id");--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_terminal_chk" CHECK (
  NOT ("completed_at" IS NOT NULL AND "cancelled_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_status_times_chk" CHECK (
  ("status" = 'PENDING' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_handoffs_active_order_uidx"
  ON "order_driver_handoffs" ("order_id")
  WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "order_driver_handoffs_order_created_idx"
  ON "order_driver_handoffs" ("order_id", "created_at", "id");--> statement-breakpoint

CREATE TABLE "order_return_workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "city_id" uuid NOT NULL,
  "assignment_id" uuid NOT NULL,
  "driver_id" uuid NOT NULL,
  "status" "order_return_workflow_status" DEFAULT 'WAITING_FOR_DRIVER_RETURN' NOT NULL,
  "reason" text NOT NULL,
  "started_by_account_id" uuid NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "driver_returned_at" timestamp with time zone,
  "store_confirmed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "proof_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_order_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_city_id_fk"
  FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_assignment_fk"
  FOREIGN KEY ("assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_driver_fk"
  FOREIGN KEY ("driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_started_by_fk"
  FOREIGN KEY ("started_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_order_city_fk"
  FOREIGN KEY ("order_id", "city_id") REFERENCES "public"."orders"("id", "city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_reason_chk" CHECK (length(btrim("reason")) > 0);--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_terminal_chk" CHECK (
  NOT ("completed_at" IS NOT NULL AND "cancelled_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_status_times_chk" CHECK (
  ("status" = 'WAITING_FOR_DRIVER_RETURN' AND "driver_returned_at" IS NULL AND "store_confirmed_at" IS NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'WAITING_FOR_STORE_CONFIRMATION' AND "driver_returned_at" IS NOT NULL AND "store_confirmed_at" IS NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'COMPLETED' AND "driver_returned_at" IS NOT NULL AND "store_confirmed_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "cancelled_at" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "completed_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "order_return_workflows_active_order_uidx"
  ON "order_return_workflows" ("order_id")
  WHERE "status" IN ('WAITING_FOR_DRIVER_RETURN', 'WAITING_FOR_STORE_CONFIRMATION');--> statement-breakpoint
CREATE INDEX "order_return_workflows_order_created_idx"
  ON "order_return_workflows" ("order_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "order_return_workflows_store_pending_idx"
  ON "order_return_workflows" ("city_id", "status", "created_at");--> statement-breakpoint

ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_handoff_id_fk"
  FOREIGN KEY ("handoff_id") REFERENCES "public"."order_driver_handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_return_workflow_id_fk"
  FOREIGN KEY ("return_workflow_id") REFERENCES "public"."order_return_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_handoffs" ADD CONSTRAINT "order_driver_handoffs_proof_id_fk"
  FOREIGN KEY ("proof_id") REFERENCES "public"."order_proofs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_return_workflows" ADD CONSTRAINT "order_return_workflows_proof_id_fk"
  FOREIGN KEY ("proof_id") REFERENCES "public"."order_proofs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "order_events"
  ADD COLUMN "handoff_id" uuid,
  ADD COLUMN "return_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_handoff_id_fk"
  FOREIGN KEY ("handoff_id") REFERENCES "public"."order_driver_handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_return_workflow_id_fk"
  FOREIGN KEY ("return_workflow_id") REFERENCES "public"."order_return_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('orders.reoffer', 'Reoffer an order to drivers after removing or replacing the current driver', 'ACTIVE'),
  ('orders.handoff.manage', 'Start, complete, or cancel driver-to-driver handoff workflows', 'ACTIVE'),
  ('orders.return.manage', 'Start and complete return-to-store workflows after cancel-in-custody', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
