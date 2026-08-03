const secretKeys = /(^|_)(password|password_hash|hash|otp|token|authorization|cookie|secret|private_key|signing_key|hmac_key|api_key|provider_key|database_url|redis_url|credential)(_|$)/i;
const canonicalKey = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_");
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]"; seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.test(canonicalKey(key)) ? "[REDACTED]" : redact(item, seen)]));
  }
  return value;
}
