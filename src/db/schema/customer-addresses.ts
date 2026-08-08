import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { cities } from "./geography";

/** PostGIS geometry(Point, 4326). Values handled via raw SQL in the address service. */
const point4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Point,4326)";
  },
});

/**
 * Customer Saved Addresses — City-scoped delivery locations.
 * Zone availability is computed at read time via ST_Covers against ACTIVE Zones.
 * Max 20 addresses per Customer + City is enforced transactionally.
 */
export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references(() => accounts.id),
    cityId: uuid("city_id")
      .notNull()
      .references(() => cities.id),
    label: text("label").notNull(),
    location: point4326("location").notNull(),
    addressDetails: text("address_details").notNull(),
    landmark: text("landmark"),
    recipientName: text("recipient_name"),
    recipientPhone: text("recipient_phone"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("customer_addresses_customer_city_created_idx").on(
      table.customerAccountId,
      table.cityId,
      table.createdAt,
      table.id,
    ),
    index("customer_addresses_customer_city_default_idx").on(
      table.customerAccountId,
      table.cityId,
      table.isDefault,
    ),
    uniqueIndex("customer_addresses_one_default_uidx")
      .on(table.customerAccountId, table.cityId)
      .where(sql`${table.isDefault} = true`),
    check(
      "customer_addresses_label_nonempty_chk",
      sql`length(btrim(${table.label})) > 0`,
    ),
    check(
      "customer_addresses_details_nonempty_chk",
      sql`length(btrim(${table.addressDetails})) > 0`,
    ),
    check(
      "customer_addresses_landmark_chk",
      sql`${table.landmark} is null or length(btrim(${table.landmark})) > 0`,
    ),
    check(
      "customer_addresses_recipient_name_chk",
      sql`${table.recipientName} is null or length(btrim(${table.recipientName})) > 0`,
    ),
    check(
      "customer_addresses_recipient_phone_chk",
      sql`${table.recipientPhone} is null or length(btrim(${table.recipientPhone})) > 0`,
    ),
    check(
      "customer_addresses_location_srid_chk",
      sql`ST_SRID(${table.location}) = 4326 and GeometryType(${table.location}) = 'POINT'`,
    ),
  ],
);
