export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, "");
  if (!/^\+[1-9][0-9]{7,14}$/.test(compact)) throw new Error("INVALID_PHONE");
  return compact;
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("INVALID_EMAIL");
  return normalized;
}
