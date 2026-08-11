CREATE TYPE "public"."offer_idempotency_status" AS ENUM('IN_PROGRESS', 'COMPLETED');--> statement-breakpoint
DROP INDEX "order_driver_assignments_driver_active_idx";--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ALTER COLUMN "response_payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD COLUMN "status" "offer_idempotency_status" DEFAULT 'IN_PROGRESS' NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "offer_idempotency_keys"
SET "status" = 'COMPLETED',
    "http_status" = 200,
    "completed_at" = "created_at",
    "updated_at" = now()
WHERE "response_payload" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "pricing_base_snapshot" integer;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "rounding_unit_snapshot" integer;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "pricing_stages_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "pricing_version_snapshot" integer;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "pricing_stage_after_seconds" integer;--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD COLUMN "pricing_stage_increase_percentage" integer;--> statement-breakpoint
CREATE INDEX "order_driver_assignments_driver_active_idx" ON "order_driver_assignments" USING btree ("driver_id","assignment_sequence","assigned_at") WHERE "order_driver_assignments"."completed_at" is null and "order_driver_assignments"."cancelled_at" is null;--> statement-breakpoint
ALTER TABLE "city_driver_pricing" ADD CONSTRAINT "city_driver_pricing_stages_chk" CHECK (jsonb_typeof("city_driver_pricing"."pricing_stages") = 'array' and jsonb_array_length("city_driver_pricing"."pricing_stages") >= 1);--> statement-breakpoint
ALTER TABLE "offer_idempotency_keys" ADD CONSTRAINT "offer_idempotency_status_chk" CHECK ((
        ("offer_idempotency_keys"."status" = 'IN_PROGRESS' and "offer_idempotency_keys"."response_payload" is null and "offer_idempotency_keys"."http_status" is null and "offer_idempotency_keys"."completed_at" is null)
        or ("offer_idempotency_keys"."status" = 'COMPLETED' and "offer_idempotency_keys"."response_payload" is not null and "offer_idempotency_keys"."http_status" is not null and "offer_idempotency_keys"."completed_at" is not null)
      ));--> statement-breakpoint
ALTER TABLE "order_driver_assignments" ADD CONSTRAINT "order_driver_assignments_pricing_source_chk" CHECK ((
        "order_driver_assignments"."offer_round_id" is not null
        or (
          "order_driver_assignments"."pricing_base_snapshot" is not null
          and "order_driver_assignments"."pricing_base_snapshot" > 0
          and "order_driver_assignments"."rounding_unit_snapshot" is not null
          and "order_driver_assignments"."rounding_unit_snapshot" > 0
          and "order_driver_assignments"."pricing_stages_snapshot" is not null
          and jsonb_typeof("order_driver_assignments"."pricing_stages_snapshot") = 'array'
          and jsonb_array_length("order_driver_assignments"."pricing_stages_snapshot") >= 1
          and "order_driver_assignments"."pricing_version_snapshot" is not null
          and "order_driver_assignments"."pricing_version_snapshot" > 0
          and "order_driver_assignments"."pricing_stage_after_seconds" is not null
          and "order_driver_assignments"."pricing_stage_after_seconds" >= 0
          and "order_driver_assignments"."pricing_stage_increase_percentage" is not null
          and "order_driver_assignments"."pricing_stage_increase_percentage" >= 0
        )
      ));--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_pricing_version_chk" CHECK ("order_offer_rounds"."pricing_version_snapshot" > 0);--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_stages_chk" CHECK (jsonb_typeof("order_offer_rounds"."pricing_stages_snapshot") = 'array' and jsonb_array_length("order_offer_rounds"."pricing_stages_snapshot") >= 1);--> statement-breakpoint
ALTER TABLE "order_offer_rounds" ADD CONSTRAINT "order_offer_rounds_status_fields_chk" CHECK ((
        ("order_offer_rounds"."status" = 'OPEN' and "order_offer_rounds"."closed_at" is null and "order_offer_rounds"."stopped_at" is null and "order_offer_rounds"."final_driver_fee" is null and "order_offer_rounds"."claimed_by_driver_id" is null)
        or ("order_offer_rounds"."status" = 'STOPPED' and "order_offer_rounds"."stopped_at" is not null and "order_offer_rounds"."final_driver_fee" is null and "order_offer_rounds"."claimed_by_driver_id" is null)
        or ("order_offer_rounds"."status" = 'CLAIMED' and "order_offer_rounds"."closed_at" is not null and "order_offer_rounds"."final_driver_fee" is not null and "order_offer_rounds"."claimed_by_driver_id" is not null)
        or ("order_offer_rounds"."status" = 'MANUALLY_ASSIGNED' and "order_offer_rounds"."closed_at" is not null and "order_offer_rounds"."final_driver_fee" is not null and "order_offer_rounds"."claimed_by_driver_id" is not null)
        or ("order_offer_rounds"."status" = 'CANCELLED' and "order_offer_rounds"."closed_at" is not null and "order_offer_rounds"."final_driver_fee" is null)
      ));
