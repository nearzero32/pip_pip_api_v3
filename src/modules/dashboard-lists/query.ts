import { t } from "elysia";
import {
  invalidFormatField,
  invalidRangeFields,
  invalidTypeField,
  invalidValueField,
  requestValidationError,
  tooLargeField,
  tooLongField,
  tooSmallField,
} from "../../errors/request-validation-error";

export const DASHBOARD_LIST_DEFAULT_PAGE = 1;
export const DASHBOARD_LIST_DEFAULT_LIMIT = 25;
export const DASHBOARD_LIST_MAX_LIMIT = 100;
export const DASHBOARD_SEARCH_MAX_LENGTH = 100;

export type DashboardSortOrder = "asc" | "desc";

export type DashboardPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type DashboardListResult<T> = {
  data: T[];
  pagination: DashboardPagination;
};

export const dashboardListQuery = {
  search: t.Optional(
    t.String({
      maxLength: DASHBOARD_SEARCH_MAX_LENGTH,
      description: "Trimmed case-insensitive contains search. Empty after trim is ignored.",
      examples: ["محمد"],
    }),
  ),
  page: t.Optional(
    t.Integer({
      minimum: 1,
      default: DASHBOARD_LIST_DEFAULT_PAGE,
      description: "1-based page. Pages past the last result return data: [].",
      examples: [1],
    }),
  ),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: DASHBOARD_LIST_MAX_LIMIT,
      default: DASHBOARD_LIST_DEFAULT_LIMIT,
      description: "Page size. Ignored by Excel export endpoints.",
      examples: [25],
    }),
  ),
  sortBy: t.Optional(
    t.String({
      maxLength: 40,
      description: "Allowlisted sort field for this resource.",
      examples: ["createdAt"],
    }),
  ),
  sortOrder: t.Optional(
    t.Union([t.Literal("asc"), t.Literal("desc")], {
      description: "Sort direction. Resource-specific default when omitted.",
    }),
  ),
};

/** Excel export query: same search/sort as the list, without pagination. */
export const dashboardExportQuery = {
  search: dashboardListQuery.search,
  sortBy: dashboardListQuery.sortBy,
  sortOrder: dashboardListQuery.sortOrder,
};

export const dashboardPaginationSchema = t.Object({
  page: t.Integer({ minimum: 1 }),
  limit: t.Integer({ minimum: 1 }),
  total: t.Integer({ minimum: 0 }),
  totalPages: t.Integer({ minimum: 0 }),
});

export const dashboardPaginated = (item: ReturnType<typeof t.Object> | ReturnType<typeof t.Any>) =>
  t.Object({
    data: t.Array(item),
    pagination: dashboardPaginationSchema,
  });

export function dashboardPageOf(page?: number, limit?: number) {
  const resolvedPage = page ?? DASHBOARD_LIST_DEFAULT_PAGE;
  const resolvedLimit = limit ?? DASHBOARD_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    throw requestValidationError({
      location: "query",
      fields: [tooSmallField("page", 1)],
    });
  }
  if (
    !Number.isInteger(resolvedLimit) ||
    resolvedLimit < 1 ||
    resolvedLimit > DASHBOARD_LIST_MAX_LIMIT
  ) {
    throw requestValidationError({
      location: "query",
      fields:
        !Number.isInteger(resolvedLimit) || resolvedLimit < 1
          ? [tooSmallField("limit", 1)]
          : [tooLargeField("limit", DASHBOARD_LIST_MAX_LIMIT)],
    });
  }
  return { page: resolvedPage, limit: resolvedLimit };
}

export function dashboardListResult<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): DashboardListResult<T> {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}

export function toDashboardList<T>(result: {
  data: T[];
  page: number;
  limit: number;
  total: number;
}): DashboardListResult<T> {
  return dashboardListResult(result.data, result.page, result.limit, result.total);
}

export function toFlatPage<T>(result: DashboardListResult<T>) {
  return {
    data: result.data,
    page: result.pagination.page,
    limit: result.pagination.limit,
    total: result.pagination.total,
  };
}

export function parseOptionalSearch(
  value?: string | null,
  field = "search",
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw requestValidationError({
      location: "query",
      fields: [invalidTypeField(field)],
    });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > DASHBOARD_SEARCH_MAX_LENGTH) {
    throw requestValidationError({
      location: "query",
      fields: [tooLongField(field, DASHBOARD_SEARCH_MAX_LENGTH)],
    });
  }
  return trimmed;
}

