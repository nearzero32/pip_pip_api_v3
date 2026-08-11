CREATE TYPE "public"."assignment_source" AS ENUM('DRIVER_CLAIM', 'DASHBOARD_MANUAL');--> statement-breakpoint
CREATE TYPE "public"."offer_round_status" AS ENUM('OPEN', 'CLAIMED', 'MANUALLY_ASSIGNED', 'STOPPED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."order_action_source" ADD VALUE 'DRIVER_APP';--> statement-breakpoint
ALTER TYPE "public"."order_actor_type" ADD VALUE 'DRIVER';--> statement-breakpoint
CREATE TABLE "city_driver_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"pricing_base" integer NOT NULL,
	"rounding_unit" integer NOT NULL,
	"pricing_stages" jsonb NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_driver_pricing_base_chk" CHECK ("city_driver_pricing"."pricing_base" > 0),
	CONSTRAINT "city_driver_pricing_rounding_chk" CHECK ("city_driver_pricing"."rounding_unit" > 0),
	CONSTRAINT "city_driver_pricing_version_chk" CHECK ("city_driver_pricing"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "offer_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_idempotency_key_nonempty_chk" CHECK (length(btrim("offer_idempotency_keys"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_driver_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"offer_round_id" uuid,
	"assignment_source" "assignment_source" NOT NULL,
	"assignment_sequence" integer NOT NULL,
	"assigned_by_account_id" uuid,
	"assignment_reason" text,
	"driver_fee" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_driver_assignments_sequence_chk" CHECK ("order_driver_assignments"."assignment_sequence" between 1 and 2),
	CONSTRAINT "order_driver_assignments_fee_chk" CHECK ("order_driver_assignments"."driver_fee" > 0),
	CONSTRAINT "order_driver_assignments_terminal_chk" CHECK (not ("order_driver_assignments"."completed_at" is not null and "order_driver_assignments"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_offer_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"status" "offer_round_status" DEFAULT 'OPEN' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"pricing_base_snapshot" integer NOT NULL,
	"rounding_unit_snapshot" integer NOT NULL,
	"pricing_stages_snapshot" jsonb NOT NULL,
	"pricing_version_snapshot" integer NOT NULL,
	"final_driver_fee" integer,
	"claimed_by_driver_id" uuid,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_offer_rounds_pricing_base_chk" CHECK ("order_offer_rounds"."pricing_base_snapshot" > 0),
	CONSTRAINT "order_offer_rounds_rounding_chk" CHECK ("order_offer_rounds"."rounding_unit_snapshot" > 0),
	CONSTRAINT "order_offer_rounds_fee_chk" CHECK ("order_offer_rounds"."final_driver_fee" is null or "order_offer_rounds"."final_driver_fee" > 0)
);
--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD COLUMN "city_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_id_city_uidx" ON "orders" USING btree ("id","city_id");--> statement-breakpoint
ALTER TABLE "city_driver_pricing" ADD CONSTRAINT "city_driver_pricing_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_driver_pricing" ADD CONSTRAINT "city_driver_pricing_updated_by_account_id_accounts_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD CONSTRAINT "offer_idempotency_keys_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD CONSTRAINT "offer_idempotency_keys_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_driver_id_accounts_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_offer_round_id_order_offer_rounds_id_fk" FOREIGN KEY ("offer_round_id") REFERENCES "public"."order_offer_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_assigned_by_account_id_accounts_id_fk" FOREIGN KEY ("assigned_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_order_city_fk" FOREIGN KEY ("order_id","city_id") REFERENCES "public"."orders"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_claimed_by_driver_id_accounts_id_fk" FOREIGN KEY ("claimed_by_driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_order_city_fk" FOREIGN KEY ("order_id","city_id") REFERENCES "public"."orders"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "city_driver_pricing_city_uidx" ON "city_driver_pricing" USING btree ("city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_idempotency_scope_actor_city_key_uidx" ON "offer_idempotency_keys" USING btree ("scope","actor_account_id","city_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_driver_assignments_active_order_uidx" ON "order_driver_assignments" USING btree ("order_id") WHERE "order_driver_assignments"."completed_at" is null and "order_driver_assignments"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "order_driver_assignments_driver_active_idx" ON "order_driver_assignments" USING btree ("driver_id","assigned_at") WHERE "order_driver_assignments"."completed_at" is null and "order_driver_assignments"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "order_driver_assignments_city_assigned_idx" ON "order_driver_assignments" USING btree ("city_id","assigned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_offer_rounds_one_open_uidx" ON "order_offer_rounds" USING btree ("order_id") WHERE "order_offer_rounds"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "order_offer_rounds_city_open_opened_idx" ON "order_offer_rounds" USING btree ("city_id","opened_at","id") WHERE "order_offer_rounds"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "order_offer_rounds_order_opened_idx" ON "order_offer_rounds" USING btree ("order_id","opened_at","id");--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_profiles_city_operational_idx" ON "driver_profiles" USING btree ("city_id","operational_status");--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_active_city_chk" CHECK ("driver_profiles"."operational_status" <> 'ACTIVE' or "driver_profiles"."city_id" is not null);--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('city_driver_pricing.read', 'Read City driver offer pricing (SUPER_ADMIN control plane)', 'ACTIVE'),
  ('city_driver_pricing.manage', 'Manage City driver offer pricing (SUPER_ADMIN control plane)', 'ACTIVE'),
  ('order_offers.read', 'Read City order offer rounds', 'ACTIVE'),
  ('order_offers.manage', 'Open, stop, and reopen City order offer rounds', 'ACTIVE'),
  ('orders.assign', 'Manually assign drivers to City orders during peak demand', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;