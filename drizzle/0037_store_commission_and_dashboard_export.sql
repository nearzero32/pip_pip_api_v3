ALTER TABLE "stores"
  ADD COLUMN "platform_commission_rate" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_platform_commission_rate_chk"
  CHECK ("platform_commission_rate" >= 0 AND "platform_commission_rate" <= 100);--> statement-breakpoint

ALTER TABLE "orders"
  ADD COLUMN "store_commission_rate_snapshot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_store_commission_rate_snapshot_chk"
  CHECK ("store_commission_rate_snapshot" >= 0 AND "store_commission_rate_snapshot" <= 100);--> statement-breakpoint

CREATE TABLE "store_commission_rate_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "city_id" uuid NOT NULL,
  "previous_rate" integer NOT NULL,
  "new_rate" integer NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "changed_by_account_id" uuid NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_rate_history_store_city_fk"
  FOREIGN KEY ("store_id", "city_id")
  REFERENCES "public"."stores"("id", "city_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_rate_history_city_fk"
  FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_rate_history_changed_by_fk"
  FOREIGN KEY ("changed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_history_previous_rate_chk"
  CHECK ("previous_rate" >= 0 AND "previous_rate" <= 100);--> statement-breakpoint
ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_history_new_rate_chk"
  CHECK ("new_rate" >= 0 AND "new_rate" <= 100);--> statement-breakpoint
ALTER TABLE "store_commission_rate_history"
  ADD CONSTRAINT "store_commission_history_reason_chk"
  CHECK (length(btrim("reason")) > 0);--> statement-breakpoint

CREATE INDEX "store_commission_history_store_changed_idx"
  ON "store_commission_rate_history" ("store_id", "changed_at", "id");--> statement-breakpoint
CREATE INDEX "store_commission_history_city_changed_idx"
  ON "store_commission_rate_history" ("city_id", "changed_at", "id");--> statement-breakpoint

CREATE FUNCTION forbid_store_commission_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'store_commission_rate_history rows are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER store_commission_rate_history_immutable_trg
  BEFORE UPDATE OR DELETE ON store_commission_rate_history
  FOR EACH ROW
  EXECUTE FUNCTION forbid_store_commission_history_mutation();--> statement-breakpoint

INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('drivers.export', 'تنزيل قائمة السائقين بصيغة Excel', 'ACTIVE'),
  ('main_categories.export', 'تنزيل التصنيفات الرئيسية بصيغة Excel', 'ACTIVE'),
  ('merchants.export', 'تنزيل التجار بصيغة Excel', 'ACTIVE'),
  ('modifiers.export', 'تنزيل المعدّلات بصيغة Excel', 'ACTIVE'),
  ('order_offers.export', 'تنزيل جولات عروض الطلبات بصيغة Excel', 'ACTIVE'),
  ('orders.assignments.export', 'تنزيل تعيينات الطلبات بصيغة Excel', 'ACTIVE'),
  ('orders.collections.export', 'تنزيل تحصيلات الطلبات بصيغة Excel', 'ACTIVE'),
  ('orders.events.export', 'تنزيل أحداث الطلبات بصيغة Excel', 'ACTIVE'),
  ('orders.export', 'تنزيل الطلبات بصيغة Excel', 'ACTIVE'),
  ('orders.handoffs.export', 'تنزيل عمليات تسليم السائقين بصيغة Excel', 'ACTIVE'),
  ('orders.returns.export', 'تنزيل عمليات إرجاع الطلبات بصيغة Excel', 'ACTIVE'),
  ('products.export', 'تنزيل المنتجات بصيغة Excel', 'ACTIVE'),
  ('staff.export', 'تنزيل الموظفين بصيغة Excel', 'ACTIVE'),
  ('store_categories.export', 'تنزيل تصنيفات المتجر بصيغة Excel', 'ACTIVE'),
  ('stores.commission.export', 'تنزيل نسب استقطاع المتاجر بصيغة Excel', 'ACTIVE'),
  ('stores.commission.read', 'مشاهدة نسب استقطاع المتاجر', 'ACTIVE'),
  ('stores.commission.update', 'تحديث نسبة استقطاع المتجر', 'ACTIVE'),
  ('stores.export', 'تنزيل المتاجر بصيغة Excel', 'ACTIVE'),
  ('subcategories.export', 'تنزيل التصنيفات الفرعية بصيغة Excel', 'ACTIVE'),
  ('zones.export', 'تنزيل المناطق بصيغة Excel', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
