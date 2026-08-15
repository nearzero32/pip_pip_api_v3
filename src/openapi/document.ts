import type { TSchema } from "elysia";

export const JSON_PARSE = "json" as const;

/** Attach OpenAPI 3.0 `example` without mutating the shared schema object. */
export function document<T extends TSchema>(
  schema: T,
  example: unknown,
  named?: Record<string, { summary?: string; value: unknown }>,
): T {
  const examples = named
    ? Object.values(named).map((item) => item.value)
    : [example];
  return Object.assign({}, schema, {
    example,
    examples,
    ...(named ? { "x-examples": named } : {}),
  }) as T;
}

/** Mark a JSON body operation so @elysiajs/openapi emits application/json content. */
export function jsonOp<T extends Record<string, unknown>>(
  options: T,
): T & { parse: "json" } {
  return { parse: JSON_PARSE, ...options };
}
