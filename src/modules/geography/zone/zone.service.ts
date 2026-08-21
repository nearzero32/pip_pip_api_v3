import type { SQL } from "bun";
import { AppError } from "../../../errors/app-error";
import { requireSuperAdmin } from "../../auth/staff/authorization";
import type { AuthIdentity } from "../../auth/sessions/session-service";
import {
  beginWithGeographyRetry,
  lockCityGeography,
  lockZoneOverlap,
} from "../geography-locks";
import { clean, dateValue } from "../shared";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalAllowlisted,
  parseOptionalDateRange,
  parseOptionalSearch,
  parseSortOrder,
  sqlDir,
} from "../../dashboard-lists/query";
import { parseCoordinate, parseGeoJsonPolygon, type GeoJsonPolygon } from "../geometry";

type ZoneStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type ZoneRow = {
  id: string;
  city_id: string;
  name: string;
  boundary_geojson: string;
  status: ZoneStatus;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  created_by_account_id: string | null;
  updated_by_account_id: string | null;
  archived_by_account_id: string | null;
};

const ZONE_COLUMNS = `z.id::text as id,
  z.city_id::text as city_id,
  z.name,
  ST_AsGeoJSON(z.boundary)::text as boundary_geojson,
  z.status::text as status,
  z.created_at,
  z.updated_at,
  z.archived_at,
  z.created_by_account_id::text as created_by_account_id,
  z.updated_by_account_id::text as updated_by_account_id,
  z.archived_by_account_id::text as archived_by_account_id`;

const parseBoundaryDto = (geojson: string): GeoJsonPolygon => {
  try {
    return parseGeoJsonPolygon(JSON.parse(geojson) as unknown);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "INTERNAL_ERROR", "Invalid stored zone boundary");
  }
};

export const zoneDto = (row: ZoneRow): any => ({
  id: row.id,
  cityId: row.city_id,
  name: row.name,
  boundary: parseBoundaryDto(row.boundary_geojson),
  status: row.status,
  createdAt: dateValue(row.created_at),
  updatedAt: dateValue(row.updated_at),
  archivedAt: dateValue(row.archived_at),
  createdByAccountId: row.created_by_account_id,
  updatedByAccountId: row.updated_by_account_id,
  archivedByAccountId: row.archived_by_account_id,
});

export const publicZoneDto = (row: ZoneRow): any => ({
  id: row.id,
  name: row.name,
  boundary: parseBoundaryDto(row.boundary_geojson),
});

const fetchZone = async (
  db: SQL,
  zoneId: string,
  cityId: string,
): Promise<ZoneRow | undefined> => {
  const rows = (await db.unsafe(
    `select ${ZONE_COLUMNS}
     from zones z
     where z.id = $1::uuid and z.city_id = $2::uuid`,
    [zoneId, cityId],
  )) as ZoneRow[];
  return rows[0];
};

/**
 * Build and validate SRID 4326 Polygon geometry from GeoJSON.
 * PostGIS is authoritative for validity / type / SRID.
 */
const buildValidatedGeometry = async (tx: SQL, polygon: GeoJsonPolygon) => {
  const geojson = JSON.stringify(polygon);
  const [row] = await tx<{
    is_valid: boolean; is_empty: boolean;
    geom_type: string;
    srid: number;
  }[]>`
    select
      ST_IsValid(g.geom) as is_valid,
      ST_IsEmpty(g.geom) as is_empty,
      GeometryType(g.geom) as geom_type,
      ST_SRID(g.geom)::int as srid
    from (
      select ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) as geom
    ) g`;
  if (!row || !row.is_valid || row.is_empty || row.geom_type !== "POLYGON" || row.srid !== 4326) {
    throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
  }
  return geojson;
};

const assertInsideCityBoundary = async (tx: SQL, cityId: string, geojson: string) => {
  const [city] = await tx<{ boundary: string | null }[]>`select ST_AsGeoJSON(boundary)::text boundary from cities where id=${cityId}`;
  if (!city?.boundary) throw new AppError(409, "CITY_BOUNDARY_REQUIRED", "City boundary is required");
  const [covered] = await tx<{ covered: boolean }[]>`
    select ST_Covers(c.boundary, ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326)) covered
    from cities c where c.id=${cityId}`;
  if (!covered?.covered) throw new AppError(409, "ZONE_OUTSIDE_CITY_BOUNDARY", "Zone boundary is outside the city boundary");
};

