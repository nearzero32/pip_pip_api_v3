import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  MAIN_CATEGORY_NAME_MAX_LENGTH,
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "../../src/modules/catalog/arabic-name";
import {
  mainCategoryDto,
  publicMainCategoryDto,
} from "../../src/modules/catalog/main-category.service";

const sampleRow = {
  id: "11111111-1111-4111-8111-111111111111",
  city_id: "22222222-2222-4222-8222-222222222222",
  name: "مطاعم",
  image_asset_id: "33333333-3333-4333-8333-333333333333",
  status: "ACTIVE" as const,
  display_order: 2,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  archived_at: null,
  asset_object_key: "cities/x/categories/y/original.png",
  asset_visibility: "PUBLIC" as const,
  asset_status: "READY",
};

describe("M3-C1 Main Category unit", () => {
  test("accepts valid Arabic names", () => {
    expect(normalizeArabicCategoryName("مطاعم")).toBe("مطاعم");
    expect(normalizeArabicCategoryName("زهور وهدايا")).toBe("زهور وهدايا");
    expect(normalizeArabicCategoryName("صيدليات-24")).toBe("صيدليات-24");
  });

  test("trims whitespace", () => {
    expect(normalizeArabicCategoryName("  حلويات  ")).toBe("حلويات");
  });

  test("rejects empty and whitespace-only names", () => {
    expect(() => normalizeArabicCategoryName("")).toThrow(AppError);
    expect(() => normalizeArabicCategoryName("   ")).toThrow(AppError);
  });

  test("rejects Latin letters", () => {
    expect(() => normalizeArabicCategoryName("Restaurants")).toThrow(AppError);
    expect(() => normalizeArabicCategoryName("مطاعمABC")).toThrow(AppError);
  });

  test("rejects names over maximum length", () => {
    const tooLong = "م".repeat(MAIN_CATEGORY_NAME_MAX_LENGTH + 1);
    expect(() => normalizeArabicCategoryName(tooLong)).toThrow(AppError);
    expect(
      normalizeArabicCategoryName("م".repeat(MAIN_CATEGORY_NAME_MAX_LENGTH)),
    ).toHaveLength(MAIN_CATEGORY_NAME_MAX_LENGTH);
  });

  test("rejects negative display order", () => {
    expect(() => validateDisplayOrder(-1)).toThrow(AppError);
  });

  test("rejects non-integer display order", () => {
    expect(() => validateDisplayOrder(1.5)).toThrow(AppError);
    expect(() => validateDisplayOrder("1")).toThrow(AppError);
  });

  test("maps dashboard DTO with public image URL", () => {
    const dto = mainCategoryDto(sampleRow, "https://media.test.example.com");
    expect(dto).toEqual({
      id: sampleRow.id,
      name: "مطاعم",
      status: "ACTIVE",
      displayOrder: 2,
      image: {
        assetId: sampleRow.image_asset_id,
        url: "https://media.test.example.com/cities/x/categories/y/original.png",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: null,
    });
    expect(JSON.stringify(dto)).not.toContain("object_key");
    expect(JSON.stringify(dto)).not.toContain("objectKey");
  });

  test("public DTO never exposes internal media fields", () => {
    const dto = publicMainCategoryDto(
      sampleRow,
      "https://media.test.example.com",
    );
    expect(dto).toEqual({
      id: sampleRow.id,
      name: "مطاعم",
      displayOrder: 2,
      image: {
        assetId: sampleRow.image_asset_id,
        url: "https://media.test.example.com/cities/x/categories/y/original.png",
      },
    });
    const text = JSON.stringify(dto);
    for (const forbidden of [
      "objectKey",
      "object_key",
      "etag",
      "deleteLeaseUntil",
      "deleteAttempts",
      "bucket",
      "status",
      "archivedAt",
      "createdAt",
      "cityId",
    ]) {
      expect(text.includes(forbidden)).toBe(false);
    }
  });

  test("public image URL mapping returns null when asset is not PUBLIC READY", () => {
    const dto = publicMainCategoryDto(
      { ...sampleRow, asset_visibility: "PRIVATE" },
      "https://media.test.example.com",
    );
    expect(dto.image.url).toBeNull();
  });
});
