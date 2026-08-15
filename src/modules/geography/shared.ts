import { t } from "elysia";
import { AppError } from "../../errors/app-error";
import type { AuthModule } from "../auth/auth-module";
import type { AuthenticationContext } from "../auth/core/context";
import {
  bearer,
  errorResponse,
  requestIdOf,
  standardErrors,
} from "../auth/http/shared";

export type Page = { page: number; limit: number };

export const pageOf = (page = 1, limit = 20): Page => ({
  page: Math.max(1, Math.min(10_000, page)),
  limit: Math.max(1, Math.min(100, limit)),
});

export const clean = (value: string, field: string) => {
  const result = value.trim();
  if (!result) throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  return result;
};

export const dateValue = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : value == null
      ? null
      : new Date(String(value)).toISOString();

export const numberValue = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n))
    throw new AppError(500, "INTERNAL_ERROR", "Invalid coordinate value");
  return n;
};

export const numberOrNull = (value: unknown): number | null => {
  if (value == null) return null;
  return numberValue(value);
};

export const dateSchema = t.String({ format: "date-time" });

export const pageQuery = {
  page: t.Optional(t.Numeric({ minimum: 1, examples: [1] })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, examples: [20] })),
  search: t.Optional(t.String({ maxLength: 100, examples: ["baghdad"] })),
  status: t.Optional(t.String({ maxLength: 20, examples: ["ACTIVE"] })),
};

export const paginated = (item: any) =>
  t.Object({
    data: t.Array(item),
    page: t.Number(),
    limit: t.Number(),
    total: t.Number(),
  });

export const dashboardListErrors = { ...standardErrors };
export const dashboardDetailErrors = { ...standardErrors, 404: errorResponse };
export const dashboardMutationErrors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
};

export const authIdentity = (
  auth: AuthModule,
  request: Request,
  context: AuthenticationContext,
  requestId: string,
) => auth.sessions.authenticate(bearer(request), context, requestId);

export { requestIdOf };

export const assertAllowedBodyKeys = (body: unknown, allowed: Set<string>) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowed.has(key))
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
};
