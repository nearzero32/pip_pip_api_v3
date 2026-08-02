CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."application_type" AS ENUM('CUSTOMER_APP', 'DRIVER_APP', 'DASHBOARD');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('SUCCESS', 'FAILURE', 'DENIED');--> statement-breakpoint
CREATE TYPE "public"."authentication_method" AS ENUM('PHONE_OTP', 'PASSWORD_TOTP');--> statement-breakpoint
CREATE TYPE "public"."customer_profile_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."document_side" AS ENUM('FRONT', 'BACK', 'SINGLE');--> statement-breakpoint
CREATE TYPE "public"."driver_application_status" AS ENUM('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."driver_approval_status" AS ENUM('APPROVED');--> statement-breakpoint
CREATE TYPE "public"."driver_document_type" AS ENUM('NATIONAL_ID', 'RESIDENCE_CARD', 'CONTRACT');--> statement-breakpoint
CREATE TYPE "public"."driver_operational_status" AS ENUM('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."driver_review_action" AS ENUM('REVIEWED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."mfa_credential_status" AS ENUM('PENDING', 'ACTIVE', 'RESET', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."mfa_method" AS ENUM('TOTP');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."role_scope_type" AS ENUM('GLOBAL', 'CITY');--> statement-breakpoint
CREATE TYPE "public"."staff_profile_status" AS ENUM('INVITED', 'ACTIVE', 'DISABLED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."staff_role_code" AS ENUM('SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SUPPORT');--> statement-breakpoint
CREATE TABLE "account_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email_original" text NOT NULL,
	"email_normalized" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_emails_normalized_lower_chk" CHECK ("account_emails"."email_normalized" = lower("account_emails"."email_normalized"))
);
--> statement-breakpoint
CREATE TABLE "account_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_phones_e164_format_chk" CHECK ("account_phones"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "account_role_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_role_id" uuid NOT NULL,
	"scope_type" "role_scope_type" NOT NULL,
	"scope_reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	CONSTRAINT "account_role_scopes_reference_chk" CHECK (("account_role_scopes"."scope_type" = 'GLOBAL' and "account_role_scopes"."scope_reference_id" is null) or ("account_role_scopes"."scope_type" = 'CITY' and "account_role_scopes"."scope_reference_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_account_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_account_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_roles_valid_window_chk" CHECK ("account_roles"."valid_until" is null or "account_roles"."valid_until" > "account_roles"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"status_reason_code" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"actor_account_id" uuid,
	"actor_session_id" uuid,
	"target_type" text,
	"target_id" text,
	"outcome" "audit_outcome" NOT NULL,
	"reason_code" text,
	"request_correlation_id" text,
	"ip_address_coarse" text,
	"user_agent_summary" text,
	"redacted_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "customer_profile_status" DEFAULT 'ACTIVE' NOT NULL,
	"status_reason_code" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profiles_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "driver_application_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_application_id" uuid NOT NULL,
	"application_version" integer NOT NULL,
	"document_type" "driver_document_type" NOT NULL,
	"side" "document_side" NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text,
	"size_bytes" bigint,
	"checksum" text,
	"uploaded_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "driver_documents_version_positive_chk" CHECK ("driver_application_documents"."application_version" > 0),
	CONSTRAINT "driver_documents_slot_chk" CHECK (("driver_application_documents"."document_type" in ('NATIONAL_ID', 'RESIDENCE_CARD') and "driver_application_documents"."side" in ('FRONT', 'BACK')) or ("driver_application_documents"."document_type" = 'CONTRACT' and "driver_application_documents"."side" = 'SINGLE')),
	CONSTRAINT "driver_documents_size_positive_chk" CHECK ("driver_application_documents"."size_bytes" is null or "driver_application_documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "driver_application_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_application_id" uuid NOT NULL,
	"application_version" integer NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"action" "driver_review_action" NOT NULL,
	"reason_code" text NOT NULL,
	"internal_reason" text,
	"applicant_feedback" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_reviews_version_positive_chk" CHECK ("driver_application_reviews"."application_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "driver_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "driver_application_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"legacy_vehicle_description" text,
	"contract_information" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_applications_version_positive_chk" CHECK ("driver_applications"."version" > 0),
	CONSTRAINT "driver_applications_decision_fields_chk" CHECK (("driver_applications"."status" not in ('APPROVED', 'REJECTED')) or ("driver_applications"."decided_at" is not null and "driver_applications"."decided_by_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "driver_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"approval_status" "driver_approval_status" DEFAULT 'APPROVED' NOT NULL,
	"operational_status" "driver_operational_status" DEFAULT 'PENDING_ACTIVATION' NOT NULL,
	"approved_application_id" uuid NOT NULL,
	"legacy_vehicle_description" text,
	"driver_photo_object_key" text,
	"status_reason_code" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_profiles_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "driver_profiles_approved_application_id_unique" UNIQUE("approved_application_id"),
	CONSTRAINT "driver_profiles_active_photo_chk" CHECK ("driver_profiles"."operational_status" <> 'ACTIVE' or "driver_profiles"."driver_photo_object_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "mfa_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"method" "mfa_method" DEFAULT 'TOTP' NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encryption_key_version" text NOT NULL,
	"status" "mfa_credential_status" DEFAULT 'PENDING' NOT NULL,
	"verified_at" timestamp with time zone,
	"reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mfa_credential_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_recovery_codes_code_verifier_unique" UNIQUE("code_verifier")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"application_type" "application_type" NOT NULL,
	"phone_e164" text NOT NULL,
	"account_id" uuid,
	"account_phone_id" uuid,
	"otp_keyed_verifier" text NOT NULL,
	"verifier_key_version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"replacement_challenge_id" uuid,
	"resulting_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_phone_e164_format_chk" CHECK ("otp_challenges"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "otp_attempts_chk" CHECK ("otp_challenges"."max_attempts" = 5 and "otp_challenges"."attempt_count" between 0 and "otp_challenges"."max_attempts"),
	CONSTRAINT "otp_expiry_window_chk" CHECK ("otp_challenges"."expires_at" = "otp_challenges"."created_at" + interval '5 minutes'),
	CONSTRAINT "otp_resend_window_chk" CHECK ("otp_challenges"."resend_available_at" = "otp_challenges"."last_sent_at" + interval '60 seconds')
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"argon2id_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_credentials_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_verifier" text NOT NULL,
	"verifier_key_version" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_security_metadata" jsonb,
	CONSTRAINT "password_reset_tokens_token_verifier_unique" UNIQUE("token_verifier")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "staff_role_code" NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT true NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "session_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"token_verifier" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "session_refresh_tokens_token_verifier_unique" UNIQUE("token_verifier"),
	CONSTRAINT "session_refresh_generation_nonnegative_chk" CHECK ("session_refresh_tokens"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"application_type" "application_type" NOT NULL,
	"authentication_method" "authentication_method" NOT NULL,
	"token_family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text,
	"device_name" text NOT NULL,
	"user_agent_summary" text,
	"created_ip_coarse" text,
	"last_seen_ip_coarse" text,
	"last_used_at" timestamp with time zone,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_family_id_unique" UNIQUE("token_family_id"),
	CONSTRAINT "sessions_expiry_after_creation_chk" CHECK ("sessions"."absolute_expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_revocation_reason_chk" CHECK ("sessions"."revoked_at" is null or "sessions"."revocation_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "staff_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"account_id" uuid,
	"invited_by_account_id" uuid NOT NULL,
	"invitation_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invitations_invitation_verifier_unique" UNIQUE("invitation_verifier"),
	CONSTRAINT "staff_invitations_email_lower_chk" CHECK ("staff_invitations"."email_normalized" = lower("staff_invitations"."email_normalized"))
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "staff_profile_status" DEFAULT 'INVITED' NOT NULL,
	"display_name" text,
	"employee_reference" text,
	"status_reason_code" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_profiles_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "staff_profiles_employee_reference_unique" UNIQUE("employee_reference")
);
--> statement-breakpoint
ALTER TABLE "account_emails" ADD CONSTRAINT "account_emails_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_phones" ADD CONSTRAINT "account_phones_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_role_scopes" ADD CONSTRAINT "account_role_scopes_account_role_id_account_roles_id_fk" FOREIGN KEY ("account_role_id") REFERENCES "public"."account_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_role_scopes" ADD CONSTRAINT "account_role_scopes_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_granted_by_account_id_accounts_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_roles" ADD CONSTRAINT "account_roles_revoked_by_account_id_accounts_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_session_id_sessions_id_fk" FOREIGN KEY ("actor_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_application_documents" ADD CONSTRAINT "driver_application_documents_driver_application_id_driver_applications_id_fk" FOREIGN KEY ("driver_application_id") REFERENCES "public"."driver_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_application_documents" ADD CONSTRAINT "driver_application_documents_uploaded_by_account_id_accounts_id_fk" FOREIGN KEY ("uploaded_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_application_reviews" ADD CONSTRAINT "driver_application_reviews_driver_application_id_driver_applications_id_fk" FOREIGN KEY ("driver_application_id") REFERENCES "public"."driver_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_application_reviews" ADD CONSTRAINT "driver_application_reviews_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_applications" ADD CONSTRAINT "driver_applications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_applications" ADD CONSTRAINT "driver_applications_decided_by_account_id_accounts_id_fk" FOREIGN KEY ("decided_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_approved_application_id_driver_applications_id_fk" FOREIGN KEY ("approved_application_id") REFERENCES "public"."driver_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_credentials" ADD CONSTRAINT "mfa_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_mfa_credential_id_mfa_credentials_id_fk" FOREIGN KEY ("mfa_credential_id") REFERENCES "public"."mfa_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_account_phone_id_account_phones_id_fk" FOREIGN KEY ("account_phone_id") REFERENCES "public"."account_phones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_resulting_session_id_sessions_id_fk" FOREIGN KEY ("resulting_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "session_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_invited_by_account_id_accounts_id_fk" FOREIGN KEY ("invited_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_normalized_uidx" ON "account_emails" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_one_primary_uidx" ON "account_emails" USING btree ("account_id") WHERE "account_emails"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "account_emails_account_idx" ON "account_emails" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_emails_account_verified_idx" ON "account_emails" USING btree ("account_id","verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_phones_phone_e164_uidx" ON "account_phones" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "account_phones_one_primary_uidx" ON "account_phones" USING btree ("account_id") WHERE "account_phones"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "account_phones_account_idx" ON "account_phones" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_phones_account_verified_idx" ON "account_phones" USING btree ("account_id","verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_role_scopes_value_uidx" ON "account_role_scopes" USING btree ("account_role_id","scope_type","scope_reference_id");--> statement-breakpoint
CREATE INDEX "account_role_scopes_lookup_idx" ON "account_role_scopes" USING btree ("scope_type","scope_reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_roles_active_assignment_uidx" ON "account_roles" USING btree ("account_id","role_id") WHERE "account_roles"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "account_roles_account_effective_idx" ON "account_roles" USING btree ("account_id","revoked_at","valid_from","valid_until");--> statement-breakpoint
CREATE INDEX "account_roles_role_revoked_idx" ON "account_roles" USING btree ("role_id","revoked_at");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "accounts_created_at_idx" ON "accounts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_occurred_idx" ON "audit_logs" USING btree ("actor_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_occurred_idx" ON "audit_logs" USING btree ("target_type","target_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_event_occurred_idx" ON "audit_logs" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_correlation_idx" ON "audit_logs" USING btree ("request_correlation_id");--> statement-breakpoint
CREATE INDEX "customer_profiles_status_idx" ON "customer_profiles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_documents_slot_uidx" ON "driver_application_documents" USING btree ("driver_application_id","application_version","document_type","side");--> statement-breakpoint
CREATE INDEX "driver_documents_application_version_idx" ON "driver_application_documents" USING btree ("driver_application_id","application_version");--> statement-breakpoint
CREATE INDEX "driver_documents_object_key_idx" ON "driver_application_documents" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "driver_reviews_application_occurred_idx" ON "driver_application_reviews" USING btree ("driver_application_id","occurred_at");--> statement-breakpoint
CREATE INDEX "driver_reviews_actor_occurred_idx" ON "driver_application_reviews" USING btree ("actor_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "driver_reviews_action_occurred_idx" ON "driver_application_reviews" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "driver_applications_account_created_idx" ON "driver_applications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "driver_applications_status_submitted_idx" ON "driver_applications" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "driver_applications_decider_decided_idx" ON "driver_applications" USING btree ("decided_by_account_id","decided_at");--> statement-breakpoint
CREATE INDEX "driver_profiles_operational_status_idx" ON "driver_profiles" USING btree ("operational_status");--> statement-breakpoint
CREATE INDEX "mfa_credentials_account_status_idx" ON "mfa_credentials" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "mfa_recovery_credential_consumed_idx" ON "mfa_recovery_codes" USING btree ("mfa_credential_id","consumed_at");--> statement-breakpoint
CREATE INDEX "otp_phone_purpose_created_idx" ON "otp_challenges" USING btree ("phone_e164","purpose","created_at");--> statement-breakpoint
CREATE INDEX "otp_account_created_idx" ON "otp_challenges" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_expires_idx" ON "otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "password_reset_account_requested_idx" ON "password_reset_tokens" USING btree ("account_id","requested_at");--> statement-breakpoint
CREATE INDEX "password_reset_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_pair_uidx" ON "role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_role_idx" ON "role_permissions" USING btree ("permission_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_refresh_generation_uidx" ON "session_refresh_tokens" USING btree ("session_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "session_refresh_current_uidx" ON "session_refresh_tokens" USING btree ("session_id") WHERE "session_refresh_tokens"."rotated_at" is null and "session_refresh_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_driver_session_uidx" ON "sessions" USING btree ("account_id") WHERE "sessions"."application_type" = 'DRIVER_APP' and "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_account_active_expiry_idx" ON "sessions" USING btree ("account_id","revoked_at","absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_account_device_idx" ON "sessions" USING btree ("account_id","device_id");--> statement-breakpoint
CREATE INDEX "staff_invitations_email_state_idx" ON "staff_invitations" USING btree ("email_normalized","accepted_at","revoked_at");--> statement-breakpoint
CREATE INDEX "staff_invitations_expires_idx" ON "staff_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "staff_profiles_status_idx" ON "staff_profiles" USING btree ("status");