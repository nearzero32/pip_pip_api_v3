/**
 * Feature-neutral localization primitives.  Resource modules use these types
 * for their public contracts; persistence is deliberately kept in dedicated
 * translation tables rather than a polymorphic catch-all table.
 */

export const DEFAULT_LOCALE = "ar";

export type LocalizedTranslation = {
  locale: string;
  name: string;
  description?: string | null;
};

export type LocalizedTextSnapshot = Record<string, string>;

export type SupportedLocale = {
  code: string;
  fallbackLocale: string | null;
  isActive: boolean;
  isDefault: boolean;
  requiredForNewContent: boolean;
};

const localePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export function normalizeLocale(value: string): string | null {
  const normalized = value.trim().replace(/_/g, "-").toLowerCase();
  return localePattern.test(normalized) ? normalized : null;
}

export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [rawTag, ...parameters] = part.trim().split(";");
      const tag = normalizeLocale(rawTag ?? "");
      const qParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const q = qParameter ? Number(qParameter.trim().slice(2)) : 1;
      return { tag, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
    })
    .filter((item): item is { tag: string; q: number; index: number } => item.tag !== null && item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((item) => item.tag);
}

/** Public/mobile links may explicitly select the response language with `?lang=`. */
export function parseRequestLocales(request: Request | undefined): string[] {
  if (!request) return [];
  const lang = new URL(request.url).searchParams.get("lang");
  const explicit = lang ? normalizeLocale(lang) : null;
  return explicit ? [explicit] : parseAcceptLanguage(request.headers.get("accept-language"));
}

/** Exact locale first, then base language; fallback is resolved separately. */
export function negotiateLocale(requested: string[], supported: SupportedLocale[]): string {
  const active = supported.filter((locale) => locale.isActive);
  const defaultLocale = active.find((locale) => locale.isDefault)?.code ?? DEFAULT_LOCALE;
  for (const tag of requested) {
    if (active.some((locale) => locale.code === tag)) return tag;
    const base = tag.split("-")[0]!;
    const baseMatch = active.find((locale) => locale.code === base || locale.code.startsWith(`${base}-`));
    if (baseMatch) return baseMatch.code;
  }
  return defaultLocale;
}

export function fallbackChain(start: string, supported: SupportedLocale[]): string[] {
  const byCode = new Map(supported.map((locale) => [locale.code, locale]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
  while (current) {
    if (seen.has(current)) throw new Error("Locale fallback cycle");
    seen.add(current);
    chain.push(current);
    current = byCode.get(current)?.fallbackLocale ?? null;
  }
  const fallback = supported.find((locale) => locale.isDefault)?.code ?? DEFAULT_LOCALE;
  if (!seen.has(fallback)) chain.push(fallback);
  return chain;
}

export function resolveLocalizedText(
  values: LocalizedTextSnapshot | null | undefined,
  requestedLocale: string,
  supported: SupportedLocale[],
): { value: string | null; resolvedLocale: string | null } {
  if (!values) return { value: null, resolvedLocale: null };
  for (const locale of fallbackChain(requestedLocale, supported)) {
    const value = values[locale];
    if (typeof value === "string" && value.trim()) return { value, resolvedLocale: locale };
  }
  return { value: null, resolvedLocale: null };
}

export function validateTranslations(
  translations: readonly LocalizedTranslation[],
  locales: SupportedLocale[],
  options: { requireAllRequired?: boolean; allowDescription?: boolean } = {},
): Array<{ path: string; code: string; message: string }> {
  const errors: Array<{ path: string; code: string; message: string }> = [];
  const seen = new Set<string>();
  translations.forEach((translation, index) => {
    const locale = normalizeLocale(translation.locale);
    if (!locale) {
      errors.push({ path: `translations[${index}].locale`, code: "LOCALE_NOT_SUPPORTED", message: "Unsupported locale" });
      return;
    }
    if (seen.has(locale)) errors.push({ path: `translations[${index}].locale`, code: "DUPLICATE_LOCALE", message: "Duplicate locale" });
    seen.add(locale);
    const configured = locales.find((item) => item.code === locale);
    if (!configured) errors.push({ path: `translations[${index}].locale`, code: "LOCALE_NOT_SUPPORTED", message: "Unsupported locale" });
    else if (!configured.isActive) errors.push({ path: `translations[${index}].locale`, code: "LOCALE_INACTIVE", message: "Locale is inactive" });
    if (!translation.name?.trim()) errors.push({ path: `translations[${index}].name`, code: "INVALID_TRANSLATION", message: "Name is required" });
    if (!options.allowDescription && translation.description !== undefined) errors.push({ path: `translations[${index}].description`, code: "INVALID_TRANSLATION", message: "Description is not supported" });
  });
  if (options.requireAllRequired) {
    for (const locale of locales.filter((item) => item.isActive && item.requiredForNewContent)) {
      if (!seen.has(locale.code)) errors.push({ path: "translations", code: "REQUIRED_TRANSLATION_MISSING", message: `Missing required ${locale.code} translation` });
    }
  }
  return errors;
}
