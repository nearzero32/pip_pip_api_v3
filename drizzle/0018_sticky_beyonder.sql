CREATE TYPE "public"."merchant_profile_status" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED');--> statement-breakpoint
ALTER TYPE "public"."application_type" ADD VALUE 'MERCHANT_APP';
