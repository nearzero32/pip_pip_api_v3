import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import {
  dashboardContext,
  driverContext,
  merchantContext,
} from "../auth/core/context";
import { requireTrustedMerchantStore } from "../auth/merchant/merchant-access";
import { errorResponse, standardErrors } from "../auth/http/shared";
import { authIdentity, requestIdOf } from "../geography/shared";
import type { MediaService } from "../media/media.service";
import type { OrderLifecycleService } from "./order-lifecycle.service";

const uuid = t.String({ format: "uuid" });
const errors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
};
const proofPurpose = t.Union([
  t.Literal("PICKUP_PROOF"),
  t.Literal("DELIVERY_PROOF"),
]);
const proofIntentBody = t.Object(
  {
    assignmentId: uuid,
    purpose: proofPurpose,
    contentType: t.Union([
      t.Literal("image/jpeg"),
      t.Literal("image/png"),
      t.Literal("image/webp"),
    ]),
    fileName: t.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: t.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const confirmation = t.Object(
  {
    fileId: t.Optional(uuid),
    note: t.Optional(t.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const override = t.Object(
  {
    reason: t.String({ minLength: 1, maxLength: 1000 }),
    note: t.Optional(t.String({ maxLength: 1000 })),
    actedOnBehalfOf: t.Union([t.Literal("STORE"), t.Literal("DRIVER")]),
  },
  { additionalProperties: false },
);

export const orderLifecycleRoutes = (
  auth: AuthModule,
  lifecycle: OrderLifecycleService,
  media: MediaService,
) =>
  new Elysia({ name: "order-lifecycle-routes" })
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/mark-ready",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId } = requireTrustedMerchantStore(identity);
        return lifecycle.markReady(identity, params.orderId, {
          kind: "MERCHANT",
          storeId,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "Mark order ready for pickup",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/driver/orders/active-assignment",
      async ({ request, set }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return lifecycle.getDriverActiveAssignment(identity);
      },
      {
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Get active order assignment",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/proofs/upload-intent",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return media.createDriverProofUploadIntent(identity, {
          orderId: params.orderId,
          ...body,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: proofIntentBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Create order proof upload intent",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/proofs/:fileId/confirm",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return media.confirm(identity, params.fileId, requestIdOf(set));
      },
      {
        params: t.Object({ orderId: uuid, fileId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Confirm order proof upload",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/confirm-pickup",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return lifecycle.confirmPickup(identity, params.orderId, body, {
          kind: "DRIVER",
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: confirmation,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Confirm order pickup",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/confirm-arrival",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return lifecycle.confirmArrival(identity, params.orderId, body, {
          kind: "DRIVER",
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: t.Object(
          { note: t.Optional(t.String({ maxLength: 1000 })) },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Confirm customer arrival",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/confirm-delivery",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return lifecycle.confirmDelivery(identity, params.orderId, body, {
          kind: "DRIVER",
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: confirmation,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Confirm order delivery",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/mark-ready",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return lifecycle.markReady(identity, params.orderId, {
          kind: "DASHBOARD",
          ...body,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: override,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Dashboard override: mark ready (source=DASHBOARD_OVERRIDE)",
          description:
            "City-scoped natural transition on behalf of STORE. Records source DASHBOARD_OVERRIDE with required reason. No proof required.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/confirm-pickup",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return lifecycle.confirmPickup(identity, params.orderId, body, {
          kind: "DASHBOARD",
          ...body,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: override,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Dashboard override: confirm pickup (source=DASHBOARD_OVERRIDE)",
          description:
            "City-scoped natural transition on behalf of DRIVER. Records source DASHBOARD_OVERRIDE with required reason. Proof is not required for DASHBOARD_OVERRIDE.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/confirm-arrival",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return lifecycle.confirmArrival(identity, params.orderId, body, {
          kind: "DASHBOARD",
          ...body,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: override,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Override arrival transition",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/confirm-delivery",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return lifecycle.confirmDelivery(identity, params.orderId, body, {
          kind: "DASHBOARD",
          ...body,
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        body: override,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Orders"],
          summary: "Override delivery transition",
          security: [{ bearerAuth: [] }],
        },
      },
    );
