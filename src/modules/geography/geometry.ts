import { AppError } from "../../errors/app-error";

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };
export type GeoJsonMultiPolygon = { type: "MultiPolygon"; coordinates: number[][][][] };
export type GeoJsonPolygonal = GeoJsonPolygon | GeoJsonMultiPolygon;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Cheap structural guard only; PostGIS remains the authority for topology. */
export function parseGeoJsonPolygonal(input: unknown, code: string, allowMulti = true): GeoJsonPolygonal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, code, "Boundary is invalid");
  const value = input as Record<string, unknown>;
  if ((value.type !== "Polygon" && (!allowMulti || value.type !== "MultiPolygon")) || "crs" in value) throw new AppError(400, code, "Boundary is invalid");
  const polygons = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (!Array.isArray(polygons) || !polygons.length) throw new AppError(400, code, "Boundary is invalid");
  const output: number[][][][] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw new AppError(400, code, "Boundary is invalid");
    const rings: number[][][] = [];
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) throw new AppError(400, code, "Boundary is invalid");
      const positions: number[][] = [];
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !finite(point[0]) || !finite(point[1]) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) throw new AppError(400, code, "Boundary is invalid");
        positions.push([point[0], point[1]]);
      }
      const first = positions[0]!, last = positions.at(-1)!;
      if (first[0] !== last[0] || first[1] !== last[1]) throw new AppError(400, code, "Boundary is invalid");
      rings.push(positions);
    }
    output.push(rings);
  }
  return value.type === "Polygon" ? { type: "Polygon", coordinates: output[0]! } : { type: "MultiPolygon", coordinates: output };
}

export const parseGeoJsonPolygon = (input: unknown): GeoJsonPolygon =>
  parseGeoJsonPolygonal(input, "INVALID_ZONE_BOUNDARY", false) as GeoJsonPolygon;

export function parseCoordinate(value: unknown, kind: "longitude" | "latitude"): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || (kind === "longitude" ? n < -180 || n > 180 : n < -90 || n > 90)) throw new AppError(400, "INVALID_ZONE_INPUT", `Invalid ${kind}`);
  return n;
}
