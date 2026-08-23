import { Elysia, t } from "elysia";

import { AppError } from "../../../../errors/app-error";
import {
  consumeInvalidBodyShape,
  consumeUnknownBodyFields,
  registerInvalidBodyShape,
  registerUnknownBodyFields,
} from "../../../../errors/unknown-body-fields";
import type { AuthModule } from "../../auth-module";
import { dashboardContext } from "../../core/context";
import {
  bearer,
  errorResponse,
  parseAuthenticationBody,
  requestIdOf,
  standardErrors,
} from "../../http/shared";
import { dashboardListQuery, dashboardPaginated } from "../../../dashboard-lists/query";
import { assertAllowedQueryKeys } from "../../../geography/shared";

const createKeys = new Set(["phone", "accessCode", "cityId", "driverPhotoAssetId", "vehicleDescription", "driverName", "fatherName", "motherName", "alternatePhone", "nationalIdFrontAssetId", "nationalIdBackAssetId", "residenceCardFrontAssetId", "residenceCardBackAssetId", "contractAssetId", "vehicleType", "vehicleNumber"]);
const patchKeys = new Set(["phone", "cityId", "operationalStatus", "driverPhotoAssetId", "vehicleDescription", "driverName", "fatherName", "motherName", "alternatePhone", "vehicleType", "vehicleNumber"]);
const codeKeys = new Set(["accessCode"]);
const listKeys = new Set(["search", "page", "limit", "sortBy", "sortOrder", "cityId", "status"]);

const parseDriverManagementBody = async (context: { request: Request; contentType: string }) => {
  if (!context.contentType.toLowerCase().includes("application/json")) return;
  const method = context.request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return;
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  let allowed: Set<string> | null = null;
  if (method === "POST" && path.endsWith("/dashboard/drivers")) allowed = createKeys;
  else if (method === "PATCH" && /\/dashboard\/drivers\/[^/]+$/.test(path)) allowed = patchKeys;
  else if (method === "POST" && /\/dashboard\/drivers\/[^/]+\/access-code$/.test(path)) allowed = codeKeys;
  if (!allowed) return body;
  if (body === null || Array.isArray(body)) registerInvalidBodyShape(context.request);
  else if (body && typeof body === "object") {
    registerUnknownBodyFields(context.request, Object.keys(body as Record<string, unknown>).filter((key) => !allowed.has(key)));
  }
  return body;
};

const assertDriverManagementBody = ({ request }: { request: Request }) => {
  const invalidShape = consumeInvalidBodyShape(request);
  const unknown = consumeUnknownBodyFields(request);
  if (!invalidShape && unknown.length === 0) return;
  throw new AppError(422, "VALIDATION_FAILED", "The request contains invalid fields", undefined, undefined, {
    location: "body",
    fields: invalidShape
      ? [{ field: "root", code: "INVALID_TYPE", message: "value has an invalid type" }]
      : unknown.map((field) => ({ field, code: "UNKNOWN_FIELD", message: `${field} is not allowed` })),
  });
};

const statusLiteral = t.Union([
  t.Literal("PENDING_ACTIVATION"), t.Literal("ACTIVE"), t.Literal("SUSPENDED"), t.Literal("CLOSED"),
]);
const driverDto = t.Object({
  accountId: t.String({ format: "uuid" }),
  phone: t.String(),
  cityId: t.Nullable(t.String({ format: "uuid" })),
  approvalStatus: t.Literal("APPROVED"),
  operationalStatus: statusLiteral,
  accountStatus: t.Union([t.Literal("ACTIVE"), t.Literal("SUSPENDED"), t.Literal("CLOSED")]),
  vehicleDescription: t.Nullable(t.String()),
  driverName: t.Nullable(t.String()), fatherName: t.Nullable(t.String()), motherName: t.Nullable(t.String()),
  alternatePhone: t.Nullable(t.String()), vehicleType: t.Nullable(t.String()), vehicleNumber: t.Nullable(t.String()),
  driverPhotoObjectKey: t.Nullable(t.String()),
  driverPhotoAssetId: t.Nullable(t.String({ format: "uuid" })),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});
const errors = { ...standardErrors, 403: errorResponse, 404: errorResponse, 409: errorResponse };

