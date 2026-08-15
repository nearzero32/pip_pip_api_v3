import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import { customerContext } from "../auth/core/context";
import { errorResponse, standardErrors } from "../auth/http/shared";
import { authIdentity, dateSchema, requestIdOf } from "../geography/shared";
import type { CustomerAddressService } from "./customer-address.service";
import { MAX_ADDRESSES_PER_CUSTOMER_CITY } from "./customer-address.service";

const locationSchema = t.Object(
  {
    latitude: t.Number({ minimum: -90, maximum: 90 }),
    longitude: t.Number({ minimum: -180, maximum: 180 }),
  },
  { additionalProperties: false },
);

const zoneSchema = t.Nullable(
  t.Object(
    {
      id: t.String({ format: "uuid" }),
      name: t.String(),
    },
    { additionalProperties: false },
  ),
);

const addressResponse = t.Object(
  {
    id: t.String({ format: "uuid" }),
    label: t.String(),
    location: locationSchema,
    addressDetails: t.String(),
    landmark: t.Nullable(t.String()),
    recipientName: t.Nullable(t.String()),
    recipientPhone: t.Nullable(t.String()),
    isDefault: t.Boolean(),
    deliveryAvailable: t.Boolean(),
    zone: zoneSchema,
    createdAt: dateSchema,
    updatedAt: dateSchema,
  },
  { additionalProperties: false },
);

const addressListResponse = t.Object(
  { data: t.Array(addressResponse) },
  { additionalProperties: false },
);

const deletedResponse = t.Object(
  { deleted: t.Literal(true) },
  { additionalProperties: false },
);

const createBody = t.Object(
  {
    label: t.String({ minLength: 1, maxLength: 100 }),
    location: locationSchema,
    addressDetails: t.String({ minLength: 1, maxLength: 500 }),
    landmark: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 200 }), t.Null()])),
    recipientName: t.Optional(
      t.Union([t.String({ minLength: 1, maxLength: 100 }), t.Null()]),
    ),
    recipientPhone: t.Optional(t.Union([t.String({ maxLength: 32 }), t.Null()])),
  },
  { additionalProperties: false },
);

const updateBody = t.Object(
  {
    label: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    location: t.Optional(locationSchema),
    addressDetails: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
    landmark: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 200 }), t.Null()])),
    recipientName: t.Optional(
      t.Union([t.String({ minLength: 1, maxLength: 100 }), t.Null()]),
    ),
    recipientPhone: t.Optional(t.Union([t.String({ maxLength: 32 }), t.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);

const addressIdParam = t.Object({ addressId: t.String({ format: "uuid" }) });

const errors = {
  ...standardErrors,
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
};

const cityParameter = {
  name: "X-City-Id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const tag = "Customer — Addresses";

const descriptionBase =
  `Customer Saved Addresses for the authenticated Customer and trusted X-City-Id City. ` +
  `Maximum ${MAX_ADDRESSES_PER_CUSTOMER_CITY} addresses per Customer per City. ` +
  `location is the authoritative Point (API latitude/longitude; stored as POINT(longitude latitude) SRID 4326). ` +
  `deliveryAvailable and zone are computed at read time via ST_Covers against current ACTIVE non-archived Zones; ` +
  `addresses outside Zones remain valid. Zone is never persisted on the address. ` +
  `First address in a City becomes default automatically. At most one default per Customer + City.`;

export const customerAddressRoutes = (
  auth: AuthModule,
  service: CustomerAddressService,
) =>
  new Elysia({ name: "customer-address-routes" })
    .post(
      "/api/v1/mobile/customer/addresses",
      async ({ request, set, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.create(identity.accountId, city.id, body);
      },
      {
        parse: "json",
        body: createBody,
        response: { 200: addressResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "Create a Saved Address",
          description:
            descriptionBase +
            " Creating outside ACTIVE Zones is allowed. customerAccountId/cityId/zoneId/deliveryAvailable from the body are ignored/rejected via schema.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .get(
      "/api/v1/mobile/customer/addresses",
      async ({ request, set }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.list(identity.accountId, city.id);
      },
      {
        response: { 200: addressListResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "List Saved Addresses",
          description:
            descriptionBase +
            " Returns only addresses for the authenticated Customer and current City. Zone availability is resolved in one query (LATERAL join), not N+1.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .get(
      "/api/v1/mobile/customer/addresses/:addressId",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.get(identity.accountId, city.id, params.addressId);
      },
      {
        params: addressIdParam,
        response: { 200: addressResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "Get a Saved Address",
          description:
            descriptionBase +
            " Cross-owner and cross-City address IDs return ADDRESS_NOT_FOUND (404).",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .patch(
      "/api/v1/mobile/customer/addresses/:addressId",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.update(
          identity.accountId,
          city.id,
          params.addressId,
          body,
        );
      },
      {
        params: addressIdParam,
        parse: "json",
        body: updateBody,
        response: { 200: addressResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "Update a Saved Address",
          description:
            descriptionBase +
            " PATCH may change label, location, addressDetails, landmark, recipientName, and recipientPhone. " +
            "Send null to clear optional nullable fields. Owner and City cannot change. Default changes use the dedicated /default endpoint.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .patch(
      "/api/v1/mobile/customer/addresses/:addressId/default",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.setDefault(
          identity.accountId,
          city.id,
          params.addressId,
        );
      },
      {
        params: addressIdParam,
        response: { 200: addressResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "Set default Saved Address",
          description:
            descriptionBase +
            " Atomically clears the previous default in this Customer + City and sets this address as default. Idempotent when already default.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    )
    .delete(
      "/api/v1/mobile/customer/addresses/:addressId",
      async ({ request, set, params }) => {
        const identity = await authIdentity(
          auth,
          request,
          customerContext,
          requestIdOf(set),
        );
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.remove(
          identity.accountId,
          city.id,
          params.addressId,
        );
      },
      {
        params: addressIdParam,
        response: { 200: deletedResponse, ...errors },
        detail: {
          tags: [tag],
          summary: "Delete a Saved Address",
          description:
            descriptionBase +
            " Hard delete. If the deleted address was default and others remain, the oldest remaining address (created_at asc, id asc) becomes default in the same transaction.",
          security: [{ bearerAuth: [] }],
          parameters: [cityParameter],
        },
      },
    );
