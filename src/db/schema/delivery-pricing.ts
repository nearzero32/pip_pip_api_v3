import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { deliveryPricingStatus } from "./enums";
import { cities } from "./geography";

export const cityDeliveryPricingVersions = pgTable("city_delivery_pricing_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  version: integer("version").notNull(),
  status: deliveryPricingStatus("status").notNull().default("DRAFT"),
  baseFee: integer("base_fee").notNull(),
  includedDistanceMeters: integer("included_distance_meters").notNull(),
  pricePerKm: integer("price_per_km").notNull(),
  roundingStep: integer("rounding_step").notNull(),
  maximumDeliveryDistanceMeters: integer("maximum_delivery_distance_meters"),
  routingFallbackEnabled: boolean("routing_fallback_enabled").notNull(),
  fallbackOnNoRoute: boolean("fallback_on_no_route").notNull(),
  fallbackOnProviderFailure: boolean("fallback_on_provider_failure").notNull(),
  fallbackExtraDistanceMeters: integer("fallback_extra_distance_meters").notNull(),
  createdByAccountId: uuid("created_by_account_id").notNull().references(() => accounts.id),
  createdAt: instant("created_at").notNull().defaultNow(),
  activatedAt: instant("activated_at"),
  deactivatedAt: instant("deactivated_at"),
}, (table) => [
  uniqueIndex("city_delivery_pricing_city_version_uidx").on(table.cityId, table.version),
  uniqueIndex("city_delivery_pricing_one_active_uidx").on(table.cityId).where(sql`${table.status} = 'ACTIVE'`),
  index("city_delivery_pricing_city_created_idx").on(table.cityId, table.createdAt, table.id),
  check("city_delivery_pricing_version_positive_chk", sql`${table.version} > 0`),
  check("city_delivery_pricing_values_chk", sql`${table.baseFee} >= 0 and ${table.includedDistanceMeters} >= 0 and ${table.pricePerKm} >= 0 and ${table.roundingStep} > 0 and ${table.fallbackExtraDistanceMeters} >= 0 and (${table.maximumDeliveryDistanceMeters} is null or ${table.maximumDeliveryDistanceMeters} > 0)`),
  check("city_delivery_pricing_fallback_consistency_chk", sql`${table.routingFallbackEnabled} or (not ${table.fallbackOnNoRoute} and not ${table.fallbackOnProviderFailure})`),
  check("city_delivery_pricing_lifecycle_chk", sql`(${table.status} = 'DRAFT' and ${table.activatedAt} is null and ${table.deactivatedAt} is null) or (${table.status} = 'ACTIVE' and ${table.activatedAt} is not null and ${table.deactivatedAt} is null) or (${table.status} = 'INACTIVE' and ${table.activatedAt} is not null and ${table.deactivatedAt} is not null)`),
]);
