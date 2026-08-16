import { Elysia, t } from "elysia";
import type { AuthModule } from "../../auth/auth-module";
import { dashboardContext } from "../../auth/core/context";
import { requirePublicCityContext } from "../../auth/city/public-city-context";
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
  requestIdOf,
} from "../shared";
import type { ZoneService } from "./zone.service";
import { document } from "../../../openapi/document";
import { geographyExamples } from "../../../openapi/examples/catalog";

const geoJsonPolygon = t.Object(
  {
    type: t.Literal("Polygon"),
    coordinates: t.Array(
      t.Array(
        t.Tuple([
          t.Number({ minimum: -180, maximum: 180 }),
          t.Number({ minimum: -90, maximum: 90 }),
        ]),
        { minItems: 4 },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

const zoneStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const zoneDto = t.Object({
  id: t.String({ format: "uuid" }),
  cityId: t.String({ format: "uuid" }),
  name: t.String(),
  boundary: geoJsonPolygon,
  status: zoneStatus,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const publicZoneDto = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  boundary: geoJsonPolygon,
});

const zoneListResponse = dashboardPaginated(zoneDto);
const publicZoneListResponse = t.Object({ data: t.Array(publicZoneDto) });

const zoneIdParam = t.Object(
  { zoneId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const zoneCreateErrors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const zoneListErrors = {
  ...dashboardListErrors,
  403: errorResponse,
  409: errorResponse,
};
const zoneDetailErrors = {
  ...dashboardDetailErrors,
  403: errorResponse,
  409: errorResponse,
};
const zoneMutationErrors = {
  ...dashboardMutationErrors,
  400: errorResponse,
  409: errorResponse,
};
const publicZoneErrors = {
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  500: errorResponse,
};

const zoneBodyKeys = new Set(["name", "boundary", "status"]);

const parseZoneBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/zones")) {
    assertAllowedBodyKeys(body, new Set(["name", "boundary"]));
  }
  if (method === "PATCH" && /\/dashboard\/zones\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, zoneBodyKeys);
  }
  return body;
};

const cityIdHeaderParam = {
  $ref: "#/components/parameters/CityIdHeader",
};

export const zoneRoutes = (auth: AuthModule, service: ZoneService) =>
  new Elysia({ name: "zone-routes" })
    .onParse(parseZoneBody)
    .post(
      "/api/v1/dashboard/zones",
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
              name: t.String({ minLength: 1, maxLength: 200 }),
              boundary: geoJsonPolygon,
            },
            { additionalProperties: false },
          ),
          geographyExamples.zoneCreate,
        ),
        response: { 200: zoneDto, ...zoneCreateErrors },
        detail: {
          tags: ["Dashboard — Zones"],
          summary: "Create a Zone in the authenticated City",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/zones",
      async ({ request, set, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          query,
        ),
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            status: t.Optional(
              t.Union([
                t.Literal("ACTIVE"),
                t.Literal("INACTIVE"),
                t.Literal("ARCHIVED"),
              ]),
            ),
            createdFrom: t.Optional(
              t.String({
                description:
                  "Inclusive created-at lower bound. Date-only values use Asia/Baghdad.",
                examples: ["2026-08-01"],
              }),
            ),
            createdTo: t.Optional(
              t.String({
                description:
                  "Inclusive created-at upper bound. Date-only values use Asia/Baghdad end of day.",
                examples: ["2026-08-16"],
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: zoneListResponse, ...zoneListErrors },
        detail: {
          tags: ["Dashboard — Zones"],
          summary: "List Zones for the authenticated City",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/zones/:zoneId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.zoneId,
        ),
      {
        params: zoneIdParam,
        response: {
          200: zoneDto,
          ...zoneDetailErrors,
        },
        detail: {
          tags: ["Dashboard — Zones"],
          summary: "Get a Zone in the authenticated City",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/zones/:zoneId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.zoneId,
          body,
        ),
      {
        params: zoneIdParam,
        parse: "json",
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            boundary: t.Optional(geoJsonPolygon),
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
            ),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: zoneDto, ...zoneMutationErrors },
        detail: {
          tags: ["Dashboard — Zones"],
          summary: "Update a Zone in the authenticated City",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/zones/:zoneId",
      async ({ request, set, params }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.zoneId,
        ),
      {
        params: zoneIdParam,
        response: { 200: zoneDto, ...zoneMutationErrors },
        detail: {
          tags: ["Dashboard — Zones"],
          summary: "Soft-archive a Zone in the authenticated City",
          description:
            "Soft archive only. Idempotent when the Zone is already ARCHIVED.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/zones",
      async ({ request }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.listPublic(city.city.id);
      },
      {
        query: t.Object({}, { additionalProperties: false }),
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicZoneListResponse, ...publicZoneErrors },
        detail: {
          tags: ["Public — Geography"],
          summary: "List active Zones for the City selected by X-City-Id",
          description:
            "Returns ACTIVE, non-archived Zones for the validated X-City-Id City only. " +
            "cityId query/path parameters are not accepted.",
          parameters: [cityIdHeaderParam],
        },
      },
    )
    .get(
      "/api/v1/public/zones/resolve",
      async ({ request, query }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.resolvePublic(
          city.city.id,
          query.longitude,
          query.latitude,
        );
      },
      {
        query: t.Object(
          {
            longitude: t.Numeric({ minimum: -180, maximum: 180 }),
            latitude: t.Numeric({ minimum: -90, maximum: 90 }),
          },
          { additionalProperties: false },
        ),
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicZoneDto, ...publicZoneErrors },
        detail: {
          tags: ["Public — Geography"],
          summary: "Resolve a point to an active Zone in the selected City",
          description:
            "Uses PostGIS ST_Covers within the X-City-Id City. " +
            "Shared-boundary ties break by createdAt ascending, then id ascending.",
          parameters: [cityIdHeaderParam],
        },
      },
    );
