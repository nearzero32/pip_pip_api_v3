CREATE TYPE "public"."order_action_source" AS ENUM('CUSTOMER_APP', 'MERCHANT_APP', 'DASHBOARD', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."order_actor_type" AS ENUM('CUSTOMER', 'MERCHANT', 'STAFF', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."order_item_state" AS ENUM('ACTIVE', 'REPLACED');--> statement-breakpoint
CREATE TYPE "public"."order_payment_method" AS ENUM('CASH', 'ONLINE');--> statement-breakpoint
CREATE TYPE "public"."order_payment_status" AS ENUM('UNPAID', 'AWAITING_PAYMENT', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('UNDER_STORE_REVIEW', 'APPROVED_BY_STORE', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'READY_FOR_PICKUP', 'ACCEPTED_BY_DRIVER', 'PICKED_UP', 'ARRIVED_AT_CUSTOMER', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "order_address_snapshots" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"source_address_id" uuid,
	"label" text NOT NULL,
	"address_details" text NOT NULL,
	"landmark" text,
	"recipient_name" text,
	"recipient_phone" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_address_snapshots_lat_chk" CHECK ("order_address_snapshots"."latitude" between -90 and 90),
	CONSTRAINT "order_address_snapshots_lng_chk" CHECK ("order_address_snapshots"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE TABLE "order_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"previous_status" "order_status" NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"actor_type" "order_actor_type" NOT NULL,
	"source" "order_action_source" NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_cancellations_reason_chk" CHECK (length(btrim("order_cancellations"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_delivery_pricing_snapshots" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"pricing_version_id" uuid NOT NULL,
	"pricing_version_number" integer NOT NULL,
	"routing_provider" text NOT NULL,
	"distance_source" text NOT NULL,
	"fallback_reason" text,
	"distance_meters" double precision NOT NULL,
	"duration_seconds" double precision,
	"delivery_fee" integer NOT NULL,
	"zone_id" uuid NOT NULL,
	"origin_latitude" double precision NOT NULL,
	"origin_longitude" double precision NOT NULL,
	"destination_latitude" double precision NOT NULL,
	"destination_longitude" double precision NOT NULL,
	"raw_calculation" jsonb NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_delivery_pricing_snapshots_fee_chk" CHECK ("order_delivery_pricing_snapshots"."delivery_fee" >= 0),
	CONSTRAINT "order_delivery_pricing_snapshots_distance_chk" CHECK ("order_delivery_pricing_snapshots"."distance_meters" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"order_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_idempotency_key_nonempty_chk" CHECK (length(btrim("order_idempotency_keys"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_item_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"original_order_item_id" uuid NOT NULL,
	"replacement_order_item_id" uuid NOT NULL,
	"original_product_id" uuid NOT NULL,
	"replacement_product_id" uuid NOT NULL,
	"original_product_name_snapshot" text NOT NULL,
	"replacement_product_name_snapshot" text NOT NULL,
	"original_quantity" integer NOT NULL,
	"replacement_quantity" integer NOT NULL,
	"original_unit_price" integer NOT NULL,
	"replacement_unit_price" integer NOT NULL,
	"original_line_total" integer NOT NULL,
	"replacement_line_total" integer NOT NULL,
	"products_subtotal_before" integer NOT NULL,
	"products_subtotal_after" integer NOT NULL,
	"total_before" integer NOT NULL,
	"total_after" integer NOT NULL,
	"price_difference" integer NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"actor_type" "order_actor_type" NOT NULL,
	"source" "order_action_source" NOT NULL,
	"reason" text NOT NULL,
	"customer_agreed_by_phone" boolean NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_replacements_reason_chk" CHECK (length(btrim("order_item_replacements"."reason")) > 0),
	CONSTRAINT "order_item_replacements_agreed_phone_chk" CHECK ("order_item_replacements"."customer_agreed_by_phone" = true)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"selected_size_id" uuid,
	"product_name_snapshot" text NOT NULL,
	"selected_size_name_snapshot" text,
	"unit_price_snapshot" integer NOT NULL,
	"modifiers_price_snapshot" integer NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" integer NOT NULL,
	"state" "order_item_state" DEFAULT 'ACTIVE' NOT NULL,
	"replaces_order_item_id" uuid,
	"modifier_selections_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_chk" CHECK ("order_items"."quantity" between 1 and 99),
	CONSTRAINT "order_items_prices_chk" CHECK ("order_items"."unit_price_snapshot" > 0 and "order_items"."modifiers_price_snapshot" >= 0 and "order_items"."line_total" > 0),
	CONSTRAINT "order_items_line_total_chk" CHECK ("order_items"."line_total" = ("order_items"."unit_price_snapshot" + "order_items"."modifiers_price_snapshot") * "order_items"."quantity"),
	CONSTRAINT "order_items_size_snapshot_chk" CHECK (("order_items"."selected_size_id" is null) = ("order_items"."selected_size_name_snapshot" is null))
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"exited_at" timestamp with time zone,
	"duration_seconds" integer,
	"changed_by_account_id" uuid,
	"actor_type" "order_actor_type" NOT NULL,
	"source" "order_action_source" NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_status_history_duration_chk" CHECK (("order_status_history"."exited_at" is null and "order_status_history"."duration_seconds" is null) or ("order_status_history"."exited_at" is not null and "order_status_history"."duration_seconds" is not null and "order_status_history"."duration_seconds" >= 0))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"city_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"driver_account_id" uuid,
	"status" "order_status" DEFAULT 'UNDER_STORE_REVIEW' NOT NULL,
	"payment_method" "order_payment_method" NOT NULL,
	"payment_status" "order_payment_status" NOT NULL,
	"products_subtotal" integer NOT NULL,
	"delivery_fee" integer NOT NULL,
	"total" integer NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_money_nonneg_chk" CHECK ("orders"."products_subtotal" >= 0 and "orders"."delivery_fee" >= 0 and "orders"."total" >= 0),
	CONSTRAINT "orders_total_sum_chk" CHECK ("orders"."total" = "orders"."products_subtotal" + "orders"."delivery_fee"),
	CONSTRAINT "orders_currency_chk" CHECK ("orders"."currency" = 'IQD'),
	CONSTRAINT "orders_version_positive_chk" CHECK ("orders"."version" > 0),
	CONSTRAINT "orders_cancelled_at_chk" CHECK (("orders"."status" = 'CANCELLED' and "orders"."cancelled_at" is not null) or ("orders"."status" <> 'CANCELLED' and "orders"."cancelled_at" is null)),
	CONSTRAINT "orders_delivered_at_chk" CHECK (("orders"."status" = 'DELIVERED' and "orders"."delivered_at" is not null) or ("orders"."status" <> 'DELIVERED' and "orders"."delivered_at" is null))
);
--> statement-breakpoint
ALTER TABLE "order_address_snapshots" ADD CONSTRAINT "order_address_snapshots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_address_snapshots" ADD CONSTRAINT "order_address_snapshots_source_address_id_customer_addresses_id_fk" FOREIGN KEY ("source_address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cancellations" ADD CONSTRAINT "order_cancellations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cancellations" ADD CONSTRAINT "order_cancellations_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_pricing_snapshots" ADD CONSTRAINT "order_delivery_pricing_snapshots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_delivery_pricing_snapshots" ADD CONSTRAINT "order_delivery_pricing_snapshots_pricing_version_id_city_delivery_pricing_versions_id_fk" FOREIGN KEY ("pricing_version_id") REFERENCES "public"."city_delivery_pricing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_idempotency_keys" ADD CONSTRAINT "order_idempotency_keys_customer_account_id_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_idempotency_keys" ADD CONSTRAINT "order_idempotency_keys_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_idempotency_keys" ADD CONSTRAINT "order_idempotency_keys_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_replacements" ADD CONSTRAINT "order_item_replacements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_replacements" ADD CONSTRAINT "order_item_replacements_original_order_item_id_order_items_id_fk" FOREIGN KEY ("original_order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_replacements" ADD CONSTRAINT "order_item_replacements_replacement_order_item_id_order_items_id_fk" FOREIGN KEY ("replacement_order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_replacements" ADD CONSTRAINT "order_item_replacements_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_size_fk" FOREIGN KEY ("selected_size_id") REFERENCES "public"."product_sizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_replaces_fk" FOREIGN KEY ("replaces_order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_account_id_accounts_id_fk" FOREIGN KEY ("changed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_account_id_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_account_id_accounts_id_fk" FOREIGN KEY ("driver_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_zone_city_fk" FOREIGN KEY ("zone_id","city_id") REFERENCES "public"."zones"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_cancellations_order_uidx" ON "order_cancellations" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_idempotency_customer_city_key_uidx" ON "order_idempotency_keys" USING btree ("customer_account_id","city_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_replacements_original_uidx" ON "order_item_replacements" USING btree ("original_order_item_id");--> statement-breakpoint
CREATE INDEX "order_item_replacements_order_created_idx" ON "order_item_replacements" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_state_idx" ON "order_items" USING btree ("order_id","state");--> statement-breakpoint
CREATE INDEX "order_status_history_order_entered_idx" ON "order_status_history" USING btree ("order_id","entered_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_history_one_open_uidx" ON "order_status_history" USING btree ("order_id") WHERE "order_status_history"."exited_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_uidx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_city_status_created_idx" ON "orders" USING btree ("city_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_store_status_created_idx" ON "orders" USING btree ("store_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "orders_city_created_idx" ON "orders" USING btree ("city_id","created_at","id");--> statement-breakpoint
CREATE SEQUENCE "orders_public_number_seq" AS bigint INCREMENT BY 1 MINVALUE 1 START WITH 1;--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('orders.read', 'Read City orders', 'ACTIVE'),
  ('orders.cancel', 'Cancel City orders', 'ACTIVE'),
  ('orders.approve', 'Approve City orders during store review', 'ACTIVE'),
  ('orders.items.replace', 'Replace order items during store review', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
