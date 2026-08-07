CREATE TABLE "cart_item_modifier_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_item_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"modifier_option_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"option_name_snapshot" text NOT NULL,
	"unit_price_snapshot" integer NOT NULL,
	"configuration_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_item_selections_quantity_chk" CHECK ("cart_item_modifier_selections"."quantity" >= 1),
	CONSTRAINT "cart_item_selections_price_chk" CHECK ("cart_item_modifier_selections"."unit_price_snapshot" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"configuration_key" text NOT NULL,
	"quantity" integer NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"unit_price_snapshot" integer NOT NULL,
	"modifiers_price_snapshot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_chk" CHECK ("cart_items"."quantity" between 1 and 99),
	CONSTRAINT "cart_items_prices_chk" CHECK ("cart_items"."unit_price_snapshot" > 0 and "cart_items"."modifiers_price_snapshot" >= 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_status_chk" CHECK ("carts"."status" in ('ACTIVE','COMPLETED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_id_cart_uidx" ON "cart_items" USING btree ("id","cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_id_store_city_uidx" ON "carts" USING btree ("id","store_id","city_id");--> statement-breakpoint
ALTER TABLE "cart_item_modifier_selections" ADD CONSTRAINT "cart_item_selections_item_cart_fk" FOREIGN KEY ("cart_item_id","cart_id") REFERENCES "public"."cart_items"("id","cart_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_store_city_fk" FOREIGN KEY ("cart_id","store_id","city_id") REFERENCES "public"."carts"("id","store_id","city_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_store_city_fk" FOREIGN KEY ("product_id","store_id","city_id") REFERENCES "public"."products"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_account_id_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_item_selections_item_option_uidx" ON "cart_item_modifier_selections" USING btree ("cart_item_id","modifier_option_id");--> statement-breakpoint
CREATE INDEX "cart_item_selections_cart_idx" ON "cart_item_modifier_selections" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_product_config_uidx" ON "cart_items" USING btree ("cart_id","product_id","configuration_key");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_one_active_customer_uidx" ON "carts" USING btree ("customer_account_id") WHERE "carts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "carts_customer_status_idx" ON "carts" USING btree ("customer_account_id","status");
