export const ALLOWED_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedImageContentType =
  (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

const CONTENT_TYPE_EXTENSION: Record<AllowedImageContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const isAllowedImageContentType = (
  value: string,
): value is AllowedImageContentType =>
  (ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);

export const canonicalExtensionForContentType = (
  contentType: AllowedImageContentType,
): string => CONTENT_TYPE_EXTENSION[contentType];

/** Reject control characters and overlong original filenames. */
export const validateOriginalFileName = (fileName: string): string => {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("INVALID_FILE_NAME");
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error("INVALID_FILE_NAME");
  }
  return trimmed;
};

/**
 * Server-generated object keys. The client never supplies objectKey.
 * Original filenames are metadata only and never appear in the key.
 */
export const buildCategoryImageObjectKey = (
  cityId: string,
  assetId: string,
  contentType: AllowedImageContentType,
): string =>
  `cities/${cityId}/categories/${assetId}/original.${canonicalExtensionForContentType(contentType)}`;

export const buildStoreLogoObjectKey = (
  cityId: string,
  assetId: string,
  contentType: AllowedImageContentType,
): string =>
  `cities/${cityId}/stores/${assetId}/logo.${canonicalExtensionForContentType(contentType)}`;

export const buildStoreCoverObjectKey = (
  cityId: string,
  assetId: string,
  contentType: AllowedImageContentType,
): string =>
  `cities/${cityId}/stores/${assetId}/cover.${canonicalExtensionForContentType(contentType)}`;

export const buildProductImageObjectKey = (
  cityId: string,
  assetId: string,
  contentType: AllowedImageContentType,
): string =>
  `cities/${cityId}/products/${assetId}/original.${canonicalExtensionForContentType(contentType)}`;

export const buildOrderProofObjectKey = (
  cityId: string,
  orderId: string,
  assetId: string,
  contentType: AllowedImageContentType,
): string =>
  `cities/${cityId}/orders/${orderId}/proofs/${assetId}.${canonicalExtensionForContentType(contentType)}`;

export const buildPublicMediaUrl = (
  publicBaseUrl: string,
  objectKey: string,
  visibility: "PUBLIC" | "PRIVATE",
  status: string,
): string | null => {
  if (visibility !== "PUBLIC" || status !== "READY") return null;
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/${objectKey}`;
};
