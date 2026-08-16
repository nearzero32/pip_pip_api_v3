import { ValidationError } from "elysia";
import { ValueErrorType } from "@sinclair/typebox/errors";

export type ValidationLocation =
  | "body"
  | "query"
  | "params"
  | "headers"
  | "response"
  | "cookie";

export type ValidationFieldCode =
  | "REQUIRED"
  | "UNKNOWN_FIELD"
  | "INVALID_FORMAT"
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "TOO_SMALL"
  | "TOO_LARGE";

export type ValidationFieldDetail = {
  field: string;
  code: ValidationFieldCode;
  message: string;
};

export type ValidationErrorDetails = {
  location: ValidationLocation;
  fields: ValidationFieldDetail[];
};

type RawValueError = {
  type?: number;
  path?: string | unknown;
  message?: string;
  summary?: string;
  schema?: {
    format?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    default?: unknown;
    type?: string;
  };
  value?: unknown;
};

const LOCATION_SET = new Set<string>([
  "body",
  "query",
  "params",
  "headers",
  "response",
  "cookie",
]);

export function normalizeValidationPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path === "/") {
    return "root";
  }
  return (
    path
      .replace(/^\//, "")
      .replaceAll("/", ".")
      .replace(/^\.+|\.+$/g, "")
      .trim() || "root"
  );
}

export function mapValidationLocation(on: string | undefined): ValidationLocation {
  // Elysia reports coerced query scalar failures as "property".
  if (on === "property") return "query";
  if (on && LOCATION_SET.has(on)) return on as ValidationLocation;
  return "body";
}

function formatName(field: string): string {
  return field === "root" ? "value" : field;
}

function formatHint(schema: RawValueError["schema"]): string | null {
  const format = schema?.format?.toLowerCase();
  if (!format) return null;
  if (format === "uuid") return "a valid UUID";
  if (format === "email") return "a valid email";
  if (format === "uri" || format === "url") return "a valid URL";
  if (format === "date-time") return "a valid date-time";
  if (format === "date") return "a valid date";
  return `a valid ${format}`;
}

