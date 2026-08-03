import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  parseCoordinate,
  parseGeoJsonPolygon,
} from "../../src/modules/geography/zone/geometry";

describe("zone geometry structural validation", () => {
  test("accepts a closed Polygon", () => {
    const polygon = parseGeoJsonPolygon({
      type: "Polygon",
      coordinates: [
        [
          [44.35, 33.3],
          [44.4, 33.3],
          [44.4, 33.35],
          [44.35, 33.35],
          [44.35, 33.3],
        ],
      ],
    });
    expect(polygon.type).toBe("Polygon");
  });

  test("rejects non-polygon types and open rings", () => {
    expect(() =>
      parseGeoJsonPolygon({ type: "Point", coordinates: [1, 2] }),
    ).toThrow(AppError);
    expect(() =>
      parseGeoJsonPolygon({
        type: "Polygon",
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 2],
          ],
        ],
      }),
    ).toThrow(AppError);
  });

  test("validates coordinate ranges", () => {
    expect(parseCoordinate(44.1, "longitude")).toBe(44.1);
    expect(() => parseCoordinate(200, "longitude")).toThrow(AppError);
    expect(() => parseCoordinate(-100, "latitude")).toThrow(AppError);
  });
});