/** Escape ILIKE wildcards so user input is matched literally. */
export function likeContains(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function parseSortOrder(
  value?: string,
  fallback: DashboardSortOrder = "desc",
  field = "sortOrder",
): DashboardSortOrder {
  if (value == null || value === "") return fallback;
  if (value === "asc" || value === "desc") return value;
  throw requestValidationError({
    location: "query",
    fields: [invalidValueField(field)],
  });
}

export function parseAllowlistedSort<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  field = "sortBy",
): T {
  if (value == null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw requestValidationError({
    location: "query",
    fields: [invalidValueField(field)],
  });
}

/** Optional enum/allowlist filter (e.g. status). */
export function parseOptionalAllowlisted<T extends string>(
  value: string | undefined | null,
  allowed: readonly T[],
  field: string,
): T | null {
  const trimmed = value?.trim() || null;
  if (!trimmed) return null;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  throw requestValidationError({
    location: "query",
    fields: [invalidValueField(field)],
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOptionalBool(
  value: string | boolean | null | undefined,
  field: string,
): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw requestValidationError({
    location: "query",
    fields: [invalidValueField(field)],
  });
}

export function parseOptionalInt(
  value: string | number | null | undefined,
  field: string,
  bounds?: { min?: number; max?: number },
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw requestValidationError({
      location: "query",
      fields: [invalidTypeField(field)],
    });
  }
  if (bounds?.min != null && n < bounds.min) {
    throw requestValidationError({
      location: "query",
      fields: [tooSmallField(field, bounds.min)],
    });
  }
  if (bounds?.max != null && n > bounds.max) {
    throw requestValidationError({
      location: "query",
      fields: [tooLargeField(field, bounds.max)],
    });
  }
  return n;
}

export function parseOptionalIntRange(
  min: string | number | null | undefined,
  max: string | number | null | undefined,
  minField: string,
  maxField: string,
  bounds?: { min?: number; max?: number },
): { min: number | null; max: number | null } {
  const lo = parseOptionalInt(min, minField, bounds);
  const hi = parseOptionalInt(max, maxField, bounds);
  if (lo != null && hi != null && lo > hi) {
    throw requestValidationError({
      location: "query",
      fields: invalidRangeFields(minField, maxField),
    });
  }
  return { min: lo, max: hi };
}

export function searchUuid(search: string | null): string | null {
  if (!search) return null;
  return UUID_RE.test(search) ? search : null;
}

export function parseOptionalUuid(
  value: string | null | undefined,
  field: string,
): string | null {
  const trimmed = value?.trim() || null;
  if (!trimmed) return null;
  if (!UUID_RE.test(trimmed)) {
    throw requestValidationError({
      location: "query",
      fields: [invalidFormatField(field, "a valid UUID")],
    });
  }
  return trimmed;
}

/** Fixed offset; Asia/Baghdad has no DST. Never use the host timezone. */
export const DASHBOARD_CALENDAR_OFFSET = "+03:00";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Next Gregorian calendar day from a YYYY-MM-DD string (UTC date arithmetic). */
export function nextCalendarDate(yyyyMmDd: string): string {
  const [year, month, day] = yyyyMmDd.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/**
 * Instant bounds for list/export date filters. Apply in SQL as half-open
 * `column >= from AND column < to` (never `<= 23:59:59.999`).
 *
 * Date-only (`YYYY-MM-DD`): Asia/Baghdad calendar days.
 * - from → start of that day (`T00:00:00.000+03:00`), inclusive
 * - to → start of the next calendar day, exclusive
 *
 * Offset / UTC date-times: the sent instant is used as-is.
 * - from is inclusive; to is exclusive ([from, to)).
 */
export function parseDashboardInstant(
  value: string,
  bound: "from" | "to",
  field: string,
): Date {
  const trimmed = value.trim();
  const instant = DATE_ONLY_RE.test(trimmed)
    ? `${bound === "from" ? trimmed : nextCalendarDate(trimmed)}T00:00:00.000${DASHBOARD_CALENDAR_OFFSET}`
    : trimmed;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) {
    throw requestValidationError({
      location: "query",
      fields: [invalidFormatField(field, "a valid date or date-time")],
    });
  }
  return parsed;
}

export function parseOptionalDateRange(input: {
  from?: string | undefined;
  to?: string | undefined;
  fromField: string;
  toField: string;
}): { from: Date | null; to: Date | null } {
  const from = input.from?.trim()
    ? parseDashboardInstant(input.from, "from", input.fromField)
    : null;
  const to = input.to?.trim()
    ? parseDashboardInstant(input.to, "to", input.toField)
    : null;
  if (from && to && from.getTime() > to.getTime()) {
    throw requestValidationError({
      location: "query",
      fields: invalidRangeFields(input.fromField, input.toField),
    });
  }
  return { from, to };
}

export const sqlDir = (order: DashboardSortOrder) =>
  order === "asc" ? "asc" : "desc";
