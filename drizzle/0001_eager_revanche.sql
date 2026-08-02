ALTER TABLE "account_phones" DROP CONSTRAINT "account_phones_e164_format_chk";--> statement-breakpoint
ALTER TABLE "otp_challenges" DROP CONSTRAINT "otp_phone_e164_format_chk";--> statement-breakpoint
DROP INDEX "account_role_scopes_value_uidx";--> statement-breakpoint
DROP INDEX "role_permissions_pair_uidx";--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_pk" PRIMARY KEY("role_id","permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_role_scopes_global_uidx" ON "account_role_scopes" USING btree ("account_role_id") WHERE "account_role_scopes"."scope_type" = 'GLOBAL';--> statement-breakpoint
CREATE UNIQUE INDEX "account_role_scopes_city_uidx" ON "account_role_scopes" USING btree ("account_role_id","scope_reference_id") WHERE "account_role_scopes"."scope_type" = 'CITY';--> statement-breakpoint
ALTER TABLE "account_phones" ADD CONSTRAINT "account_phones_e164_format_chk" CHECK ("account_phones"."phone_e164" ~ '^\+[1-9][0-9]{1,14}$');--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_phone_e164_format_chk" CHECK ("otp_challenges"."phone_e164" ~ '^\+[1-9][0-9]{1,14}$');
--> statement-breakpoint
INSERT INTO "roles" ("code", "display_name", "description", "is_system") VALUES
  ('SUPER_ADMIN', 'Super Admin', 'Global dashboard staff role; operation permissions are intentionally not seeded.', true),
  ('ADMIN', 'Admin', 'Single-city dashboard staff role; operation permissions are intentionally not seeded.', true),
  ('OPERATIONS', 'Operations', 'Dashboard operations staff role; operation permissions are intentionally not seeded.', true),
  ('ACCOUNTANT', 'Accountant', 'Dashboard accounting staff role; operation permissions are intentionally not seeded.', true),
  ('SUPPORT', 'Support', 'Dashboard support staff role; operation permissions are intentionally not seeded.', true)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
COMMENT ON COLUMN "audit_logs"."redacted_metadata" IS 'Allowlisted, redacted metadata only. Passwords, OTPs, tokens, recovery codes, authorization headers, and MFA secrets are prohibited.';
--> statement-breakpoint
COMMENT ON COLUMN "password_reset_tokens"."request_security_metadata" IS 'Minimized security metadata only; raw reset tokens and credentials are prohibited.';
