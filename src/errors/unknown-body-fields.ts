/**
 * Route-scoped unknown JSON body key detection.
 *
 * Elysia normalize strips additionalProperties before TypeBox can emit
 * ObjectAdditionalProperties. Write routes may register unknown keys from the
 * already-parsed JSON object (no second body read) during onParse, then either:
 * - reject in onBeforeHandle, or
 * - let app.ts merge them into a VALIDATION_FAILED details payload when schema
 *   validation fails first (so clients still see UNKNOWN_FIELD).
 *
 * Not used for GET/HEAD, multipart, or non-JSON media uploads.
 */
const pendingUnknownBodyFields = new WeakMap<Request, string[]>();
const pendingInvalidBodyShape = new WeakMap<Request, true>();

export function registerUnknownBodyFields(
  request: Request,
  fields: string[],
): void {
  if (fields.length === 0) return;
  pendingUnknownBodyFields.set(
    request,
    [...fields].sort((a, b) => a.localeCompare(b)),
  );
}

export function registerInvalidBodyShape(request: Request): void {
  pendingInvalidBodyShape.set(request, true);
}

export function consumeUnknownBodyFields(request: Request): string[] {
  const fields = pendingUnknownBodyFields.get(request) ?? [];
  pendingUnknownBodyFields.delete(request);
  return fields;
}

export function consumeInvalidBodyShape(request: Request): boolean {
  const present = pendingInvalidBodyShape.has(request);
  pendingInvalidBodyShape.delete(request);
  return present;
}
