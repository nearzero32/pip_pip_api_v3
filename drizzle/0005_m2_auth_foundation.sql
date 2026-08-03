ALTER TABLE "sessions" DROP CONSTRAINT "sessions_auth_method_chk";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_password_credential_id_password_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD COLUMN "verifier_key_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "password_credentials_id_account_uidx" ON "password_credentials" USING btree ("id","account_id");--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_credential_account_fk" FOREIGN KEY ("password_credential_id","account_id") REFERENCES "public"."password_credentials"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "sessions" SET "authentication_method" = 'PASSWORD' WHERE "application_type" = 'DASHBOARD' AND "authentication_method" = 'PASSWORD_TOTP';--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_auth_method_chk" CHECK (("sessions"."application_type" = 'DASHBOARD' and "sessions"."authentication_method" = 'PASSWORD') or ("sessions"."application_type" in ('CUSTOMER_APP', 'DRIVER_APP') and "sessions"."authentication_method" = 'PHONE_OTP'));
