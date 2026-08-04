import { sql } from "drizzle-orm";
import {
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
import { mainCategoryStatus } from "./enums";
import { cities } from "./geography";
import { mediaAssets } from "./media";

/**
 * Main Categories — M3-C1.
 * image_asset_id is mandatory and remains claimed through soft archive.
 */
export const mainCategories = pgTable(
  "main_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    name: text("name").notNull(),
    imageAssetId: uuid("image_asset_id")
      .notNull()
      .references(() => mediaAssets.id),
    status: mainCategoryStatus("status").notNull().default("ACTIVE"),
    displayOrder: integer("display_order").notNull().default(0),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    archivedAt: instant("archived_at"),
  },
  (table) => [
    /** Supports composite FK from subcategories(main_category_id, city_id). */
    uniqueIndex("main_categories_id_city_uidx").on(table.id, table.cityId),
    uniqueIndex("main_categories_image_asset_uidx").on(table.imageAssetId),
    uniqueIndex("main_categories_city_name_active_uidx")
      .on(table.cityId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index("main_categories_city_status_order_idx").on(
      table.cityId,
      table.status,
      table.displayOrder,
      table.createdAt,
      table.id,
    ),
    index("main_categories_city_name_idx").on(table.cityId, table.name),
    check(
      "main_categories_name_nonempty_chk",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "main_categories_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "main_categories_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
  ],
);

/**
 * Subcategories — M3-C2.
 * Optional image; soft archive clears and releases the image FK.
 * Reuses main_category_status (ACTIVE | INACTIVE | ARCHIVED).
 */
export const subcategories = pgTable(
  "subcategories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    mainCategoryId: uuid("main_category_id").notNull(),
    name: text("name").notNull(),
    imageAssetId: uuid("image_asset_id").references(() => mediaAssets.id),
    status: mainCategoryStatus("status").notNull().default("ACTIVE"),
    displayOrder: integer("display_order").notNull().default(0),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    archivedAt: instant("archived_at"),
  },
  (table) => [
    foreignKey({
      name: "subcategories_main_category_city_fk",
      columns: [table.mainCategoryId, table.cityId],
      foreignColumns: [mainCategories.id, mainCategories.cityId],
    }),
    uniqueIndex("subcategories_image_asset_uidx")
      .on(table.imageAssetId)
      .where(sql`${table.imageAssetId} is not null`),
    uniqueIndex("subcategories_parent_name_active_uidx")
      .on(
        table.cityId,
        table.mainCategoryId,
        sql`lower(btrim(${table.name}))`,
      )
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index("subcategories_city_parent_status_order_idx").on(
      table.cityId,
      table.mainCategoryId,
      table.status,
      table.displayOrder,
      table.createdAt,
      table.id,
    ),
    index("subcategories_city_status_order_idx").on(
      table.cityId,
      table.status,
      table.displayOrder,
      table.createdAt,
      table.id,
    ),
    index("subcategories_city_name_idx").on(table.cityId, table.name),
    check(
      "subcategories_name_nonempty_chk",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check(
      "subcategories_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "subcategories_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
  ],
);
