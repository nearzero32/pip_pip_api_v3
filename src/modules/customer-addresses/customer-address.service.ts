import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import { normalizePhone } from "../auth/shared/normalization";
import { clean, dateValue, numberValue } from "../geography/shared";
import { parseCoordinate } from "../geography/zone/geometry";

export const MAX_ADDRESSES_PER_CUSTOMER_CITY = 20;

const LABEL_MAX = 100;
const DETAILS_MAX = 500;
const LANDMARK_MAX = 200;
const RECIPIENT_NAME_MAX = 100;

type AddressRow = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  address_details: string;
  landmark: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  is_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  zone_id: string | null;
  zone_name: string | null;
};

export type CustomerAddressDto = {
  id: string;
  label: string;
  location: { latitude: number; longitude: number };
  addressDetails: string;
  landmark: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  isDefault: boolean;
  deliveryAvailable: boolean;
  zone: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAddressInput = {
  label: string;
  location: { latitude: unknown; longitude: unknown };
  addressDetails: string;
  landmark?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
};

export type UpdateAddressInput = {
  label?: string;
  location?: { latitude: unknown; longitude: unknown };
  addressDetails?: string;
  landmark?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
};

const ADDRESS_SELECT = `
  a.id::text as id,
  a.label,
  ST_Y(a.location)::float8 as latitude,
  ST_X(a.location)::float8 as longitude,
  a.address_details,
  a.landmark,
  a.recipient_name,
  a.recipient_phone,
  a.is_default,
  a.created_at,
  a.updated_at,
  z.id::text as zone_id,
  z.name as zone_name
`;

/** ACTIVE non-archived Zone covering the address Point; ties break like Zone.resolvePublic. */
const ZONE_LATERAL = `
  left join lateral (
    select z.id, z.name
    from zones z
    where z.city_id = a.city_id
      and z.status = 'ACTIVE'
      and z.archived_at is null
      and ST_Covers(z.boundary, a.location)
    order by z.created_at asc, z.id asc
    limit 1
  ) z on true
`;

const toDto = (row: AddressRow): CustomerAddressDto => {
  const zone =
    row.zone_id && row.zone_name
      ? { id: row.zone_id, name: row.zone_name }
      : null;
  return {
    id: row.id,
    label: row.label,
    location: {
      latitude: numberValue(row.latitude),
      longitude: numberValue(row.longitude),
    },
    addressDetails: row.address_details,
    landmark: row.landmark,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    isDefault: row.is_default,
    deliveryAvailable: zone !== null,
    zone,
    createdAt: dateValue(row.created_at)!,
    updatedAt: dateValue(row.updated_at)!,
  };
};

const parseLocation = (raw: { latitude: unknown; longitude: unknown }) => ({
  latitude: parseCoordinate(raw.latitude, "latitude"),
  longitude: parseCoordinate(raw.longitude, "longitude"),
});

const optionalText = (
  value: unknown,
  field: string,
  max: number,
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed)
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  if (trimmed.length > max)
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return trimmed;
};

const requiredText = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  const trimmed = clean(value, field);
  if (trimmed.length > max)
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return trimmed;
};

const optionalPhone = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string")
    throw new AppError(422, "VALIDATION_FAILED", "Invalid recipientPhone");
  return normalizePhone(value);
};

/**
 * Customer Saved Addresses.
 * Default replacement after deleting the default: oldest remaining by
 * (created_at asc, id asc) within the same Customer + City.
 */
export class CustomerAddressService {
  constructor(private client: SQL) {}

