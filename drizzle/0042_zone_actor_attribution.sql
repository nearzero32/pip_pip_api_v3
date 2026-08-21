-- Legacy Zones intentionally retain NULL actor fields. New dashboard mutations
-- always record the authenticated account; no synthetic backfill is performed.
ALTER TABLE "zones" ADD COLUMN "created_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN "updated_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN "archived_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_updated_by_account_id_accounts_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_archived_by_account_id_accounts_id_fk" FOREIGN KEY ("archived_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
