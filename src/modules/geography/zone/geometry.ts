import { AppError } from "../../../errors/app-error";

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Structural GeoJSON Polygon validation before PostGIS authority checks. */
export function parseGeoJsonPolygon(input: unknown): GeoJsonPolygon {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
  }
  const record = input as Record<string, unknown>;
  if (record.type !== "Polygon") {
    throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
  }
  if (!Array.isArray(record.coordinates) || record.coordinates.length === 0) {
    throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
  }
  if ("crs" in record) {
    throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
  }

  const rings: number[][][] = [];
  for (const ring of record.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
    }
    const positions: number[][] = [];
    for (const position of ring) {
      if (!Array.isArray(position) || position.length < 2 || position.length > 2) {
        throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
      }
      const longitude = position[0];
      const latitude = position[1];
      if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude)) {
        throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
      }
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
      }
      positions.push([longitude, latitude]);
    }
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new AppError(400, "INVALID_ZONE_BOUNDARY", "Zone boundary is invalid");
    }
    rings.push(positions);
  }

  return { type: "Polygon", coordinates: rings };
}

export function parseCoordinate(
  value: unknown,
  kind: "longitude" | "latitude",
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError(400, "INVALID_ZONE_INPUT", `Invalid ${kind}`);
  }
  if (kind === "longitude" && (n < -180 || n > 180)) {
    throw new AppError(400, "INVALID_ZONE_INPUT", `Invalid ${kind}`);
  }
  if (kind === "latitude" && (n < -90 || n > 90)) {
    throw new AppError(400, "INVALID_ZONE_INPUT", `Invalid ${kind}`);
  }
  return n;
}
