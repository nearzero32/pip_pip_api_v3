const validRequestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveRequestId(incoming: string | null): string {
  return incoming && validRequestId.test(incoming) ? incoming : crypto.randomUUID();
}