function inferFieldName(
  error: RawValueError,
  validationOn: string | undefined,
  foundValue: unknown,
  request?: Request,
): string {
  const fromPath = normalizeValidationPath(error.path);
  if (fromPath !== "root") return fromPath;

  if (request) {
    const url = new URL(request.url, "http://localhost");
    const matches: string[] = [];
    for (const [key, raw] of url.searchParams.entries()) {
      if (typeof foundValue === "number" && Number(raw) === foundValue) {
        matches.push(key);
      } else if (String(foundValue) === raw) {
        matches.push(key);
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const schema = error.schema;
      if (schema?.maximum != null && matches.includes("limit")) return "limit";
      if (schema?.default === 1 && matches.includes("page")) return "page";
      return matches.sort((a, b) => a.localeCompare(b))[0]!;
    }
  }

  if (validationOn === "property" || validationOn === "query") {
    const schema = error.schema;
    if (schema?.maximum === 100) return "limit";
    if (schema?.minimum === 1 && schema?.default === 1 && schema?.maximum == null) {
      return "page";
    }
  }
  return "root";
}

function mapField(
  error: RawValueError,
  validationOn: string | undefined,
  foundValue: unknown,
  request?: Request,
): ValidationFieldDetail {
  const field = inferFieldName(
    error,
    validationOn,
    error.value ?? foundValue,
    request,
  );
  const name = formatName(field);
  const type = error.type;
  const schema = error.schema;
  const missing =
    type === ValueErrorType.ObjectRequiredProperty ||
    error.value === undefined ||
    (type === ValueErrorType.String && error.value === undefined);

  if (type === ValueErrorType.ObjectAdditionalProperties) {
    return { field, code: "UNKNOWN_FIELD", message: `${name} is not allowed` };
  }
  if (missing) {
    return { field, code: "REQUIRED", message: `${name} is required` };
  }
  if (
    type === ValueErrorType.StringFormat ||
    type === ValueErrorType.StringFormatUnknown
  ) {
    const hint = formatHint(schema) ?? "a valid format";
    return {
      field,
      code: "INVALID_FORMAT",
      message: `${name} must be ${hint}`,
    };
  }
  if (type === ValueErrorType.StringMinLength) {
    const min = schema?.minLength;
    return {
      field,
      code: "TOO_SHORT",
      message:
        typeof min === "number"
          ? `${name} must be at least ${min} characters`
          : `${name} is too short`,
    };
  }
  if (type === ValueErrorType.StringMaxLength) {
    const max = schema?.maxLength;
    return {
      field,
      code: "TOO_LONG",
      message:
        typeof max === "number"
          ? `${name} must be at most ${max} characters`
          : `${name} is too long`,
    };
  }
  if (
    type === ValueErrorType.IntegerMinimum ||
    type === ValueErrorType.NumberMinimum ||
    type === ValueErrorType.IntegerExclusiveMinimum ||
    type === ValueErrorType.NumberExclusiveMinimum
  ) {
    const min = schema?.minimum;
    return {
      field,
      code: "TOO_SMALL",
      message:
        typeof min === "number"
          ? `${name} must be at least ${min}`
          : `${name} is too small`,
    };
  }
  if (
    type === ValueErrorType.IntegerMaximum ||
    type === ValueErrorType.NumberMaximum ||
    type === ValueErrorType.IntegerExclusiveMaximum ||
    type === ValueErrorType.NumberExclusiveMaximum
  ) {
    const max = schema?.maximum;
    return {
      field,
      code: "TOO_LARGE",
      message:
        typeof max === "number"
          ? `${name} must be at most ${max}`
          : `${name} is too large`,
    };
  }
  if (
    type === ValueErrorType.String ||
    type === ValueErrorType.Integer ||
    type === ValueErrorType.Number ||
    type === ValueErrorType.Boolean ||
    type === ValueErrorType.Object ||
    type === ValueErrorType.Array
  ) {
    return {
      field,
      code: "INVALID_TYPE",
      message: `${name} has an invalid type`,
    };
  }
  if (type === ValueErrorType.Union || type === ValueErrorType.Literal) {
    return {
      field,
      code: "INVALID_VALUE",
      message: `${name} has an invalid value`,
    };
  }
  return { field, code: "INVALID_VALUE", message: `${name} is invalid` };
}

function dedupeAndSort(fields: ValidationFieldDetail[]): ValidationFieldDetail[] {
  const seen = new Set<string>();
  const unique: ValidationFieldDetail[] = [];
  for (const field of fields) {
    const key = `${field.field}\0${field.code}\0${field.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(field);
  }
  return unique.sort((a, b) => {
    const byField = a.field.localeCompare(b.field);
    if (byField !== 0) return byField;
    const byCode = a.code.localeCompare(b.code);
    if (byCode !== 0) return byCode;
    return a.message.localeCompare(b.message);
  });
}

export function validationLogFields(
  fields: ValidationFieldDetail[],
): Array<{ field: string; code: string }> {
  return fields.map((field) => ({ field: field.field, code: field.code }));
}

/**
 * Maps Elysia ValidationError to a stable client-safe contract.
 *
 * Uses ValidationError.all (always available; does not need
 * allowUnsafeValidationDetails). Never includes found values, bodies,
 * schema trees, or stacks.
 */
export function mapElysiaValidationError(
  error: ValidationError,
  request?: Request,
): {
  details: ValidationErrorDetails;
  clientDetails: ValidationErrorDetails | undefined;
  message: string;
} {
  const location = mapValidationLocation(error.type);
  const raw = (Array.isArray(error.all) ? error.all : []).filter(
    Boolean,
  ) as RawValueError[];
  const fields = dedupeAndSort(
    raw.map((item) => mapField(item, error.type, error.value, request)),
  );
  const details: ValidationErrorDetails = { location, fields };
  if (location === "response") {
    return {
      details,
      clientDetails: { location: "response", fields: [] },
      message: "The request contains invalid fields",
    };
  }
  return {
    details,
    clientDetails: details,
    message: "The request contains invalid fields",
  };
}
