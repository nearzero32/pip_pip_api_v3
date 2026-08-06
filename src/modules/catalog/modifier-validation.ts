import { AppError } from "../../errors/app-error";

/** IQD integer price; zero is allowed for modifiers. */
export const parseIqdNonNegativePrice = (
  raw: unknown,
  field = "price",
): number => {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    !Number.isSafeInteger(raw)
  ) {
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  }
  return raw;
};

export const parseMaxQuantity = (raw: unknown): number => {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    !Number.isSafeInteger(raw)
  ) {
    throw new AppError(422, "INVALID_MAX_QUANTITY", "Invalid maxQuantity");
  }
  return raw;
};

export const parseMinMaxSelect = (
  minSelectRaw: unknown,
  maxSelectRaw: unknown,
): { minSelect: number; maxSelect: number } => {
  if (
    typeof minSelectRaw !== "number" ||
    !Number.isInteger(minSelectRaw) ||
    minSelectRaw < 0 ||
    !Number.isSafeInteger(minSelectRaw)
  ) {
    throw new AppError(422, "INVALID_MODIFIER_SELECT", "Invalid minSelect");
  }
  if (
    typeof maxSelectRaw !== "number" ||
    !Number.isInteger(maxSelectRaw) ||
    maxSelectRaw < 1 ||
    !Number.isSafeInteger(maxSelectRaw)
  ) {
    throw new AppError(422, "INVALID_MODIFIER_SELECT", "Invalid maxSelect");
  }
  if (minSelectRaw > maxSelectRaw) {
    throw new AppError(
      422,
      "INVALID_MODIFIER_SELECT",
      "minSelect must be <= maxSelect",
    );
  }
  return { minSelect: minSelectRaw, maxSelect: maxSelectRaw };
};

/** Defaults each contribute quantity 1 toward maxSelect. */
export const assertDefaultsWithinMaxSelect = (
  defaultCount: number,
  maxSelect: number,
) => {
  if (defaultCount > maxSelect) {
    throw new AppError(
      422,
      "INVALID_MODIFIER_DEFAULTS",
      "Default options exceed group maxSelect",
    );
  }
};
