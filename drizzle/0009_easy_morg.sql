CREATE TABLE "account_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_account_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "managed_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "account_permission_grants" ADD CONSTRAINT "account_permission_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_permission_grants" ADD CONSTRAINT "account_permission_grants_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_permission_grants" ADD CONSTRAINT "account_permission_grants_granted_by_account_id_accounts_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_permission_grants" ADD CONSTRAINT "account_permission_grants_revoked_by_account_id_accounts_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_permission_grants_active_uidx" ON "account_permission_grants" USING btree ("account_id","permission_id") WHERE "account_permission_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "account_permission_grants_account_idx" ON "account_permission_grants" USING btree ("account_id","revoked_at");--> statement-breakpoint
CREATE INDEX "account_permission_grants_permission_idx" ON "account_permission_grants" USING btree ("permission_id");--> statement-breakpoint
ALTER TABLE "account_role_scopes" ADD CONSTRAINT "account_role_scopes_city_id_cities_id_fk" FOREIGN KEY ("scope_reference_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_managed_by_account_id_accounts_id_fk" FOREIGN KEY ("managed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_role_scopes_one_city_uidx" ON "account_role_scopes" USING btree ("account_role_id") WHERE "account_role_scopes"."scope_type" = 'CITY';--> statement-breakpoint
CREATE INDEX "staff_profiles_managed_by_idx" ON "staff_profiles" USING btree ("managed_by_account_id");--> statement-breakpoint
INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('zones.read', 'Read City zones', 'ACTIVE'),
  ('zones.create', 'Create City zones', 'ACTIVE'),
  ('zones.update', 'Update City zones', 'ACTIVE'),
  ('zones.archive', 'Archive City zones', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
