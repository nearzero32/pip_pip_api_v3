import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
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
import type { ModifierService } from "./modifier.service";

const catalogStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);
const mutableStatus = t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]);

const optionDto = t.Object({
  id: t.String({ format: "uuid" }),
  modifierGroupId: t.String({ format: "uuid" }),
  name: t.String(),
  isAvailable: t.Boolean(),
  displayOrder: t.Integer({ minimum: 0 }),
  status: catalogStatus,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const groupDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  name: t.String(),
  minSelect: t.Integer({ minimum: 0 }),
  maxSelect: t.Integer({ minimum: 1 }),
  status: catalogStatus,
  options: t.Array(optionDto),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const productModifierOptionDto = t.Object({
  id: t.String({ format: "uuid" }),
  productId: t.String({ format: "uuid" }),
  modifierOptionId: t.String({ format: "uuid" }),
  name: t.String(),
  price: t.Integer({ minimum: 0 }),
  isAvailable: t.Boolean(),
  isDefault: t.Boolean(),
  maxQuantity: t.Integer({ minimum: 1 }),
  optionIsAvailable: t.Boolean(),
  optionStatus: catalogStatus,
  displayOrder: t.Integer({ minimum: 0 }),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const productModifiersDto = t.Object({
  productId: t.String({ format: "uuid" }),
  productStatus: t.String(),
  productIsAvailable: t.Boolean(),
  modifierGroupId: t.Nullable(t.String({ format: "uuid" })),
  group: t.Nullable(groupDto),
  options: t.Array(productModifierOptionDto),
});

const publicModifiersDto = t.Object({
  productId: t.String({ format: "uuid" }),
  group: t.Nullable(
    t.Object({
      id: t.String({ format: "uuid" }),
      name: t.String(),
      minSelect: t.Integer({ minimum: 0 }),
      maxSelect: t.Integer({ minimum: 1 }),
    }),
  ),
  options: t.Array(
    t.Object({
      modifierOptionId: t.String({ format: "uuid" }),
      name: t.String(),
      price: t.Integer({ minimum: 0 }),
      isDefault: t.Boolean(),
      maxQuantity: t.Integer({ minimum: 1 }),
      displayOrder: t.Integer({ minimum: 0 }),
      isAvailable: t.Boolean(),
      isSelectable: t.Boolean(),
    }),
  ),
});

const optionInput = t.Object(
  {
    name: t.String({ minLength: 1, maxLength: 100 }),
    isAvailable: t.Optional(t.Boolean()),
    displayOrder: t.Optional(t.Integer({ minimum: 0 })),
    status: t.Optional(mutableStatus),
  },
  { additionalProperties: false },
);

const storeIdParam = t.Object(
  { storeId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const groupParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    groupId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
const optionParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    groupId: t.String({ format: "uuid" }),
    optionId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
const productParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    productId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
const productOptionParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    productId: t.String({ format: "uuid" }),
    optionId: t.String({ format: "uuid" }),
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
const publicErrors = {
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
};

const cityIdHeaderParam = {
  $ref: "#/components/parameters/CityIdHeader",
};

const createGroupKeys = new Set([
  "name",
  "minSelect",
  "maxSelect",
  "status",
  "options",
]);
const patchGroupKeys = new Set(["name", "minSelect", "maxSelect", "status"]);
const optionBodyKeys = new Set([
  "name",
  "isAvailable",
  "displayOrder",
  "status",
]);
const productModifierKeys = new Set([
  "price",
  "isAvailable",
  "isDefault",
  "maxQuantity",
]);

const parseModifierBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (
    method === "POST" &&
    /\/dashboard\/stores\/[^/]+\/modifier-groups$/.test(path)
  ) {
    assertAllowedBodyKeys(body, createGroupKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/stores\/[^/]+\/modifier-groups\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchGroupKeys);
  }
  if (
    method === "POST" &&
    /\/dashboard\/stores\/[^/]+\/modifier-groups\/[^/]+\/options$/.test(path)
  ) {
    assertAllowedBodyKeys(body, optionBodyKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/stores\/[^/]+\/modifier-groups\/[^/]+\/options\/[^/]+$/.test(
      path,
    )
  ) {
    assertAllowedBodyKeys(body, optionBodyKeys);
  }
  if (
    (method === "PUT" || method === "PATCH") &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/modifiers\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, productModifierKeys);
  }
  return body;
};

export const modifierRoutes = (auth: AuthModule, service: ModifierService) =>
  new Elysia({ name: "modifier-routes" })
    .onParse(parseModifierBody)
    .post(
      "/api/v1/dashboard/stores/:storeId/modifier-groups",
      async ({ request, set, params, body }) =>
        service.createGroup(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          body,
          requestIdOf(set),
        ),
      {
        params: storeIdParam,
        parse: "json",
        body: t.Object(
          {
            name: t.String({ minLength: 1, maxLength: 100 }),
            minSelect: t.Optional(t.Integer({ minimum: 0 })),
            maxSelect: t.Optional(t.Integer({ minimum: 1 })),
            status: t.Optional(mutableStatus),
            options: t.Array(optionInput, { minItems: 1 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: groupDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Create a Modifier Group with initial Options",
          description:
            "Atomic create of Group + ≥1 Options. Option names are unique store-wide (normalized). Do not send cityId or storeId.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/modifier-groups",
      async ({ request, set, params, query }) =>
        service.listGroups(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          query,
        ),
      {
        params: storeIdParam,
        query: t.Object(
          {
            page: pageQuery.page,
            limit: pageQuery.limit,
            search: pageQuery.search,
            status: t.Optional(catalogStatus),
          },
          { additionalProperties: false },
        ),
        response: { 200: paginated(groupDto), ...listErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "List Modifier Groups for a Store",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId",
      async ({ request, set, params }) =>
        service.getGroup(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
        ),
      {
        params: groupParams,
        response: { 200: groupDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Get a Modifier Group",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId",
      async ({ request, set, params, body }) =>
        service.updateGroup(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          body,
          requestIdOf(set),
        ),
      {
        params: groupParams,
        parse: "json",
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            minSelect: t.Optional(t.Integer({ minimum: 0 })),
            maxSelect: t.Optional(t.Integer({ minimum: 1 })),
            status: t.Optional(mutableStatus),
          },
          { additionalProperties: false },
        ),
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Update a Modifier Group",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId",
      async ({ request, set, params }) =>
        service.archiveGroup(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          requestIdOf(set),
        ),
      {
        params: groupParams,
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Soft-archive a Modifier Group",
          description:
            "Products remain available; modifiers disappear from public/current configuration. ProductModifierOption rows are preserved.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId/restore",
      async ({ request, set, params }) =>
        service.restoreGroup(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          requestIdOf(set),
        ),
      {
        params: groupParams,
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Restore an archived Modifier Group",
          description:
            "Fails with MODIFIER_GROUP_NAME_CONFLICT if another non-archived Group has the same normalized Store name.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId/options",
      async ({ request, set, params, body }) =>
        service.addOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          body,
          requestIdOf(set),
        ),
      {
        params: groupParams,
        parse: "json",
        body: optionInput,
        response: { 200: groupDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Add an Option to a Modifier Group",
          description:
            "Does not automatically configure ProductModifierOption on existing Products.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId/options/:optionId",
      async ({ request, set, params, body }) =>
        service.updateOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          params.optionId,
          body,
          requestIdOf(set),
        ),
      {
        params: optionParams,
        parse: "json",
        body: t.Object(
          {
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            isAvailable: t.Optional(t.Boolean()),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            status: t.Optional(mutableStatus),
          },
          { additionalProperties: false },
        ),
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Update a Modifier Option",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId/options/:optionId",
      async ({ request, set, params }) =>
        service.archiveOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          params.optionId,
          requestIdOf(set),
        ),
      {
        params: optionParams,
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Soft-archive a Modifier Option",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/stores/:storeId/modifier-groups/:groupId/options/:optionId/restore",
      async ({ request, set, params }) =>
        service.restoreOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.groupId,
          params.optionId,
          requestIdOf(set),
        ),
      {
        params: optionParams,
        response: { 200: groupDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Restore an archived Modifier Option",
          description:
            "Fails with MODIFIER_OPTION_NAME_CONFLICT if another non-archived Option has the same normalized Store name.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/products/:productId/modifiers",
      async ({ request, set, params }) =>
        service.getProductModifiers(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
        ),
      {
        params: productParams,
        response: { 200: productModifiersDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Get Product modifier configuration for the CURRENT Group",
          description:
            "Returns only ProductModifierOption rows whose Option belongs to the Product's current modifierGroupId. Preserved configs from previous Groups are not leaked.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .put(
      "/api/v1/dashboard/stores/:storeId/products/:productId/modifiers/:optionId",
      async ({ request, set, params, body }) =>
        service.upsertProductModifierOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          params.optionId,
          body,
          requestIdOf(set),
        ),
      {
        params: productOptionParams,
        parse: "json",
        body: t.Object(
          {
            price: t.Optional(t.Integer({ minimum: 0 })),
            isAvailable: t.Optional(t.Boolean()),
            isDefault: t.Optional(t.Boolean()),
            maxQuantity: t.Optional(t.Integer()),
          },
          { additionalProperties: false },
        ),
        response: { 200: productModifiersDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Configure a ProductModifierOption",
          description:
            "Option must belong to the Product's current ModifierGroup. isDefault requires price=0. Defaults cannot exceed Group maxSelect.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/products/:productId/modifiers/:optionId",
      async ({ request, set, params }) =>
        service.removeProductModifierOption(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          params.optionId,
          requestIdOf(set),
        ),
      {
        params: productOptionParams,
        response: { 200: productModifiersDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Modifiers"],
          summary: "Remove ProductModifierOption configuration",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/stores/:storeId/products/:productId/modifiers",
      async ({ request, params }) =>
        service.publicProductModifiers(
          request,
          params.storeId,
          params.productId,
        ),
      {
        params: productParams,
        response: { 200: publicModifiersDto, ...publicErrors },
        detail: {
          tags: ["Public — Products"],
          summary: "Public effective Product modifiers",
          description:
            "Requires X-City-Id. Returns only current-Group configured Options that are ACTIVE (not archived). Temporarily unavailable Options remain visible with isAvailable/isSelectable=false. Insufficient available Options never hide the Product.",
          parameters: [cityIdHeaderParam],
        },
      },
    );
