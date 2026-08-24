import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { instant } from "./columns";
import { merchantProfileStatus } from "./enums";
import { stores } from "./stores";

/**
 * Merchant application profile — phone+password auth via MERCHANT_APP sessions.
 * Exactly one Store per Merchant. Same account may also hold Customer/Driver
 * profiles (shared phone); never Staff.
 */
export const merchantProfiles = pgTable(
  "merchant_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references(() => accounts.id),
    storeId: uuid("store_id").notNull(),
    cityId: uuid("city_id").notNull(),
    displayName: text("display_name"),
    name: text("name"),
    managerName: text("manager_name"),
    managerPhone: text("manager_phone"),
    ownerPhone: text("owner_phone"),
    restaurantSupportName: text("restaurant_support_name"),
    restaurantSupportPhone: text("restaurant_support_phone"),
    cashRecipientName: text("cash_recipient_name"),
    payoutMethod: text("payout_method"),
    transferCity: text("transfer_city"),
    transferRecipientName: text("transfer_recipient_name"),
    iban: text("iban"),
    cardNumber: text("card_number"),
    otherCardName: text("other_card_name"),
    isAgencyAffiliate: boolean("is_agency_affiliate").notNull().default(false),
    agencyName: text("agency_name"),
    status: merchantProfileStatus("status").notNull().default("ACTIVE"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdByAccountId: uuid("created_by_account_id")
      .notNull()
      .references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "merchant_profiles_store_city_fk",
      columns: [table.storeId, table.cityId],
      foreignColumns: [stores.id, stores.cityId],
    }),
    uniqueIndex("merchant_profiles_account_uidx").on(table.accountId),
    index("merchant_profiles_store_status_idx").on(
      table.storeId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("merchant_profiles_city_status_idx").on(
      table.cityId,
      table.status,
      table.createdAt,
      table.id,
    ),
    check(
      "merchant_profiles_display_name_chk",
      sql`${table.displayName} is null or length(btrim(${table.displayName})) > 0`,
    ),
  ],
);
