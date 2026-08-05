CREATE TABLE "store_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"parent_category_id" uuid,
	"name" text NOT NULL,
	"status" "main_category_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "store_categories_name_nonempty_chk" CHECK (length(btrim("store_categories"."name")) > 0),
	CONSTRAINT "store_categories_display_order_nonnegative_chk" CHECK ("store_categories"."display_order" >= 0),
	CONSTRAINT "store_categories_archived_at_chk" CHECK (("store_categories"."status" = 'ARCHIVED' and "store_categories"."archived_at" is not null) or ("store_categories"."status" <> 'ARCHIVED' and "store_categories"."archived_at" is null)),
	CONSTRAINT "store_categories_no_self_parent_chk" CHECK ("store_categories"."parent_category_id" is null or "store_categories"."parent_category_id" <> "store_categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "store_categories_id_store_uidx" ON "store_categories" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_categories_id_store_city_uidx" ON "store_categories" USING btree ("id","store_id","city_id");--> statement-breakpoint
ALTER TABLE "store_categories" ADD CONSTRAINT "store_categories_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_categories" ADD CONSTRAINT "store_categories_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_categories" ADD CONSTRAINT "store_categories_parent_store_fk" FOREIGN KEY ("parent_category_id","store_id") REFERENCES "public"."store_categories"("id","store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_categories_store_root_name_active_uidx" ON "store_categories" USING btree ("store_id",lower(btrim("name"))) WHERE "store_categories"."status" <> 'ARCHIVED' and "store_categories"."parent_category_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "store_categories_store_parent_name_active_uidx" ON "store_categories" USING btree ("store_id","parent_category_id",lower(btrim("name"))) WHERE "store_categories"."status" <> 'ARCHIVED' and "store_categories"."parent_category_id" is not null;--> statement-breakpoint
CREATE INDEX "store_categories_store_status_order_idx" ON "store_categories" USING btree ("store_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "store_categories_store_parent_status_order_idx" ON "store_categories" USING btree ("store_id","parent_category_id","status","display_order","created_at","id");--> statement-breakpoint
CREATE INDEX "store_categories_city_store_idx" ON "store_categories" USING btree ("city_id","store_id");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('store_categories.read', 'Read Store product categories', 'ACTIVE'),
  ('store_categories.create', 'Create Store product categories', 'ACTIVE'),
  ('store_categories.update', 'Update Store product categories', 'ACTIVE'),
  ('store_categories.archive', 'Archive Store product categories', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
