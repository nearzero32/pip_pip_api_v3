import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { productStatus } from "./enums";
import { stores } from "./stores";

/**
 * Store-scoped Modifier Groups.
 * A Product may reference at most one Group. A Group may be used by many Products.
 * Selection limits (minSelect/maxSelect) count TOTAL QUANTITY, not distinct options.
 */
export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    name: text("name").notNull(),
    minSelect: integer("min_select").notNull().default(0),
    maxSelect: integer("max_select").notNull().default(1),
    status: productStatus("status").notNull().default("ACTIVE"),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    archivedAt: instant("archived_at"),
  },
  (table) => [
    foreignKey({
      name: "modifier_groups_store_city_fk",
      columns: [table.storeId, table.cityId],
      foreignColumns: [stores.id, stores.cityId],
    }),
    uniqueIndex("modifier_groups_id_store_uidx").on(table.id, table.storeId),
    uniqueIndex("modifier_groups_id_store_city_uidx").on(
      table.id,
      table.storeId,
      table.cityId,
    ),
    uniqueIndex("modifier_groups_store_name_active_uidx")
      .on(table.storeId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index("modifier_groups_store_status_idx").on(
      table.storeId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("modifier_groups_city_store_idx").on(table.cityId, table.storeId),
    check(
      "modifier_groups_name_nonempty_chk",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check("modifier_groups_min_select_chk", sql`${table.minSelect} >= 0`),
    check("modifier_groups_max_select_chk", sql`${table.maxSelect} >= 1`),
    check(
      "modifier_groups_min_max_chk",
      sql`${table.minSelect} <= ${table.maxSelect}`,
    ),
    check(
      "modifier_groups_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
  ],
);

/**
 * Modifier Options belong to exactly one Group.
 * Option names are unique across the entire Store among non-archived Options.
 */
export const modifierOptions = pgTable(
  "modifier_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    modifierGroupId: uuid("modifier_group_id").notNull(),
    name: text("name").notNull(),
    isAvailable: boolean("is_available").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    status: productStatus("status").notNull().default("ACTIVE"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    archivedAt: instant("archived_at"),
  },
  (table) => [
    foreignKey({
      name: "modifier_options_group_store_city_fk",
      columns: [table.modifierGroupId, table.storeId, table.cityId],
      foreignColumns: [
        modifierGroups.id,
        modifierGroups.storeId,
        modifierGroups.cityId,
      ],
    }),
    uniqueIndex("modifier_options_id_store_uidx").on(table.id, table.storeId),
    uniqueIndex("modifier_options_id_group_uidx").on(
      table.id,
      table.modifierGroupId,
    ),
    uniqueIndex("modifier_options_id_store_city_uidx").on(
      table.id,
      table.storeId,
      table.cityId,
    ),
    /** Store-level normalized uniqueness among non-archived Options. */
    uniqueIndex("modifier_options_store_name_active_uidx")
      .on(table.storeId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index("modifier_options_group_status_order_idx").on(
      table.modifierGroupId,
      table.status,
      table.displayOrder,
      table.id,
    ),
    index("modifier_options_store_status_idx").on(table.storeId, table.status),
    check(
      "modifier_options_name_nonempty_chk",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "modifier_options_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "modifier_options_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
  ],
);
