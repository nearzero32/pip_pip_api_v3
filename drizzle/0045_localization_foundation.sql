CREATE TABLE "supported_locales" (
  "code" text PRIMARY KEY NOT NULL,
  "native_name" text NOT NULL,
  "direction" text NOT NULL,
  "fallback_locale" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "is_default" boolean NOT NULL DEFAULT false,
  "required_for_new_content" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "supported_locales_code_chk" CHECK ("code" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  CONSTRAINT "supported_locales_direction_chk" CHECK ("direction" IN ('LTR', 'RTL')),
  CONSTRAINT "supported_locales_fallback_self_chk" CHECK ("fallback_locale" IS NULL OR "fallback_locale" <> "code"),
  CONSTRAINT "supported_locales_default_active_chk" CHECK (NOT "is_default" OR "is_active"),
  CONSTRAINT "supported_locales_required_active_chk" CHECK (NOT "required_for_new_content" OR "is_active")
);--> statement-breakpoint
ALTER TABLE "supported_locales" ADD CONSTRAINT "supported_locales_fallback_locale_supported_locales_code_fk" FOREIGN KEY ("fallback_locale") REFERENCES "public"."supported_locales"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supported_locales_one_default_uidx" ON "supported_locales" USING btree ("is_default") WHERE "supported_locales"."is_default" = true;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "supported_locales_require_one_active_default"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM supported_locales WHERE is_active AND is_default) <> 1 THEN
    RAISE EXCEPTION 'supported_locales must contain exactly one active default locale';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "supported_locales_one_active_default_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "supported_locales"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "supported_locales_require_one_active_default"();--> statement-breakpoint
INSERT INTO "supported_locales" ("code", "native_name", "direction", "fallback_locale", "is_active", "is_default", "required_for_new_content") VALUES
  ('ar', 'العربية', 'RTL', NULL, true, true, true),
  ('en', 'English', 'LTR', 'ar', true, false, true)
ON CONFLICT ("code") DO NOTHING;
