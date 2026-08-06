CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "modifier_groups_name_nonempty_chk" CHECK (length(btrim("modifier_groups"."name")) > 0),
	CONSTRAINT "modifier_groups_min_select_chk" CHECK ("modifier_groups"."min_select" >= 0),
	CONSTRAINT "modifier_groups_max_select_chk" CHECK ("modifier_groups"."max_select" >= 1),
	CONSTRAINT "modifier_groups_min_max_chk" CHECK ("modifier_groups"."min_select" <= "modifier_groups"."max_select"),
	CONSTRAINT "modifier_groups_archived_at_chk" CHECK (("modifier_groups"."status" = 'ARCHIVED' and "modifier_groups"."archived_at" is not null) or ("modifier_groups"."status" <> 'ARCHIVED' and "modifier_groups"."archived_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_id_store_uidx" ON "modifier_groups" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_id_store_city_uidx" ON "modifier_groups" USING btree ("id","store_id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_store_name_active_uidx" ON "modifier_groups" USING btree ("store_id",lower(btrim("name"))) WHERE "modifier_groups"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "modifier_groups_store_status_idx" ON "modifier_groups" USING btree ("store_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "modifier_groups_city_store_idx" ON "modifier_groups" USING btree ("city_id","store_id");--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "modifier_options_name_nonempty_chk" CHECK (length(btrim("modifier_options"."name")) > 0),
	CONSTRAINT "modifier_options_display_order_nonnegative_chk" CHECK ("modifier_options"."display_order" >= 0),
	CONSTRAINT "modifier_options_archived_at_chk" CHECK (("modifier_options"."status" = 'ARCHIVED' and "modifier_options"."archived_at" is not null) or ("modifier_options"."status" <> 'ARCHIVED' and "modifier_options"."archived_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_id_store_uidx" ON "modifier_options" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_id_group_uidx" ON "modifier_options" USING btree ("id","modifier_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_id_store_city_uidx" ON "modifier_options" USING btree ("id","store_id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_store_name_active_uidx" ON "modifier_options" USING btree ("store_id",lower(btrim("name"))) WHERE "modifier_options"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "modifier_options_group_status_order_idx" ON "modifier_options" USING btree ("modifier_group_id","status","display_order","id");--> statement-breakpoint
CREATE INDEX "modifier_options_store_status_idx" ON "modifier_options" USING btree ("store_id","status");--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_store_city_fk" FOREIGN KEY ("modifier_group_id","store_id","city_id") REFERENCES "public"."modifier_groups"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "modifier_group_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_modifier_group_store_fk" FOREIGN KEY ("modifier_group_id","store_id") REFERENCES "public"."modifier_groups"("id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_store_modifier_group_idx" ON "products" USING btree ("store_id","modifier_group_id");--> statement-breakpoint
CREATE TABLE "product_modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"modifier_option_id" uuid NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"max_quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_modifier_options_price_nonnegative_chk" CHECK ("product_modifier_options"."price" >= 0),
	CONSTRAINT "product_modifier_options_max_quantity_chk" CHECK ("product_modifier_options"."max_quantity" >= 1),
	CONSTRAINT "product_modifier_options_default_price_chk" CHECK ("product_modifier_options"."is_default" = false or "product_modifier_options"."price" = 0)
);
--> statement-breakpoint
ALTER TABLE "product_modifier_options" ADD CONSTRAINT "product_modifier_options_product_store_city_fk" FOREIGN KEY ("product_id","store_id","city_id") REFERENCES "public"."products"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_options" ADD CONSTRAINT "product_modifier_options_option_store_city_fk" FOREIGN KEY ("modifier_option_id","store_id","city_id") REFERENCES "public"."modifier_options"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_modifier_options_product_option_uidx" ON "product_modifier_options" USING btree ("product_id","modifier_option_id");--> statement-breakpoint
CREATE INDEX "product_modifier_options_product_idx" ON "product_modifier_options" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_modifier_options_option_idx" ON "product_modifier_options" USING btree ("modifier_option_id");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('modifiers.read', 'Read Store modifier groups and options', 'ACTIVE'),
  ('modifiers.create', 'Create Store modifier groups and options', 'ACTIVE'),
  ('modifiers.update', 'Update Store modifier groups and options', 'ACTIVE'),
  ('modifiers.archive', 'Archive Store modifier groups and options', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
