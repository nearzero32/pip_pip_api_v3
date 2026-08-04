const secretKeys =
  /(^|_)(password|password_hash|hash|code|access_code|access_code_hash|otp|otp_code|otp_verifier|token|authorization|cookie|set_cookie|secret|private_key|signing_key|hmac_key|api_key|provider_key|database_url|redis_url|credential|access_key_id|secret_access_key|r2_access_key_id|r2_secret_access_key|presigned|presigned_url|upload_url)(_|$)/i;
const canonicalKey = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_");
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKeys.test(canonicalKey(key)) ? "[REDACTED]" : redact(item, seen),
      ]),
    );
  }
  return value;
}
