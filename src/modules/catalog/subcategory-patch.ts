import { AppError } from "../../errors/app-error";

/** Distinguish omitted vs null vs UUID for optional subcategory images. */
export type ImagePatch =
  | { kind: "omit" }
  | { kind: "clear" }
  | { kind: "set"; assetId: string };

export const parseImagePatch = (
  input: Record<string, unknown>,
  field = "imageAssetId",
): ImagePatch => {
  if (!(field in input)) return { kind: "omit" };
  const value = input[field];
  if (value === null) return { kind: "clear" };
  if (typeof value !== "string" || !value) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid image asset id");
  }
  return { kind: "set", assetId: value };
};

/** Reject create-time null for imageAssetId while allowing omission. */
export const parseOptionalCreateImage = (
  input: Record<string, unknown>,
): string | null => {
  if (!("imageAssetId" in input)) return null;
  if (input.imageAssetId === null) {
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "imageAssetId cannot be null on create; omit the field instead",
    );
  }
  if (typeof input.imageAssetId !== "string" || !input.imageAssetId) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid image asset id");
  }
  return input.imageAssetId;
};

export const assertAtLeastOnePatchField = (
  input: Record<string, unknown>,
  allowed: string[],
) => {
  if (!allowed.some((key) => key in input)) {
    throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
  }
};

export const assertPatchStatusNotArchived = (status: unknown) => {
  if (status === "ARCHIVED") {
    throw new AppError(
      422,
      "SUBCATEGORY_INVALID_STATUS",
      "Use DELETE to archive a subcategory",
    );
  }
};
