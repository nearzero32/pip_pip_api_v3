ALTER TABLE "audit_logs" ALTER COLUMN "request_correlation_id" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "password_credential_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD COLUMN "replaced_by_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD COLUMN "invited_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_replacement_challenge_id_fk" FOREIGN KEY ("replacement_challenge_id") REFERENCES "public"."otp_challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_password_credential_id_password_credentials_id_fk" FOREIGN KEY ("password_credential_id") REFERENCES "public"."password_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "session_refresh_tokens_replaced_by_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."session_refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_invited_by_staff_id_fk" FOREIGN KEY ("invited_by_staff_id") REFERENCES "public"."staff_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_session_occurred_idx" ON "audit_logs" USING btree ("actor_session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "otp_replacement_challenge_idx" ON "otp_challenges" USING btree ("replacement_challenge_id");--> statement-breakpoint
CREATE INDEX "otp_resulting_session_idx" ON "otp_challenges" USING btree ("resulting_session_id");--> statement-breakpoint
CREATE INDEX "password_reset_credential_requested_idx" ON "password_reset_tokens" USING btree ("password_credential_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_refresh_replaced_by_uidx" ON "session_refresh_tokens" USING btree ("replaced_by_id") WHERE "session_refresh_tokens"."replaced_by_id" is not null;--> statement-breakpoint
CREATE INDEX "staff_profiles_invited_by_idx" ON "staff_profiles" USING btree ("invited_by_staff_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_request_id_format_chk" CHECK ("audit_logs"."request_correlation_id" is null or "audit_logs"."request_correlation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "session_refresh_replacement_state_chk" CHECK ("session_refresh_tokens"."replaced_by_id" is null or "session_refresh_tokens"."rotated_at" is not null);