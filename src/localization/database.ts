import type { SQL } from "bun";
import { AppError } from "../errors/app-error";
import { normalizeLocale, validateTranslations, type LocalizedTranslation, type SupportedLocale } from "./localization";

export async function activeLocales(db: SQL): Promise<SupportedLocale[]> {
  return db<SupportedLocale[]>`select code, fallback_locale as "fallbackLocale", is_active as "isActive", is_default as "isDefault", required_for_new_content as "requiredForNewContent" from supported_locales`;
}

export function translationsInput(value: unknown, options: { required: boolean; descriptions?: boolean }): LocalizedTranslation[] | undefined {
  if (value === undefined) {
    if (options.required) throw new AppError(422, "REQUIRED_TRANSLATION_MISSING", "Translations are required", undefined, undefined, { fields: [{ field: "translations", code: "REQUIRED_TRANSLATION_MISSING", message: "Translations are required" }] });
    return undefined;
  }
  if (!Array.isArray(value)) throw new AppError(422, "INVALID_TRANSLATION", "Invalid translations", undefined, undefined, { fields: [{ field: "translations", code: "INVALID_TRANSLATION", message: "Translations must be an array" }] });
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new AppError(422, "INVALID_TRANSLATION", "Invalid translation", undefined, undefined, { fields: [{ field: `translations[${index}]`, code: "INVALID_TRANSLATION", message: "Translation must be an object" }] });
    const input = entry as Record<string, unknown>;
    const locale = typeof input.locale === "string" ? normalizeLocale(input.locale) : null;
    const base = { locale: locale ?? String(input.locale ?? ""), name: typeof input.name === "string" ? input.name.trim() : "" };
    return input.description === undefined ? base : { ...base, description: input.description === null ? null : typeof input.description === "string" ? input.description.trim() : "" };
  });
}

export async function validateTranslationInput(db: SQL, translations: LocalizedTranslation[], options: { requireAllRequired: boolean; descriptions?: boolean; maxName?: number; maxDescription?: number }) {
  const validationOptions = options.descriptions === undefined ? { requireAllRequired: options.requireAllRequired } : { requireAllRequired: options.requireAllRequired, allowDescription: options.descriptions };
  const errors = validateTranslations(translations, await activeLocales(db), validationOptions);
  translations.forEach((translation, index) => {
    if (options.maxName && translation.name.length > options.maxName) errors.push({ path: `translations[${index}].name`, code: "INVALID_TRANSLATION", message: "Name is too long" });
    if (options.maxDescription && translation.description && translation.description.length > options.maxDescription) errors.push({ path: `translations[${index}].description`, code: "INVALID_TRANSLATION", message: "Description is too long" });
  });
  if (errors.length) throw new AppError(422, errors[0]!.code, "Invalid translations", undefined, undefined, { fields: errors.map((error) => ({ field: error.path, code: error.code, message: error.message })) });
}

export async function upsertNameTranslations(db: SQL, table: "city_translations" | "main_category_translations" | "subcategory_translations" | "zone_translations" | "store_category_translations" | "product_size_translations" | "modifier_group_translations" | "modifier_option_translations", ownerColumn: string, ownerId: string, scope: Record<string, string>, translations: LocalizedTranslation[]) {
  for (const translation of translations) {
    const columns = [ownerColumn, ...Object.keys(scope), "locale", "name"];
    const values = [ownerId, ...Object.values(scope), translation.locale, translation.name];
    const updates = "name=excluded.name,updated_at=now()";
    await db.unsafe(`insert into ${table} (${columns.join(",")}) values (${columns.map((_, index) => `$${index + 1}`).join(",")}) on conflict (${ownerColumn},locale) do update set ${updates}`, values);
  }
}
