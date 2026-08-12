-- M4-C1: custody, assignment lifecycle, events, proofs, item mutations, permissions.
ALTER TABLE "orders"
  ADD COLUMN "custody_status" "order_custody_status" DEFAULT 'WITH_STORE' NOT NULL,
  ADD COLUMN "custody_driver_id" uuid;--> statement-breakpoint
UPDATE "orders" SET "custody_status" = 'WITH_CUSTOMER' WHERE "status" = 'DELIVERED';--> statement-breakpoint
UPDATE "orders"
SET "custody_status" = 'WITH_DRIVER',
    "custody_driver_id" = "driver_account_id"
WHERE "status" IN ('PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'ACCEPTED_BY_DRIVER')
  AND "driver_account_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_custody_driver_id_accounts_id_fk"
  FOREIGN KEY ("custody_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_custody_logic_chk" CHECK (
  (
    ("custody_status" = 'WITH_STORE' AND "custody_driver_id" IS NULL)
    OR ("custody_status" = 'WITH_DRIVER' AND "custody_driver_id" IS NOT NULL)
    OR ("custody_status" = 'WITH_CUSTOMER' AND "custody_driver_id" IS NULL)
  )
);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_custody_chk" CHECK (
  (
    ("status" IN ('PICKED_UP', 'ARRIVED_AT_CUSTOMER') AND "custody_status" = 'WITH_DRIVER' AND "custody_driver_id" IS NOT NULL)
    OR ("status" = 'DELIVERED' AND "custody_status" = 'WITH_CUSTOMER' AND "custody_driver_id" IS NULL)
    OR ("status" NOT IN ('PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'DELIVERED'))
  )
);--> statement-breakpoint

ALTER TABLE "order_driver_assignments"
  ADD COLUMN "status" "assignment_lifecycle_status" DEFAULT 'ASSIGNED' NOT NULL,
  ADD COLUMN "picked_up_at" timestamp with time zone,
  ADD COLUMN "arrived_at_customer_at" timestamp with time zone;--> statement-breakpoint
-- Historical completed rows (if any) need timestamps to satisfy status check.
UPDATE "order_driver_assignments"
SET
  "status" = 'COMPLETED',
  "picked_up_at" = COALESCE("picked_up_at", "assigned_at"),
  "arrived_at_customer_at" = COALESCE("arrived_at_customer_at", "completed_at", "assigned_at")
WHERE "completed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_status_times_chk" CHECK (
  (
    ("cancelled_at" IS NOT NULL)
    OR (
      ("status" = 'ASSIGNED' AND "picked_up_at" IS NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'PICKED_UP' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'ARRIVED_AT_CUSTOMER' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'COMPLETED' AND "picked_up_at" IS NOT NULL AND "arrived_at_customer_at" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
  )
);--> statement-breakpoint
-- Cancelled assignments keep lifecycle status; completed_at/cancelled_at mutual exclusion already exists.

ALTER TABLE "order_item_replacements" DROP CONSTRAINT IF EXISTS "order_item_replacements_agreed_phone_chk";--> statement-breakpoint
ALTER TABLE "order_item_replacements" ALTER COLUMN "customer_agreed_by_phone" SET DEFAULT true;--> statement-breakpoint

CREATE TABLE "order_custody_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "assignment_id" uuid,
  "from_status" "order_custody_status",
  "to_status" "order_custody_status" NOT NULL,
  "from_driver_id" uuid,
  "to_driver_id" uuid,
  "actor_account_id" uuid,
  "actor_type" "order_actor_type" NOT NULL,
  "source" "order_action_source" NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_custody_history" ADD CONSTRAINT "order_custody_history_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_custody_history" ADD CONSTRAINT "order_custody_history_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_custody_history_order_created_idx" ON "order_custody_history" ("order_id", "created_at", "id");--> statement-breakpoint

CREATE TABLE "order_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "assignment_id" uuid,
  "event_type" "order_event_type" NOT NULL,
  "from_order_status" "order_status",
  "to_order_status" "order_status",
  "from_custody_status" "order_custody_status",
  "to_custody_status" "order_custody_status",
  "actor_type" "order_actor_type" NOT NULL,
  "actor_account_id" uuid,
  "source" "order_action_source" NOT NULL,
  "acted_on_behalf_of" text,
  "reason" text,
  "proof_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_acted_on_behalf_chk" CHECK (
  ("acted_on_behalf_of" IS NULL) OR ("acted_on_behalf_of" IN ('STORE', 'DRIVER'))
);--> statement-breakpoint
CREATE INDEX "order_events_order_created_idx" ON "order_events" ("order_id", "created_at", "id");--> statement-breakpoint

CREATE TABLE "order_item_mutations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "mutation_type" text NOT NULL,
  "order_item_id" uuid,
  "related_order_item_id" uuid,
  "product_id_before" uuid,
  "product_id_after" uuid,
  "product_name_before" text,
  "product_name_after" text,
  "quantity_before" integer,
  "quantity_after" integer,
  "unit_price_before" integer,
  "unit_price_after" integer,
  "line_total_before" integer,
  "line_total_after" integer,
  "products_subtotal_before" integer NOT NULL,
  "products_subtotal_after" integer NOT NULL,
  "delivery_fee_before" integer NOT NULL,
  "delivery_fee_after" integer NOT NULL,
  "total_before" integer NOT NULL,
  "total_after" integer NOT NULL,
  "actor_account_id" uuid NOT NULL,
  "actor_type" "order_actor_type" NOT NULL,
  "source" "order_action_source" NOT NULL,
  "reason" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_item_mutations" ADD CONSTRAINT "order_item_mutations_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_mutations" ADD CONSTRAINT "order_item_mutations_reason_chk" CHECK (length(btrim("reason")) > 0);--> statement-breakpoint
ALTER TABLE "order_item_mutations" ADD CONSTRAINT "order_item_mutations_type_chk" CHECK (
  "mutation_type" IN ('ADD', 'REMOVE', 'REPLACE', 'QUANTITY_CHANGE')
);--> statement-breakpoint
ALTER TABLE "order_item_mutations" ADD CONSTRAINT "order_item_mutations_delivery_fee_unchanged_chk" CHECK (
  "delivery_fee_before" = "delivery_fee_after"
);--> statement-breakpoint
CREATE INDEX "order_item_mutations_order_created_idx" ON "order_item_mutations" ("order_id", "created_at", "id");--> statement-breakpoint

CREATE TABLE "order_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "assignment_id" uuid NOT NULL,
  "city_id" uuid NOT NULL,
  "media_asset_id" uuid NOT NULL,
  "purpose" "order_proof_purpose" NOT NULL,
  "uploaded_by_driver_id" uuid NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_event_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_media_asset_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_uploaded_by_driver_id_fk" FOREIGN KEY ("uploaded_by_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_media_asset_uidx" UNIQUE ("media_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_proofs_one_consumed_purpose_uidx"
  ON "order_proofs" ("order_id", "assignment_id", "purpose")
  WHERE "consumed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "order_proofs_order_created_idx" ON "order_proofs" ("order_id", "created_at");--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_proof_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."order_proofs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_proofs" ADD CONSTRAINT "order_proofs_consumed_by_event_id_fk" FOREIGN KEY ("consumed_by_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('orders.items.mutate', 'Mutate order items before ready-for-pickup lock', 'ACTIVE'),
  ('orders.lifecycle.override', 'Execute natural delivery lifecycle transitions as dashboard override', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
UPDATE "order_driver_assignments"
SET "status" = 'ASSIGNED'
WHERE "completed_at" IS NULL AND "cancelled_at" IS NULL AND "picked_up_at" IS NULL;
