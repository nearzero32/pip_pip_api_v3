import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth-module";
import { dashboardContext } from "../core/context";
import {
  bearer,
  errorResponse,
  parseAuthenticationBody,
  requestIdOf,
  standardErrors,
} from "../http/shared";
import { assertAllowedBodyKeys } from "../../geography/shared";
import {
  dashboardListQuery,
  dashboardPaginated,
} from "../../dashboard-lists/query";

const tag = ["Dashboard — Merchants"];

const createKeys = new Set(["phone", "password", "storeId", "displayName", "name", "status", "cityId", "managerName", "managerPhone", "ownerPhone", "restaurantSupportName", "restaurantSupportPhone", "cashRecipientName", "payoutMethod", "transferCity", "transferRecipientName", "iban", "cardNumber", "otherCardName", "isAgencyAffiliate", "agencyName"]);
const patchKeys = new Set(["displayName", "status", "cityId"]);
const passwordKeys = new Set(["password", "cityId"]);
const transferKeys = new Set(["storeId", "cityId"]);

const parseMerchantBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/merchants")) {
    assertAllowedBodyKeys(body, createKeys);
  }
  if (method === "PATCH" && /\/dashboard\/merchants\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, patchKeys);
  }
  if (
    method === "POST" &&
    /\/dashboard\/merchants\/[^/]+\/password$/.test(path)
  ) {
    assertAllowedBodyKeys(body, passwordKeys);
  }
  if (
    method === "POST" &&
    /\/dashboard\/merchants\/[^/]+\/store$/.test(path)
  ) {
    assertAllowedBodyKeys(body, transferKeys);
  }
  return body;
};

const merchantStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("SUSPENDED"),
]);

const merchantDto = t.Object({
  accountId: t.String({ format: "uuid" }),
  phone: t.String(),
  displayName: t.Nullable(t.String()),
  status: merchantStatus,
  storeId: t.String({ format: "uuid" }),
  storeName: t.Nullable(t.String()),
  cityId: t.String({ format: "uuid" }),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
  statusChangedAt: t.String({ format: "date-time" }),
});

const listResponse = dashboardPaginated(merchantDto);

const merchantErrors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};

const accountParam = t.Object(
  { accountId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export const merchantOrganizationRoutes = (auth: AuthModule) =>
  new Elysia({ name: "merchant-organization-routes" })
    .onParse(parseMerchantBody)
    .post(
      "/api/v1/dashboard/merchants",
      async ({ request, set, body }) =>
        auth.merchants.create(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          body,
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: t.Object(
          {
            phone: t.String({ maxLength: 32 }),
            password: t.String({ minLength: 12, maxLength: 128 }),
            storeId: t.String({ format: "uuid" }),
            displayName: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
            name: t.Optional(t.Nullable(t.String({ maxLength: 100 }))), managerName: t.Optional(t.String({ maxLength: 100 })), managerPhone: t.Optional(t.String({ maxLength: 32 })), ownerPhone: t.Optional(t.String({ maxLength: 32 })), restaurantSupportName: t.Optional(t.String({ maxLength: 100 })), restaurantSupportPhone: t.Optional(t.String({ maxLength: 32 })), cashRecipientName: t.Optional(t.String({ maxLength: 100 })), payoutMethod: t.Optional(t.String({ maxLength: 32 })), transferCity: t.Optional(t.String({ maxLength: 100 })), transferRecipientName: t.Optional(t.String({ maxLength: 100 })), iban: t.Optional(t.String({ maxLength: 64 })), cardNumber: t.Optional(t.String({ maxLength: 64 })), otherCardName: t.Optional(t.String({ maxLength: 100 })), isAgencyAffiliate: t.Optional(t.Boolean()), agencyName: t.Optional(t.String({ maxLength: 100 })),
            status: t.Optional(merchantStatus),
            cityId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: { 200: merchantDto, ...merchantErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "Create Merchant in ADMIN City (merchants.create)",
        },
      },
    )
    .get(
      "/api/v1/dashboard/merchants",
      async ({ request, set, query }) =>
        auth.merchants.list(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          query,
        ),
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            status: t.Optional(merchantStatus),
            storeId: t.Optional(t.String({ format: "uuid" })),
            createdFrom: t.Optional(t.String({ examples: ["2026-08-01"] })),
            createdTo: t.Optional(t.String({ examples: ["2026-08-16"] })),
            cityId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: { 200: listResponse, ...merchantErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "List Merchants in ADMIN City (merchants.read)",
        },
      },
    )
    .get(
      "/api/v1/dashboard/merchants/:accountId",
      async ({ request, set, params, query }) =>
        auth.merchants.get(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.accountId, query.cityId,
        ),
      {
        params: accountParam, query: t.Object({ cityId: t.Optional(t.String({ format: "uuid" })) }, { additionalProperties: false }),
        response: { 200: merchantDto, ...merchantErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "Get Merchant (merchants.read)",
        },
      },
    )
    .patch(
      "/api/v1/dashboard/merchants/:accountId",
      async ({ request, set, params, body }) =>
        auth.merchants.update(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.accountId,
          body,
          requestIdOf(set),
        ),
      {
        params: accountParam,
        parse: "json",
        body: t.Object(
          {
            displayName: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
            status: t.Optional(merchantStatus),
            cityId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: { 200: merchantDto, ...merchantErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary:
            "Update Merchant profile/status (INACTIVE/SUSPENDED revokes sessions)",
        },
      },
    )
    .post(
      "/api/v1/dashboard/merchants/:accountId/password",
      async ({ request, set, params, body }) =>
        auth.merchants.resetPassword(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.accountId,
          body,
          requestIdOf(set),
        ),
      {
        params: accountParam,
        parse: "json",
        body: t.Object(
          {
            password: t.String({ minLength: 12, maxLength: 128 }),
            cityId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({
            reset: t.Boolean(),
            request_id: t.String(),
          }),
          ...merchantErrors,
        },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "ADMIN Merchant password reset (revokes Merchant sessions)",
        },
      },
    )
    .post(
      "/api/v1/dashboard/merchants/:accountId/store",
      async ({ request, set, params, body }) =>
        auth.merchants.transferStore(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.accountId,
          body,
          requestIdOf(set),
        ),
      {
        params: accountParam,
        parse: "json",
        body: t.Object(
          {
            storeId: t.String({ format: "uuid" }),
            cityId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: { 200: merchantDto, ...merchantErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary:
            "Transfer Merchant to another Store in ADMIN City (revokes sessions)",
        },
      },
    );
