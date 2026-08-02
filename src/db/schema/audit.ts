import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { accounts } from "./accounts";
import { instant } from "./columns";
import { auditOutcome } from "./enums";
import { sessions } from "./sessions";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: instant("occurred_at").notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id),
    actorSessionId: uuid("actor_session_id").references(() => sessions.id),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: auditOutcome("outcome").notNull(),
    reasonCode: text("reason_code"),
    requestCorrelationId: varchar("request_correlation_id", { length: 128 }),
    ipAddressCoarse: text("ip_address_coarse"),
    userAgentSummary: text("user_agent_summary"),
    redactedMetadata: jsonb("redacted_metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index("audit_logs_occurred_idx").on(table.occurredAt),
    index("audit_logs_actor_occurred_idx").on(table.actorAccountId, table.occurredAt),
    index("audit_logs_target_occurred_idx").on(table.targetType, table.targetId, table.occurredAt),
    index("audit_logs_event_occurred_idx").on(table.eventType, table.occurredAt),
    index("audit_logs_correlation_idx").on(table.requestCorrelationId),
    index("audit_logs_actor_session_occurred_idx").on(table.actorSessionId, table.occurredAt),
    check("audit_logs_request_id_format_chk", sql`${table.requestCorrelationId} is null or ${table.requestCorrelationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`),
  ],
);
