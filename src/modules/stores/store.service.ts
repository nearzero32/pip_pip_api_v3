import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { normalizePhone } from "../auth/shared/normalization";
import { authorizeMerchantStoreScope } from "../auth/merchant/merchant-access";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "../catalog/arabic-name";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../geography/geography-locks";
import { dateValue } from "../geography/shared";
import {
  dashboardListResult,
  dashboardPageOf,
} from "../dashboard-lists/query";
import {
  parseStoreListQuery,
  STORE_LIST_WHERE_SQL,
  storeListParams,
  type StoreListInput,
} from "../dashboard-lists/store-list-query";
import { parseCoordinate } from "../geography/zone/geometry";
import { buildPublicMediaUrl } from "../media/object-key";
import type { MediaService } from "../media/media.service";
import { PUBLIC_STORE_ELIGIBILITY_SQL } from "./public-store-eligibility";
import {
  computeIsAcceptingOrders,
  evaluateStoreSchedule,
  validateWorkingHours,
  type Weekday,
  type WorkingHourPeriod,
} from "./schedule";

type StoreStatus = "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
type OrderAcceptance = "ACCEPTING" | "PAUSED";

type StoreRow = {
  id: string;
  city_id: string;
  main_category_id: string;
  main_category_name: string;
  main_category_status: string;
  name: string;
  phone: string;
  address: string;
  latitude: string | number;
  longitude: string | number;
  logo_asset_id: string | null;
  cover_asset_id: string | null;
  status: StoreStatus;
  order_acceptance_status: OrderAcceptance;
  display_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  logo_object_key: string;
  logo_visibility: string;
  logo_status: string;
  cover_object_key: string | null;
  cover_visibility: string | null;
  cover_status: string | null;
};

const STORE_SELECT = `
  s.id::text as id,
  s.city_id::text as city_id,
  s.main_category_id::text as main_category_id,
  mc.name as main_category_name,
  mc.status::text as main_category_status,
  s.name,
  s.phone,
  s.address,
  ST_Y(s.location)::float8 as latitude,
  ST_X(s.location)::float8 as longitude,
  s.logo_asset_id::text as logo_asset_id,
  s.cover_asset_id::text as cover_asset_id,
  s.status::text as status,
  s.order_acceptance_status::text as order_acceptance_status,
  s.display_order,
  s.created_at,
  s.updated_at,
  s.archived_at,
  logo.object_key as logo_object_key,
  logo.visibility::text as logo_visibility,
  logo.status::text as logo_status,
  cover.object_key as cover_object_key,
  cover.visibility::text as cover_visibility,
  cover.status::text as cover_status
`;

const sortUuidAsc = (ids: string[]) =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const mediaImage = (
  assetId: string | null,
  objectKey: string | null,
  visibility: string | null,
  status: string | null,
  publicBaseUrl: string,
) => {
  if (!assetId) return null;
  return {
    assetId,
    url: buildPublicMediaUrl(
      publicBaseUrl,
      objectKey ?? "",
      (visibility as "PUBLIC" | "PRIVATE") ?? "PRIVATE",
      status ?? "PENDING_UPLOAD",
    ),
  };
};

