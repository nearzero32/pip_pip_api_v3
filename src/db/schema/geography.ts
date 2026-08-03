import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { instant } from "./columns";
import { cityStatus, governorateStatus, zoneStatus } from "./enums";

/** PostGIS geometry(Polygon, 4326). Values are handled via raw SQL in the Zone service. */
const polygon4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Polygon,4326)";
  },
});

export const governorates = pgTable("governorates", {
  id: uuid("id").primaryKey(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull(),
  status: governorateStatus("status").notNull().default("ACTIVE"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
}, (table) => [
  index("governorates_status_order_idx").on(table.status, table.displayOrder, table.nameEn),
  check("governorates_display_order_nonnegative_chk", sql`${table.displayOrder} >= 0`),
  check("governorates_names_nonempty_chk", sql`length(btrim(${table.nameAr})) > 0 and length(btrim(${table.nameEn})) > 0`),
]);

export const cities = pgTable("cities", {
  id: uuid("id").primaryKey().defaultRandom(),
  governorateId: uuid("governorate_id").notNull().references(() => governorates.id),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
  status: cityStatus("status").notNull().default("DRAFT"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
  archivedAt: instant("archived_at"),
}, (table) => [
  index("cities_governorate_status_order_idx").on(table.governorateId, table.status, table.displayOrder, table.nameEn),
  index("cities_status_order_idx").on(table.status, table.displayOrder, table.nameEn),
  check("cities_display_order_nonnegative_chk", sql`${table.displayOrder} >= 0`),
  check("cities_coordinates_chk", sql`${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180`),
  check("cities_names_nonempty_chk", sql`length(btrim(${table.nameAr})) > 0 and length(btrim(${table.nameEn})) > 0`),
  check("cities_archived_at_chk", sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`),
]);

export const zones = pgTable("zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  name: text("name").notNull(),
  boundary: polygon4326("boundary").notNull(),
  status: zoneStatus("status").notNull().default("ACTIVE"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
  archivedAt: instant("archived_at"),
}, (table) => [
  index("zones_city_status_name_idx").on(table.cityId, table.status, table.name),
  index("zones_city_created_idx").on(table.cityId, table.createdAt, table.id),
  index("zones_boundary_gix").using("gist", table.boundary),
  uniqueIndex("zones_city_name_active_uidx")
    .on(table.cityId, sql`lower(btrim(${table.name}))`)
    .where(sql`${table.status} <> 'ARCHIVED'`),
  check("zones_name_nonempty_chk", sql`length(btrim(${table.name})) > 0`),
  check(
    "zones_archived_at_chk",
    sql`(${table.status} = 'ARCHIVED' and ${table.archivedAt} is not null) or (${table.status} <> 'ARCHIVED' and ${table.archivedAt} is null)`,
  ),
]);