  private async lockScope(tx: SQL, accountId: string, cityId: string) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`customer-addresses:${accountId}:${cityId}`}, 0))`;
  }

  private async assertActiveCustomer(tx: SQL, accountId: string) {
    const [customer] = await tx<
      { id: string }[]
    >`select cp.account_id::text id
      from customer_profiles cp
      join accounts a on a.id = cp.account_id
      where cp.account_id = ${accountId}
        and cp.status = 'ACTIVE'
        and a.status = 'ACTIVE'`;
    if (!customer)
      throw new AppError(
        401,
        "AUTHENTICATION_STATE_INVALID",
        "Authentication state is invalid",
      );
  }

  private async fetchOne(
    executor: SQL,
    accountId: string,
    cityId: string,
    addressId: string,
  ) {
    const rows = await executor.unsafe(
      `select ${ADDRESS_SELECT}
       from customer_addresses a
       ${ZONE_LATERAL}
       where a.id = $1::uuid
         and a.customer_account_id = $2::uuid
         and a.city_id = $3::uuid`,
      [addressId, accountId, cityId],
    );
    return (rows as AddressRow[])[0] ?? null;
  }

  private async fetchMany(executor: SQL, accountId: string, cityId: string) {
    const rows = await executor.unsafe(
      `select ${ADDRESS_SELECT}
       from customer_addresses a
       ${ZONE_LATERAL}
       where a.customer_account_id = $1::uuid
         and a.city_id = $2::uuid
       order by a.is_default desc, a.created_at asc, a.id asc`,
      [accountId, cityId],
    );
    return rows as AddressRow[];
  }

  async list(accountId: string, cityId: string) {
    await this.assertActiveCustomer(this.client, accountId);
    const rows = await this.fetchMany(this.client, accountId, cityId);
    return { data: rows.map(toDto) };
  }

  async get(accountId: string, cityId: string, addressId: string) {
    await this.assertActiveCustomer(this.client, accountId);
    const row = await this.fetchOne(this.client, accountId, cityId, addressId);
    if (!row)
      throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");
    return toDto(row);
  }

  async create(accountId: string, cityId: string, input: CreateAddressInput) {
    const label = requiredText(input.label, "label", LABEL_MAX);
    const addressDetails = requiredText(
      input.addressDetails,
      "addressDetails",
      DETAILS_MAX,
    );
    const { latitude, longitude } = parseLocation(input.location);
    const landmark = optionalText(input.landmark, "landmark", LANDMARK_MAX);
    const recipientName = optionalText(
      input.recipientName,
      "recipientName",
      RECIPIENT_NAME_MAX,
    );
    const recipientPhone = optionalPhone(input.recipientPhone);

    return this.client.begin(async (tx) => {
      await this.lockScope(tx, accountId, cityId);
      await this.assertActiveCustomer(tx, accountId);

      const [countRow] = await tx<
        { count: number }[]
      >`select count(*)::int as count
        from customer_addresses
        where customer_account_id = ${accountId}
          and city_id = ${cityId}`;
      const count = countRow?.count ?? 0;
      if (count >= MAX_ADDRESSES_PER_CUSTOMER_CITY)
        throw new AppError(
          409,
          "ADDRESS_LIMIT_EXCEEDED",
          `Maximum of ${MAX_ADDRESSES_PER_CUSTOMER_CITY} saved addresses per city`,
        );

      const isDefault = count === 0;
      const [inserted] = await tx<
        { id: string }[]
      >`insert into customer_addresses (
          customer_account_id,
          city_id,
          label,
          location,
          address_details,
          landmark,
          recipient_name,
          recipient_phone,
          is_default
        ) values (
          ${accountId},
          ${cityId},
          ${label},
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
          ${addressDetails},
          ${landmark ?? null},
          ${recipientName ?? null},
          ${recipientPhone ?? null},
          ${isDefault}
        )
        returning id::text as id`;

      const row = await this.fetchOne(tx, accountId, cityId, inserted!.id);
      return toDto(row!);
    });
  }

  async update(
    accountId: string,
    cityId: string,
    addressId: string,
    input: UpdateAddressInput,
  ) {
    const hasLabel = input.label !== undefined;
    const hasDetails = input.addressDetails !== undefined;
    const hasLocation = input.location !== undefined;
    const hasLandmark = input.landmark !== undefined;
    const hasRecipientName = input.recipientName !== undefined;
    const hasRecipientPhone = input.recipientPhone !== undefined;

    if (
      !hasLabel &&
      !hasDetails &&
      !hasLocation &&
      !hasLandmark &&
      !hasRecipientName &&
      !hasRecipientPhone
    )
      throw new AppError(422, "VALIDATION_FAILED", "No fields to update");

    const label = hasLabel
      ? requiredText(input.label, "label", LABEL_MAX)
      : undefined;
    const addressDetails = hasDetails
      ? requiredText(input.addressDetails, "addressDetails", DETAILS_MAX)
      : undefined;
    const location = hasLocation ? parseLocation(input.location!) : undefined;
    const landmark = hasLandmark
      ? optionalText(input.landmark, "landmark", LANDMARK_MAX)
      : undefined;
    const recipientName = hasRecipientName
      ? optionalText(input.recipientName, "recipientName", RECIPIENT_NAME_MAX)
      : undefined;
    const recipientPhone = hasRecipientPhone
      ? optionalPhone(input.recipientPhone)
      : undefined;

    return this.client.begin(async (tx) => {
      await this.lockScope(tx, accountId, cityId);
      await this.assertActiveCustomer(tx, accountId);

      const existing = await tx<
        { id: string }[]
      >`select id::text as id
        from customer_addresses
        where id = ${addressId}
          and customer_account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!existing[0])
        throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");

      await tx`
        update customer_addresses set
          label = coalesce(${label ?? null}, label),
          address_details = coalesce(${addressDetails ?? null}, address_details),
          location = case
            when ${hasLocation} then ST_SetSRID(ST_MakePoint(${location?.longitude ?? 0}, ${location?.latitude ?? 0}), 4326)
            else location
          end,
          landmark = case
            when ${hasLandmark} then ${landmark ?? null}
            else landmark
          end,
          recipient_name = case
            when ${hasRecipientName} then ${recipientName ?? null}
            else recipient_name
          end,
          recipient_phone = case
            when ${hasRecipientPhone} then ${recipientPhone ?? null}
            else recipient_phone
          end,
          updated_at = now()
        where id = ${addressId}
          and customer_account_id = ${accountId}
          and city_id = ${cityId}`;

      const row = await this.fetchOne(tx, accountId, cityId, addressId);
      return toDto(row!);
    });
  }

  async setDefault(accountId: string, cityId: string, addressId: string) {
    return this.client.begin(async (tx) => {
      await this.lockScope(tx, accountId, cityId);
      await this.assertActiveCustomer(tx, accountId);

      const [target] = await tx<
        { id: string; is_default: boolean }[]
      >`select id::text as id, is_default
        from customer_addresses
        where id = ${addressId}
          and customer_account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!target)
        throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");

      if (!target.is_default) {
        await tx`
          update customer_addresses
          set is_default = false, updated_at = now()
          where customer_account_id = ${accountId}
            and city_id = ${cityId}
            and is_default = true
            and id <> ${addressId}`;
        await tx`
          update customer_addresses
          set is_default = true, updated_at = now()
          where id = ${addressId}
            and customer_account_id = ${accountId}
            and city_id = ${cityId}`;
      }

      const row = await this.fetchOne(tx, accountId, cityId, addressId);
      return toDto(row!);
    });
  }

  async remove(accountId: string, cityId: string, addressId: string) {
    return this.client.begin(async (tx) => {
      await this.lockScope(tx, accountId, cityId);
      await this.assertActiveCustomer(tx, accountId);

      const [target] = await tx<
        { id: string; is_default: boolean }[]
      >`select id::text as id, is_default
        from customer_addresses
        where id = ${addressId}
          and customer_account_id = ${accountId}
          and city_id = ${cityId}
        for update`;
      if (!target)
        throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");

      await tx`
        delete from customer_addresses
        where id = ${addressId}
          and customer_account_id = ${accountId}
          and city_id = ${cityId}`;

      if (target.is_default) {
        const [replacement] = await tx<
          { id: string }[]
        >`select id::text as id
          from customer_addresses
          where customer_account_id = ${accountId}
            and city_id = ${cityId}
          order by created_at asc, id asc
          limit 1
          for update`;
        if (replacement)
          await tx`
            update customer_addresses
            set is_default = true, updated_at = now()
            where id = ${replacement.id}`;
      }

      return { deleted: true as const };
    });
  }
}
