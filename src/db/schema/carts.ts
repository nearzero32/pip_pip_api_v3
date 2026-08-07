import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { products, productSizes } from "./products";
import { stores } from "./stores";

export const carts = pgTable("carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerAccountId: uuid("customer_account_id").notNull().references(() => accounts.id),
  cityId: uuid("city_id").notNull(),
  storeId: uuid("store_id").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "carts_store_city_fk", columns: [table.storeId, table.cityId], foreignColumns: [stores.id, stores.cityId] }),
  uniqueIndex("carts_one_active_customer_uidx").on(table.customerAccountId).where(sql`${table.status} = 'ACTIVE'`),
  uniqueIndex("carts_id_store_city_uidx").on(table.id, table.storeId, table.cityId),
  index("carts_customer_status_idx").on(table.customerAccountId, table.status),
  check("carts_status_chk", sql`${table.status} in ('ACTIVE','COMPLETED')`),
]);

export const cartItems = pgTable("cart_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  cartId: uuid("cart_id").notNull(),
  storeId: uuid("store_id").notNull(),
  cityId: uuid("city_id").notNull(),
  productId: uuid("product_id").notNull(),
  selectedSizeId: uuid("selected_size_id"),
  selectedSizeNameSnapshot: text("selected_size_name_snapshot"),
  configurationKey: text("configuration_key").notNull(),
  quantity: integer("quantity").notNull(),
  productNameSnapshot: text("product_name_snapshot").notNull(),
  unitPriceSnapshot: integer("unit_price_snapshot").notNull(),
  modifiersPriceSnapshot: integer("modifiers_price_snapshot").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "cart_items_cart_store_city_fk", columns: [table.cartId, table.storeId, table.cityId], foreignColumns: [carts.id, carts.storeId, carts.cityId] }).onDelete("cascade"),
  foreignKey({ name: "cart_items_product_store_city_fk", columns: [table.productId, table.storeId, table.cityId], foreignColumns: [products.id, products.storeId, products.cityId] }),
  foreignKey({ name: "cart_items_size_product_store_city_fk", columns: [table.selectedSizeId, table.productId, table.storeId, table.cityId], foreignColumns: [productSizes.id, productSizes.productId, productSizes.storeId, productSizes.cityId] }),
  uniqueIndex("cart_items_cart_product_config_uidx").on(table.cartId, table.productId, table.configurationKey),
  uniqueIndex("cart_items_id_cart_uidx").on(table.id, table.cartId),
  index("cart_items_cart_idx").on(table.cartId),
  check("cart_items_quantity_chk", sql`${table.quantity} between 1 and 99`),
  check("cart_items_prices_chk", sql`${table.unitPriceSnapshot} > 0 and ${table.modifiersPriceSnapshot} >= 0`),
  check("cart_items_size_snapshot_chk", sql`(${table.selectedSizeId} is null) = (${table.selectedSizeNameSnapshot} is null)`),
]);

export const cartItemModifierSelections = pgTable("cart_item_modifier_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  cartItemId: uuid("cart_item_id").notNull(),
  cartId: uuid("cart_id").notNull(),
  modifierOptionId: uuid("modifier_option_id").notNull(),
  quantity: integer("quantity").notNull(),
  optionNameSnapshot: text("option_name_snapshot").notNull(),
  unitPriceSnapshot: integer("unit_price_snapshot").notNull(),
  configurationSnapshot: jsonb("configuration_snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "cart_item_selections_item_cart_fk", columns: [table.cartItemId, table.cartId], foreignColumns: [cartItems.id, cartItems.cartId] }).onDelete("cascade"),
  uniqueIndex("cart_item_selections_item_option_uidx").on(table.cartItemId, table.modifierOptionId),
  index("cart_item_selections_cart_idx").on(table.cartId),
  check("cart_item_selections_quantity_chk", sql`${table.quantity} >= 1`),
  check("cart_item_selections_price_chk", sql`${table.unitPriceSnapshot} >= 0`),
]);
