ALTER TABLE "merchant_profiles" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "manager_name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "manager_phone" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "owner_phone" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "restaurant_support_name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "restaurant_support_phone" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "cash_recipient_name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "payout_method" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "transfer_city" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "transfer_recipient_name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "iban" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "card_number" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "other_card_name" text;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "is_agency_affiliate" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD COLUMN "agency_name" text;
