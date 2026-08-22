import { Elysia, t } from "elysia";
import type { AuthModule } from "../../auth/auth-module";
import { dashboardContext } from "../../auth/core/context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../../auth/http/shared";
import {
  dashboardListQuery,
  dashboardPaginated,
} from "../../dashboard-lists/query";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  paginated,
  requestIdOf,
} from "../shared";
import type { CityService } from "./city.service";
import { document } from "../../../openapi/document";
import { geographyExamples } from "../../../openapi/examples/catalog";

const govSummary = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String() })),
  status: t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
});
const geoJsonPolygon = t.Object({ type: t.Literal("Polygon"), coordinates: t.Array(t.Array(t.Tuple([t.Number({ minimum: -180, maximum: 180 }), t.Number({ minimum: -90, maximum: 90 })]), { minItems: 4 }), { minItems: 1 }) }, { additionalProperties: false });
const geoJsonMultiPolygon = t.Object({ type: t.Literal("MultiPolygon"), coordinates: t.Array(t.Array(t.Array(t.Tuple([t.Number({ minimum: -180, maximum: 180 }), t.Number({ minimum: -90, maximum: 90 })]), { minItems: 4 }), { minItems: 1 }), { minItems: 1 }) }, { additionalProperties: false });
const cityBoundaryInput = t.Union([geoJsonPolygon, geoJsonMultiPolygon]);
const cityListDto = t.Object({
  id: t.String({ format: "uuid" }),
  governorateId: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String() })),
  latitude: t.Number(),
  longitude: t.Number(),
  status: t.Union([
    t.Literal("DRAFT"),
    t.Literal("ACTIVE"),
    t.Literal("SUSPENDED"),
    t.Literal("ARCHIVED"),
  ]),
  displayOrder: t.Integer(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
  hasBoundary: t.Boolean(),
  governorate: govSummary,
});
const cityDetailDto = t.Intersect([cityListDto, t.Object({ boundary: t.Nullable(geoJsonMultiPolygon) })]);
const publicGov = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  name: t.String(),
  resolvedLocale: t.String(),
});
const publicCity = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  resolvedLocale: t.String(),
  nameAr: t.String(),
  nameEn: t.String(),
  latitude: t.Union([t.Number(), t.Null()]),
  longitude: t.Union([t.Number(), t.Null()]),
  governorate: publicGov,
});
const cityResponse = dashboardPaginated(cityListDto);
const publicCityResponse = paginated(publicCity);
const cityCreateErrors = { ...standardErrors, 403: errorResponse };
const cityTransitionErrors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const publicListErrors = {
  422: errorResponse,
  500: errorResponse,
};
const cityIdParam = t.Object(
  { cityId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const cityBodyKeys = new Set([
  "governorateId",
  "translations",
  "latitude",
  "longitude",
  "displayOrder",
  "boundary",
]);

const parseCityBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/cities")) {
    assertAllowedBodyKeys(body, cityBodyKeys);
  }
  if (method === "PATCH" && /\/dashboard\/cities\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, cityBodyKeys);
  }
  return body;
};

export const cityRoutes = (auth: AuthModule, service: CityService) =>
  new Elysia({ name: "city-routes" })
    .onParse(parseCityBody)
    .post(
      "/api/v1/dashboard/cities",
      async ({ request, set, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          body,
        ),
      {
        parse: "json",
        body: document(
          t.Object(
            {
              governorateId: t.String({ format: "uuid" }),
              translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 16 }), name: t.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }), { minItems: 1 }),
              latitude: t.Number({ minimum: -90, maximum: 90 }),
              longitude: t.Number({ minimum: -180, maximum: 180 }),
              displayOrder: t.Integer({ minimum: 0 }),
              boundary: cityBoundaryInput,
            },
            { additionalProperties: false },
          ),
          geographyExamples.cityCreate,
        ),
        response: { 200: cityDetailDto, ...cityCreateErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/cities",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.list(identity, query);
      },
      {
        query: t.Object(
          {
            governorateId: t.Optional(
              t.String({
                format: "uuid",
                description: "Filter by governorate",
              }),
            ),
            ...dashboardListQuery,
            status: t.Optional(
              t.Union([
                t.Literal("DRAFT"),
                t.Literal("ACTIVE"),
                t.Literal("SUSPENDED"),
                t.Literal("ARCHIVED"),
              ]),
            ),
            createdFrom: t.Optional(t.String({ examples: ["2026-08-01"] })),
            createdTo: t.Optional(t.String({ examples: ["2026-08-16"] })),
          },
          { additionalProperties: false },
        ),
        response: { 200: cityResponse, ...dashboardListErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/cities/:cityId",
      async ({ request, set, params }) => {
        await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.get(params.cityId);
      },
      {
        params: cityIdParam,
        response: { 200: cityDetailDto, ...dashboardDetailErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/cities/:cityId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.cityId,
          body,
        ),
      {
        params: cityIdParam,
        parse: "json",
        body: t.Object(
          {
            governorateId: t.Optional(t.String({ format: "uuid" })),
            translations: t.Optional(t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 16 }), name: t.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }), { minItems: 1 })),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            boundary: t.Optional(cityBoundaryInput),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: cityDetailDto, ...dashboardMutationErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/cities/:cityId/activate",
      async ({ request, set, params }) =>
        service.transition(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.cityId,
          "ACTIVE",
        ),
      {
        params: cityIdParam,
        response: { 200: cityDetailDto, ...cityTransitionErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/cities/:cityId/suspend",
      async ({ request, set, params }) =>
        service.transition(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.cityId,
          "SUSPENDED",
        ),
      {
        params: cityIdParam,
        response: { 200: cityDetailDto, ...cityTransitionErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/cities/:cityId/archive",
      async ({ request, set, params }) =>
        service.transition(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.cityId,
          "ARCHIVED",
        ),
      {
        params: cityIdParam,
        response: { 200: cityDetailDto, ...cityTransitionErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/cities",
      async ({ query, request }) => service.listPublic(query, request),
      {
        query: t.Object(
          {
            page: t.Optional(t.Numeric({ minimum: 1 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
            search: t.Optional(t.String({ maxLength: 100 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: publicCityResponse, ...publicListErrors },
        detail: {
          tags: ["Public — Geography"],
          summary: "List active cities for pre-login selection",
          description:
            "Returns only ACTIVE cities belonging to ACTIVE governorates. " +
            "No access token is required. Shared by Customer and Driver apps " +
            "before login or registration. Administrative status filters are not accepted.",
        },
      },
    );
