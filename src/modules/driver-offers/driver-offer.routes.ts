import { Elysia, t } from "elysia";
import { AppError } from "../../errors/app-error";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext, driverContext } from "../auth/core/context";
import { errorResponse, standardErrors } from "../auth/http/shared";
import {
  authIdentity,
  dateSchema,
  requestIdOf,
} from "../geography/shared";
import type { CityDriverPricingService } from "./city-driver-pricing.service";
import type { OfferService } from "./offer.service";

const uuid = t.String({ format: "uuid" });
const errors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  429: errorResponse,
};

const pricingStage = t.Object(
  {
    afterSeconds: t.Integer({ minimum: 0 }),
    increasePercentage: t.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const pricingBody = t.Object(
  {
    pricingBase: t.Integer({ exclusiveMinimum: 0 }),
    roundingUnit: t.Integer({ exclusiveMinimum: 0 }),
    pricingStages: t.Array(pricingStage, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const pricingResponse = t.Object({
  id: uuid,
  cityId: uuid,
  version: t.Integer({ minimum: 1 }),
  pricingBase: t.Integer({ exclusiveMinimum: 0 }),
  roundingUnit: t.Integer({ exclusiveMinimum: 0 }),
  pricingStages: t.Array(pricingStage),
  updatedByAccountId: uuid,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const offerRound = t.Object({
  id: uuid,
  orderId: uuid,
  cityId: uuid,
  status: t.Union([
    t.Literal("OPEN"),
    t.Literal("CLAIMED"),
    t.Literal("MANUALLY_ASSIGNED"),
    t.Literal("STOPPED"),
    t.Literal("CANCELLED"),
  ]),
  openedAt: dateSchema,
  closedAt: t.Nullable(dateSchema),
  stoppedAt: t.Nullable(dateSchema),
  stopReason: t.Nullable(t.String()),
  pricingBaseSnapshot: t.Integer({ exclusiveMinimum: 0 }),
  roundingUnitSnapshot: t.Integer({ exclusiveMinimum: 0 }),
  pricingStagesSnapshot: t.Array(pricingStage),
  pricingVersionSnapshot: t.Integer({ minimum: 1 }),
  finalDriverFee: t.Nullable(t.Integer({ exclusiveMinimum: 0 })),
  claimedByDriverId: t.Nullable(uuid),
  createdByAccountId: uuid,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const orderSummary = t.Object({
  orderId: uuid,
  orderNumber: t.String(),
  status: t.String(),
  assignmentSequence: t.Integer({ minimum: 1, maximum: 2 }),
});

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 128 },
} as const;

const idempotencyHeaders = t.Object(
  { "idempotency-key": t.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: true },
);

const idempotencyKeyOf = (request: Request) => {
  const key = request.headers.get("idempotency-key");
  if (!key?.trim())
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "Idempotency-Key header is required",
    );
  return key.trim();
};

export const driverOfferRoutes = (
  auth: AuthModule,
  pricing: CityDriverPricingService,
  offers: OfferService,
) =>
  new Elysia({ name: "driver-offer-routes" })
    .get(
      "/api/v1/dashboard/cities/:cityId/driver-pricing",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return pricing.get(identity, params.cityId);
      },
      {
        params: t.Object({ cityId: uuid }),
        response: { 200: pricingResponse, ...errors },
        detail: {
          tags: ["Dashboard — Driver Pricing"],
          summary: "Get city driver pricing",
          description: "SUPER_ADMIN only.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .put(
      "/api/v1/dashboard/cities/:cityId/driver-pricing",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return pricing.put(
          identity,
          params.cityId,
          {
            pricingBase: body.pricingBase,
            roundingUnit: body.roundingUnit,
            pricingStages: body.pricingStages,
          },
          requestIdOf(set),
          idempotencyKeyOf(request),
        );
      },
      {
        params: t.Object({ cityId: uuid }),
        body: pricingBody,
        headers: idempotencyHeaders,
        response: { 200: pricingResponse, ...errors },
        detail: {
          tags: ["Dashboard — Driver Pricing"],
          summary: "Upsert city driver pricing",
          description: "SUPER_ADMIN only. Upserts one row per city and bumps version.",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/offer-rounds/open",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.openRound(
          identity,
          params.orderId,
          requestIdOf(set),
          idempotencyKeyOf(request),
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        response: { 200: offerRound, ...errors },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "Open an order offer round",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/offer-rounds/stop",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.stopRound(
          identity,
          params.orderId,
          body.reason,
          requestIdOf(set),
          idempotencyKeyOf(request),
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        body: t.Object(
          {
            reason: t.String({ minLength: 1, maxLength: 1000 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: offerRound, ...errors },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "Stop an open offer round",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/offer-rounds/reopen",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.reopenRound(
          identity,
          params.orderId,
          body.reason,
          requestIdOf(set),
          idempotencyKeyOf(request),
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        body: t.Object(
          {
            reason: t.String({ minLength: 1, maxLength: 1000 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: offerRound, ...errors },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "Stop open round if any and open a new one",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/orders/:orderId/offer-rounds",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.listRounds(identity, params.orderId);
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Array(offerRound), ...errors },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "List offer rounds for an order",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/assign-driver",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.assignDriver(
          identity,
          params.orderId,
          {
            driverId: body.driverId,
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          },
          idempotencyKeyOf(request),
          requestIdOf(set),
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        body: t.Object(
          {
            driverId: uuid,
            reason: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({
            assignmentId: uuid,
            orderId: uuid,
            driverId: uuid,
            driverFee: t.Integer({ exclusiveMinimum: 0 }),
            assignmentSequence: t.Integer({ minimum: 1, maximum: 2 }),
            offerRoundId: t.Nullable(uuid),
          }),
          ...errors,
        },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "Manually assign a driver to an order",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/drivers/assignment-candidates",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return offers.listDriverCandidates(
          identity,
          query.page,
          query.limit,
        );
      },
      {
        query: t.Object({
          page: t.Optional(t.Integer({ minimum: 1 })),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        }),
        response: {
          200: t.Object({
            data: t.Array(
              t.Object({
                driverId: uuid,
                driverName: t.String(),
                cityId: uuid,
                eligibilityStatus: t.Union([
                  t.Literal("ELIGIBLE"),
                  t.Literal("INELIGIBLE"),
                ]),
                workStatus: t.Union([
                  t.Literal("AVAILABLE"),
                  t.Literal("BUSY"),
                  t.Literal("OFFLINE"),
                ]),
                activeOrderCount: t.Integer({ minimum: 0 }),
                lastLocation: t.Nullable(
                  t.Object({
                    latitude: t.Number(),
                    longitude: t.Number(),
                  }),
                ),
                lastLocationAt: t.Nullable(dateSchema),
                locationFreshness: t.Union([
                  t.Literal("FRESH"),
                  t.Literal("STALE"),
                  t.Literal("MISSING"),
                ]),
                currentOrderSummary: t.Nullable(orderSummary),
                nextOrderSummary: t.Nullable(orderSummary),
              }),
            ),
            page: t.Integer({ minimum: 1 }),
            limit: t.Integer({ minimum: 1 }),
            total: t.Integer({ minimum: 0 }),
          }),
          ...errors,
        },
        detail: {
          tags: ["Dashboard — Order Offers"],
          summary: "List driver assignment candidates for the signed city",
          description:
            "Locations come only from the realtime Redis cache; missing location is null (API never invents GPS). Order summaries exclude customer PII.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/order-offers/spin",
      async ({ request, set }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return offers.spin(identity);
      },
      {
        response: {
          200: t.Array(
            t.Object({
              offerId: uuid,
              offeredDriverFee: t.Integer({ exclusiveMinimum: 0 }),
            }),
          ),
          ...errors,
        },
        detail: {
          tags: ["Mobile — Driver Offers"],
          summary: "Spin for open order offer cards",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/order-offers/:offerId/claim",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return offers.claim(
          identity,
          params.offerId,
          idempotencyKeyOf(request),
          requestIdOf(set),
        );
      },
      {
        params: t.Object({ offerId: uuid }),
        headers: idempotencyHeaders,
        response: {
          200: t.Object({
            orderId: uuid,
            orderTotal: t.Integer({ minimum: 0 }),
            paymentMethod: t.Union([t.Literal("CASH"), t.Literal("ONLINE")]),
            offeredDriverFee: t.Integer({ exclusiveMinimum: 0 }),
            store: t.Nullable(
              t.Object({
                id: uuid,
                name: t.String(),
                latitude: t.Number(),
                longitude: t.Number(),
              }),
            ),
            customer: t.Object({ phone: t.Nullable(t.String()) }),
            deliveryAddress: t.Nullable(
              t.Object({
                label: t.String(),
                addressDetails: t.String(),
                landmark: t.Nullable(t.String()),
                recipientName: t.Nullable(t.String()),
                recipientPhone: t.Nullable(t.String()),
                latitude: t.Number(),
                longitude: t.Number(),
              }),
            ),
            items: t.Array(
              t.Object({
                id: uuid,
                productName: t.String(),
                quantity: t.Integer({ minimum: 1 }),
                selectedSizeName: t.Nullable(t.String()),
                lineTotal: t.Integer({ exclusiveMinimum: 0 }),
              }),
            ),
          }),
          ...errors,
        },
        detail: {
          tags: ["Mobile — Driver Offers"],
          summary: "Claim an open order offer",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/runtime/availability",
      async ({ request, set, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return offers.setAvailability(identity, body.workStatus);
      },
      {
        body: t.Object(
          {
            workStatus: t.Union([
              t.Literal("AVAILABLE"),
              t.Literal("OFFLINE"),
            ]),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({
            driverId: uuid,
            cityId: uuid,
            workStatus: t.Union([
              t.Literal("AVAILABLE"),
              t.Literal("BUSY"),
              t.Literal("OFFLINE"),
            ]),
            eligibilityStatus: t.Union([
              t.Literal("ELIGIBLE"),
              t.Literal("INELIGIBLE"),
            ]),
            activeOrderCount: t.Integer({ minimum: 0 }),
          }),
          ...errors,
        },
        detail: {
          tags: ["Mobile — Driver Offers"],
          summary: "Set driver availability work status",
          security: [{ bearerAuth: [] }],
        },
      },
    );
