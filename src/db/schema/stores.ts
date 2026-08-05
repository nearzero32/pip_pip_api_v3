import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { mainCategories, subcategories } from "./catalog";
import { instant } from "./columns";
import {
  storeOrderAcceptanceStatus,
  storeStatus,
  weekday,
} from "./enums";
import { cities, zones } from "./geography";
import { mediaAssets } from "./media";

/** PostGIS geometry(Point, 4326). Values handled via raw SQL in the Store service. */
const point4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Point,4326)";
  },
});

/**
 * Stores — M3-D0.
 * City comes only from signed Dashboard identity; public City via X-City-Id.
 * Physical location (Point) is independent of service coverage (store_zones).
 */
export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    mainCategoryId: uuid("main_category_id").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    location: point4326("location").notNull(),
    logoAssetId: uuid("logo_asset_id").references(() => mediaAssets.id),
    coverAssetId: uuid("cover_asset_id").references(() => mediaAssets.id),
    status: storeStatus("status").notNull().default("DRAFT"),
    orderAcceptanceStatus: storeOrderAcceptanceStatus(
      "order_acceptance_status",
    )
      .notNull()
      .default("ACCEPTING"),
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
      name: "stores_main_category_city_fk",
      columns: [table.mainCategoryId, table.cityId],
      foreignColumns: [mainCategories.id, mainCategories.cityId],
    }),
    uniqueIndex("stores_id_city_uidx").on(table.id, table.cityId),
    uniqueIndex("stores_id_main_category_city_uidx").on(
      table.id,
      table.mainCategoryId,
      table.cityId,
    ),
    uniqueIndex("stores_logo_asset_uidx")
      .on(table.logoAssetId)
      .where(sql`${table.logoAssetId} is not null`),
    uniqueIndex("stores_cover_asset_uidx")
      .on(table.coverAssetId)
      .where(sql`${table.coverAssetId} is not null`),
    index("stores_city_status_order_idx").on(
      table.cityId,
      table.status,
      table.displayOrder,
      table.createdAt,
      table.id,
    ),
    index("stores_city_main_category_status_idx").on(
      table.cityId,
      table.mainCategoryId,
      table.status,
    ),
    index("stores_city_name_idx").on(table.cityId, table.name),
    index("stores_location_gix").using("gist", table.location),
    check("stores_name_nonempty_chk", sql`length(btrim(${table.name})) > 0`),
    check("stores_phone_nonempty_chk", sql`length(btrim(${table.phone})) > 0`),
    check(
      "stores_address_nonempty_chk",
      sql`length(btrim(${table.address})) > 0`,
    ),
    check(
      "stores_display_order_nonnegative_chk",
      sql`${table.displayOrder} >= 0`,
    ),
    check(
      "stores_archived_at_chk",
      sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
    ),
    check(
      "stores_logo_required_when_not_archived_chk",
      sql`${table.status} = 'ARCHIVED' or ${table.logoAssetId} is not null`,
    ),
    check(
      "stores_logo_cover_distinct_chk",
      sql`${table.coverAssetId} is null or ${table.logoAssetId} is null or ${table.coverAssetId} <> ${table.logoAssetId}`,
    ),
  ],
);

/** Service/delivery coverage Zones — independent of physical Store location. */
export const storeZones = pgTable(
  "store_zones",
  {
    storeId: uuid("store_id").notNull(),
    zoneId: uuid("zone_id").notNull(),
    cityId: uuid("city_id").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "store_zones_pk",
      columns: [table.storeId, table.zoneId],
    }),
    foreignKey({
      name: "store_zones_store_city_fk",
      columns: [table.storeId, table.cityId],
      foreignColumns: [stores.id, stores.cityId],
    }),
    foreignKey({
      name: "store_zones_zone_city_fk",
      columns: [table.zoneId, table.cityId],
      foreignColumns: [zones.id, zones.cityId],
    }),
    index("store_zones_zone_store_idx").on(table.zoneId, table.storeId),
    index("store_zones_city_zone_idx").on(table.cityId, table.zoneId),
  ],
);

/**
 * Store ↔ Subcategory assignments.
 * Composite FKs enforce same City and same Main Category as the Store.
 */
export const storeSubcategories = pgTable(
  "store_subcategories",
  {
    storeId: uuid("store_id").notNull(),
    subcategoryId: uuid("subcategory_id").notNull(),
    cityId: uuid("city_id").notNull(),
    mainCategoryId: uuid("main_category_id").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "store_subcategories_pk",
      columns: [table.storeId, table.subcategoryId],
    }),
    foreignKey({
      name: "store_subcategories_store_main_category_city_fk",
      columns: [table.storeId, table.mainCategoryId, table.cityId],
      foreignColumns: [
        stores.id,
        stores.mainCategoryId,
        stores.cityId,
      ],
    }),
    foreignKey({
      name: "store_subcategories_subcategory_main_category_city_fk",
      columns: [table.subcategoryId, table.mainCategoryId, table.cityId],
      foreignColumns: [
        subcategories.id,
        subcategories.mainCategoryId,
        subcategories.cityId,
      ],
    }),
    index("store_subcategories_subcategory_store_idx").on(
      table.subcategoryId,
      table.storeId,
    ),
    index("store_subcategories_city_main_category_idx").on(
      table.cityId,
      table.mainCategoryId,
    ),
  ],
);

/**
 * Weekly working hours. Multiple periods per day allowed; overnight when closes_at < opens_at.
 * Equal opens/closes is rejected (no ambiguous 00:00→00:00 24h encoding).
 * Date-specific overrides are deferred (M3-D0+).
 */
export const storeWorkingHours = pgTable(
  "store_working_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    dayOfWeek: weekday("day_of_week").notNull(),
    opensAt: time("opens_at", { withTimezone: false }).notNull(),
    closesAt: time("closes_at", { withTimezone: false }).notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("store_working_hours_store_day_idx").on(
      table.storeId,
      table.dayOfWeek,
      table.opensAt,
    ),
    uniqueIndex("store_working_hours_store_day_opens_uidx").on(
      table.storeId,
      table.dayOfWeek,
      table.opensAt,
    ),
    check(
      "store_working_hours_opens_closes_distinct_chk",
      sql`${table.opensAt} <> ${table.closesAt}`,
    ),
  ],
);
