import { Elysia, t } from "elysia";
import type { AuthModule } from "../../auth/auth-module";
import {
  customerContext,
  dashboardContext,
  driverContext,
} from "../../auth/core/context";
import { errorResponse, parseAuthenticationBody, standardErrors } from "../../auth/http/shared";
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
} from "../shared";
import type { CityService } from "./city.service";

const govSummary = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  status: t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
});
const cityDto = t.Object({
  id: t.String({ format: "uuid" }),
  governorateId: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
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
  governorate: govSummary,
});
const mobileGov = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
});
const mobileCity = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  latitude: t.Number(),
  longitude: t.Number(),
  displayOrder: t.Integer(),
  governorate: mobileGov,
});
const cityResponse = paginated(cityDto);
const mobileCityResponse = paginated(mobileCity);
const cityCreateErrors = { ...standardErrors, 403: errorResponse };
const cityTransitionErrors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const mobileListErrors = { ...standardErrors };
const cityIdParam = t.Object(
  { cityId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const cityBodyKeys = new Set([
  "governorateId",
  "nameAr",
  "nameEn",
  "latitude",
  "longitude",
  "displayOrder",
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
        body: t.Object(
          {
            governorateId: t.String({ format: "uuid" }),
            nameAr: t.String({ minLength: 1, maxLength: 200 }),
            nameEn: t.String({ minLength: 1, maxLength: 200 }),
            latitude: t.Number({ minimum: -90, maximum: 90 }),
            longitude: t.Number({ minimum: -180, maximum: 180 }),
            displayOrder: t.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: cityDto, ...cityCreateErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/cities",
      async ({ request, set, query }) => {
        await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.list(query);
      },
      {
        query: t.Object(
          {
            governorateId: t.Optional(t.String({ format: "uuid" })),
            ...pageQuery,
            status: t.Optional(
              t.Union([
                t.Literal("DRAFT"),
                t.Literal("ACTIVE"),
                t.Literal("SUSPENDED"),
                t.Literal("ARCHIVED"),
              ]),
            ),
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
        response: { 200: cityDto, ...dashboardDetailErrors },
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
        body: t.Object(
          {
            governorateId: t.Optional(t.String({ format: "uuid" })),
            nameAr: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            nameEn: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: cityDto, ...dashboardMutationErrors },
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
        response: { 200: cityDto, ...cityTransitionErrors },
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
        response: { 200: cityDto, ...cityTransitionErrors },
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
        response: { 200: cityDto, ...cityTransitionErrors },
        detail: {
          tags: ["Dashboard — Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/customer/cities",
      async ({ request, set, query }) => {
        await authIdentity(auth, request, customerContext, requestIdOf(set));
        return service.list({ ...query, mobile: true });
      },
      {
        query: t.Object(
          {
            page: t.Optional(t.Numeric({ minimum: 1 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
            search: t.Optional(t.String({ maxLength: 100 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: mobileCityResponse, ...mobileListErrors },
        detail: {
          tags: ["Mobile — Customer Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/driver/cities",
      async ({ request, set, query }) => {
        await authIdentity(auth, request, driverContext, requestIdOf(set));
        return service.list({ ...query, mobile: true });
      },
      {
        query: t.Object(
          {
            page: t.Optional(t.Numeric({ minimum: 1 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
            search: t.Optional(t.String({ maxLength: 100 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: mobileCityResponse, ...mobileListErrors },
        detail: {
          tags: ["Mobile — Driver Cities"],
          security: [{ bearerAuth: [] }],
        },
      },
    );
