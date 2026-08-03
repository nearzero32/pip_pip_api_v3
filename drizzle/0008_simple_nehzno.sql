CREATE TYPE "public"."city_status" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."governorate_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"governorate_id" uuid NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"status" "city_status" DEFAULT 'DRAFT' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "cities_display_order_nonnegative_chk" CHECK ("cities"."display_order" >= 0),
	CONSTRAINT "cities_coordinates_chk" CHECK ("cities"."latitude" between -90 and 90 and "cities"."longitude" between -180 and 180),
	CONSTRAINT "cities_names_nonempty_chk" CHECK (length(btrim("cities"."name_ar")) > 0 and length(btrim("cities"."name_en")) > 0),
	CONSTRAINT "cities_archived_at_chk" CHECK (("cities"."status" = 'ARCHIVED' and "cities"."archived_at" is not null) or ("cities"."status" <> 'ARCHIVED' and "cities"."archived_at" is null))
);
--> statement-breakpoint
CREATE TABLE "governorates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"status" "governorate_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governorates_display_order_nonnegative_chk" CHECK ("governorates"."display_order" >= 0),
	CONSTRAINT "governorates_names_nonempty_chk" CHECK (length(btrim("governorates"."name_ar")) > 0 and length(btrim("governorates"."name_en")) > 0)
);
--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_governorate_id_governorates_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cities_governorate_status_order_idx" ON "cities" USING btree ("governorate_id","status","display_order","name_en");--> statement-breakpoint
CREATE INDEX "cities_status_order_idx" ON "cities" USING btree ("status","display_order","name_en");--> statement-breakpoint
CREATE INDEX "governorates_status_order_idx" ON "governorates" USING btree ("status","display_order","name_en");