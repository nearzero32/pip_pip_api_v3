CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TYPE "public"."zone_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"boundary" geometry(Polygon,4326) NOT NULL,
	"status" "zone_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "zones_name_nonempty_chk" CHECK (length(btrim("zones"."name")) > 0),
	CONSTRAINT "zones_archived_at_chk" CHECK (("zones"."status" = 'ARCHIVED' and "zones"."archived_at" is not null) or ("zones"."status" <> 'ARCHIVED' and "zones"."archived_at" is null))
);
--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zones_city_status_name_idx" ON "zones" USING btree ("city_id","status","name");--> statement-breakpoint
CREATE INDEX "zones_city_created_idx" ON "zones" USING btree ("city_id","created_at","id");--> statement-breakpoint
CREATE INDEX "zones_boundary_gix" ON "zones" USING gist ("boundary");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_city_name_active_uidx" ON "zones" USING btree ("city_id",lower(btrim("name"))) WHERE "zones"."status" <> 'ARCHIVED';