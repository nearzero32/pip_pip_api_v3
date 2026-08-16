import { AppError } from "./app-error";
import type {
  ValidationErrorDetails,
  ValidationFieldCode,
  ValidationFieldDetail,
  ValidationLocation,
} from "./validation-details";

function sortFields(fields: ValidationFieldDetail[]): ValidationFieldDetail[] {
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

/** Structured 422 for client request input (body/query/params/headers/cookie). */
export function requestValidationError(input: {
  location: ValidationLocation;
  fields: ValidationFieldDetail[];
}): AppError {
  if (input.fields.length === 0) {
    throw new Error("requestValidationError requires at least one field");
  }
  const details: ValidationErrorDetails = {
    location: input.location,
    fields: sortFields(input.fields),
  };
  return new AppError(
    422,
    "VALIDATION_FAILED",
    "The request contains invalid fields",
    undefined,
    undefined,
    details,
  );
}

export function validationField(
  field: string,
  code: ValidationFieldCode,
  message: string,
): ValidationFieldDetail {
  return { field, code, message };
}

export function invalidValueField(field: string): ValidationFieldDetail {
  return validationField(field, "INVALID_VALUE", `${field} has an invalid value`);
}

export function invalidFormatField(
  field: string,
  hint = "a valid format",
): ValidationFieldDetail {
  return validationField(field, "INVALID_FORMAT", `${field} must be ${hint}`);
}

export function invalidTypeField(field: string): ValidationFieldDetail {
  return validationField(field, "INVALID_TYPE", `${field} has an invalid type`);
}

export function tooSmallField(field: string, minimum?: number): ValidationFieldDetail {
  return validationField(
    field,
    "TOO_SMALL",
    typeof minimum === "number"
      ? `${field} must be at least ${minimum}`
      : `${field} is too small`,
  );
}

export function tooLargeField(field: string, maximum?: number): ValidationFieldDetail {
  return validationField(
    field,
    "TOO_LARGE",
    typeof maximum === "number"
      ? `${field} must be at most ${maximum}`
      : `${field} is too large`,
  );
}

export function tooLongField(field: string, maxLength?: number): ValidationFieldDetail {
  return validationField(
    field,
    "TOO_LONG",
    typeof maxLength === "number"
      ? `${field} must be at most ${maxLength} characters`
      : `${field} is too long`,
  );
}

export function invalidRangeFields(
  fromField: string,
  toField: string,
): ValidationFieldDetail[] {
  return [
    validationField(
      fromField,
      "INVALID_RANGE",
      `${fromField} must be before or equal to ${toField}`,
    ),
    validationField(
      toField,
      "INVALID_RANGE",
      `${toField} must be after or equal to ${fromField}`,
    ),
  ];
}
