CREATE TYPE "public"."store_order_acceptance_status" AS ENUM('ACCEPTING', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."weekday" AS ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');--> statement-breakpoint
CREATE UNIQUE INDEX "zones_id_city_uidx" ON "zones" USING btree ("id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subcategories_id_city_uidx" ON "subcategories" USING btree ("id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subcategories_id_main_category_city_uidx" ON "subcategories" USING btree ("id","main_category_id","city_id");--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"main_category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"logo_asset_id" uuid,
	"cover_asset_id" uuid,
	"status" "store_status" DEFAULT 'DRAFT' NOT NULL,
	"order_acceptance_status" "store_order_acceptance_status" DEFAULT 'ACCEPTING' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "stores_name_nonempty_chk" CHECK (length(btrim("stores"."name")) > 0),
	CONSTRAINT "stores_phone_nonempty_chk" CHECK (length(btrim("stores"."phone")) > 0),
	CONSTRAINT "stores_address_nonempty_chk" CHECK (length(btrim("stores"."address")) > 0),
	CONSTRAINT "stores_display_order_nonnegative_chk" CHECK ("stores"."display_order" >= 0),
	CONSTRAINT "stores_archived_at_chk" CHECK (("stores"."status" = 'ARCHIVED' and "stores"."archived_at" is not null) or ("stores"."status" <> 'ARCHIVED' and "stores"."archived_at" is null)),
	CONSTRAINT "stores_logo_required_when_not_archived_chk" CHECK ("stores"."status" = 'ARCHIVED' or "stores"."logo_asset_id" is not null),
	CONSTRAINT "stores_logo_cover_distinct_chk" CHECK ("stores"."cover_asset_id" is null or "stores"."logo_asset_id" is null or "stores"."cover_asset_id" <> "stores"."logo_asset_id")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_logo_asset_id_media_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_cover_asset_id_media_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_main_category_city_fk" FOREIGN KEY ("main_category_id","city_id") REFERENCES "public"."main_categories"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_id_city_uidx" ON "stores" USING btree ("id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_id_main_category_city_uidx" ON "stores" USING btree ("id","main_category_id","city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_logo_asset_uidx" ON "stores" USING btree ("logo_asset_id") WHERE "stores"."logo_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_cover_asset_uidx" ON "stores" USING btree ("cover_asset_id") WHERE "stores"."cover_asset_id" is not null;--> statement-breakpoint
CREATE INDEX "stores_city_status_order_idx" ON "stores" USING btree ("city_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "stores_city_main_category_status_idx" ON "stores" USING btree ("city_id","main_category_id","status");--> statement-breakpoint
CREATE INDEX "stores_city_name_idx" ON "stores" USING btree ("city_id","name");--> statement-breakpoint
CREATE INDEX "stores_location_gix" ON "stores" USING gist ("location");--> statement-breakpoint
CREATE TABLE "store_zones" (
	"store_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_zones_pk" PRIMARY KEY("store_id","zone_id")
);
--> statement-breakpoint
ALTER TABLE "store_zones" ADD CONSTRAINT "store_zones_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_zones" ADD CONSTRAINT "store_zones_zone_city_fk" FOREIGN KEY ("zone_id","city_id") REFERENCES "public"."zones"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_zones_zone_store_idx" ON "store_zones" USING btree ("zone_id","store_id");--> statement-breakpoint
CREATE INDEX "store_zones_city_zone_idx" ON "store_zones" USING btree ("city_id","zone_id");--> statement-breakpoint
CREATE TABLE "store_subcategories" (
	"store_id" uuid NOT NULL,
	"subcategory_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"main_category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_subcategories_pk" PRIMARY KEY("store_id","subcategory_id")
);
--> statement-breakpoint
ALTER TABLE "store_subcategories" ADD CONSTRAINT "store_subcategories_store_main_category_city_fk" FOREIGN KEY ("store_id","main_category_id","city_id") REFERENCES "public"."stores"("id","main_category_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_subcategories" ADD CONSTRAINT "store_subcategories_subcategory_main_category_city_fk" FOREIGN KEY ("subcategory_id","main_category_id","city_id") REFERENCES "public"."subcategories"("id","main_category_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_subcategories_subcategory_store_idx" ON "store_subcategories" USING btree ("subcategory_id","store_id");--> statement-breakpoint
CREATE INDEX "store_subcategories_city_main_category_idx" ON "store_subcategories" USING btree ("city_id","main_category_id");--> statement-breakpoint
CREATE TABLE "store_working_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"day_of_week" "weekday" NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_working_hours_opens_closes_distinct_chk" CHECK ("store_working_hours"."opens_at" <> "store_working_hours"."closes_at")
);
--> statement-breakpoint
ALTER TABLE "store_working_hours" ADD CONSTRAINT "store_working_hours_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_working_hours_store_day_idx" ON "store_working_hours" USING btree ("store_id","day_of_week","opens_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_working_hours_store_day_opens_uidx" ON "store_working_hours" USING btree ("store_id","day_of_week","opens_at");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('stores.read', 'Read City stores', 'ACTIVE'),
  ('stores.create', 'Create City stores', 'ACTIVE'),
  ('stores.update', 'Update City stores', 'ACTIVE'),
  ('stores.archive', 'Archive City stores', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
