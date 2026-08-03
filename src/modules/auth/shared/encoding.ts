export const encodeBase64Url = (value: Uint8Array | string): string =>
  (typeof value === "string" ? Buffer.from(value) : Buffer.from(value)).toString("base64url");

export const decodeBase64Url = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));

export const randomOpaqueToken = (bytes = 32): string => encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
