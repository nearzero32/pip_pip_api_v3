import { sql } from "drizzle-orm";
import {
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
import { mainCategoryStatus } from "./enums";
import { cities } from "./geography";
import { mediaAssets } from "./media";

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