export const driverManagementRoutes = (auth: AuthModule) =>
  new Elysia({ name: "driver-management-routes" })
    .onParse(parseDriverManagementBody)
    .onBeforeHandle(assertDriverManagementBody)
    .post("/api/v1/dashboard/drivers", async ({ request, set, body }) =>
      auth.driverManagement.create(await auth.sessions.authenticate(bearer(request), dashboardContext, requestIdOf(set)), body), {
      parse: "json",
      body: t.Object({
        phone: t.String({ minLength: 8, maxLength: 32 }),
        accessCode: t.String({ minLength: 6, maxLength: 12, pattern: "^[0-9]{6,12}$" }),
        cityId: t.String({ format: "uuid" }),
        driverPhotoAssetId: t.String({ format: "uuid" }),
        driverName: t.String({ minLength: 1, maxLength: 200 }), fatherName: t.String({ minLength: 1, maxLength: 200 }), motherName: t.String({ minLength: 1, maxLength: 200 }), alternatePhone: t.String({ minLength: 8, maxLength: 32 }),
        nationalIdFrontAssetId: t.String({ format: "uuid" }), nationalIdBackAssetId: t.String({ format: "uuid" }), residenceCardFrontAssetId: t.String({ format: "uuid" }), residenceCardBackAssetId: t.String({ format: "uuid" }), contractAssetId: t.String({ format: "uuid" }),
        vehicleType: t.Optional(t.String({ maxLength: 200 })), vehicleNumber: t.Optional(t.String({ maxLength: 200 })),
        vehicleDescription: t.Optional(t.String({ maxLength: 1000 })),
      }, { additionalProperties: false }),
      response: { 200: driverDto, ...errors },
      detail: { tags: ["Dashboard — Drivers"], security: [{ bearerAuth: [] }], summary: "Create an active driver (SUPER_ADMIN only)" },
    })
    .get("/api/v1/dashboard/drivers", async ({ request, set, query }) => {
      assertAllowedQueryKeys(request, listKeys);
      return auth.driverManagement.list(await auth.sessions.authenticate(bearer(request), dashboardContext, requestIdOf(set)), query);
    }, {
      query: t.Object({ ...dashboardListQuery, cityId: t.Optional(t.String({ format: "uuid" })), status: t.Optional(t.String()) }, { additionalProperties: false }),
      response: { 200: dashboardPaginated(driverDto), ...errors },
      detail: { tags: ["Dashboard — Drivers"], security: [{ bearerAuth: [] }], summary: "List drivers across cities (SUPER_ADMIN only)" },
    })
    .get("/api/v1/dashboard/drivers/:driverId", async ({ request, set, params }) =>
      auth.driverManagement.get(await auth.sessions.authenticate(bearer(request), dashboardContext, requestIdOf(set)), params.driverId), {
      params: t.Object({ driverId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
      response: { 200: driverDto, ...errors },
      detail: { tags: ["Dashboard — Drivers"], security: [{ bearerAuth: [] }] },
    })
    .patch("/api/v1/dashboard/drivers/:driverId", async ({ request, set, params, body }) =>
      auth.driverManagement.update(await auth.sessions.authenticate(bearer(request), dashboardContext, requestIdOf(set)), params.driverId, body), {
      params: t.Object({ driverId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
      parse: "json",
      body: t.Object({
        phone: t.Optional(t.String({ minLength: 8, maxLength: 32 })),
        cityId: t.Optional(t.String({ format: "uuid" })),
        operationalStatus: t.Optional(statusLiteral),
        driverPhotoAssetId: t.Optional(t.String({ format: "uuid" })),
        vehicleDescription: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        driverName: t.Optional(t.String({ minLength: 1, maxLength: 200 })), fatherName: t.Optional(t.String({ minLength: 1, maxLength: 200 })), motherName: t.Optional(t.String({ minLength: 1, maxLength: 200 })), alternatePhone: t.Optional(t.String({ minLength: 8, maxLength: 32 })),
        vehicleType: t.Optional(t.Nullable(t.String({ maxLength: 200 }))), vehicleNumber: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
      }, { additionalProperties: false, minProperties: 1 }),
      response: { 200: driverDto, ...errors },
      detail: { tags: ["Dashboard — Drivers"], security: [{ bearerAuth: [] }] },
    })
    .post("/api/v1/dashboard/drivers/:driverId/access-code", async ({ request, set, params, body }) =>
      auth.driverManagement.resetAccessCode(await auth.sessions.authenticate(bearer(request), dashboardContext, requestIdOf(set)), params.driverId, body.accessCode), {
      params: t.Object({ driverId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
      parse: "json",
      body: t.Object({ accessCode: t.String({ minLength: 6, maxLength: 12, pattern: "^[0-9]{6,12}$" }) }, { additionalProperties: false }),
      response: { 200: t.Object({ reset: t.Literal(true) }), ...errors },
      detail: { tags: ["Dashboard — Drivers"], security: [{ bearerAuth: [] }], summary: "Reset driver access code and revoke driver sessions" },
    });
