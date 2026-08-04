import { AppError } from "../../errors/app-error";

/** Arabic Main Category / catalog names. Latin letters are rejected. */
export const MAIN_CATEGORY_NAME_MAX_LENGTH = 100;

const ARABIC_LETTER = /[\u0600-\u06FF]/;
const LATIN_LETTER = /[A-Za-z]/
/** Letters, Arabic digits, spaces, and common Arabic punctuation. */
const ALLOWED_NAME = /^[\u0600-\u06FF0-9\u0660-\u0669\s.,،\-_/()]+$/u;

export const normalizeArabicCategoryName = (raw: unknown): string => {
  if (typeof raw !== "string") {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  const name = raw.trim();
  if (!name) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  if (name.length > MAIN_CATEGORY_NAME_MAX_LENGTH) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  if (LATIN_LETTER.test(name)) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  if (!ARABIC_LETTER.test(name)) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  if (!ALLOWED_NAME.test(name)) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid category name");
  }
  return name;
};

export const validateDisplayOrder = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid display order");
  }
  return value;
};
