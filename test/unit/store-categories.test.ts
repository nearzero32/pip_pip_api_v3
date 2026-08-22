import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "../../src/modules/catalog/arabic-name";
import { storeCategoryDto } from "../../src/modules/catalog/store-category.service";

describe("Store Categories unit", () => {
  test("reuses Arabic name and displayOrder validation", () => {
    expect(normalizeArabicCategoryName("مشروبات")).toBe("مشروبات");
    expect(() => normalizeArabicCategoryName("Drinks")).toThrow(AppError);
    expect(validateDisplayOrder(3)).toBe(3);
    expect(() => validateDisplayOrder(-1)).toThrow(AppError);
  });

  test("maps flat dashboard DTO with nullable parent", () => {
    const dto = storeCategoryDto({
      id: "11111111-1111-4111-8111-111111111111",
      store_id: "22222222-2222-4222-8222-222222222222",
      city_id: "33333333-3333-4333-8333-333333333333",
      parent_category_id: null,
      name: "برغر",
      status: "ACTIVE",
      display_order: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      archived_at: null,
    });
    expect(dto).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
      parentCategoryId: null,
      name: "برغر",
      translations: [{ locale: "ar", name: "برغر" }],
      status: "ACTIVE",
      displayOrder: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: null,
    });
  });

  test("maps subcategory DTO with parentCategoryId", () => {
    const dto = storeCategoryDto({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      store_id: "22222222-2222-4222-8222-222222222222",
      city_id: "33333333-3333-4333-8333-333333333333",
      parent_category_id: "11111111-1111-4111-8111-111111111111",
      name: "عصائر",
      status: "INACTIVE",
      display_order: 2,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      archived_at: null,
    });
    expect(dto.parentCategoryId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(dto.status).toBe("INACTIVE");
  });
});
