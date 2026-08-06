import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { productStatus, weekday } from "./enums";
import { mediaAssets } from "./media";
import { modifierGroups, modifierOptions } from "./modifiers";
import { storeCategories, stores } from "./stores";

/**
 * Store Products — Dashboard catalog management.
 * Price source invariant (service-enforced): either base_price set with zero
 * non-archived sizes, or base_price null with ≥1 non-archived size.
 * IQD only; integer dinars (no floating point).
 * Optional modifierGroupId: at most one ModifierGroup per Product.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    categoryId: uuid("category_id"),
    modifierGroupId: uuid("modifier_group_id"),
    name: text("name").notNull(),
    description: text("description"),
    basePrice: integer("base_price"),
    status: productStatus("status").notNull().default("ACTIVE"),
    isAvailable: boolean("is_available").notNull().default(true),
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
      name: "products_store_city_fk",
      columns: [table.storeId, table.cityId],
      foreignColumns: [stores.id, stores.cityId],
    }),
    foreignKey({
      name: "products_category_store_fk",
      columns: [table.categoryId, table.storeId],
      foreignColumns: [storeCategories.id, storeCategories.storeId],
    }),
    foreignKey({
      name: "products_modifier_group_store_fk",
      columns: [table.modifierGroupId, table.storeId],
      foreignColumns: [modifierGroups.id, modifierGroups.storeId],
    }),
    uniqueIndex("products_id_store_uidx").on(table.id, table.storeId),
    uniqueIndex("products_id_store_city_uidx").on(
      table.id,
      table.storeId,
      table.cityId,
    ),
    uniqueIndex("products_store_name_active_uidx")
      .on(table.storeId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    index("products_store_status_order_idx").on(
      table.storeId,
      table.status,
      table.displayOrder,
      table.createdAt,
      table.id,
    ),
    index("products_store_category_status_idx").on(
      table.storeId,
      table.categoryId,
      table.status,
    ),
    index("products_store_modifier_group_idx").on(
      table.storeId,
      table.modifierGroupId,
    ),
    index("products_city_store_idx").on(table.cityId, table.storeId),
    check("products_name_nonempty_chk", sql`length(btrim(${table.name})) > 0`),
    check(
      "products_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "products_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
    check(
      "products_base_price_positive_chk",
      sql`${table.basePrice} is null or ${table.basePrice} > 0`,
    ),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id),
    displayOrder: integer("display_order").notNull().default(0),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "product_images_product_store_city_fk",
      columns: [table.productId, table.storeId, table.cityId],
      foreignColumns: [products.id, products.storeId, products.cityId],
    }),
    uniqueIndex("product_images_media_asset_uidx").on(table.mediaAssetId),
    uniqueIndex("product_images_product_primary_uidx")
      .on(table.productId)
      .where(sql`${table.isPrimary} = true`),
    index("product_images_product_order_idx").on(
      table.productId,
      table.displayOrder,
      table.id,
    ),
    check(
      "product_images_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
  ],
);

export const productSizes = pgTable(
  "product_sizes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    name: text("name").notNull(),
    price: integer("price").notNull(),
    status: productStatus("status").notNull().default("ACTIVE"),
    isAvailable: boolean("is_available").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    archivedAt: instant("archived_at"),
  },
  (table) => [
    foreignKey({
      name: "product_sizes_product_store_city_fk",
      columns: [table.productId, table.storeId, table.cityId],
      foreignColumns: [products.id, products.storeId, products.cityId],
    }),
    uniqueIndex("product_sizes_product_name_active_uidx")
      .on(table.productId, sql`lower(btrim(${table.name}))`)
      .where(sql`${table.status} <> 'ARCHIVED'`),
    uniqueIndex("product_sizes_product_default_active_uidx")
      .on(table.productId)
      .where(sql`${table.isDefault} = true and ${table.status} = 'ACTIVE'`),
    index("product_sizes_product_status_order_idx").on(
      table.productId,
      table.status,
      table.displayOrder,
      table.id,
    ),
    check(
      "product_sizes_name_nonempty_chk",
      sql`length(btrim(${table.name})) > 0`,
    ),
    check("product_sizes_price_positive_chk", sql`${table.price} > 0`),
    check(
      "product_sizes_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "product_sizes_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
    check(
      "product_sizes_default_active_chk",
      sql`${table.isDefault} = false or ${table.status} = 'ACTIVE'`,
    ),
  ],
);

/**
 * Recurring weekly Product availability windows (Asia/Baghdad wall-clock).
 * Windows do not cross midnight; overnight spans use two rows.
 */
export const productAvailabilityWindows = pgTable(
  "product_availability_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    dayOfWeek: weekday("day_of_week").notNull(),
    opensAt: time("opens_at", { withTimezone: false }).notNull(),
    closesAt: time("closes_at", { withTimezone: false }).notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "product_availability_product_store_city_fk",
      columns: [table.productId, table.storeId, table.cityId],
      foreignColumns: [products.id, products.storeId, products.cityId],
    }),
    uniqueIndex("product_availability_product_day_opens_uidx").on(
      table.productId,
      table.dayOfWeek,
      table.opensAt,
    ),
    index("product_availability_product_day_idx").on(
      table.productId,
      table.dayOfWeek,
      table.opensAt,
    ),
    check(
      "product_availability_opens_before_closes_chk",
      sql`${table.opensAt} < ${table.closesAt}`,
    ),
  ],
);

/**
 * Per-Product configuration of a ModifierOption (price/default/maxQuantity).
 * Rows for Options outside the Product's CURRENT modifier_group_id are preserved
 * but must not be returned as active modifiers (service-layer filter).
 * Price is IQD integer; zero is allowed; defaults require price = 0.
 */
export const productModifierOptions = pgTable(
  "product_modifier_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull(),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    modifierOptionId: uuid("modifier_option_id").notNull(),
    price: integer("price").notNull().default(0),
    isAvailable: boolean("is_available").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    maxQuantity: integer("max_quantity").notNull().default(1),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "product_modifier_options_product_store_city_fk",
      columns: [table.productId, table.storeId, table.cityId],
      foreignColumns: [products.id, products.storeId, products.cityId],
    }),
    foreignKey({
      name: "product_modifier_options_option_store_city_fk",
      columns: [table.modifierOptionId, table.storeId, table.cityId],
      foreignColumns: [
        modifierOptions.id,
        modifierOptions.storeId,
        modifierOptions.cityId,
      ],
    }),
    uniqueIndex("product_modifier_options_product_option_uidx").on(
      table.productId,
      table.modifierOptionId,
    ),
    index("product_modifier_options_product_idx").on(table.productId),
    index("product_modifier_options_option_idx").on(table.modifierOptionId),
    check(
      "product_modifier_options_price_nonnegative_chk",
      sql`${table.price} >= 0`,
    ),
    check(
      "product_modifier_options_max_quantity_chk",
      sql`${table.maxQuantity} >= 1`,
    ),
    check(
      "product_modifier_options_default_price_chk",
      sql`${table.isDefault} = false or ${table.price} = 0`,
    ),
  ],
);
