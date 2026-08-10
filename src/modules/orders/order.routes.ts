import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  customerContext,
  dashboardContext,
  merchantContext,
} from "../auth/core/context";
import { errorResponse, standardErrors } from "../auth/http/shared";
import { requireTrustedMerchantStore } from "../auth/merchant/merchant-access";
import {
  authIdentity,
  pageQuery,
  paginated,
  requestIdOf,
} from "../geography/shared";
import type { OrderService } from "./order.service";

const uuid = t.String({ format: "uuid" });
const errors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const cityParameter = {
  name: "X-City-Id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const selection = t.Object(
  {
    modifierOptionId: uuid,
    quantity: t.Optional(t.Integer({ minimum: 1, maximum: 99 })),
  },
  { additionalProperties: false },
);
const createItem = t.Object(
  {
    productId: uuid,
    sizeId: t.Optional(t.Union([uuid, t.Null()])),
    quantity: t.Integer({ minimum: 1, maximum: 99 }),
    modifierSelections: t.Optional(t.Array(selection)),
  },
  { additionalProperties: false },
);
const createBody = t.Object(
  {
    storeId: uuid,
    addressId: uuid,
    paymentMethod: t.Union([t.Literal("CASH"), t.Literal("ONLINE")]),
    items: t.Array(createItem, { minItems: 1 }),
    idempotencyKey: t.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

const replaceBody = t.Object(
  {
    productId: uuid,
    sizeId: t.Optional(t.Union([uuid, t.Null()])),
    quantity: t.Integer({ minimum: 1, maximum: 99 }),
    modifierSelections: t.Optional(t.Array(selection)),
    reason: t.String({ minLength: 1, maxLength: 1000 }),
    customerAgreedByPhone: t.Literal(true),
  },
  { additionalProperties: false },
);

const cancelBody = t.Object(
  { reason: t.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);

export const orderRoutes = (auth: AuthModule, service: OrderService) =>
  new Elysia({ name: "order-routes" })
    .post(
      "/api/v1/mobile/customer/orders",
      async ({ request, set, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.create(identity.accountId, city.id, {
          ...body,
          requestId: requestIdOf(set),
        });
      },
      {
        body: createBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "Create order",
          description:
            "Creates a City-scoped order in UNDER_STORE_REVIEW with immutable product, address, and delivery-pricing snapshots. Prices and delivery fee are server-authoritative. Requires idempotencyKey. ONLINE orders are created as AWAITING_PAYMENT until a future verified payment confirmation exists.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .get(
      "/api/v1/mobile/customer/orders",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.listForCustomer(
          identity.accountId,
          city.id,
          query.page,
          query.limit,
        );
      },
      {
        query: t.Object(pageQuery, { additionalProperties: false }),
        response: { 200: paginated(t.Any()), ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "List my orders",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .get(
      "/api/v1/mobile/customer/orders/:orderId",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.getForCustomer(
          identity.accountId,
          city.id,
          params.orderId,
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "Get my order",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .post(
      "/api/v1/mobile/customer/orders/:orderId/cancel",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.cancelByCustomer(
          identity.accountId,
          city.id,
          params.orderId,
          body.reason,
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        body: cancelBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "Cancel my order",
          description:
            "Customer may cancel only while UNDER_STORE_REVIEW. After APPROVED_BY_STORE this returns ORDER_CANCELLATION_NOT_ALLOWED.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .get(
      "/api/v1/dashboard/orders",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.listForDashboard(identity, query.page, query.limit);
      },
      {
        query: t.Object(pageQuery, { additionalProperties: false }),
        response: { 200: paginated(t.Any()), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "List City orders",
          description: "ADMIN or employees with orders.read. SUPER_ADMIN is blocked.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/orders/:orderId",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.getForDashboard(identity, params.orderId);
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Get City order details",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/cancel",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.cancelByDashboard(identity, params.orderId, body.reason);
      },
      {
        params: t.Object({ orderId: uuid }),
        body: cancelBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Cancel City order",
          description: "Requires orders.cancel. Reason is mandatory.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/approve",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.approve(identity, params.orderId, { kind: "DASHBOARD" });
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Approve order",
          description: "UNDER_STORE_REVIEW → APPROVED_BY_STORE. Requires orders.approve.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/items/:itemId/replace",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.replaceItem(
          identity,
          params.orderId,
          params.itemId,
          body,
          { kind: "DASHBOARD" },
        );
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: replaceBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Replace order item",
          description:
            "Only while UNDER_STORE_REVIEW. Requires orders.items.replace and customerAgreedByPhone=true.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/merchant/orders",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId, cityId } = requireTrustedMerchantStore(identity);
        return service.listForStore(storeId, cityId, query.page, query.limit);
      },
      {
        query: t.Object(pageQuery, { additionalProperties: false }),
        response: { 200: paginated(t.Any()), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "List store orders",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/merchant/orders/:orderId",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId, cityId } = requireTrustedMerchantStore(identity);
        return service.getForStore(storeId, cityId, params.orderId);
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "Get store order",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/approve",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId } = requireTrustedMerchantStore(identity);
        return service.approve(identity, params.orderId, {
          kind: "MERCHANT",
          storeId,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "Approve store order",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/items/:itemId/replace",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId } = requireTrustedMerchantStore(identity);
        return service.replaceItem(
          identity,
          params.orderId,
          params.itemId,
          body,
          { kind: "MERCHANT", storeId },
        );
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: replaceBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "Replace store order item",
          security: [{ bearerAuth: [] }],
        },
      },
    );