export class StoreService {
  constructor(
    private client: SQL,
    private media: MediaService,
    private config: MediaConfig,
  ) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "stores.read"
      | "stores.create"
      | "stores.update"
      | "stores.archive",
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  /** Merchant-only: toggle Store order acceptance (open/closed operational state). */
  async updateMerchantOrderAcceptance(
    identity: AuthIdentity,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await authorizeMerchantStoreScope(this.client, identity);
    const storeId = identity.storeId!;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== "orderAcceptanceStatus") {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const orderAcceptanceStatus = input.orderAcceptanceStatus;
    if (
      orderAcceptanceStatus !== "ACCEPTING" &&
      orderAcceptanceStatus !== "PAUSED"
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [locked] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from stores
        where id = ${storeId} and city_id = ${cityId}
        for update`;
      if (!locked) {
        throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      }
      if (locked.status === "ARCHIVED") {
        throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
      }
      await tx`
        update stores set
          order_acceptance_status = ${orderAcceptanceStatus}::store_order_acceptance_status,
          updated_at = now()
        where id = ${storeId}
          and city_id = ${cityId}`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_ORDER_ACCEPTANCE_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, cityId, orderAcceptanceStatus })}::jsonb
      )`;

    return this.getDto(cityId, storeId);
  }

  private async loadHours(
    storeId: string,
    db: SQL = this.client,
  ): Promise<WorkingHourPeriod[]> {
    const rows = await db<{
      day_of_week: Weekday;
      opens_at: string;
      closes_at: string;
    }[]>`
      select
        day_of_week::text as day_of_week,
        to_char(opens_at, 'HH24:MI') as opens_at,
        to_char(closes_at, 'HH24:MI') as closes_at
      from store_working_hours
      where store_id = ${storeId}
      order by day_of_week, opens_at`;
    return rows.map((row) => ({
      dayOfWeek: row.day_of_week,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    }));
  }

  private async loadZoneIds(storeId: string, db: SQL = this.client) {
    const rows = await db<{ zone_id: string }[]>`
      select zone_id::text as zone_id from store_zones
      where store_id = ${storeId} order by zone_id`;
    return rows.map((row) => row.zone_id);
  }

  private async loadSubcategoryIds(storeId: string, db: SQL = this.client) {
    const rows = await db<{ subcategory_id: string }[]>`
      select subcategory_id::text as subcategory_id from store_subcategories
      where store_id = ${storeId} order by subcategory_id`;
    return rows.map((row) => row.subcategory_id);
  }

  private storeDto(
    row: StoreRow,
    zoneIds: string[],
    subcategoryIds: string[],
    hours: WorkingHourPeriod[],
    now = new Date(),
  ): any {
    const schedule = evaluateStoreSchedule(hours, now);
    return {
      id: row.id,
      mainCategory: {
        id: row.main_category_id,
        name: row.main_category_name,
      },
      name: row.name,
      phone: row.phone,
      address: row.address,
      location: {
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      },
      logo: mediaImage(
        row.logo_asset_id,
        row.logo_object_key,
        row.logo_visibility,
        row.logo_status,
        this.config.r2PublicBaseUrl,
      ),
      cover: mediaImage(
        row.cover_asset_id,
        row.cover_object_key,
        row.cover_visibility,
        row.cover_status,
        this.config.r2PublicBaseUrl,
      ),
      status: row.status,
      orderAcceptanceStatus: row.order_acceptance_status,
      displayOrder: row.display_order,
      zoneIds,
      subcategoryIds,
      workingHours: hours,
      availability: {
        isOpen: schedule.isOpen,
        isAcceptingOrders: computeIsAcceptingOrders({
          status: row.status,
          orderAcceptanceStatus: row.order_acceptance_status,
          isOpen: schedule.isOpen,
        }),
        nextOpeningAt: schedule.nextOpeningAt,
        nextClosingAt: schedule.nextClosingAt,
      },
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      archivedAt: dateValue(row.archived_at),
    };
  }

  private publicDto(
    row: StoreRow,
    hours: WorkingHourPeriod[],
    now = new Date(),
  ): any {
    const schedule = evaluateStoreSchedule(hours, now);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      address: row.address,
      location: {
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      },
      mainCategory: {
        id: row.main_category_id,
        name: row.main_category_name,
      },
      logo: mediaImage(
        row.logo_asset_id,
        row.logo_object_key,
        row.logo_visibility,
        row.logo_status,
        this.config.r2PublicBaseUrl,
      ),
      cover: mediaImage(
        row.cover_asset_id,
        row.cover_object_key,
        row.cover_visibility,
        row.cover_status,
        this.config.r2PublicBaseUrl,
      ),
      displayOrder: row.display_order,
      isOpen: schedule.isOpen,
      isAcceptingOrders: computeIsAcceptingOrders({
        status: row.status,
        orderAcceptanceStatus: row.order_acceptance_status,
        isOpen: schedule.isOpen,
      }),
      orderAcceptanceStatus: row.order_acceptance_status,
      nextOpeningAt: schedule.nextOpeningAt,
      nextClosingAt: schedule.nextClosingAt,
    };
  }

