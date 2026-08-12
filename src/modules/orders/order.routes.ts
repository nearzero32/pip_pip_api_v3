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
  dateSchema,
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

const orderStatus = t.Union([
  t.Literal("PENDING_STORE_APPROVAL"),
  t.Literal("APPROVED_BY_STORE"),
  t.Literal("SEARCHING_DRIVER"),
  t.Literal("DRIVER_ASSIGNED"),
  t.Literal("READY_FOR_PICKUP"),
  t.Literal("ACCEPTED_BY_DRIVER"),
  t.Literal("PICKED_UP"),
  t.Literal("ARRIVED_AT_CUSTOMER"),
  t.Literal("DELIVERED"),
  t.Literal("CANCELLED"),
]);

const customerOrderItem = t.Object({
  id: uuid,
  productId: uuid,
  selectedSizeId: t.Nullable(uuid),
  productName: t.String(),
  selectedSizeName: t.Nullable(t.String()),
  unitPrice: t.Integer({ exclusiveMinimum: 0 }),
  modifiersPrice: t.Integer({ minimum: 0 }),
  quantity: t.Integer({ minimum: 1, maximum: 99 }),
  lineTotal: t.Integer({ exclusiveMinimum: 0 }),
  state: t.Union([
    t.Literal("ACTIVE"),
    t.Literal("REPLACED"),
    t.Literal("REMOVED"),
  ]),
  replacesOrderItemId: t.Nullable(uuid),
  modifierSelections: t.Array(
    t.Object({
      modifierOptionId: uuid,
      name: t.String(),
      quantity: t.Integer({ minimum: 1 }),
      unitPrice: t.Integer({ minimum: 0 }),
    }),
  ),
  createdAt: dateSchema,
});

const customerOrderFields = {
  id: uuid,
  orderNumber: t.String(),
  cityId: uuid,
  zoneId: uuid,
  storeId: uuid,
  customerAccountId: uuid,
  status: orderStatus,
  custodyStatus: t.Union([
    t.Literal("WITH_STORE"),
    t.Literal("WITH_DRIVER"),
    t.Literal("WITH_CUSTOMER"),
  ]),
  custodyDriverId: t.Nullable(uuid),
  paymentMethod: t.Union([t.Literal("CASH"), t.Literal("ONLINE")]),
  paymentStatus: t.Union([
    t.Literal("UNPAID"),
    t.Literal("AWAITING_PAYMENT"),
    t.Literal("PAID"),
    t.Literal("FAILED"),
  ]),
  productsSubtotal: t.Integer({ minimum: 0 }),
  deliveryFee: t.Integer({ minimum: 0 }),
  total: t.Integer({ minimum: 0 }),
  currency: t.Literal("IQD"),
  version: t.Integer({ minimum: 1 }),
  statusChangedAt: dateSchema,
  deliveredAt: t.Nullable(dateSchema),
  cancelledAt: t.Nullable(dateSchema),
  createdAt: dateSchema,
  updatedAt: dateSchema,
};

const customerOrderSummary = t.Object(customerOrderFields);
const customerOrderDetail = t.Object({
  ...customerOrderFields,
  items: t.Array(customerOrderItem),
});

const replaceBody = t.Object(
  {
    productId: uuid,
    sizeId: t.Optional(t.Union([uuid, t.Null()])),
    quantity: t.Integer({ minimum: 1, maximum: 99 }),
    modifierSelections: t.Optional(t.Array(selection)),
    reason: t.String({ minLength: 1, maxLength: 1000 }),
    customerAgreedByPhone: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);

const cancelBody = t.Object(
  { reason: t.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);
const mutationReasonBody = t.Object(
  { reason: t.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);
const quantityBody = t.Object(
  {
    quantity: t.Integer({ minimum: 1, maximum: 99 }),
    reason: t.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
const addItemBody = t.Object(
  {
    ...createItem.properties,
    reason: t.String({ minLength: 1, maxLength: 1000 }),
  },
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
        }) as any;
      },
      {
        body: createBody,
        response: { 200: customerOrderDetail, ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "Create order",
          description:
            "Creates a City-scoped CASH order in PENDING_STORE_APPROVAL with immutable product, address, and delivery-pricing snapshots. Prices and delivery fee are server-authoritative. Requires idempotencyKey. paymentMethod=ONLINE is rejected with ORDER_ONLINE_PAYMENT_NOT_CONFIRMED until a trusted payment confirmation flow exists; the schema retains ONLINE for that future integration.",
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
        ) as any;
      },
      {
        query: t.Object(pageQuery, { additionalProperties: false }),
        response: { 200: paginated(customerOrderSummary), ...errors },
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
        ) as any;
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: customerOrderDetail, ...errors },
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
        ) as any;
      },
      {
        params: t.Object({ orderId: uuid }),
        body: cancelBody,
        response: { 200: customerOrderDetail, ...errors },
        detail: {
          tags: ["Customer — Orders"],
          summary: "Cancel my order",
          description:
            "Customer may cancel only while PENDING_STORE_APPROVAL. Later states return ORDER_CANCELLATION_NOT_ALLOWED.",
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
          description: "PENDING_STORE_APPROVAL → SEARCHING_DRIVER and atomically opens one offer round. Requires orders.approve.",
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
            "Allowed until READY_FOR_PICKUP. Requires orders.items.replace and a reason.",
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
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/items",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, merchantContext, requestIdOf(set));
        const { storeId } = requireTrustedMerchantStore(identity);
        return service.addItem(identity, params.orderId, body, { kind: "MERCHANT", storeId });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: addItemBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Mobile — Merchant Orders"], summary: "Add order item", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/items/:itemId/remove",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, merchantContext, requestIdOf(set));
        const { storeId } = requireTrustedMerchantStore(identity);
        return service.removeItem(identity, params.orderId, params.itemId, body.reason, { kind: "MERCHANT", storeId });
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: mutationReasonBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Mobile — Merchant Orders"], summary: "Remove order item", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/items/:itemId/quantity",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, merchantContext, requestIdOf(set));
        const { storeId } = requireTrustedMerchantStore(identity);
        return service.changeQuantity(identity, params.orderId, params.itemId, body, { kind: "MERCHANT", storeId });
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: quantityBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Mobile — Merchant Orders"], summary: "Change order item quantity", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/items",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.addItem(identity, params.orderId, body, { kind: "DASHBOARD" });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: addItemBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Dashboard — Orders"], summary: "Add order item", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/items/:itemId/remove",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.removeItem(identity, params.orderId, params.itemId, body.reason, { kind: "DASHBOARD" });
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: mutationReasonBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Dashboard — Orders"], summary: "Remove order item", security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/items/:itemId/quantity",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.changeQuantity(identity, params.orderId, params.itemId, body, { kind: "DASHBOARD" });
      },
      {
        params: t.Object({ orderId: uuid, itemId: uuid }),
        body: quantityBody,
        response: { 200: t.Any(), ...errors },
        detail: { tags: ["Dashboard — Orders"], summary: "Change order item quantity", security: [{ bearerAuth: [] }] },
      },
    );
