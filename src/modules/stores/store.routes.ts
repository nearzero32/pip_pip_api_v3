import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  pageQuery,
  paginated,
  requestIdOf,
} from "../geography/shared";
import type { StoreService } from "./store.service";

const storeStatus = t.Union([
  t.Literal("DRAFT"),
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const mutableStoreStatus = t.Union([
  t.Literal("DRAFT"),
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
]);

const orderAcceptance = t.Union([
  t.Literal("ACCEPTING"),
  t.Literal("PAUSED"),
]);

const weekday = t.Union([
  t.Literal("MONDAY"),
  t.Literal("TUESDAY"),
  t.Literal("WEDNESDAY"),
  t.Literal("THURSDAY"),
  t.Literal("FRIDAY"),
  t.Literal("SATURDAY"),
  t.Literal("SUNDAY"),
]);

const mediaDto = t.Object({
  assetId: t.String({ format: "uuid" }),
  url: t.Nullable(t.String()),
});

const workingHourPeriod = t.Object(
  {
    dayOfWeek: weekday,
    opensAt: t.String({ minLength: 4, maxLength: 8 }),
    closesAt: t.String({ minLength: 4, maxLength: 8 }),
  },
  { additionalProperties: false },
);

const availabilityDto = t.Object({
  isOpen: t.Boolean(),
  isAcceptingOrders: t.Boolean(),
  nextOpeningAt: t.Nullable(t.String()),
  nextClosingAt: t.Nullable(t.String()),
});

const storeDto = t.Object({
  id: t.String({ format: "uuid" }),
  mainCategory: t.Object({
    id: t.String({ format: "uuid" }),
    name: t.String(),
  }),
  name: t.String(),
  phone: t.String(),
  address: t.String(),
  location: t.Object({
    latitude: t.Number(),
    longitude: t.Number(),
  }),
  logo: t.Nullable(mediaDto),
  cover: t.Nullable(mediaDto),
  status: storeStatus,
  orderAcceptanceStatus: orderAcceptance,
  displayOrder: t.Integer({ minimum: 0 }),
  zoneIds: t.Array(t.String({ format: "uuid" })),
  subcategoryIds: t.Array(t.String({ format: "uuid" })),
  workingHours: t.Array(workingHourPeriod),
  availability: availabilityDto,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const publicStoreDto = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  phone: t.String(),
  address: t.String(),
  location: t.Object({
    latitude: t.Number(),
    longitude: t.Number(),
  }),
  mainCategory: t.Object({
    id: t.String({ format: "uuid" }),
    name: t.String(),
  }),
  logo: t.Nullable(mediaDto),
  cover: t.Nullable(mediaDto),
  displayOrder: t.Integer({ minimum: 0 }),
  isOpen: t.Boolean(),
  isAcceptingOrders: t.Boolean(),
  nextOpeningAt: t.Nullable(t.String()),
  nextClosingAt: t.Nullable(t.String()),
});

const listResponse = paginated(storeDto);
const publicListResponse = t.Object({ data: t.Array(publicStoreDto) });

const storeIdParam = t.Object(
  { storeId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const createErrors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const listErrors = {
  ...dashboardListErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const detailErrors = {
  ...dashboardDetailErrors,
  403: errorResponse,
  409: errorResponse,
};
const mutationErrors = {
  ...dashboardMutationErrors,
  400: errorResponse,
  409: errorResponse,
};
const publicErrors = {
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  500: errorResponse,
};

const createBodyKeys = new Set([
  "mainCategoryId",
  "name",
  "phone",
  "address",
  "latitude",
  "longitude",
  "logoAssetId",
  "coverAssetId",
  "status",
  "orderAcceptanceStatus",
  "displayOrder",
  "zoneIds",
  "subcategoryIds",
  "workingHours",
]);
const patchBodyKeys = new Set([
  "mainCategoryId",
  "name",
  "phone",
  "address",
  "latitude",
  "longitude",
  "logoAssetId",
  "coverAssetId",
  "status",
  "orderAcceptanceStatus",
  "displayOrder",
  "zoneIds",
  "subcategoryIds",
  "workingHours",
]);

const parseStoreBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/stores")) {
    assertAllowedBodyKeys(body, createBodyKeys);
  }
  if (method === "PATCH" && /\/dashboard\/stores\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, patchBodyKeys);
  }
  return body;
};

const cityIdHeaderParam = {
  $ref: "#/components/parameters/CityIdHeader",
};

export const storeRoutes = (auth: AuthModule, service: StoreService) =>
  new Elysia({ name: "store-routes" })
    .onParse(parseStoreBody)
    .post(
      "/api/v1/dashboard/stores",
      async ({ request, set, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          body,
          requestIdOf(set),
        ),
      {
        body: t.Object(
          {
            mainCategoryId: t.String({ format: "uuid" }),
            name: t.String({ minLength: 1, maxLength: 100 }),
            phone: t.String({ minLength: 8, maxLength: 20 }),
            address: t.String({ minLength: 1, maxLength: 500 }),
            latitude: t.Number({ minimum: -90, maximum: 90 }),
            longitude: t.Number({ minimum: -180, maximum: 180 }),
            logoAssetId: t.String({ format: "uuid" }),
            coverAssetId: t.Optional(t.String({ format: "uuid" })),
            status: t.Optional(mutableStoreStatus),
            orderAcceptanceStatus: t.Optional(orderAcceptance),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            zoneIds: t.Array(t.String({ format: "uuid" }), { minItems: 1 }),
            subcategoryIds: t.Array(t.String({ format: "uuid" }), {
              minItems: 1,
            }),
            workingHours: t.Optional(t.Array(workingHourPeriod)),
          },
          { additionalProperties: false },
        ),
        response: { 200: storeDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Stores"],
          summary: "Create a Store in the authenticated City",
          description:
            "City scope is exclusively the signed staff City (`auth.cityId`). Do not send cityId. Requires logoAssetId (STORE_LOGO), at least one service Zone, and at least one Subcategory under the selected Main Category. Physical latitude/longitude must fall inside an ACTIVE Zone of the same City (ST_Covers). Service Zones are independent of physical location. Working hours support multiple periods per day and overnight closesAt < opensAt. Computed availability fields are server-derived and must not be sent.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores",
      async ({ request, set, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          query,
        ),
      {
        query: t.Object(
          {
            ...pageQuery,
            search: t.Optional(t.String({ maxLength: 200 })),
            status: t.Optional(storeStatus),
            mainCategoryId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        response: { 200: listResponse, ...listErrors },
        detail: {
          tags: ["Dashboard — Stores"],
          summary: "List Stores for the authenticated City",
          description:
            "Defaults to excluding ARCHIVED unless status is set. City comes only from the signed token.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
        ),
      {
        params: storeIdParam,
        response: { 200: storeDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Stores"],
          summary: "Get a Store in the authenticated City",
          description:
            "Cross-City store identifiers return STORE_NOT_FOUND without leaking foreign City data.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          body,
          requestIdOf(set),
        ),
      {
        params: storeIdParam,
        body: t.Object(
          {
            mainCategoryId: t.Optional(t.String({ format: "uuid" })),
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            phone: t.Optional(t.String({ minLength: 8, maxLength: 20 })),
            address: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            logoAssetId: t.Optional(t.String({ format: "uuid" })),
            coverAssetId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            status: t.Optional(mutableStoreStatus),
            orderAcceptanceStatus: t.Optional(orderAcceptance),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            zoneIds: t.Optional(
              t.Array(t.String({ format: "uuid" }), { minItems: 1 }),
            ),
            subcategoryIds: t.Optional(
              t.Array(t.String({ format: "uuid" }), { minItems: 1 }),
            ),
            workingHours: t.Optional(t.Array(workingHourPeriod)),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: storeDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Stores"],
          summary: "Update a Store in the authenticated City",
          description:
            "Omitted fields are unchanged. coverAssetId null removes the cover and releases the asset. logoAssetId cannot be null. Changing mainCategoryId requires a valid Subcategory set for the new parent (send subcategoryIds in the same request). latitude and longitude must be updated together. status ARCHIVED is rejected — use DELETE. Schedule management is covered by stores.update. Date-specific schedule overrides are deferred.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId",
      async ({ request, set, params }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          requestIdOf(set),
        ),
      {
        params: storeIdParam,
        response: { 200: storeDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Stores"],
          summary: "Soft-archive a Store in the authenticated City",
          description:
            "Sets status=ARCHIVED and archived_at. Clears and releases logo/cover media. Idempotent when already ARCHIVED. No hard delete. Join rows and working hours are retained.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/stores",
      async ({ request, query }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.listPublic(city.city.id, {
          zoneId: query.zoneId,
          ...(query.mainCategoryId
            ? { mainCategoryId: query.mainCategoryId }
            : {}),
        });
      },
      {
        query: t.Object(
          {
            zoneId: t.String({ format: "uuid" }),
            mainCategoryId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false },
        ),
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicListResponse, ...publicErrors },
        detail: {
          tags: ["Public — Stores"],
          summary:
            "List customer-visible Stores for a Zone in the City selected by X-City-Id",
          description:
            "Requires trusted X-City-Id and zoneId belonging to that City. Returns ACTIVE non-archived Stores that serve the Zone via store_zones, with an ACTIVE Main Category. Closed-by-schedule and PAUSED Stores remain visible with computed isOpen / isAcceptingOrders / nextOpeningAt / nextClosingAt. Physical Store coordinates do not control visibility.",
          parameters: [cityIdHeaderParam],
        },
      },
    )
    .get(
      "/api/v1/public/stores/:storeId",
      async ({ request, params }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.getPublic(city.city.id, params.storeId);
      },
      {
        params: storeIdParam,
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicStoreDto, ...publicErrors },
        detail: {
          tags: ["Public — Stores"],
          summary: "Get a customer-visible Store in the City selected by X-City-Id",
          description:
            "Returns only ACTIVE non-archived Stores with an ACTIVE Main Category in the header City. Schedule-closed and PAUSED Stores remain visible with computed availability.",
          parameters: [cityIdHeaderParam],
        },
      },
    );
