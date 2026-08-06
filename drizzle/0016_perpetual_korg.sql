CREATE TYPE "public"."product_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"base_price" integer,
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "products_name_nonempty_chk" CHECK (length(btrim("products"."name")) > 0),
	CONSTRAINT "products_display_order_nonnegative_chk" CHECK ("products"."display_order" >= 0),
	CONSTRAINT "products_archived_at_chk" CHECK (("products"."status" = 'ARCHIVED' and "products"."archived_at" is not null) or ("products"."status" <> 'ARCHIVED' and "products"."archived_at" is null)),
	CONSTRAINT "products_base_price_positive_chk" CHECK ("products"."base_price" is null or "products"."base_price" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "products_id_store_uidx" ON "products" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_id_store_city_uidx" ON "products" USING btree ("id","store_id","city_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_store_fk" FOREIGN KEY ("category_id","store_id") REFERENCES "public"."store_categories"("id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_store_name_active_uidx" ON "products" USING btree ("store_id",lower(btrim("name"))) WHERE "products"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE INDEX "products_store_status_order_idx" ON "products" USING btree ("store_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "products_store_category_status_idx" ON "products" USING btree ("store_id","category_id","status");--> statement-breakpoint
CREATE INDEX "products_city_store_idx" ON "products" USING btree ("city_id","store_id");--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_display_order_nonnegative_chk" CHECK ("product_images"."display_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_store_city_fk" FOREIGN KEY ("product_id","store_id","city_id") REFERENCES "public"."products"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_media_asset_uidx" ON "product_images" USING btree ("media_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_product_primary_uidx" ON "product_images" USING btree ("product_id") WHERE "product_images"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "product_images_product_order_idx" ON "product_images" USING btree ("product_id","display_order","id");--> statement-breakpoint
CREATE TABLE "product_sizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "product_sizes_name_nonempty_chk" CHECK (length(btrim("product_sizes"."name")) > 0),
	CONSTRAINT "product_sizes_price_positive_chk" CHECK ("product_sizes"."price" > 0),
	CONSTRAINT "product_sizes_display_order_nonnegative_chk" CHECK ("product_sizes"."display_order" >= 0),
	CONSTRAINT "product_sizes_archived_at_chk" CHECK (("product_sizes"."status" = 'ARCHIVED' and "product_sizes"."archived_at" is not null) or ("product_sizes"."status" <> 'ARCHIVED' and "product_sizes"."archived_at" is null)),
	CONSTRAINT "product_sizes_default_active_chk" CHECK ("product_sizes"."is_default" = false or "product_sizes"."status" = 'ACTIVE')
);
--> statement-breakpoint
ALTER TABLE "product_sizes" ADD CONSTRAINT "product_sizes_product_store_city_fk" FOREIGN KEY ("product_id","store_id","city_id") REFERENCES "public"."products"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_sizes_product_name_active_uidx" ON "product_sizes" USING btree ("product_id",lower(btrim("name"))) WHERE "product_sizes"."status" <> 'ARCHIVED';--> statement-breakpoint
CREATE UNIQUE INDEX "product_sizes_product_default_active_uidx" ON "product_sizes" USING btree ("product_id") WHERE "product_sizes"."is_default" = true and "product_sizes"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "product_sizes_product_status_order_idx" ON "product_sizes" USING btree ("product_id","status","display_order","id");--> statement-breakpoint
CREATE TABLE "product_availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"day_of_week" "weekday" NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_availability_opens_before_closes_chk" CHECK ("product_availability_windows"."opens_at" < "product_availability_windows"."closes_at")
);
--> statement-breakpoint
ALTER TABLE "product_availability_windows" ADD CONSTRAINT "product_availability_product_store_city_fk" FOREIGN KEY ("product_id","store_id","city_id") REFERENCES "public"."products"("id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_availability_product_day_opens_uidx" ON "product_availability_windows" USING btree ("product_id","day_of_week","opens_at");--> statement-breakpoint
CREATE INDEX "product_availability_product_day_idx" ON "product_availability_windows" USING btree ("product_id","day_of_week","opens_at");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('products.read', 'Read Store products', 'ACTIVE'),
  ('products.create', 'Create Store products', 'ACTIVE'),
  ('products.update', 'Update Store products', 'ACTIVE'),
  ('products.archive', 'Archive Store products', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
