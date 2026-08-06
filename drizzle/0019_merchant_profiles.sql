CREATE TABLE "merchant_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"display_name" text,
	"status" "merchant_profile_status" DEFAULT 'ACTIVE' NOT NULL,
	"status_reason_code" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_profiles_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "merchant_profiles_display_name_chk" CHECK ("merchant_profiles"."display_name" is null or length(btrim("merchant_profiles"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_auth_method_chk";--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_store_city_fk" FOREIGN KEY ("store_id","city_id") REFERENCES "public"."stores"("id","city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_profiles_account_uidx" ON "merchant_profiles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "merchant_profiles_store_status_idx" ON "merchant_profiles" USING btree ("store_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "merchant_profiles_city_status_idx" ON "merchant_profiles" USING btree ("city_id","status","created_at","id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_auth_method_chk" CHECK (("sessions"."application_type" = 'DASHBOARD' and "sessions"."authentication_method" = 'PASSWORD') or ("sessions"."application_type" = 'CUSTOMER_APP' and "sessions"."authentication_method" = 'PHONE_OTP') or ("sessions"."application_type" = 'DRIVER_APP' and "sessions"."authentication_method" = 'DRIVER_ACCESS_CODE') or ("sessions"."application_type" = 'MERCHANT_APP' and "sessions"."authentication_method" = 'PASSWORD'));--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('merchants.read', 'Read Merchant accounts in the authenticated City', 'ACTIVE'),
  ('merchants.create', 'Create Merchant accounts in the authenticated City', 'ACTIVE'),
  ('merchants.update', 'Update Merchant accounts in the authenticated City', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
