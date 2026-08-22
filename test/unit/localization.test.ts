import { describe, expect, test } from "bun:test";
import {
  fallbackChain,
  negotiateLocale,
  normalizeLocale,
  parseAcceptLanguage,
  resolveLocalizedText,
  validateTranslations,
  type SupportedLocale,
} from "../../src/localization/localization";

const locales: SupportedLocale[] = [
  { code: "ar", fallbackLocale: null, isActive: true, isDefault: true, requiredForNewContent: true },
  { code: "en", fallbackLocale: "ar", isActive: true, isDefault: false, requiredForNewContent: true },
];

describe("localization foundation", () => {
  test("normalizes BCP-47 tags and parses q-values", () => {
    expect(normalizeLocale(" EN_us ")).toBe("en-us");
    expect(normalizeLocale("not a locale")).toBeNull();
    expect(parseAcceptLanguage("fr;q=0.3, en-US;q=0.9, ar;q=1")).toEqual(["ar", "en-us", "fr"]);
  });

  test("negotiates exact, base-language and default locales", () => {
    expect(negotiateLocale(parseAcceptLanguage("en-US,en;q=0.8"), locales)).toBe("en");
    expect(negotiateLocale(parseAcceptLanguage("ckb"), locales)).toBe("ar");
  });

  test("resolves fallback and protects against fallback cycles", () => {
    expect(resolveLocalizedText({ ar: "مطاعم" }, "en", locales)).toEqual({ value: "مطاعم", resolvedLocale: "ar" });
    expect(() => fallbackChain("ar", [
      { code: "ar", fallbackLocale: "en", isActive: true, isDefault: true, requiredForNewContent: true },
      { code: "en", fallbackLocale: "ar", isActive: true, isDefault: false, requiredForNewContent: true },
    ])).toThrow("Locale fallback cycle");
  });

  test("validates required, duplicate, unknown and inactive translations", () => {
    expect(validateTranslations([{ locale: "ar", name: "مطاعم" }, { locale: "ar", name: "مكرر" }], locales, { requireAllRequired: true }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_LOCALE" }),
        expect.objectContaining({ code: "REQUIRED_TRANSLATION_MISSING" }),
      ]));
    expect(validateTranslations([{ locale: "ckb", name: "" }], locales)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOCALE_NOT_SUPPORTED" }),
      expect.objectContaining({ code: "INVALID_TRANSLATION" }),
    ]));
  });
});