/**
 * Positive-area intersection rejects overlap/containment/identical polygons.
 * Boundary-only touching (ST_Touches) is allowed.
 *
 * Expression:
 *   ST_Intersects(a, b) AND NOT ST_Touches(a, b)
 */
const assertNoPositiveAreaOverlap = async (
  tx: SQL,
  cityId: string,
  geojson: string,
  excludeZoneId: string | null,
) => {
  const [hit] = await tx<{ id: string }[]>`
    select z.id::text as id
    from zones z
    where z.city_id = ${cityId}
      and z.status <> 'ARCHIVED'
      and (${excludeZoneId}::uuid is null or z.id <> ${excludeZoneId}::uuid)
      and ST_Intersects(
        z.boundary,
        ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)
      )
      and not ST_Touches(
        z.boundary,
        ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)
      )
    limit 1`;
  if (hit) {
    throw new AppError(
      409,
      "ZONE_BOUNDARY_OVERLAP",
      "Zone boundary overlaps an existing zone",
    );
  }
};

const isUniqueNameViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = String(record.errno ?? record.code ?? "");
  const constraint = String(record.constraint ?? "");
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : null;
  const causeCode = cause ? String(cause.errno ?? cause.code ?? "") : "";
  const causeConstraint = cause ? String(cause.constraint ?? "") : "";
  return (
    (code === "23505" || causeCode === "23505") &&
    (constraint.includes("zones_city_name_active_uidx") ||
      causeConstraint.includes("zones_city_name_active_uidx"))
  );
};

const writeZoneAudit = async (
  tx: SQL,
  identity: AuthIdentity,
  requestId: string,
  event: "ZONE_CREATED" | "ZONE_UPDATED" | "ZONE_ARCHIVED",
  cityId: string,
  zoneId: string,
  changedFields: string[],
) => {
  await tx`
    insert into audit_logs (
      event_type, actor_account_id, actor_session_id, target_type, target_id,
      outcome, request_correlation_id, redacted_metadata
    ) values (
      ${event}, ${identity.accountId}, ${identity.sessionId}, 'zone', ${zoneId},
      'SUCCESS', ${requestId},
      ${JSON.stringify({ targetCityId: cityId, zoneId, changedFields, boundaryChanged: changedFields.includes("boundary") })}::jsonb
    )`;
};

export class ZoneService {
  constructor(private client: SQL) {}

