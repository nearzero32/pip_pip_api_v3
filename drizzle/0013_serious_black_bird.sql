CREATE UNIQUE INDEX "main_categories_id_city_uidx" ON "main_categories" USING btree ("id","city_id");--> statement-breakpoint
CREATE TABLE "subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"main_category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image_asset_id" uuid,
	"status" "main_category_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "subcategories_name_nonempty_chk" CHECK (length(btrim("subcategories"."name")) > 0),
	CONSTRAINT "subcategories_display_order_nonnegative_chk" CHECK ("subcategories"."display_order" >= 0),
	CONSTRAINT "subcategories_archived_at_chk" CHECK (("subcategories"."status" = 'ARCHIVED' and "subcategories"."archived_at" is not null) or ("subcategories"."status" <> 'ARCHIVED' and "subcategories"."archived_at" is null))
);
--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_image_asset_id_media_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_main_category_city_fk" FOREIGN KEY ("main_category_id","city_id") REFERENCES "public"."main_categories"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subcategories_image_asset_uidx" ON "subcategories" USING btree ("image_asset_id") WHERE "subcategories"."image_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subcategories_parent_name_active_uidx" ON "subcategories" USING btree ("city_id","main_category_id",lower(btrim("name"))) WHERE "subcategories"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "subcategories_city_parent_status_order_idx" ON "subcategories" USING btree ("city_id","main_category_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "subcategories_city_status_order_idx" ON "subcategories" USING btree ("city_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "subcategories_city_name_idx" ON "subcategories" USING btree ("city_id","name");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('subcategories.read', 'Read City subcategories', 'ACTIVE'),
  ('subcategories.create', 'Create City subcategories', 'ACTIVE'),
  ('subcategories.update', 'Update City subcategories', 'ACTIVE'),
  ('subcategories.archive', 'Archive City subcategories', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
