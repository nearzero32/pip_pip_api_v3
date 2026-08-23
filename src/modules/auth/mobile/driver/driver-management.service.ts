import type { SQL } from "bun";

import { AppError } from "../../../../errors/app-error";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalAllowlisted,
  parseOptionalSearch,
  parseOptionalUuid,
  parseSortOrder,
  searchUuid,
  sqlDir,
} from "../../../dashboard-lists/query";
import type { AuthIdentity } from "../../sessions/session-service";
import { normalizePhone } from "../../shared/normalization";
import { requireSuperAdmin } from "../../staff/authorization";
import { assertActiveCity } from "../../staff/dashboard-scope";
import type { Argon2PasswordHasher } from "../../staff/password";

const DRIVER_STATUSES = [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
] as const;

type DriverStatus = (typeof DRIVER_STATUSES)[number];

export class DriverManagementService {
  constructor(
    private readonly client: SQL,
    private readonly password: Argon2PasswordHasher,
  ) {}

  private dto(row: Record<string, unknown>) {
    return {
      accountId: String(row.account_id),
      phone: String(row.phone_e164),
      cityId: row.city_id == null ? null : String(row.city_id),
      approvalStatus: "APPROVED" as const,
      operationalStatus: String(row.operational_status) as DriverStatus,
      accountStatus: String(row.account_status) as
        | "ACTIVE"
        | "SUSPENDED"
        | "CLOSED",
      vehicleDescription:
        row.legacy_vehicle_description == null
          ? null
          : String(row.legacy_vehicle_description),
      driverName: row.driver_name == null ? null : String(row.driver_name),
      fatherName: row.father_name == null ? null : String(row.father_name),
      motherName: row.mother_name == null ? null : String(row.mother_name),
      alternatePhone: row.alternate_phone == null ? null : String(row.alternate_phone),
      vehicleType: row.vehicle_type == null ? null : String(row.vehicle_type),
      vehicleNumber: row.vehicle_number == null ? null : String(row.vehicle_number),
      driverPhotoObjectKey:
        row.driver_photo_object_key == null
          ? null
          : String(row.driver_photo_object_key),
      driverPhotoAssetId:
        row.driver_photo_asset_id == null
          ? null
          : String(row.driver_photo_asset_id),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }

  private async claimDriverPhoto(tx: SQL, assetId: string, cityId: string) {
    const [asset] = await tx<
      { object_key: string; city_id: string; purpose: string; status: string; attached_at: Date | null }[]
    >`select object_key, city_id::text, purpose::text, status::text, attached_at
       from media_assets where id = ${assetId} for update`;
    if (
      !asset ||
      asset.city_id !== cityId ||
      asset.purpose !== "DRIVER_PHOTO" ||
      asset.status !== "READY" ||
      asset.attached_at !== null
    ) {
      throw new AppError(409, "MEDIA_NOT_ATTACHABLE", "Media asset cannot be attached");
    }
    await tx`update media_assets set attached_at = now(), updated_at = now()
             where id = ${assetId} and attached_at is null and status = 'READY'`;
    return asset.object_key;
  }

  private async releaseDriverPhoto(tx: SQL, assetId: string, cityId: string) {
    await tx`update media_assets set attached_at = null, status = 'DELETE_PENDING',
               delete_requested_at = coalesce(delete_requested_at, now()), updated_at = now()
             where id = ${assetId} and city_id = ${cityId} and status = 'READY'`;
  }

  private async claimDriverDocument(tx: SQL, assetId: string, cityId: string) {
    const [asset] = await tx<{ object_key: string; city_id: string; purpose: string; status: string; attached_at: Date | null }[]>`
      select object_key, city_id::text, purpose::text, status::text, attached_at from media_assets where id = ${assetId} for update`;
    if (!asset || asset.city_id !== cityId || asset.purpose !== "DRIVER_DOCUMENT" || asset.status !== "READY" || asset.attached_at !== null)
      throw new AppError(409, "MEDIA_NOT_ATTACHABLE", "Document asset cannot be attached");
    await tx`update media_assets set attached_at = now(), updated_at = now() where id = ${assetId} and attached_at is null and status = 'READY'`;
    return asset.object_key;
  }

  async create(
    identity: AuthIdentity,
    input: {
      phone: string;
      accessCode: string;
      cityId: string;
      driverPhotoAssetId: string;
      driverName: string;
      fatherName: string;
      motherName: string;
      alternatePhone: string;
      nationalIdFrontAssetId: string;
      nationalIdBackAssetId: string;
      residenceCardFrontAssetId: string;
      residenceCardBackAssetId: string;
      contractAssetId: string;
      vehicleType?: string;
      vehicleNumber?: string;
      vehicleDescription?: string;
    },
  ) {
    requireSuperAdmin(identity);
    const phone = normalizePhone(input.phone);
    if (!/^[0-9]{6,12}$/.test(input.accessCode))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid access code");
    await assertActiveCity(this.client, input.cityId);
    const accessCodeHash = await this.password.hash(input.accessCode);
    const vehicle = input.vehicleDescription?.trim() || null;
    const name = input.driverName.trim(), father = input.fatherName.trim(), mother = input.motherName.trim();
    if (!name || !father || !mother) throw new AppError(422, "VALIDATION_FAILED", "Driver names are required");
    const alternatePhone = normalizePhone(input.alternatePhone);

    return this.client.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`
        select account_id::text as id from account_phones
        where phone_e164 = ${phone}`;
      if (existing)
        throw new AppError(409, "PHONE_ALREADY_USED", "Phone already used");
      const photoKey = await this.claimDriverPhoto(
        tx,
        input.driverPhotoAssetId,
        input.cityId,
      );
      const documentSlots = [["NATIONAL_ID", "FRONT", input.nationalIdFrontAssetId], ["NATIONAL_ID", "BACK", input.nationalIdBackAssetId], ["RESIDENCE_CARD", "FRONT", input.residenceCardFrontAssetId], ["RESIDENCE_CARD", "BACK", input.residenceCardBackAssetId], ["CONTRACT", "SINGLE", input.contractAssetId]] as const;
      const documentKeys = await Promise.all(documentSlots.map(async ([type, side, assetId]) => ({ type, side, objectKey: await this.claimDriverDocument(tx, assetId, input.cityId) })));

      const [account] = await tx<{ id: string }[]>`
        insert into accounts default values returning id::text`;
      await tx`
        insert into account_phones
          (account_id, phone_e164, verified_at, is_primary)
        values (${account!.id}, ${phone}, now(), true)`;
      const [application] = await tx<{ id: string }[]>`
        insert into driver_applications
          (account_id, status, legacy_vehicle_description, submitted_at,
           decided_at, decided_by_account_id)
        values (${account!.id}, 'APPROVED', ${vehicle}, now(), now(),
                ${identity.accountId})
        returning id::text`;
      await tx`
        insert into driver_application_reviews
          (driver_application_id, application_version, actor_account_id,
           action, reason_code, internal_reason)
        values (${application!.id}, 1, ${identity.accountId}, 'APPROVED',
                'SUPER_ADMIN_CREATED', 'Driver created from dashboard')`;
      await tx`
        insert into driver_profiles
          (account_id, city_id, approval_status, operational_status,
           approved_application_id, legacy_vehicle_description,
           driver_name, father_name, mother_name, alternate_phone, vehicle_type, vehicle_number,
           driver_photo_object_key, driver_photo_asset_id, access_code_hash)
        values (${account!.id}, ${input.cityId}, 'APPROVED', 'ACTIVE',
                ${application!.id}, ${vehicle},
                ${name}, ${father}, ${mother}, ${alternatePhone}, ${input.vehicleType?.trim() || null}, ${input.vehicleNumber?.trim() || null},
                ${photoKey}, ${input.driverPhotoAssetId}, ${accessCodeHash})`;
      for (const document of documentKeys) await tx`
        insert into driver_application_documents (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id)
        values (${application!.id}, 1, ${document.type}::driver_document_type, ${document.side}::document_side, ${document.objectKey}, ${identity.accountId})`;
      await tx`
        insert into audit_logs
          (event_type, actor_account_id, actor_session_id, target_type,
           target_id, outcome, redacted_metadata)
        values ('DRIVER_CREATED', ${identity.accountId}, ${identity.sessionId},
                'DRIVER', ${account!.id}, 'SUCCESS',
                ${JSON.stringify({ cityId: input.cityId })}::jsonb)`;
      return this.get(identity, account!.id, tx);
    });
  }

  async list(
    identity: AuthIdentity,
    input: {
      search?: string;
      cityId?: string;
      status?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    requireSuperAdmin(identity);
    const p = dashboardPageOf(input.page, input.limit);
    const search = parseOptionalSearch(input.search);
    const pattern = search ? likeContains(search) : null;
    const uuid = searchUuid(search);
    const cityId = parseOptionalUuid(input.cityId, "cityId");
    const driverStatus = parseOptionalAllowlisted(
      input.status,
      DRIVER_STATUSES,
      "status",
    );
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["createdAt", "phone", "status"] as const,
      "createdAt",
    );
    const sortOrder = parseSortOrder(input.sortOrder, "desc");
    const orderSql = {
      createdAt: `dp.created_at ${sqlDir(sortOrder)}, dp.account_id ${sqlDir(sortOrder)}`,
      phone: `ph.phone_e164 ${sqlDir(sortOrder)}, dp.account_id ${sqlDir(sortOrder)}`,
      status: `dp.operational_status ${sqlDir(sortOrder)}, dp.account_id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const offset = (p.page - 1) * p.limit;
    const where = `
      ($1::text is null or ph.phone_e164 ilike $1 escape '\\'
        or coalesce(dp.legacy_vehicle_description, '') ilike $1 escape '\\'
        or ($4::uuid is not null and dp.account_id = $4::uuid))
      and ($2::uuid is null or dp.city_id = $2::uuid)
      and ($3::text is null or dp.operational_status = $3::driver_operational_status)`;
    const values = [pattern, cityId, driverStatus, uuid];
    const rows = (await this.client.unsafe(
      `select dp.account_id::text, ph.phone_e164, dp.city_id::text,
              dp.approval_status::text, dp.operational_status::text,
              a.status::text as account_status,
              dp.legacy_vehicle_description, dp.driver_photo_object_key,
              dp.driver_photo_asset_id::text,
              dp.driver_name, dp.father_name, dp.mother_name, dp.alternate_phone, dp.vehicle_type, dp.vehicle_number,
              dp.created_at, dp.updated_at
       from driver_profiles dp
       join accounts a on a.id = dp.account_id
       join account_phones ph on ph.account_id = dp.account_id and ph.is_primary = true
       where ${where}
       order by ${orderSql}
       limit $5::int offset $6::int`,
      [...values, p.limit, offset],
    )) as Record<string, unknown>[];
    const [count] = (await this.client.unsafe(
      `select count(*)::int as total
       from driver_profiles dp
       join account_phones ph on ph.account_id = dp.account_id and ph.is_primary = true
       where ${where}`,
      values,
    )) as { total: number }[];
    return dashboardListResult(
      rows.map((row) => this.dto(row)),
      p.page,
      p.limit,
      count?.total ?? 0,
    );
  }

  async get(identity: AuthIdentity, driverId: string, client: SQL = this.client) {
    requireSuperAdmin(identity);
    const [row] = await client<Record<string, unknown>[]>`
      select dp.account_id::text, ph.phone_e164, dp.city_id::text,
             dp.approval_status::text, dp.operational_status::text,
             a.status::text as account_status,
             dp.legacy_vehicle_description, dp.driver_photo_object_key,
             dp.driver_photo_asset_id::text,
             dp.driver_name, dp.father_name, dp.mother_name, dp.alternate_phone, dp.vehicle_type, dp.vehicle_number,
             dp.created_at, dp.updated_at
      from driver_profiles dp
      join accounts a on a.id = dp.account_id
      join account_phones ph on ph.account_id = dp.account_id and ph.is_primary = true
      where dp.account_id = ${driverId}`;
    if (!row)
      throw new AppError(404, "DRIVER_NOT_FOUND", "Driver not found");
    return this.dto(row);
  }

  async documents(identity: AuthIdentity, driverId: string) {
    requireSuperAdmin(identity);
    return this.client<{ assetId: string; documentType: string; side: string; originalName: string }[]>`
      select ma.id::text as "assetId", dad.document_type::text as "documentType", dad.side::text as side, ma.original_name as "originalName"
      from driver_profiles dp join driver_application_documents dad on dad.driver_application_id = dp.approved_application_id and dad.invalidated_at is null
      join media_assets ma on ma.object_key = dad.object_key
      where dp.account_id = ${driverId} order by dad.document_type, dad.side`;
  }

  async update(
    identity: AuthIdentity,
    driverId: string,
    input: {
      phone?: string;
      cityId?: string;
      operationalStatus?: DriverStatus;
      driverPhotoAssetId?: string;
      vehicleDescription?: string | null;
      driverName?: string; fatherName?: string; motherName?: string; alternatePhone?: string;
      vehicleType?: string | null; vehicleNumber?: string | null;
      nationalIdFrontAssetId?: string; nationalIdBackAssetId?: string; residenceCardFrontAssetId?: string; residenceCardBackAssetId?: string; contractAssetId?: string;
    },
  ) {
    requireSuperAdmin(identity);
    if (Object.keys(input).length === 0)
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "At least one field is required",
      );
    const phone = input.phone === undefined ? undefined : normalizePhone(input.phone);
    if (input.cityId !== undefined) await assertActiveCity(this.client, input.cityId);
    const vehicle =
      input.vehicleDescription === undefined
        ? undefined
        : input.vehicleDescription?.trim() || null;
    const alternatePhone = input.alternatePhone === undefined ? undefined : normalizePhone(input.alternatePhone);

    return this.client.begin(async (tx) => {
      const [current] = await tx<
        { account_id: string; city_id: string | null; photo: string | null; photo_asset_id: string | null; application_id: string }[]
      >`select account_id::text, city_id::text,
               driver_photo_object_key as photo,
               driver_photo_asset_id::text as photo_asset_id, approved_application_id::text as application_id
        from driver_profiles where account_id = ${driverId} for update`;
      if (!current)
        throw new AppError(404, "DRIVER_NOT_FOUND", "Driver not found");

      const targetCityId = input.cityId ?? current.city_id;
      if (input.cityId !== undefined && input.cityId !== current.city_id && input.driverPhotoAssetId === undefined)
        throw new AppError(422, "DRIVER_PHOTO_REQUIRED", "Changing city requires a new driver photo");
      if (input.driverPhotoAssetId !== undefined && !targetCityId)
        throw new AppError(422, "DRIVER_PHOTO_REQUIRED", "A driver photo requires a city");
      const photoKey = input.driverPhotoAssetId === undefined
        ? undefined
        : await this.claimDriverPhoto(tx, input.driverPhotoAssetId, targetCityId!);
      if (input.operationalStatus === "ACTIVE") {
        if (!targetCityId || !(photoKey ?? current.photo))
          throw new AppError(
            422,
            "DRIVER_ACTIVATION_REQUIREMENTS",
            "An active driver requires a city and photo",
          );
      }
      if (phone !== undefined) {
        const [duplicate] = await tx<{ account_id: string }[]>`
          select account_id::text from account_phones
          where phone_e164 = ${phone} and account_id <> ${driverId}`;
        if (duplicate)
          throw new AppError(409, "PHONE_ALREADY_USED", "Phone already used");
        await tx`update account_phones set phone_e164 = ${phone}, updated_at = now()
                 where account_id = ${driverId} and is_primary = true`;
      }
      await tx`
        update driver_profiles set
          city_id = coalesce(${input.cityId ?? null}::uuid, city_id),
          operational_status = coalesce(${input.operationalStatus ?? null}::driver_operational_status, operational_status),
          driver_photo_object_key = coalesce(${photoKey ?? null}, driver_photo_object_key),
          driver_photo_asset_id = coalesce(${input.driverPhotoAssetId ?? null}::uuid, driver_photo_asset_id),
          legacy_vehicle_description = case
            when ${vehicle !== undefined} then ${vehicle ?? null}
            else legacy_vehicle_description
          end,
          driver_name = coalesce(${input.driverName?.trim() ?? null}, driver_name),
          father_name = coalesce(${input.fatherName?.trim() ?? null}, father_name),
          mother_name = coalesce(${input.motherName?.trim() ?? null}, mother_name),
          alternate_phone = coalesce(${alternatePhone ?? null}, alternate_phone),
          vehicle_type = case when ${input.vehicleType !== undefined} then ${input.vehicleType?.trim() || null} else vehicle_type end,
          vehicle_number = case when ${input.vehicleNumber !== undefined} then ${input.vehicleNumber?.trim() || null} else vehicle_number end,
          status_reason_code = case
            when ${input.operationalStatus ?? null}::text is null then status_reason_code
            else 'SUPER_ADMIN_UPDATE'
          end,
          status_changed_at = case
            when ${input.operationalStatus ?? null}::text is null then status_changed_at
            else now()
          end,
          updated_at = now()
        where account_id = ${driverId}`;
      if (input.driverPhotoAssetId !== undefined && current.photo_asset_id) {
        await this.releaseDriverPhoto(tx, current.photo_asset_id, current.city_id!);
      }
      const replacements = [["NATIONAL_ID", "FRONT", input.nationalIdFrontAssetId], ["NATIONAL_ID", "BACK", input.nationalIdBackAssetId], ["RESIDENCE_CARD", "FRONT", input.residenceCardFrontAssetId], ["RESIDENCE_CARD", "BACK", input.residenceCardBackAssetId], ["CONTRACT", "SINGLE", input.contractAssetId]] as const;
      for (const [type, side, assetId] of replacements) if (assetId) {
        const objectKey = await this.claimDriverDocument(tx, assetId, targetCityId!);
        await tx`update driver_application_documents set invalidated_at = now() where driver_application_id = ${current.application_id} and application_version = 1 and document_type = ${type}::driver_document_type and side = ${side}::document_side and invalidated_at is null`;
        await tx`insert into driver_application_documents (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id) values (${current.application_id}, 1, ${type}::driver_document_type, ${side}::document_side, ${objectKey}, ${identity.accountId})`;
      }
      await tx`
        insert into audit_logs
          (event_type, actor_account_id, actor_session_id, target_type,
           target_id, outcome, redacted_metadata)
        values ('DRIVER_UPDATED', ${identity.accountId}, ${identity.sessionId},
                'DRIVER', ${driverId}, 'SUCCESS',
                ${JSON.stringify({ changedFields: Object.keys(input) })}::jsonb)`;
      if (phone !== undefined || input.operationalStatus !== undefined) {
        await tx`update sessions set revoked_at = now(),
                   revocation_reason = 'DRIVER_MANAGEMENT_UPDATE', updated_at = now()
                 where account_id = ${driverId} and application_type = 'DRIVER_APP'
                   and revoked_at is null`;
      }
      return this.get(identity, driverId, tx);
    });
  }

  async resetAccessCode(
    identity: AuthIdentity,
    driverId: string,
    accessCode: string,
  ) {
    requireSuperAdmin(identity);
    if (!/^[0-9]{6,12}$/.test(accessCode))
      throw new AppError(422, "VALIDATION_FAILED", "Invalid access code");
    const hash = await this.password.hash(accessCode);
    return this.client.begin(async (tx) => {
      const [driver] = await tx<{ account_id: string }[]>`
        select account_id::text from driver_profiles
        where account_id = ${driverId} for update`;
      if (!driver)
        throw new AppError(404, "DRIVER_NOT_FOUND", "Driver not found");
      await tx`update driver_profiles set access_code_hash = ${hash}, updated_at = now()
               where account_id = ${driverId}`;
      await tx`update sessions set revoked_at = now(),
                 revocation_reason = 'DRIVER_ACCESS_CODE_RESET', updated_at = now()
               where account_id = ${driverId} and application_type = 'DRIVER_APP'
                 and revoked_at is null`;
      await tx`
        insert into audit_logs
          (event_type, actor_account_id, actor_session_id, target_type,
           target_id, outcome, redacted_metadata)
        values ('DRIVER_ACCESS_CODE_RESET', ${identity.accountId},
                ${identity.sessionId}, 'DRIVER', ${driverId}, 'SUCCESS', '{}'::jsonb)`;
      return { reset: true as const };
    });
  }
}