  /**
   * Early rejection only — authoritative operability is re-checked under
   * geography locks inside the mutation transaction.
   */
  private async requireTargetCity(identity: AuthIdentity, cityId?: string): Promise<string> {
    requireSuperAdmin(identity);
    if (!cityId) throw new AppError(422, "CITY_ID_REQUIRED", "City selection is required");
    const [city] = await this.client<{ status: string }[]>`select status::text status from cities where id=${cityId}`;
    if (!city) throw new AppError(404, "CITY_NOT_FOUND", "City not found");
    if (city.status === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
    return cityId;
  }

  async create(identity: AuthIdentity, requestedCityId: string, body: unknown, requestId: string) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "INVALID_ZONE_INPUT", "Invalid zone input");
    }
    const input = body as Record<string, unknown>;
    const cityId = await this.requireTargetCity(identity, requestedCityId);
    const name = clean(String(input.name ?? ""), "name");
    if (!input.boundary) {
      throw new AppError(400, "INVALID_ZONE_INPUT", "Invalid zone input");
    }
    const polygon = parseGeoJsonPolygon(input.boundary);

    return beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      if (state.cityStatus === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
      await lockZoneOverlap(tx, cityId);
      const geojson = await buildValidatedGeometry(tx, polygon);
      await assertInsideCityBoundary(tx, cityId, geojson);
      await assertNoPositiveAreaOverlap(tx, cityId, geojson, null);
      let insertedId: string;
      try {
        const [inserted] = await tx<{ id: string }[]>`
          insert into zones (city_id, name, boundary, status, created_by_account_id, updated_by_account_id)
          values (
            ${cityId},
            ${name},
            ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
            'ACTIVE', ${identity.accountId}, ${identity.accountId}
          )
          returning id::text as id`;
        insertedId = inserted!.id;
      } catch (error) {
        if (isUniqueNameViolation(error)) {
          throw new AppError(409, "ZONE_NAME_CONFLICT", "Zone name already exists");
        }
        throw error;
      }
      await writeZoneAudit(tx, identity, requestId, "ZONE_CREATED", cityId, insertedId, ["name", "boundary", "status"]);
      const row = await fetchZone(tx, insertedId, cityId);
      if (!row) throw new AppError(500, "INTERNAL_ERROR", "Zone create failed");
      return zoneDto(row);
    });
  }

  async list(
    identity: AuthIdentity,
    input: {
      status?: string;
      cityId?: string;
      search?: string;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: string;
      createdFrom?: string;
      createdTo?: string;
    },
  ) {
    const cityId = await this.requireTargetCity(identity, input.cityId);
    const { page, limit } = dashboardPageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = parseOptionalSearch(input.search);
    const pattern = search ? likeContains(search) : null;
    const status = parseOptionalAllowlisted(
      input.status,
      ["ACTIVE", "INACTIVE", "ARCHIVED"] as const,
      "status",
    );
    const created = parseOptionalDateRange({
      from: input.createdFrom,
      to: input.createdTo,
      fromField: "createdFrom",
      toField: "createdTo",
    });
    const sortBy = parseAllowlistedSort(
      input.sortBy,
      ["name", "status", "createdAt"] as const,
      "name",
    );
    const sortOrder = parseSortOrder(
      input.sortOrder,
      sortBy === "name" ? "asc" : "desc",
    );
    const orderSql = {
      name: `z.name ${sqlDir(sortOrder)}, z.id ${sqlDir(sortOrder)}`,
      status: `z.status ${sqlDir(sortOrder)}, z.name asc, z.id asc`,
      createdAt: `z.created_at ${sqlDir(sortOrder)}, z.id ${sqlDir(sortOrder)}`,
    }[sortBy];
    const rows = (await this.client.unsafe(
      `select ${ZONE_COLUMNS}
       from zones z
       where z.city_id = $1::uuid
         and ($2::text is null or z.status = $2::zone_status)
         and ($3::text is null or z.name ilike $3 escape '\\')
         and ($4::timestamptz is null or z.created_at >= $4::timestamptz)
         and ($5::timestamptz is null or z.created_at < $5::timestamptz)
       order by ${orderSql}
       limit $6::int offset $7::int`,
      [cityId, status, pattern, created.from, created.to, limit, offset],
    )) as ZoneRow[];
    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from zones z
       where z.city_id = $1::uuid
         and ($2::text is null or z.status = $2::zone_status)
         and ($3::text is null or z.name ilike $3 escape '\\')
         and ($4::timestamptz is null or z.created_at >= $4::timestamptz)
         and ($5::timestamptz is null or z.created_at < $5::timestamptz)`,
      [cityId, status, pattern, created.from, created.to],
    )) as { total: string }[];
    return dashboardListResult(
      rows.map((row) => zoneDto(row)),
      page,
      limit,
      Number(count?.total ?? 0),
    );
  }

  async get(identity: AuthIdentity, zoneId: string, requestedCityId?: string) {
    const cityId = await this.requireTargetCity(identity, requestedCityId);
    const row = await fetchZone(this.client, zoneId, cityId);
    if (!row) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
    return zoneDto(row);
  }

  async update(identity: AuthIdentity, zoneId: string, body: unknown, requestedCityId: string | undefined, requestId: string) {
    const cityId = await this.requireTargetCity(identity, requestedCityId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "INVALID_ZONE_INPUT", "Invalid zone input");
    }
    const input = body as Record<string, unknown>;
    if ("cityId" in input) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const hasName = "name" in input;
    const hasStatus = "status" in input;
    const hasBoundary = "boundary" in input;
    if (!hasName && !hasStatus && !hasBoundary) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if (hasStatus) {
      const nextStatus = input.status;
      if (nextStatus !== "ACTIVE" && nextStatus !== "INACTIVE") {
        throw new AppError(400, "INVALID_ZONE_INPUT", "Invalid zone input");
      }
    }
    const name = hasName ? clean(String(input.name ?? ""), "name") : null;
    const status = hasStatus ? (input.status as "ACTIVE" | "INACTIVE") : null;
    const polygon = hasBoundary ? parseGeoJsonPolygon(input.boundary) : null;

    return beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      if (state.cityStatus === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
      await lockZoneOverlap(tx, cityId);
      const [existing] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from zones
        where id = ${zoneId} and city_id = ${cityId}
        for update`;
      if (!existing) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
      if (existing.status === "ARCHIVED") {
        throw new AppError(409, "ZONE_ARCHIVED", "Zone is archived");
      }

      let geojson: string | null = null;
      if (polygon) {
        geojson = await buildValidatedGeometry(tx, polygon);
        await assertInsideCityBoundary(tx, cityId, geojson);
        await assertNoPositiveAreaOverlap(tx, cityId, geojson, zoneId);
      }

      try {
        if (geojson) {
          await tx`
            update zones set
              name = coalesce(${name}, name),
              status = coalesce(${status}::zone_status, status),
              boundary = ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
              updated_by_account_id = ${identity.accountId},
              updated_at = now()
            where id = ${zoneId} and city_id = ${cityId}`;
        } else {
          await tx`
            update zones set
              name = coalesce(${name}, name),
              status = coalesce(${status}::zone_status, status),
              updated_by_account_id = ${identity.accountId},
              updated_at = now()
            where id = ${zoneId} and city_id = ${cityId}`;
        }
      } catch (error) {
        if (isUniqueNameViolation(error)) {
          throw new AppError(409, "ZONE_NAME_CONFLICT", "Zone name already exists");
        }
        throw error;
      }

      await writeZoneAudit(
        tx, identity, requestId, "ZONE_UPDATED", cityId, zoneId,
        [hasName ? "name" : null, hasStatus ? "status" : null, hasBoundary ? "boundary" : null].filter((field): field is string => field !== null),
      );

      const row = await fetchZone(tx, zoneId, cityId);
      if (!row) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
      return zoneDto(row);
    });
  }

  async archive(identity: AuthIdentity, zoneId: string, requestedCityId: string | undefined, requestId: string) {
    const cityId = await this.requireTargetCity(identity, requestedCityId);
    return beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      if (state.cityStatus === "ARCHIVED") throw new AppError(409, "CITY_ARCHIVED", "City is archived");
      await lockZoneOverlap(tx, cityId);
      const [existing] = await tx<{ id: string; status: string }[]>`
        select id::text as id, status::text as status
        from zones
        where id = ${zoneId} and city_id = ${cityId}
        for update`;
      if (!existing) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
      if (existing.status !== "ARCHIVED") {
        await tx`
          update zones set
            status = 'ARCHIVED',
            archived_at = now(),
            archived_by_account_id = ${identity.accountId},
            updated_by_account_id = ${identity.accountId},
            updated_at = now()
          where id = ${zoneId} and city_id = ${cityId}`;
        await writeZoneAudit(tx, identity, requestId, "ZONE_ARCHIVED", cityId, zoneId, ["status", "archivedAt"]);
      }
      const row = await fetchZone(tx, zoneId, cityId);
      return zoneDto(row!);
    });
  }

  async listPublic(cityId: string) {
    const rows = (await this.client.unsafe(
      `select ${ZONE_COLUMNS}
       from zones z
       where z.city_id = $1::uuid
         and z.status = 'ACTIVE'
         and z.archived_at is null
       order by z.name asc, z.id asc`,
      [cityId],
    )) as ZoneRow[];
    return { data: rows.map((row) => publicZoneDto(row)) };
  }

  async resolvePublic(
    cityId: string,
    longitudeRaw: unknown,
    latitudeRaw: unknown,
  ) {
    const longitude = parseCoordinate(longitudeRaw, "longitude");
    const latitude = parseCoordinate(latitudeRaw, "latitude");
    const rows = (await this.client.unsafe(
      `select ${ZONE_COLUMNS}
       from zones z
       where z.city_id = $1::uuid
         and z.status = 'ACTIVE'
         and z.archived_at is null
         and ST_Covers(
           z.boundary,
           ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)
         )
       order by z.created_at asc, z.id asc
       limit 1`,
      [cityId, longitude, latitude],
    )) as ZoneRow[];
    const row = rows[0];
    if (!row) throw new AppError(404, "ZONE_NOT_FOUND", "Zone not found");
    return publicZoneDto(row);
  }
}
