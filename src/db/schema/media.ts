import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import {
  mediaAssetPurpose,
  mediaAssetStatus,
  mediaAssetVisibility,
} from "./enums";
import { cities } from "./geography";

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    purpose: mediaAssetPurpose("purpose").notNull(),
    visibility: mediaAssetVisibility("visibility").notNull(),
    status: mediaAssetStatus("status").notNull(),
    objectKey: text("object_key").notNull(),
    originalName: text("original_name").notNull(),
    expectedContentType: text("expected_content_type").notNull(),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    verifiedContentType: text("verified_content_type"),
    verifiedSizeBytes: bigint("verified_size_bytes", { mode: "number" }),
    etag: text("etag"),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    uploadExpiresAt: instant("upload_expires_at").notNull(),
    readyAt: instant("ready_at"),
    attachedAt: instant("attached_at"),
    deleteRequestedAt: instant("delete_requested_at"),
    deleteAttempts: integer("delete_attempts").notNull().default(0),
    lastDeleteErrorAt: instant("last_delete_error_at"),
    deleteLeaseUntil: instant("delete_lease_until"),
    deletedAt: instant("deleted_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("media_assets_object_key_uidx").on(table.objectKey),
    index("media_assets_city_status_created_idx").on(
      table.cityId,
      table.status,
      table.createdAt,
    ),
    index("media_assets_creator_created_idx").on(
      table.createdByAccountId,
      table.createdAt,
    ),
    index("media_assets_pending_upload_expires_idx")
      .on(table.uploadExpiresAt)
      .where(sql`${table.status} = 'PENDING_UPLOAD'`),
    index("media_assets_ready_unattached_idx")
      .on(table.readyAt)
      .where(sql`${table.status} = 'READY' and ${table.attachedAt} is null`),
    index("media_assets_delete_pending_lease_idx")
      .on(table.deleteLeaseUntil, table.deleteRequestedAt)
      .where(sql`${table.status} = 'DELETE_PENDING'`),
    check(
      "media_assets_object_key_nonempty_chk",
      sql`length(btrim(${table.objectKey})) > 0`,
    ),
    check(
      "media_assets_original_name_nonempty_chk",
      sql`length(btrim(${table.originalName})) > 0`,
    ),
    check(
      "media_assets_expected_size_positive_chk",
      sql`${table.expectedSizeBytes} > 0`,
    ),
    check(
      "media_assets_verified_size_positive_chk",
      sql`${table.verifiedSizeBytes} is null or ${table.verifiedSizeBytes} > 0`,
    ),
    check(
      "media_assets_pending_upload_chk",
      sql`${table.status} <> 'PENDING_UPLOAD' or (${table.readyAt} is null and ${table.deletedAt} is null)`,
    ),
    check(
      "media_assets_ready_chk",
      sql`${table.status} <> 'READY' or (
        ${table.readyAt} is not null
        and ${table.verifiedContentType} is not null
        and ${table.verifiedSizeBytes} is not null
        and ${table.deletedAt} is null
      )`,
    ),
    check(
      "media_assets_delete_pending_chk",
      sql`${table.status} <> 'DELETE_PENDING' or ${table.deleteRequestedAt} is not null`,
    ),
    check(
      "media_assets_deleted_chk",
      sql`${table.status} <> 'DELETED' or (
        ${table.deleteRequestedAt} is not null
        and ${table.deletedAt} is not null
        and ${table.attachedAt} is null
      )`,
    ),
    check(
      "media_assets_attached_ready_chk",
      sql`${table.attachedAt} is null or ${table.status} = 'READY'`,
    ),
  ],
);
