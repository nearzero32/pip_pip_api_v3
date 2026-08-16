import { t } from "elysia";
import { AppError } from "../../errors/app-error";

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
      default: "desc",
      description: "Sort direction. Default desc unless the resource uses displayOrder.",
    }),
  ),
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
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  if (
    !Number.isInteger(resolvedLimit) ||
    resolvedLimit < 1 ||
    resolvedLimit > DASHBOARD_LIST_MAX_LIMIT
  ) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
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

export function parseOptionalSearch(value?: string | null): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > DASHBOARD_SEARCH_MAX_LENGTH) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
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
): DashboardSortOrder {
  if (value == null || value === "") return fallback;
  if (value === "asc" || value === "desc") return value;
  throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
}

export function parseAllowlistedSort<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value == null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOptionalUuid(value?: string | null): string | null {
  const trimmed = value?.trim() || null;
  if (!trimmed) return null;
  if (!UUID_RE.test(trimmed)) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  return trimmed;
}

/**
 * Date-only values are Asia/Baghdad calendar days (UTC+3, no DST).
 * `from` is inclusive start-of-day; `to` is inclusive end-of-day.
 * Offset date-times are respected as sent.
 */
export function parseDashboardInstant(
  value: string,
  bound: "from" | "to",
): Date {
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}${bound === "from" ? "T00:00:00.000+03:00" : "T23:59:59.999+03:00"}`
    : trimmed;
  const parsed = new Date(dateOnly);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  return parsed;
}

export function parseOptionalDateRange(input: {
  from?: string | undefined;
  to?: string | undefined;
}): { from: Date | null; to: Date | null } {
  const from = input.from?.trim()
    ? parseDashboardInstant(input.from, "from")
    : null;
  const to = input.to?.trim() ? parseDashboardInstant(input.to, "to") : null;
  if (from && to && from.getTime() > to.getTime()) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
  return { from, to };
}

export const sqlDir = (order: DashboardSortOrder) =>
  order === "asc" ? "asc" : "desc";
