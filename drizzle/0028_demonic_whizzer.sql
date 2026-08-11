CREATE TYPE "public"."redis_reconciliation_job_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."redis_reconciliation_job_type" AS ENUM('DRIVER_RUNTIME', 'CITY_OPEN_OFFERS');--> statement-breakpoint
CREATE TABLE "driver_runtime_revisions" (
	"driver_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redis_reconciliation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" "redis_reconciliation_job_type" NOT NULL,
	"resource_id" uuid NOT NULL,
	"city_id" uuid,
	"expected_revision" integer,
	"status" "redis_reconciliation_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "redis_recon_jobs_attempt_chk" CHECK ("redis_reconciliation_jobs"."attempt_count" >= 0),
	CONSTRAINT "redis_recon_jobs_driver_rev_chk" CHECK ((
        ("redis_reconciliation_jobs"."job_type" = 'DRIVER_RUNTIME' and "redis_reconciliation_jobs"."expected_revision" is not null and "redis_reconciliation_jobs"."expected_revision" > 0)
        or ("redis_reconciliation_jobs"."job_type" = 'CITY_OPEN_OFFERS' and "redis_reconciliation_jobs"."expected_revision" is null and "redis_reconciliation_jobs"."city_id" is not null)
      )),
	CONSTRAINT "redis_recon_jobs_status_dates_chk" CHECK ((
        ("redis_reconciliation_jobs"."status" in ('PENDING', 'PROCESSING') and "redis_reconciliation_jobs"."completed_at" is null)
        or ("redis_reconciliation_jobs"."status" in ('COMPLETED', 'DEAD') and "redis_reconciliation_jobs"."completed_at" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "driver_runtime_revisions" ADD CONSTRAINT "driver_runtime_revisions_driver_id_accounts_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis_reconciliation_jobs" ADD CONSTRAINT "redis_reconciliation_jobs_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redis_recon_jobs_due_idx" ON "redis_reconciliation_jobs" USING btree ("status","next_attempt_at") WHERE "redis_reconciliation_jobs"."status" in ('PENDING', 'PROCESSING');--> statement-breakpoint
CREATE UNIQUE INDEX "redis_recon_jobs_driver_revision_uidx" ON "redis_reconciliation_jobs" USING btree ("job_type","resource_id","expected_revision") WHERE "redis_reconciliation_jobs"."job_type" = 'DRIVER_RUNTIME';--> statement-breakpoint
CREATE UNIQUE INDEX "redis_recon_jobs_city_open_active_uidx" ON "redis_reconciliation_jobs" USING btree ("job_type","resource_id") WHERE "redis_reconciliation_jobs"."job_type" = 'CITY_OPEN_OFFERS' and "redis_reconciliation_jobs"."status" in ('PENDING', 'PROCESSING');