import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { accounts } from "./accounts";
import { instant } from "./columns";
import {
  documentSide,
  driverApplicationStatus,
  driverApprovalStatus,
  driverDocumentType,
  driverOperationalStatus,
  driverReviewAction,
} from "./enums";

export const driverApplications = pgTable(
  "driver_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    status: driverApplicationStatus("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    legacyVehicleDescription: text("legacy_vehicle_description"),
    contractInformation: text("contract_information"),
    submittedAt: instant("submitted_at"),
    decidedAt: instant("decided_at"),
    decidedByAccountId: uuid("decided_by_account_id").references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_applications_account_created_idx").on(table.accountId, table.createdAt),
    index("driver_applications_status_submitted_idx").on(table.status, table.submittedAt),
    index("driver_applications_decider_decided_idx").on(table.decidedByAccountId, table.decidedAt),
    check("driver_applications_version_positive_chk", sql`${table.version} > 0`),
    check("driver_applications_decision_fields_chk", sql`(${table.status} not in ('APPROVED', 'REJECTED')) or (${table.decidedAt} is not null and ${table.decidedByAccountId} is not null)`),
  ],
);

export const driverProfiles = pgTable(
  "driver_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().unique().references(() => accounts.id),
    approvalStatus: driverApprovalStatus("approval_status").notNull().default("APPROVED"),
    operationalStatus: driverOperationalStatus("operational_status").notNull().default("PENDING_ACTIVATION"),
    approvedApplicationId: uuid("approved_application_id").notNull().unique().references(() => driverApplications.id),
    legacyVehicleDescription: text("legacy_vehicle_description"),
    driverPhotoObjectKey: text("driver_photo_object_key"),
    accessCodeHash: text("access_code_hash"),
    statusReasonCode: text("status_reason_code"),
    statusChangedAt: instant("status_changed_at").notNull().defaultNow(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_profiles_operational_status_idx").on(table.operationalStatus),
    check("driver_profiles_active_photo_chk", sql`${table.operationalStatus} <> 'ACTIVE' or ${table.driverPhotoObjectKey} is not null`),
  ],
);

export const driverApplicationDocuments = pgTable(
  "driver_application_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverApplicationId: uuid("driver_application_id").notNull().references(() => driverApplications.id),
    applicationVersion: integer("application_version").notNull(),
    documentType: driverDocumentType("document_type").notNull(),
    side: documentSide("side").notNull(),
    objectKey: text("object_key").notNull(),
    mediaType: text("media_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    uploadedByAccountId: uuid("uploaded_by_account_id").notNull().references(() => accounts.id),
    createdAt: instant("created_at").notNull().defaultNow(),
    invalidatedAt: instant("invalidated_at"),
  },
  (table) => [
    uniqueIndex("driver_documents_current_slot_uidx").on(table.driverApplicationId, table.applicationVersion, table.documentType, table.side).where(sql`${table.invalidatedAt} is null`),
    index("driver_documents_application_version_idx").on(table.driverApplicationId, table.applicationVersion),
    index("driver_documents_object_key_idx").on(table.objectKey),
    check("driver_documents_version_positive_chk", sql`${table.applicationVersion} > 0`),
    check("driver_documents_slot_chk", sql`(${table.documentType} in ('NATIONAL_ID', 'RESIDENCE_CARD') and ${table.side} in ('FRONT', 'BACK')) or (${table.documentType} = 'CONTRACT' and ${table.side} = 'SINGLE')`),
    check("driver_documents_size_positive_chk", sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`),
  ],
);

export const driverApplicationReviews = pgTable(
  "driver_application_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverApplicationId: uuid("driver_application_id").notNull().references(() => driverApplications.id),
    applicationVersion: integer("application_version").notNull(),
    actorAccountId: uuid("actor_account_id").notNull().references(() => accounts.id),
    action: driverReviewAction("action").notNull(),
    reasonCode: text("reason_code").notNull(),
    internalReason: text("internal_reason"),
    applicantFeedback: text("applicant_feedback"),
    occurredAt: instant("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    index("driver_reviews_application_occurred_idx").on(table.driverApplicationId, table.occurredAt),
    index("driver_reviews_actor_occurred_idx").on(table.actorAccountId, table.occurredAt),
    index("driver_reviews_action_occurred_idx").on(table.action, table.occurredAt),
    check("driver_reviews_version_positive_chk", sql`${table.applicationVersion} > 0`),
  ],
);
