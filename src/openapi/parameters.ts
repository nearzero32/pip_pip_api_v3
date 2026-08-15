import { SAMPLE } from "./samples";

export const cityIdHeaderParameter = {
  name: "X-City-Id",
  in: "header" as const,
  required: true,
  description:
    "Canonical public/mobile City selection header. UUID of an ACTIVE City under an ACTIVE Governorate. Not an authentication credential and never overrides Dashboard signed City scope.",
  schema: { type: "string" as const, format: "uuid" as const },
  example: SAMPLE.cityId,
};

export const idempotencyKeyParameter = {
  name: "Idempotency-Key",
  in: "header" as const,
  required: true,
  description: "Client-generated idempotency key for mutating order/offer operations.",
  schema: { type: "string" as const, minLength: 1, maxLength: 128 },
  example: SAMPLE.idempotencyKey,
};

export const requestIdParameter = {
  name: "X-Request-Id",
  in: "header" as const,
  required: false,
  description: "Optional correlation id. Invalid values are replaced by the server.",
  schema: { type: "string" as const },
  example: SAMPLE.requestId,
};
