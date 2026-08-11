CREATE TABLE "city_open_offer_revisions" (
	"city_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redis_reconciliation_jobs" DROP CONSTRAINT "redis_recon_jobs_driver_rev_chk";--> statement-breakpoint
-- Backfill CITY_OPEN_OFFERS rows so the new CHECK (expected_revision > 0) can apply.
UPDATE "redis_reconciliation_jobs"
SET "expected_revision" = 1
WHERE "job_type" = 'CITY_OPEN_OFFERS'
  AND "expected_revision" IS NULL;--> statement-breakpoint
INSERT INTO "city_open_offer_revisions" ("city_id", "revision", "updated_at")
SELECT DISTINCT "resource_id", 1, now()
FROM "redis_reconciliation_jobs"
WHERE "job_type" = 'CITY_OPEN_OFFERS'
ON CONFLICT ("city_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "city_open_offer_revisions" ADD CONSTRAINT "city_open_offer_revisions_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redis_recon_jobs_expired_lease_idx" ON "redis_reconciliation_jobs" USING btree ("status","locked_at") WHERE "redis_reconciliation_jobs"."status" = 'PROCESSING';--> statement-breakpoint
ALTER TABLE "redis_reconciliation_jobs" ADD CONSTRAINT "redis_recon_jobs_driver_rev_chk" CHECK ((
        ("redis_reconciliation_jobs"."job_type" = 'DRIVER_RUNTIME' and "redis_reconciliation_jobs"."expected_revision" is not null and "redis_reconciliation_jobs"."expected_revision" > 0)
        or ("redis_reconciliation_jobs"."job_type" = 'CITY_OPEN_OFFERS' and "redis_reconciliation_jobs"."expected_revision" is not null and "redis_reconciliation_jobs"."expected_revision" > 0 and "redis_reconciliation_jobs"."city_id" is not null)
      ));
