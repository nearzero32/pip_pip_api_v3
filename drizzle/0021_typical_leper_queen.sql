ALTER TABLE "cart_items" ADD COLUMN "selected_size_id" uuid;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "selected_size_name_snapshot" text;--> statement-breakpoint
CREATE UNIQUE INDEX "product_sizes_id_product_store_city_uidx" ON "product_sizes" USING btree ("id","product_id","store_id","city_id");--> statement-breakpoint
UPDATE "cart_items" ci
SET "configuration_key" = CASE
  WHEN p."base_price" IS NOT NULL THEN 'base|' || ci."configuration_key"
  ELSE 'legacy-size-unresolved|' || ci."configuration_key"
END
FROM "products" p
WHERE p."id" = ci."product_id";--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_size_product_store_city_fk" FOREIGN KEY ("selected_size_id","product_id","store_id","city_id") REFERENCES "public"."product_sizes"("id","product_id","store_id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_size_snapshot_chk" CHECK (("cart_items"."selected_size_id" is null) = ("cart_items"."selected_size_name_snapshot" is null));