  private async loadCityScoped(id: string, cityId: string, db: SQL = this.client) {
    const rows = (await db.unsafe(
      `select ${STORE_SELECT}
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       left join media_assets logo on logo.id = s.logo_asset_id
       left join media_assets cover on cover.id = s.cover_asset_id
       where s.id = $1::uuid and s.city_id = $2::uuid`,
      [id, cityId],
    )) as StoreRow[];
    const row = rows[0];
    if (!row) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return row;
  }

  private async assertLocationInCityZone(
    tx: SQL,
    cityId: string,
    longitude: number,
    latitude: number,
  ) {
    const [hit] = await tx<{ id: string }[]>`
      select id::text as id from zones
      where city_id = ${cityId}
        and status = 'ACTIVE'
        and archived_at is null
        and ST_Covers(
          boundary,
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
        )
      limit 1`;
    if (!hit) {
      throw new AppError(
        422,
        "INVALID_STORE_LOCATION",
        "Store location must be inside an active City Zone",
      );
    }
  }

  private async lockMainCategory(tx: SQL, cityId: string, mainCategoryId: string) {
    const [row] = await tx<{ id: string; status: string }[]>`
      select id::text as id, status::text as status
      from main_categories
      where id = ${mainCategoryId} and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(404, "MAIN_CATEGORY_NOT_FOUND", "Main category not found");
    }
    if (row.status === "ARCHIVED") {
      throw new AppError(409, "MAIN_CATEGORY_ARCHIVED", "Main category is archived");
    }
    return row;
  }

  private async lockZones(tx: SQL, cityId: string, zoneIds: string[]) {
    if (zoneIds.length === 0) {
      throw new AppError(
        422,
        "STORE_REQUIRES_SERVICE_ZONE",
        "Store requires at least one service Zone",
      );
    }
    const ordered = sortUuidAsc(zoneIds);
    const locked: string[] = [];
    for (const zoneId of ordered) {
      const [row] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from zones
        where id = ${zoneId} and city_id = ${cityId}
        for update`;
      if (!row || row.status === "ARCHIVED") {
        throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
      }
      locked.push(row.id);
    }
    return locked;
  }

  private async lockSubcategories(
    tx: SQL,
    cityId: string,
    mainCategoryId: string,
    subcategoryIds: string[],
  ) {
    if (subcategoryIds.length === 0) {
      throw new AppError(
        422,
        "STORE_REQUIRES_SUBCATEGORY",
        "Store requires at least one Subcategory",
      );
    }
    const ordered = sortUuidAsc(subcategoryIds);
    for (const subcategoryId of ordered) {
      const [row] = await tx<{
        id: string;
        status: string;
        main_category_id: string;
      }[]>`
        select id::text as id, status::text as status, main_category_id::text as main_category_id
        from subcategories
        where id = ${subcategoryId} and city_id = ${cityId}
        for update`;
      if (!row) {
        throw new AppError(404, "SUBCATEGORY_NOT_FOUND", "Subcategory not found");
      }
      if (row.status === "ARCHIVED") {
        throw new AppError(404, "SUBCATEGORY_NOT_FOUND", "Subcategory not found");
      }
      if (row.main_category_id !== mainCategoryId) {
        throw new AppError(
          422,
          "VALIDATION_FAILED",
          "Subcategory does not belong to the selected Main Category",
        );
      }
    }
    return ordered;
  }

  private async replaceHours(
    tx: SQL,
    storeId: string,
    hours: WorkingHourPeriod[],
  ) {
    await tx`delete from store_working_hours where store_id = ${storeId}`;
    for (const period of hours) {
      await tx`
        insert into store_working_hours (store_id, day_of_week, opens_at, closes_at)
        values (
          ${storeId},
          ${period.dayOfWeek}::weekday,
          ${period.opensAt}::time,
          ${period.closesAt}::time
        )`;
    }
  }

  private async replaceZones(
    tx: SQL,
    storeId: string,
    cityId: string,
    zoneIds: string[],
  ) {
    await tx`delete from store_zones where store_id = ${storeId}`;
    for (const zoneId of zoneIds) {
      await tx`
        insert into store_zones (store_id, zone_id, city_id)
        values (${storeId}, ${zoneId}, ${cityId})`;
    }
  }

  private async replaceSubcategories(
    tx: SQL,
    storeId: string,
    cityId: string,
    mainCategoryId: string,
    subcategoryIds: string[],
  ) {
    await tx`delete from store_subcategories where store_id = ${storeId}`;
    for (const subcategoryId of subcategoryIds) {
      await tx`
        insert into store_subcategories (store_id, subcategory_id, city_id, main_category_id)
        values (${storeId}, ${subcategoryId}, ${cityId}, ${mainCategoryId})`;
    }
  }

  async create(identity: AuthIdentity, body: unknown, requestId: string) {
    const cityId = await this.authorize(identity, "stores.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
      "isOpen",
      "isAcceptingOrders",
      "nextOpeningAt",
      "nextClosingAt",
      "platformCommissionRate",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (typeof input.mainCategoryId !== "string") {
      throw new AppError(422, "VALIDATION_FAILED", "mainCategoryId is required");
    }
    if (!("logoAssetId" in input) || input.logoAssetId == null) {
      throw new AppError(422, "VALIDATION_FAILED", "logoAssetId is required");
    }
    if (input.coverAssetId === null) {
      throw new AppError(422, "VALIDATION_FAILED", "coverAssetId cannot be null on create");
    }
    const name = normalizeArabicCategoryName(input.name);
    const phone = normalizePhone(String(input.phone ?? ""));
    const address = String(input.address ?? "").trim();
    if (!address) throw new AppError(422, "VALIDATION_FAILED", "Invalid address");
    const latitude = parseCoordinate(input.latitude, "latitude");
    const longitude = parseCoordinate(input.longitude, "longitude");
    const status = (input.status as StoreStatus | undefined) ?? "DRAFT";
    if (!["DRAFT", "ACTIVE", "INACTIVE"].includes(status)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid store status");
    }
    const orderAcceptanceStatus =
      (input.orderAcceptanceStatus as OrderAcceptance | undefined) ?? "ACCEPTING";
    if (!["ACCEPTING", "PAUSED"].includes(orderAcceptanceStatus)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid order acceptance status");
    }
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );
    const logoAssetId = String(input.logoAssetId);
    const coverAssetId =
      input.coverAssetId === undefined ? null : String(input.coverAssetId);
    if (coverAssetId && coverAssetId === logoAssetId) {
      throw new AppError(422, "VALIDATION_FAILED", "Logo and cover must differ");
    }
    const zoneIds = Array.isArray(input.zoneIds)
      ? input.zoneIds.map(String)
      : [];
    const subcategoryIds = Array.isArray(input.subcategoryIds)
      ? input.subcategoryIds.map(String)
      : [];
    const workingHours = validateWorkingHours(
      Array.isArray(input.workingHours)
        ? (input.workingHours as WorkingHourPeriod[])
        : [],
    );

    const mainCategoryId = String(input.mainCategoryId);
    const storeId = await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockMainCategory(tx, cityId, mainCategoryId);
      const lockedZones = await this.lockZones(tx, cityId, zoneIds);
      const lockedSubs = await this.lockSubcategories(
        tx,
        cityId,
        mainCategoryId,
        subcategoryIds,
      );
      await this.assertLocationInCityZone(tx, cityId, longitude, latitude);
      await this.media.claimAsset(tx, {
        assetId: logoAssetId,
        cityId,
        purpose: "STORE_LOGO",
        visibility: "PUBLIC",
      });
      if (coverAssetId) {
        await this.media.claimAsset(tx, {
          assetId: coverAssetId,
          cityId,
          purpose: "STORE_IMAGE",
          visibility: "PUBLIC",
        });
      }
      const [inserted] = await tx<{ id: string }[]>`
        insert into stores (
          city_id, main_category_id, name, phone, address, location,
          logo_asset_id, cover_asset_id, status, order_acceptance_status,
          display_order, created_by_account_id
        ) values (
          ${cityId},
          ${mainCategoryId},
          ${name},
          ${phone},
          ${address},
          ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
          ${logoAssetId},
          ${coverAssetId},
          ${status}::store_status,
          ${orderAcceptanceStatus}::store_order_acceptance_status,
          ${displayOrder},
          ${identity.accountId}
        )
        returning id::text as id`;
      const id = inserted!.id;
      await this.replaceZones(tx, id, cityId, lockedZones);
      await this.replaceSubcategories(
        tx,
        id,
        cityId,
        mainCategoryId,
        lockedSubs,
      );
      await this.replaceHours(tx, id, workingHours);
      return id;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, mainCategoryId })}::jsonb
      )`;

    return this.getDto(cityId, storeId);
  }

  private async getDto(cityId: string, storeId: string) {
    const row = await this.loadCityScoped(storeId, cityId);
    const [zoneIds, subcategoryIds, hours] = await Promise.all([
      this.loadZoneIds(storeId),
      this.loadSubcategoryIds(storeId),
      this.loadHours(storeId),
    ]);
    return this.storeDto(row, zoneIds, subcategoryIds, hours);
  }

  async list(
    identity: AuthIdentity,
    input: StoreListInput & { page?: number; limit?: number },
  ) {
    const cityId = await this.authorize(identity, "stores.read");
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const filters = parseStoreListQuery(input);
    const params = storeListParams(cityId, filters);
    const rows = (await this.client.unsafe(
      `select ${STORE_SELECT}
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       left join media_assets logo on logo.id = s.logo_asset_id
       left join media_assets cover on cover.id = s.cover_asset_id
       where ${STORE_LIST_WHERE_SQL}
       order by ${filters.orderSql}
       limit $${params.length + 1}::int offset $${params.length + 2}::int`,
      [...params, limit, offset],
    )) as StoreRow[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total from stores s
       where ${STORE_LIST_WHERE_SQL}`,
      params,
    )) as { total: string }[];

    const data = [];
    const storeIds = rows.map((row) => row.id);
    const zoneMap = new Map<string, string[]>();
    const subcategoryMap = new Map<string, string[]>();
    const hoursMap = new Map<string, WorkingHourPeriod[]>();
    if (storeIds.length > 0) {
      const zoneRows = await this.client<{ store_id: string; zone_id: string }[]>`
        select store_id::text as store_id, zone_id::text as zone_id
        from store_zones where store_id in ${this.client(storeIds)}
        order by store_id, zone_id`;
      for (const row of zoneRows) {
        const list = zoneMap.get(row.store_id) ?? [];
        list.push(row.zone_id);
        zoneMap.set(row.store_id, list);
      }
      const subcategoryRows = await this.client<{ store_id: string; subcategory_id: string }[]>`
        select store_id::text as store_id, subcategory_id::text as subcategory_id
        from store_subcategories where store_id in ${this.client(storeIds)}
        order by store_id, subcategory_id`;
      for (const row of subcategoryRows) {
        const list = subcategoryMap.get(row.store_id) ?? [];
        list.push(row.subcategory_id);
        subcategoryMap.set(row.store_id, list);
      }
      const hourRows = await this.client<{
        store_id: string;
        day_of_week: Weekday;
        opens_at: string;
        closes_at: string;
      }[]>`
        select store_id::text as store_id,
               day_of_week::text as day_of_week,
               to_char(opens_at, 'HH24:MI') as opens_at,
               to_char(closes_at, 'HH24:MI') as closes_at
        from store_working_hours
        where store_id in ${this.client(storeIds)}
        order by store_id, day_of_week, opens_at`;
      for (const row of hourRows) {
        const list = hoursMap.get(row.store_id) ?? [];
        list.push({
          dayOfWeek: row.day_of_week,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
        });
        hoursMap.set(row.store_id, list);
      }
    }
    for (const row of rows) {
      data.push(
        this.storeDto(
          row,
          zoneMap.get(row.id) ?? [],
          subcategoryMap.get(row.id) ?? [],
          hoursMap.get(row.id) ?? [],
        ),
      );
    }
    return dashboardListResult(data, page, limit, Number(count?.total ?? 0));
  }

  async get(identity: AuthIdentity, storeId: string) {
    const cityId = await this.authorize(identity, "stores.read");
    return this.getDto(cityId, storeId);
  }

  async update(
    identity: AuthIdentity,
    storeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "stores.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "archivedAt",
      "isOpen",
      "isAcceptingOrders",
      "nextOpeningAt",
      "nextClosingAt",
      "platformCommissionRate",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const keys = [
      "mainCategoryId",
      "name",
      "phone",
      "address",
      "latitude",
      "longitude",
      "logoAssetId",
      "coverAssetId",
      "status",
      "orderAcceptanceStatus",
      "displayOrder",
      "zoneIds",
      "subcategoryIds",
      "workingHours",
    ];
    if (!keys.some((key) => key in input)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(422, "VALIDATION_FAILED", "Use DELETE to archive a store");
    }
    if ("logoAssetId" in input && input.logoAssetId == null) {
      throw new AppError(422, "VALIDATION_FAILED", "logoAssetId is required");
    }

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [locked] = await tx<{
        id: string;
        status: string;
        main_category_id: string;
        logo_asset_id: string | null;
        cover_asset_id: string | null;
      }[]>`
        select
          id::text as id,
          status::text as status,
          main_category_id::text as main_category_id,
          logo_asset_id::text as logo_asset_id,
          cover_asset_id::text as cover_asset_id
        from stores
        where id = ${storeId} and city_id = ${cityId}
        for update`;
      if (!locked) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      if (locked.status === "ARCHIVED") {
        throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
      }

      const nextMain =
        "mainCategoryId" in input
          ? String(input.mainCategoryId)
          : locked.main_category_id;
      await this.lockMainCategory(tx, cityId, nextMain);

      let nextZones: string[] | null = null;
      if ("zoneIds" in input) {
        if (!Array.isArray(input.zoneIds)) {
          throw new AppError(422, "VALIDATION_FAILED", "Invalid zoneIds");
        }
        nextZones = await this.lockZones(tx, cityId, input.zoneIds.map(String));
      }

      let nextSubs: string[] | null = null;
      if ("subcategoryIds" in input || "mainCategoryId" in input) {
        const ids = Array.isArray(input.subcategoryIds)
          ? input.subcategoryIds.map(String)
          : await this.loadSubcategoryIds(storeId, tx);
        nextSubs = await this.lockSubcategories(tx, cityId, nextMain, ids);
      }

      let latitude: number | null = null;
      let longitude: number | null = null;
      if ("latitude" in input || "longitude" in input) {
        if (!("latitude" in input) || !("longitude" in input)) {
          throw new AppError(
            422,
            "VALIDATION_FAILED",
            "latitude and longitude must be updated together",
          );
        }
        latitude = parseCoordinate(input.latitude, "latitude");
        longitude = parseCoordinate(input.longitude, "longitude");
        await this.assertLocationInCityZone(tx, cityId, longitude, latitude);
      }

      let nextLogo = locked.logo_asset_id;
      let releaseLogo: string | null = null;
      if ("logoAssetId" in input) {
        const logoAssetId = String(input.logoAssetId);
        if (logoAssetId !== locked.logo_asset_id) {
          await this.media.claimAsset(tx, {
            assetId: logoAssetId,
            cityId,
            purpose: "STORE_LOGO",
            visibility: "PUBLIC",
          });
          releaseLogo = locked.logo_asset_id;
          nextLogo = logoAssetId;
        }
      }
      if (!nextLogo) {
        throw new AppError(422, "VALIDATION_FAILED", "logoAssetId is required");
      }

      let nextCover = locked.cover_asset_id;
      let releaseCover: string | null = null;
      if ("coverAssetId" in input) {
        if (input.coverAssetId === null) {
          if (locked.cover_asset_id) {
            releaseCover = locked.cover_asset_id;
            nextCover = null;
          }
        } else {
          const coverAssetId = String(input.coverAssetId);
          if (coverAssetId !== locked.cover_asset_id) {
            await this.media.claimAsset(tx, {
              assetId: coverAssetId,
              cityId,
              purpose: "STORE_IMAGE",
              visibility: "PUBLIC",
            });
            releaseCover = locked.cover_asset_id;
            nextCover = coverAssetId;
          }
        }
      }
      if (nextCover && nextCover === nextLogo) {
        throw new AppError(422, "VALIDATION_FAILED", "Logo and cover must differ");
      }

      const name =
        "name" in input ? normalizeArabicCategoryName(input.name) : null;
      const phone =
        "phone" in input ? normalizePhone(String(input.phone)) : null;
      const address =
        "address" in input ? String(input.address).trim() : null;
      if (address !== null && !address) {
        throw new AppError(422, "VALIDATION_FAILED", "Invalid address");
      }
      const status =
        "status" in input ? (input.status as StoreStatus) : null;
      if (status && !["DRAFT", "ACTIVE", "INACTIVE"].includes(status)) {
        throw new AppError(422, "VALIDATION_FAILED", "Invalid store status");
      }
      const orderAcceptanceStatus =
        "orderAcceptanceStatus" in input
          ? (input.orderAcceptanceStatus as OrderAcceptance)
          : null;
      const displayOrder =
        "displayOrder" in input
          ? validateDisplayOrder(input.displayOrder)
          : null;

      if (nextZones) await this.replaceZones(tx, storeId, cityId, nextZones);
      if (nextSubs) {
        // Delete join rows before changing stores.main_category_id — composite FK
        // store_subcategories → stores(id, main_category_id, city_id) would otherwise
        // reject the parent update while old subcategory rows still reference the prior main.
        await tx`delete from store_subcategories where store_id = ${storeId}`;
      }

      if (longitude != null && latitude != null) {
        await tx`
          update stores set
            main_category_id = ${nextMain},
            name = coalesce(${name}, name),
            phone = coalesce(${phone}, phone),
            address = coalesce(${address}, address),
            location = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326),
            logo_asset_id = ${nextLogo},
            cover_asset_id = ${nextCover},
            status = coalesce(${status}::store_status, status),
            order_acceptance_status = coalesce(${orderAcceptanceStatus}::store_order_acceptance_status, order_acceptance_status),
            display_order = coalesce(${displayOrder}, display_order),
            updated_at = now()
          where id = ${storeId} and city_id = ${cityId}`;
      } else {
        await tx`
          update stores set
            main_category_id = ${nextMain},
            name = coalesce(${name}, name),
            phone = coalesce(${phone}, phone),
            address = coalesce(${address}, address),
            logo_asset_id = ${nextLogo},
            cover_asset_id = ${nextCover},
            status = coalesce(${status}::store_status, status),
            order_acceptance_status = coalesce(${orderAcceptanceStatus}::store_order_acceptance_status, order_acceptance_status),
            display_order = coalesce(${displayOrder}, display_order),
            updated_at = now()
          where id = ${storeId} and city_id = ${cityId}`;
      }

      if (nextSubs) {
        for (const subcategoryId of nextSubs) {
          await tx`
            insert into store_subcategories (store_id, subcategory_id, city_id, main_category_id)
            values (${storeId}, ${subcategoryId}, ${cityId}, ${nextMain})`;
        }
      }
      if ("workingHours" in input) {
        if (!Array.isArray(input.workingHours)) {
          throw new AppError(422, "VALIDATION_FAILED", "Invalid workingHours");
        }
        await this.replaceHours(
          tx,
          storeId,
          validateWorkingHours(input.workingHours as WorkingHourPeriod[]),
        );
      }

      if (releaseLogo) {
        await this.media.releaseAsset(tx, { assetId: releaseLogo, cityId });
      }
      if (releaseCover) {
        await this.media.releaseAsset(tx, { assetId: releaseCover, cityId });
      }
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId })}::jsonb
      )`;
    return this.getDto(cityId, storeId);
  }

  async archive(identity: AuthIdentity, storeId: string, requestId: string) {
    const cityId = await this.authorize(identity, "stores.archive");
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      const [locked] = await tx<{
        id: string;
        status: string;
        logo_asset_id: string | null;
        cover_asset_id: string | null;
      }[]>`
        select
          id::text as id,
          status::text as status,
          logo_asset_id::text as logo_asset_id,
          cover_asset_id::text as cover_asset_id
        from stores
        where id = ${storeId} and city_id = ${cityId}
        for update`;
      if (!locked) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
      if (locked.status === "ARCHIVED") return;

      const logo = locked.logo_asset_id;
      const cover = locked.cover_asset_id;
      // Logo is required while non-archived (DB check). Archive clears both FKs
      // and releases assets so Merchant-ready Store history keeps rows without
      // holding media claims.
      await tx`
        update stores set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now(),
          logo_asset_id = null,
          cover_asset_id = null
        where id = ${storeId} and city_id = ${cityId}`;
      if (logo) {
        await this.media.releaseAsset(tx, { assetId: logo, cityId });
      }
      if (cover) {
        await this.media.releaseAsset(tx, { assetId: cover, cityId });
      }
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'STORE_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId })}::jsonb
      )`;
    return this.getDto(cityId, storeId);
  }

  async listPublic(
    cityId: string,
    input: { zoneId: string; mainCategoryId?: string; now?: Date },
  ) {
    const [zone] = await this.client<{ id: string; status: string }[]>`
      select id::text as id, status::text as status from zones
      where id = ${input.zoneId} and city_id = ${cityId}
        and status = 'ACTIVE' and archived_at is null`;
    if (!zone) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");

    const mainCategoryId = input.mainCategoryId?.trim() || null;
    const rows = (await this.client.unsafe(
      `select ${STORE_SELECT}
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       join media_assets logo on logo.id = s.logo_asset_id
       left join media_assets cover on cover.id = s.cover_asset_id
       join store_zones sz on sz.store_id = s.id and sz.zone_id = $2::uuid
       where s.city_id = $1::uuid
         and ${PUBLIC_STORE_ELIGIBILITY_SQL}
         and ($3::uuid is null or s.main_category_id = $3::uuid)
       order by s.display_order asc, s.created_at asc, s.id asc`,
      [cityId, input.zoneId, mainCategoryId],
    )) as StoreRow[];

    const now = input.now ?? new Date();
    const data = [];
    for (const row of rows) {
      data.push(this.publicDto(row, await this.loadHours(row.id), now));
    }
    return { data };
  }

  async getPublic(cityId: string, storeId: string, now = new Date()) {
    const rows = (await this.client.unsafe(
      `select ${STORE_SELECT}
       from stores s
       join main_categories mc on mc.id = s.main_category_id and mc.city_id = s.city_id
       join media_assets logo on logo.id = s.logo_asset_id
       left join media_assets cover on cover.id = s.cover_asset_id
       where s.id = $1::uuid and s.city_id = $2::uuid
         and ${PUBLIC_STORE_ELIGIBILITY_SQL}`,
      [storeId, cityId],
    )) as StoreRow[];
    const row = rows[0];
    if (!row) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return this.publicDto(row, await this.loadHours(storeId), now);
  }
}
