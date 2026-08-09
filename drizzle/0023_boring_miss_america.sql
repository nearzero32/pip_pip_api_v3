CREATE TYPE "public"."delivery_pricing_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "city_delivery_pricing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "delivery_pricing_status" DEFAULT 'DRAFT' NOT NULL,
	"base_fee" integer NOT NULL,
	"included_distance_meters" integer NOT NULL,
	"price_per_km" integer NOT NULL,
	"rounding_step" integer NOT NULL,
	"maximum_delivery_distance_meters" integer,
	"routing_fallback_enabled" boolean NOT NULL,
	"fallback_on_no_route" boolean NOT NULL,
	"fallback_on_provider_failure" boolean NOT NULL,
	"fallback_extra_distance_meters" integer NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "city_delivery_pricing_version_positive_chk" CHECK ("city_delivery_pricing_versions"."version" > 0),
	CONSTRAINT "city_delivery_pricing_values_chk" CHECK ("city_delivery_pricing_versions"."base_fee" >= 0 and "city_delivery_pricing_versions"."included_distance_meters" >= 0 and "city_delivery_pricing_versions"."price_per_km" >= 0 and "city_delivery_pricing_versions"."rounding_step" > 0 and "city_delivery_pricing_versions"."fallback_extra_distance_meters" >= 0 and ("city_delivery_pricing_versions"."maximum_delivery_distance_meters" is null or "city_delivery_pricing_versions"."maximum_delivery_distance_meters" > 0)),
	CONSTRAINT "city_delivery_pricing_fallback_consistency_chk" CHECK ("city_delivery_pricing_versions"."routing_fallback_enabled" or (not "city_delivery_pricing_versions"."fallback_on_no_route" and not "city_delivery_pricing_versions"."fallback_on_provider_failure")),
	CONSTRAINT "city_delivery_pricing_lifecycle_chk" CHECK (("city_delivery_pricing_versions"."status" = 'DRAFT' and "city_delivery_pricing_versions"."activated_at" is null and "city_delivery_pricing_versions"."deactivated_at" is null) or ("city_delivery_pricing_versions"."status" = 'ACTIVE' and "city_delivery_pricing_versions"."activated_at" is not null and "city_delivery_pricing_versions"."deactivated_at" is null) or ("city_delivery_pricing_versions"."status" = 'INACTIVE' and "city_delivery_pricing_versions"."activated_at" is not null and "city_delivery_pricing_versions"."deactivated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "city_delivery_pricing_versions" ADD CONSTRAINT "city_delivery_pricing_versions_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_delivery_pricing_versions" ADD CONSTRAINT "city_delivery_pricing_versions_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "city_delivery_pricing_city_version_uidx" ON "city_delivery_pricing_versions" USING btree ("city_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "city_delivery_pricing_one_active_uidx" ON "city_delivery_pricing_versions" USING btree ("city_id") WHERE "city_delivery_pricing_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "city_delivery_pricing_city_created_idx" ON "city_delivery_pricing_versions" USING btree ("city_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION enforce_delivery_pricing_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.city_id <> OLD.city_id OR NEW.version <> OLD.version
    OR NEW.base_fee <> OLD.base_fee OR NEW.included_distance_meters <> OLD.included_distance_meters
    OR NEW.price_per_km <> OLD.price_per_km OR NEW.rounding_step <> OLD.rounding_step
    OR NEW.maximum_delivery_distance_meters IS DISTINCT FROM OLD.maximum_delivery_distance_meters
    OR NEW.routing_fallback_enabled <> OLD.routing_fallback_enabled
    OR NEW.fallback_on_no_route <> OLD.fallback_on_no_route
    OR NEW.fallback_on_provider_failure <> OLD.fallback_on_provider_failure
    OR NEW.fallback_extra_distance_meters <> OLD.fallback_extra_distance_meters
    OR NEW.created_by_account_id <> OLD.created_by_account_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'delivery pricing values are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND NEW.activated_at IS NOT NULL AND NEW.deactivated_at IS NULL)
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE' AND NEW.activated_at = OLD.activated_at AND NEW.deactivated_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid delivery pricing lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER city_delivery_pricing_immutable_before_update BEFORE UPDATE ON city_delivery_pricing_versions
FOR EACH ROW EXECUTE FUNCTION enforce_delivery_pricing_immutability();
