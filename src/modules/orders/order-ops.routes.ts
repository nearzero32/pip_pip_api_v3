import { Elysia, t } from "elysia";
import { AppError } from "../../errors/app-error";
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
import type { OrderOpsService } from "./order-ops.service";

const uuid = t.String({ format: "uuid" });
const errors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
};
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
    throw new AppError(422, "VALIDATION_FAILED", "Idempotency-Key header is required");
  return key.trim();
};

const reasonBody = t.Object(
  {
    reason: t.String({ minLength: 1, maxLength: 1000 }),
    note: t.Optional(t.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const orderOpsRoutes = (
  auth: AuthModule,
  ops: OrderOpsService,
  media: MediaService,
) =>
  new Elysia({ name: "order-ops-routes" })
    .post(
      "/api/v1/dashboard/orders/:orderId/remove-driver",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.removeDriverBeforePickup(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            reason: t.String({ minLength: 1, maxLength: 1000 }),
            note: t.Optional(t.String({ maxLength: 1000 })),
            nextAction: t.Union([
              t.Literal("REOFFER"),
              t.Literal("ASSIGN_DRIVER"),
            ]),
            driverId: t.Optional(uuid),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Remove driver before pickup",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/reoffer",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.reofferAfterPickup(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: reasonBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Reoffer replacement driver after pickup",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/assign-replacement",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.startHandoffAssign(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            driverId: uuid,
            reason: t.String({ minLength: 1, maxLength: 1000 }),
            note: t.Optional(t.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Start handoff with direct driver assign",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/handoffs/start",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.startHandoffAssign(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            driverId: uuid,
            reason: t.String({ minLength: 1, maxLength: 1000 }),
            note: t.Optional(t.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Start driver handoff",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/handoffs/:handoffId/cancel",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.cancelHandoff(identity, params.orderId, params.handoffId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid, handoffId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: reasonBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Cancel pending handoff",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/handoffs/:handoffId/complete",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.completeHandoff(
          identity,
          params.orderId,
          params.handoffId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "DASHBOARD" },
        );
      },
      {
        params: t.Object({ orderId: uuid, handoffId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            reason: t.String({ minLength: 1, maxLength: 1000 }),
            note: t.Optional(t.String({ maxLength: 1000 })),
            actedOnBehalfOf: t.Optional(t.Literal("DRIVER")),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Complete handoff (dashboard override)",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/returns/start",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.startReturnToStore(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: reasonBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Start operational return to store without commercial cancel",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/returns/confirm-driver",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.confirmDriverReturn(
          identity,
          params.orderId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "DASHBOARD" },
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: reasonBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Confirm driver return (dashboard override)",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/returns/confirm-store",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.confirmStoreReturn(
          identity,
          params.orderId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "DASHBOARD" },
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: reasonBody,
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Confirm store return (dashboard override)",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/orders/:orderId/reopen",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return ops.reopenOrder(identity, params.orderId, {
          ...body,
          idempotencyKey: idempotencyKeyOf(request),
        });
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            reason: t.String({ minLength: 1, maxLength: 1000 }),
            note: t.Optional(t.String({ maxLength: 1000 })),
            nextAction: t.Union([
              t.Literal("KEEP_CANCELLED"),
              t.Literal("PREPARE"),
              t.Literal("REOFFER"),
              t.Literal("ASSIGN_DRIVER"),
            ]),
            driverId: t.Optional(uuid),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Dashboard — Order Ops"],
          summary: "Reopen cancelled order after return",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/driver/orders/:orderId/ops",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return ops.getDriverOps(identity, params.orderId);
      },
      {
        params: t.Object({ orderId: uuid }),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Get driver ops state for an order",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/handoffs/:handoffId/complete",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return ops.completeHandoff(
          identity,
          params.orderId,
          params.handoffId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "DRIVER" },
        );
      },
      {
        params: t.Object({ orderId: uuid, handoffId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            fileId: uuid,
            note: t.Optional(t.String({ maxLength: 1000 })),
            assignmentId: t.Optional(uuid),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Complete handoff with proof",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/returns/confirm",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          driverContext,
          requestIdOf(set),
        );
        return ops.confirmDriverReturn(
          identity,
          params.orderId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "DRIVER" },
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            fileId: uuid,
            note: t.Optional(t.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Confirm driver return with proof",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/driver/orders/:orderId/proofs/ops-upload-intent",
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
        parse: "json",
        body: t.Object(
          {
            assignmentId: uuid,
            purpose: t.Union([
              t.Literal("HANDOFF_PROOF"),
              t.Literal("RETURN_PROOF"),
            ]),
            contentType: t.Union([
              t.Literal("image/jpeg"),
              t.Literal("image/png"),
              t.Literal("image/webp"),
            ]),
            fileName: t.String({ minLength: 1, maxLength: 255 }),
            sizeBytes: t.Integer({ minimum: 1 }),
            handoffId: t.Optional(uuid),
            returnWorkflowId: t.Optional(uuid),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Driver Orders"],
          summary: "Create handoff/return proof upload intent",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/mobile/merchant/orders/returns",
      async ({ request, set, query }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        return ops.listStorePendingReturns(
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
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "List pending store return confirmations",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/orders/:orderId/returns/confirm",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          merchantContext,
          requestIdOf(set),
        );
        const { storeId } = requireTrustedMerchantStore(identity);
        return ops.confirmStoreReturn(
          identity,
          params.orderId,
          { ...body, idempotencyKey: idempotencyKeyOf(request) },
          { kind: "MERCHANT", storeId },
        );
      },
      {
        params: t.Object({ orderId: uuid }),
        headers: idempotencyHeaders,
        parse: "json",
        body: t.Object(
          {
            note: t.Optional(t.String({ maxLength: 1000 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: ["Mobile — Merchant Orders"],
          summary: "Confirm store received returned order",
          parameters: [idempotencyHeader],
          security: [{ bearerAuth: [] }],
        },
      },
    );
