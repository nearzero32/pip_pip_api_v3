CREATE TYPE "public"."main_category_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "main_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image_asset_id" uuid NOT NULL,
	"status" "main_category_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "main_categories_name_nonempty_chk" CHECK (length(btrim("main_categories"."name")) > 0),
	CONSTRAINT "main_categories_display_order_nonnegative_chk" CHECK ("main_categories"."display_order" >= 0),
	CONSTRAINT "main_categories_archived_at_chk" CHECK (("main_categories"."status" = 'ARCHIVED' and "main_categories"."archived_at" is not null) or ("main_categories"."status" <> 'ARCHIVED' and "main_categories"."archived_at" is null))
);
--> statement-breakpoint
ALTER TABLE "main_categories" ADD CONSTRAINT "main_categories_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_categories" ADD CONSTRAINT "main_categories_image_asset_id_media_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_categories" ADD CONSTRAINT "main_categories_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "main_categories_image_asset_uidx" ON "main_categories" USING btree ("image_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "main_categories_city_name_active_uidx" ON "main_categories" USING btree ("city_id",lower(btrim("name"))) WHERE "main_categories"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "main_categories_city_status_order_idx" ON "main_categories" USING btree ("city_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "main_categories_city_name_idx" ON "main_categories" USING btree ("city_id","name");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('main_categories.read', 'Read City main categories', 'ACTIVE'),
  ('main_categories.create', 'Create City main categories', 'ACTIVE'),
  ('main_categories.update', 'Update City main categories', 'ACTIVE'),
  ('main_categories.archive', 'Archive City main categories', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;