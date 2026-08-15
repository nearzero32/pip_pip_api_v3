import { SAMPLE } from "./samples";

type JsonSchema = Record<string, unknown>;

const paramExamples: Record<string, unknown> = {
  cityId: SAMPLE.cityId,
  governorateId: SAMPLE.governorateId,
  zoneId: SAMPLE.zoneId,
  storeId: SAMPLE.storeId,
  productId: SAMPLE.productId,
  sizeId: SAMPLE.sizeId,
  categoryId: SAMPLE.categoryId,
  subcategoryId: SAMPLE.subcategoryId,
  mainCategoryId: SAMPLE.mainCategoryId,
  storeCategoryId: SAMPLE.storeCategoryId,
  modifierGroupId: SAMPLE.modifierGroupId,
  modifierOptionId: SAMPLE.modifierOptionId,
  assetId: SAMPLE.mediaAssetId,
  fileId: SAMPLE.mediaAssetId,
  accountId: SAMPLE.accountId,
  adminId: SAMPLE.adminId,
  employeeId: SAMPLE.employeeId,
  sessionId: SAMPLE.sessionId,
  orderId: SAMPLE.orderId,
  itemId: SAMPLE.orderItemId,
  addressId: SAMPLE.addressId,
  offerId: SAMPLE.offerId,
  assignmentId: SAMPLE.assignmentId,
  versionId: SAMPLE.pricingVersionId,
  page: 1,
  limit: 20,
  search: "baghdad",
  status: "ACTIVE",
  from: SAMPLE.instant,
  to: SAMPLE.instant,
  latitude: SAMPLE.baghdadLat,
  longitude: SAMPLE.baghdadLng,
  "X-City-Id": SAMPLE.cityId,
  "Idempotency-Key": SAMPLE.idempotencyKey,
  "X-Request-Id": SAMPLE.requestId,
  "idempotency-key": SAMPLE.idempotencyKey,
};

const audienceByPath = (path: string): string | undefined => {
  if (path.includes("/dashboard/auth")) return "DASHBOARD";
  if (path.includes("/mobile/driver/")) return "DRIVER_APP";
  if (path.includes("/mobile/merchant/")) return "MERCHANT_APP";
  if (path.includes("/mobile/customer/")) return "CUSTOMER_APP";
  return undefined;
};

const resolveRef = (
  schema: unknown,
  components: Record<string, unknown> | undefined,
  seen: Set<string>,
): JsonSchema | undefined => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as JsonSchema;
  const ref = record.$ref;
  if (typeof ref !== "string") return record;
  const name = ref.slice(ref.lastIndexOf("/") + 1);
  if (seen.has(ref)) return record;
  seen.add(ref);
  const target = (components ?? {})[name];
  return resolveRef(target, components, seen) ?? record;
};

const exampleFromSchema = (
  schema: unknown,
  components: Record<string, unknown> | undefined,
  propertyName?: string,
  path?: string,
): unknown => {
  const resolved = resolveRef(schema, components, new Set());
  if (!resolved) return null;
  if (resolved.example !== undefined) return resolved.example;
  if (Array.isArray(resolved.examples) && resolved.examples.length)
    return resolved.examples[0];
  if (Array.isArray(resolved.enum) && resolved.enum.length) {
    if (propertyName === "application_type" && path) {
      return audienceByPath(path) ?? resolved.enum[0];
    }
    return resolved.enum[0];
  }
  if (resolved.const !== undefined) return resolved.const;
  const anyOf = resolved.anyOf ?? resolved.oneOf;
  if (Array.isArray(anyOf) && anyOf.length) {
    const nonNull = anyOf.find(
      (item) => item && typeof item === "object" && (item as JsonSchema).type !== "null",
    );
    return exampleFromSchema(nonNull ?? anyOf[0], components, propertyName, path);
  }
  const type = resolved.type;
  if (type === "object" || resolved.properties) {
    const properties = (resolved.properties ?? {}) as Record<string, unknown>;
    const required = new Set(
      Array.isArray(resolved.required) ? (resolved.required as string[]) : Object.keys(properties),
    );
    const object: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(properties)) {
      if (!required.has(name) && !shouldIncludeOptional(name)) continue;
      object[name] = exampleFromSchema(property, components, name, path);
    }
    return object;
  }
  if (type === "array") {
    const item = exampleFromSchema(resolved.items, components, propertyName, path);
    return item === undefined ? [] : [item];
  }
  if (type === "boolean") return true;
  if (type === "integer" || resolved.format === "integer") {
    if (typeof resolved.exclusiveMinimum === "number")
      return Math.max(1, Math.floor(resolved.exclusiveMinimum) + 1);
    if (typeof resolved.minimum === "number") return resolved.minimum;
    return 1;
  }
  if (type === "number") {
    if (propertyName === "latitude") return SAMPLE.baghdadLat;
    if (propertyName === "longitude") return SAMPLE.baghdadLng;
    if (typeof resolved.minimum === "number") return resolved.minimum;
    return 1;
  }
  if (resolved.format === "uuid")
    return (propertyName && paramExamples[propertyName]) || SAMPLE.sessionId;
  if (resolved.format === "date-time") return SAMPLE.instant;
  if (propertyName && paramExamples[propertyName] !== undefined)
    return paramExamples[propertyName];
  if (propertyName === "email") return "superadmin@example.com";
  if (propertyName === "password" || propertyName?.toLowerCase().includes("password"))
    return SAMPLE.password;
  if (propertyName === "phone" || propertyName === "recipientPhone") return SAMPLE.phone;
  if (propertyName === "otp" || propertyName === "code") return "123456";
  if (propertyName === "refresh_token") return SAMPLE.refreshToken;
  if (propertyName === "access_token") return SAMPLE.accessToken;
  if (propertyName === "device_name") return "Angular Dashboard";
  if (propertyName === "device_id") return "dashboard-browser-001";
  if (typeof resolved.minLength === "number" && resolved.minLength >= 12)
    return SAMPLE.password;
  return "example";
};

