CREATE INDEX IF NOT EXISTS "order_driver_handoffs_order_status_idx"
  ON "order_driver_handoffs" ("order_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_return_workflows_order_status_idx"
  ON "order_return_workflows" ("order_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_collections_order_collected_idx"
  ON "order_collections" ("order_id", "collected_at", "id");
