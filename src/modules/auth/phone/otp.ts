export function generateOtp(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while (values[0]! >= limit);
  return String(values[0]! % 1_000_000).padStart(6, "0");
}
