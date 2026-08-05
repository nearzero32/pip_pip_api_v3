import { openapi } from "@elysiajs/openapi";

/** Fresh plugin per app instance — Elysia OpenAPI state is not safe to reuse across createApp calls. */
export const createOpenApiPlugin = () =>
  openapi({
  path: "/openapi",
  specPath: "/openapi/json",
  documentation: {
    info: {
      title: "pip_pip_api_v3",
      version: "0.2.0",
      description: "Identity, authentication, and session security API",
    },
    tags: [
      { name: "Health", description: "Runtime health probes" },
      {
        name: "Mobile — Customer Authentication",
        description: "Customer phone OTP authentication",
      },
      {
        name: "Mobile — Driver Authentication",
        description: "Driver phone and numeric access-code authentication",
      },
      {
        name: "Dashboard — Authentication",
        description: "Dashboard email and password authentication",
      },
      {
        name: "Dashboard — Staff",
        description:
          "SUPER_ADMIN ADMIN management and ADMIN employee management",
      },
      {
        name: "Dashboard — Governorates",
        description: "Governorate administration",
      },
      { name: "Dashboard — Cities", description: "City administration" },
      {
        name: "Dashboard — Zones",
        description:
          "City-scoped Zone administration for ADMIN and granted employees. SUPER_ADMIN has no Zone access.",
      },
      {
        name: "Dashboard — Media",
        description:
          "City-scoped media upload intents, confirmation, and deletion for ADMIN and granted employees. SUPER_ADMIN has no Media access. Direct browser-to-R2 uploads via short-lived presigned PUT URLs.",
      },
      {
        name: "Dashboard — Main Categories",
        description:
          "City-scoped Main Category administration for ADMIN and granted employees. SUPER_ADMIN has no Main Category access. Images are mandatory CATEGORY_IMAGE media assets.",
      },
      {
        name: "Dashboard — Subcategories",
        description:
          "City-scoped Subcategory administration under Main Categories for ADMIN and granted employees. SUPER_ADMIN has no Subcategory access. Images are optional CATEGORY_IMAGE media assets.",
      },
      {
        name: "Dashboard — Stores",
        description:
          "City-scoped Store administration for ADMIN and granted employees. SUPER_ADMIN has no Store access. City comes only from signed auth.cityId. Physical location and service Zones are separate. Weekly working hours support overnight periods in Asia/Baghdad.",
      },
      {
        name: "Dashboard — Store Categories",
        description:
          "In-store product category administration under a Store for ADMIN and granted employees. SUPER_ADMIN has no Store Category access. Optional two-level hierarchy only. Not the global categories used to classify Stores.",
      },
      {
        name: "Public — Geography",
        description:
          "Unauthenticated geography reads for pre-login City selection and City-scoped Zone lookup via X-City-Id",
      },
      {
        name: "Public — Main Categories",
        description:
          "Unauthenticated Main Category catalog for the City selected by X-City-Id",
      },
      {
        name: "Public — Subcategories",
        description:
          "Unauthenticated Subcategory catalog for a Main Category in the City selected by X-City-Id",
      },
      {
        name: "Public — Stores",
        description:
          "Unauthenticated Store discovery for the City selected by X-City-Id. Visibility is based on service Zones (store_zones), not physical Store proximity. Closed and PAUSED Stores remain listed with computed availability.",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      parameters: {
        CityIdHeader: {
          name: "X-City-Id",
          in: "header",
          required: true,
          description:
            "Canonical public/mobile City selection header. UUID of an ACTIVE City under an ACTIVE Governorate. Not an authentication credential and never overrides Dashboard signed City scope.",
          schema: { type: "string", format: "uuid" },
        },
      },
    },
  },
});