const shouldIncludeOptional = (name: string) =>
  new Set([
    "device_id",
    "device_name",
    "note",
    "displayName",
    "coverAssetId",
    "sizeId",
    "modifierSelections",
    "destination",
    "addressId",
    "landmark",
    "recipientName",
    "recipientPhone",
    "isDefault",
    "workingHours",
    "description",
    "actedOnBehalfOf",
    "customerAgreedByPhone",
    "reason",
  ]).has(name);

export function enrichOpenApiDocument(
  document: {
    paths?: Record<string, Record<string, any>>;
    components?: { schemas?: Record<string, unknown>; parameters?: Record<string, any> };
    servers?: unknown;
  },
  serverUrl?: string | null,
) {
  if (serverUrl) {
    document.servers = [
      { url: serverUrl.replace(/\/+$/, ""), description: "API" },
    ];
  }
  const schemas = document.components?.schemas;
  if (document.components?.parameters) {
    for (const parameter of Object.values(document.components.parameters)) {
      if (parameter?.name && parameter.example === undefined && paramExamples[parameter.name] !== undefined) {
        parameter.example = paramExamples[parameter.name];
      }
    }
  }
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const operation of Object.values(operations ?? {})) {
      if (!operation || typeof operation !== "object") continue;
      if (Array.isArray(operation.parameters)) {
        for (const parameter of operation.parameters) {
          const name = parameter?.name as string | undefined;
          if (!name) continue;
          if (parameter.example === undefined && paramExamples[name] !== undefined) {
            parameter.example = paramExamples[name];
          }
          if (name === "idempotency-key") parameter.name = "Idempotency-Key";
          if (name === "x-city-id") parameter.name = "X-City-Id";
          if (name === "x-request-id") parameter.name = "X-Request-Id";
        }
      }
      const contents = operation.requestBody?.content as Record<string, any> | undefined;
      if (contents) {
        for (const media of Object.values(contents)) {
          if (!media || typeof media !== "object") continue;
          const named = media.schema?.["x-examples"] as
            | Record<string, { summary?: string; value: unknown }>
            | undefined;
          if (named) {
            media.examples = Object.fromEntries(
              Object.entries(named).map(([key, value]) => [key, value]),
            );
          }
          if (media.example === undefined) {
            media.example =
              media.schema?.example ??
              (Array.isArray(media.schema?.examples) ? media.schema.examples[0] : undefined) ??
              exampleFromSchema(media.schema, schemas, undefined, path);
          }
          if (media.schema && media.schema.example === undefined && media.example !== undefined) {
            media.schema.example = media.example;
          }
        }
      }
      const responses = operation.responses as Record<string, any> | undefined;
      if (responses) {
        for (const response of Object.values(responses)) {
          const media = response?.content?.["application/json"];
          if (!media?.schema) continue;
          if (media.example === undefined) {
            media.example =
              media.schema.example ??
              (Array.isArray(media.schema.examples) ? media.schema.examples[0] : undefined) ??
              exampleFromSchema(media.schema, schemas, undefined, path);
          }
        }
      }
    }
  }
  return document;
}
