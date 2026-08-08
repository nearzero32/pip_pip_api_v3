CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"label" text NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"address_details" text NOT NULL,
	"landmark" text,
	"recipient_name" text,
	"recipient_phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_addresses_label_nonempty_chk" CHECK (length(btrim("customer_addresses"."label")) > 0),
	CONSTRAINT "customer_addresses_details_nonempty_chk" CHECK (length(btrim("customer_addresses"."address_details")) > 0),
	CONSTRAINT "customer_addresses_landmark_chk" CHECK ("customer_addresses"."landmark" is null or length(btrim("customer_addresses"."landmark")) > 0),
	CONSTRAINT "customer_addresses_recipient_name_chk" CHECK ("customer_addresses"."recipient_name" is null or length(btrim("customer_addresses"."recipient_name")) > 0),
	CONSTRAINT "customer_addresses_recipient_phone_chk" CHECK ("customer_addresses"."recipient_phone" is null or length(btrim("customer_addresses"."recipient_phone")) > 0),
	CONSTRAINT "customer_addresses_location_srid_chk" CHECK (ST_SRID("customer_addresses"."location") = 4326 and GeometryType("customer_addresses"."location") = 'POINT')
);
--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_account_id_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_city_created_idx" ON "customer_addresses" USING btree ("customer_account_id","city_id","created_at","id");--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_city_default_idx" ON "customer_addresses" USING btree ("customer_account_id","city_id","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_addresses_one_default_uidx" ON "customer_addresses" USING btree ("customer_account_id","city_id") WHERE "customer_addresses"."is_default" = true;