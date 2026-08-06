import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  requestIdOf,
} from "../geography/shared";
import type { StoreCategoryService } from "./store-category.service";

const categoryStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const mutableStatus = t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]);

const storeCategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  parentCategoryId: t.Nullable(t.String({ format: "uuid" })),
  name: t.String(),
  status: categoryStatus,
  displayOrder: t.Integer({ minimum: 0 }),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const listResponse = t.Object({ data: t.Array(storeCategoryDto) });

const storeIdParam = t.Object(
  { storeId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const categoryParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    categoryId: t.String({ format: "uuid" }),
  },
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

const createBodyKeys = new Set([
  "name",
  "parentCategoryId",
  "status",
  "displayOrder",
]);
const patchBodyKeys = new Set([
  "name",
  "parentCategoryId",
  "status",
  "displayOrder",
]);

const parseStoreCategoryBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (
    method === "POST" &&
    /\/dashboard\/stores\/[^/]+\/categories$/.test(path)
  ) {
    assertAllowedBodyKeys(body, createBodyKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/stores\/[^/]+\/categories\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchBodyKeys);
  }
  return body;
};

export const storeCategoryRoutes = (
  auth: AuthModule,
  service: StoreCategoryService,
) =>
  new Elysia({ name: "store-category-routes" })
    .onParse(parseStoreCategoryBody)
    .post(
      "/api/v1/dashboard/stores/:storeId/categories",
      async ({ request, set, params, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          body,
          requestIdOf(set),
        ),
      {
        params: storeIdParam,
        body: t.Object(
          {
            name: t.String({ minLength: 1, maxLength: 100 }),
            parentCategoryId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            status: t.Optional(mutableStatus),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: storeCategoryDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Store Categories"],
          summary: "Create an in-store product category",
          description:
            "Belongs to the path Store which must be in the signed City (`auth.cityId`). parentCategoryId null/omitted creates a main category; a UUID creates a subcategory under a same-Store non-archived root. Maximum depth is two. Do not send cityId or storeId in the body.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/categories",
      async ({ request, set, params, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          query,
        ),
      {
        params: storeIdParam,
        query: t.Object(
          {
            status: t.Optional(categoryStatus),
            parentCategoryId: t.Optional(t.String({ maxLength: 64 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: listResponse, ...listErrors },
        detail: {
          tags: ["Dashboard — Store Categories"],
          summary: "List in-store product categories for a Store",
          description:
            "Flat list with parentCategoryId for hierarchy. Defaults to excluding ARCHIVED. Optional parentCategoryId filters children; use the literal `null` to list roots only. Ordering is deterministic by parent display order then sibling display order.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/categories/:categoryId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.categoryId,
        ),
      {
        params: categoryParams,
        response: { 200: storeCategoryDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Store Categories"],
          summary: "Get an in-store product category",
          description:
            "Cross-City Store or Category identifiers return not-found without leaking foreign City data.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId/categories/:categoryId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.categoryId,
          body,
          requestIdOf(set),
        ),
      {
        params: categoryParams,
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            parentCategoryId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            status: t.Optional(mutableStatus),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: storeCategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Store Categories"],
          summary: "Update an in-store product category",
          description:
            "Omitted fields unchanged. parentCategoryId null promotes to a main category. Setting a parent requires a same-Store non-archived root and forbids third-level depth. A root with non-archived children cannot be demoted. status ARCHIVED is rejected — use DELETE. INACTIVE does not cascade to Products.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/categories/:categoryId",
      async ({ request, set, params }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.categoryId,
          requestIdOf(set),
        ),
      {
        params: categoryParams,
        response: { 200: storeCategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Store Categories"],
          summary: "Soft-archive an in-store product category",
          description:
            "Sets status=ARCHIVED and archived_at. Rejects archiving a main category that still has non-archived children. Cascade soft-archives Products in this category (status+archived_at only; images/sizes/availability rows are kept). Idempotent when already ARCHIVED.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/stores/:storeId/categories",
      async ({ request, params }) => {
        const { city } = await requirePublicCityContext(
          auth.client,
          request,
        );
        return service.listPublic(city.id, params.storeId);
      },
      {
        params: storeIdParam,
        response: {
          200: t.Object({
            data: t.Array(
              t.Object({
                id: t.String({ format: "uuid" }),
                storeId: t.String({ format: "uuid" }),
                parentCategoryId: t.Nullable(t.String({ format: "uuid" })),
                name: t.String(),
                displayOrder: t.Integer({ minimum: 0 }),
              }),
            ),
          }),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          ...standardErrors,
        },
        detail: {
          tags: ["Public — Products"],
          summary: "List public Store Categories",
          description:
            "Requires X-City-Id. Returns ACTIVE categories that contain at least one public-visible Product. Empty, INACTIVE, and ARCHIVED categories are hidden. PAUSED Stores remain browseable.",
          parameters: [
            {
              name: "X-City-Id",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
        },
      },
    );
