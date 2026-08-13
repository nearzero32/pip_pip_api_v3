-- Delivery cash-collection fact (not a wallet, ledger, tip, or payout).
-- expected amount is orders.total (products_subtotal + delivery_fee) at delivery time.

CREATE UNIQUE INDEX "order_driver_assignments_id_order_uidx"
  ON "order_driver_assignments" ("id", "order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_assignments_id_driver_uidx"
  ON "order_driver_assignments" ("id", "driver_id");--> statement-breakpoint

CREATE TABLE "order_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "assignment_id" uuid NOT NULL,
  "collecting_driver_id" uuid NOT NULL,
  "expected_amount" integer NOT NULL,
  "collected_amount" integer NOT NULL,
  "difference_amount" integer NOT NULL,
  "currency" text DEFAULT 'IQD' NOT NULL,
  "confirmed_by_account_id" uuid NOT NULL,
  "confirmation_source" "order_action_source" NOT NULL,
  "order_event_id" uuid NOT NULL,
  "collected_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_order_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_assignment_id_fk"
  FOREIGN KEY ("assignment_id") REFERENCES "public"."order_driver_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_collecting_driver_fk"
  FOREIGN KEY ("collecting_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_confirmed_by_fk"
  FOREIGN KEY ("confirmed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_event_fk"
  FOREIGN KEY ("order_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_assignment_order_fk"
  FOREIGN KEY ("assignment_id", "order_id")
  REFERENCES "public"."order_driver_assignments"("id", "order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_assignment_driver_fk"
  FOREIGN KEY ("assignment_id", "collecting_driver_id")
  REFERENCES "public"."order_driver_assignments"("id", "driver_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "order_collections_order_uidx" ON "order_collections" ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_collections_event_uidx" ON "order_collections" ("order_event_id");--> statement-breakpoint
CREATE INDEX "order_collections_assignment_idx" ON "order_collections" ("assignment_id");--> statement-breakpoint
CREATE INDEX "order_collections_driver_idx" ON "order_collections" ("collecting_driver_id");--> statement-breakpoint

ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_currency_chk"
  CHECK ("currency" = 'IQD');--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_source_chk"
  CHECK ("confirmation_source" IN ('DRIVER_APP', 'DASHBOARD_OVERRIDE'));--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_amounts_nonneg_chk"
  CHECK (
    "expected_amount" >= 0
    AND "collected_amount" >= 0
    AND "difference_amount" >= 0
    AND "expected_amount" <= 99999999
    AND "collected_amount" <= 99999999
  );--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_collected_gte_expected_chk"
  CHECK ("collected_amount" >= "expected_amount");--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_difference_chk"
  CHECK ("difference_amount" = ("collected_amount" - "expected_amount"));--> statement-breakpoint

CREATE FUNCTION forbid_order_collection_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_collections rows are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER order_collections_immutable_trg
  BEFORE UPDATE OR DELETE ON order_collections
  FOR EACH ROW
  EXECUTE FUNCTION forbid_order_collection_mutation();
