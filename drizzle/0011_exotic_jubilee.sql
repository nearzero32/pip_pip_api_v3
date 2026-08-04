CREATE TYPE "public"."media_asset_purpose" AS ENUM('CATEGORY_IMAGE', 'STORE_LOGO', 'STORE_IMAGE', 'PRODUCT_IMAGE', 'DRIVER_PHOTO', 'DRIVER_DOCUMENT', 'USER_AVATAR', 'BANNER_IMAGE');--> statement-breakpoint
CREATE TYPE "public"."media_asset_status" AS ENUM('PENDING_UPLOAD', 'READY', 'DELETE_PENDING', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."media_asset_visibility" AS ENUM('PUBLIC', 'PRIVATE');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"purpose" "media_asset_purpose" NOT NULL,
	"visibility" "media_asset_visibility" NOT NULL,
	"status" "media_asset_status" NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"expected_content_type" text NOT NULL,
	"expected_size_bytes" bigint NOT NULL,
	"verified_content_type" text,
	"verified_size_bytes" bigint,
	"etag" text,
	"created_by_account_id" uuid NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"delete_requested_at" timestamp with time zone,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_delete_error_at" timestamp with time zone,
	"delete_lease_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_object_key_nonempty_chk" CHECK (length(btrim("media_assets"."object_key")) > 0),
	CONSTRAINT "media_assets_original_name_nonempty_chk" CHECK (length(btrim("media_assets"."original_name")) > 0),
	CONSTRAINT "media_assets_expected_size_positive_chk" CHECK ("media_assets"."expected_size_bytes" > 0),
	CONSTRAINT "media_assets_verified_size_positive_chk" CHECK ("media_assets"."verified_size_bytes" is null or "media_assets"."verified_size_bytes" > 0),
	CONSTRAINT "media_assets_pending_upload_chk" CHECK ("media_assets"."status" <> 'PENDING_UPLOAD' or ("media_assets"."ready_at" is null and "media_assets"."deleted_at" is null)),
	CONSTRAINT "media_assets_ready_chk" CHECK ("media_assets"."status" <> 'READY' or (
        "media_assets"."ready_at" is not null
        and "media_assets"."verified_content_type" is not null
        and "media_assets"."verified_size_bytes" is not null
        and "media_assets"."deleted_at" is null
      )),
	CONSTRAINT "media_assets_delete_pending_chk" CHECK ("media_assets"."status" <> 'DELETE_PENDING' or "media_assets"."delete_requested_at" is not null),
	CONSTRAINT "media_assets_deleted_chk" CHECK ("media_assets"."status" <> 'DELETED' or (
        "media_assets"."delete_requested_at" is not null
        and "media_assets"."deleted_at" is not null
        and "media_assets"."attached_at" is null
      )),
	CONSTRAINT "media_assets_attached_ready_chk" CHECK ("media_assets"."attached_at" is null or "media_assets"."status" = 'READY')
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_object_key_uidx" ON "media_assets" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "media_assets_city_status_created_idx" ON "media_assets" USING btree ("city_id","status","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_creator_created_idx" ON "media_assets" USING btree ("created_by_account_id","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_pending_upload_expires_idx" ON "media_assets" USING btree ("upload_expires_at") WHERE "media_assets"."status" = 'PENDING_UPLOAD';--> statement-breakpoint
CREATE INDEX "media_assets_ready_unattached_idx" ON "media_assets" USING btree ("ready_at") WHERE "media_assets"."status" = 'READY' and "media_assets"."attached_at" is null;--> statement-breakpoint
CREATE INDEX "media_assets_delete_pending_lease_idx" ON "media_assets" USING btree ("delete_lease_until","delete_requested_at") WHERE "media_assets"."status" = 'DELETE_PENDING';--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('media.read', 'Read City media assets', 'ACTIVE'),
  ('media.create', 'Create City media upload intents and confirm uploads', 'ACTIVE'),
  ('media.delete', 'Queue deletion of unattached City media assets', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
