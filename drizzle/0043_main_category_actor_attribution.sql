-- Existing categories deliberately remain unattributed for fields introduced later.
ALTER TABLE "main_categories" ADD COLUMN "updated_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "main_categories" ADD COLUMN "archived_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "main_categories" ADD CONSTRAINT "main_categories_updated_by_account_id_accounts_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_categories" ADD CONSTRAINT "main_categories_archived_by_account_id_accounts_id_fk" FOREIGN KEY ("archived_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
