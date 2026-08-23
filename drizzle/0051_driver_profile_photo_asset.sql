ALTER TABLE "driver_profiles" ADD COLUMN "driver_photo_asset_id" uuid REFERENCES "media_assets"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_profiles_photo_asset_uidx" ON "driver_profiles" USING btree ("driver_photo_asset_id") WHERE "driver_profiles"."driver_photo_asset_id" IS NOT NULL;
