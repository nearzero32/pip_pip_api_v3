import { AppError } from "../../errors/app-error";
import type { AllowedImageContentType } from "./object-key";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const detectImageContentTypeFromPrefix = (
  bytes: Uint8Array,
): AllowedImageContentType | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
};

/** Validates that the object prefix matches the expected image MIME. Rejects SVG and spoofed bytes. */
export const assertImageSignatureMatches = (
  bytes: Uint8Array,
  expectedContentType: string,
): void => {
  const detected = detectImageContentTypeFromPrefix(bytes);
  if (!detected || detected !== expectedContentType) {
    throw new AppError(
      400,
      "MEDIA_CONTENT_INVALID",
      "Uploaded media content is invalid",
    );
  }
};
