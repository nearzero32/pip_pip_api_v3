import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  MAIN_CATEGORY_NAME_MAX_LENGTH,
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "../../src/modules/catalog/arabic-name";
import {
  assertAtLeastOnePatchField,
  assertPatchStatusNotArchived,
  parseImagePatch,
  parseOptionalCreateImage,
} from "../../src/modules/catalog/subcategory-patch";
import {
  publicSubcategoryDto,
  subcategoryDto,
} from "../../src/modules/catalog/subcategory.service";

const sampleRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  city_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  main_category_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  main_category_name: "مطاعم",
  name: "برغر",
  image_asset_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as string | null,
  status: "ACTIVE" as const,
  display_order: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  archived_at: null,
  asset_object_key: "cities/x/categories/y/original.png" as string | null,
  asset_visibility: "PUBLIC" as "PUBLIC" | "PRIVATE" | null,
  asset_status: "READY" as string | null,
};

describe("M3-C2 Subcategory unit", () => {
  test("accepts valid Arabic names", () => {
    expect(normalizeArabicCategoryName("برغر")).toBe("برغر");
    expect(normalizeArabicCategoryName("مأكولات بحرية")).toBe("مأكولات بحرية");
  });

  test("trims whitespace", () => {
    expect(normalizeArabicCategoryName("  بيتزا  ")).toBe("بيتزا");
  });

  test("rejects empty and Latin names", () => {
    expect(() => normalizeArabicCategoryName("")).toThrow(AppError);
    expect(() => normalizeArabicCategoryName("Burger")).toThrow(AppError);
  });

  test("rejects over-length names and invalid display orders", () => {
    expect(() =>
      normalizeArabicCategoryName("م".repeat(MAIN_CATEGORY_NAME_MAX_LENGTH + 1)),
    ).toThrow(AppError);
    expect(() => validateDisplayOrder(-1)).toThrow(AppError);
    expect(() => validateDisplayOrder(1.5)).toThrow(AppError);
  });

  test("create image parsing: omit ok, null rejected", () => {
    expect(parseOptionalCreateImage({ name: "برغر" })).toBeNull();
    expect(
      parseOptionalCreateImage({
        imageAssetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(() => parseOptionalCreateImage({ imageAssetId: null })).toThrow(
      AppError,
    );
  });

  test("update image parsing distinguishes omit, null, and UUID", () => {
    expect(parseImagePatch({})).toEqual({ kind: "omit" });
    expect(parseImagePatch({ imageAssetId: null })).toEqual({ kind: "clear" });
    expect(
      parseImagePatch({
        imageAssetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ).toEqual({
      kind: "set",
      assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
  });

  test("PATCH rejects empty body and ARCHIVED status", () => {
    expect(() => assertAtLeastOnePatchField({}, ["name"])).toThrow(AppError);
    expect(() => assertPatchStatusNotArchived("ARCHIVED")).toThrow(AppError);
    expect(() => assertPatchStatusNotArchived("ACTIVE")).not.toThrow();
  });

  test("dashboard DTO returns image null without asset", () => {
    const dto = subcategoryDto(
      { ...sampleRow, image_asset_id: null, asset_object_key: null },
      "https://media.test.example.com",
    );
    expect(dto.image).toBeNull();
    expect(dto.mainCategory).toEqual({
      id: sampleRow.main_category_id,
      name: "مطاعم",
    });
  });

  test("public DTO with image uses public URL and hides internals", () => {
    const dto = publicSubcategoryDto(
      sampleRow,
      "https://media.test.example.com",
    );
    expect(dto.image).toEqual({
      assetId: sampleRow.image_asset_id,
      url: "https://media.test.example.com/cities/x/categories/y/original.png",
    });
    const text = JSON.stringify(dto);
    for (const forbidden of [
      "objectKey",
      "object_key",
      "etag",
      "bucket",
      "status",
      "archivedAt",
      "mainCategory",
    ]) {
      expect(text.includes(forbidden)).toBe(false);
    }
  });

  test("public DTO returns image null when absent", () => {
    const dto = publicSubcategoryDto(
      { ...sampleRow, image_asset_id: null, asset_object_key: null },
      "https://media.test.example.com",
    );
    expect(dto.image).toBeNull();
  });
});
