import { describe, expect, test } from "bun:test";
import { Elysia, t, ValidationError } from "elysia";
import {
  mapElysiaValidationError,
  normalizeValidationPath,
} from "../../src/errors/validation-details";

describe("validation details mapper", () => {
  test("normalizes TypeBox paths", () => {
    expect(normalizeValidationPath("/cityId")).toBe("cityId");
    expect(normalizeValidationPath("/a/b")).toBe("a.b");
    expect(normalizeValidationPath("/")).toBe("root");
    expect(normalizeValidationPath("")).toBe("root");
  });

  test("maps body ValidationError.all without leaking values", async () => {
    const app = new Elysia()
      .onError(({ error, code, request }) => {
        if (code === "VALIDATION" && error instanceof ValidationError) {
          return mapElysiaValidationError(error, request);
        }
      })
      .post("/", () => "ok", {
        body: t.Object(
          {
            email: t.String({ maxLength: 254 }),
            password: t.String({ minLength: 12, maxLength: 256 }),
            cityId: t.String({ format: "uuid" }),
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
      });

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: "short",
          cityId: "not-a-uuid",
          displayName: "",
        }),
      }),
    );
    const body = (await response.json()) as ReturnType<typeof mapElysiaValidationError>;
    expect(body.message).toBe("The request contains invalid fields");
    expect(body.clientDetails?.location).toBe("body");
    const fields = body.clientDetails?.fields ?? [];
    expect(fields.map((f) => f.field).sort()).toEqual([
      "cityId",
      "displayName",
      "email",
      "password",
    ]);
    expect(fields.find((f) => f.field === "email")?.code).toBe("REQUIRED");
    expect(fields.find((f) => f.field === "password")?.code).toBe("TOO_SHORT");
    expect(fields.find((f) => f.field === "cityId")).toMatchObject({
      code: "INVALID_FORMAT",
      message: "cityId must be a valid UUID",
    });
    expect(fields.find((f) => f.field === "displayName")?.code).toBe("TOO_SHORT");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("short");
    expect(serialized).not.toContain("not-a-uuid");
    expect(serialized).not.toContain("found");
    expect(serialized).not.toContain("expected");
    expect(serialized).not.toContain("stack");
  });

  test("maps query bounds using request URL when Elysia reports property errors", async () => {
    const app = new Elysia()
      .onError(({ error, code, request }) => {
        if (code === "VALIDATION" && error instanceof ValidationError) {
          return mapElysiaValidationError(error, request).clientDetails;
        }
      })
      .get("/list", () => ({ ok: true }), {
        query: t.Object(
          {
            page: t.Optional(t.Integer({ minimum: 1, default: 1 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 25 })),
            sortOrder: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
          },
          { additionalProperties: false },
        ),
      });

    const page = await app.handle(new Request("http://localhost/list?page=0"));
    const pageBody = (await page.json()) as {
      location: string;
      fields: Array<{ field: string; code: string }>;
    };
    expect(pageBody.location).toBe("query");
    expect(pageBody.fields.some((f) => f.field === "page" && f.code === "TOO_SMALL")).toBe(true);

    const limit = await app.handle(new Request("http://localhost/list?limit=101"));
    const limitBody = (await limit.json()) as {
      fields: Array<{ field: string; code: string }>;
    };
    expect(limitBody.fields.some((f) => f.field === "limit" && f.code === "TOO_LARGE")).toBe(true);

    const sort = await app.handle(new Request("http://localhost/list?sortOrder=up"));
    const sortBody = (await sort.json()) as {
      fields: Array<{ field: string; code: string }>;
    };
    expect(sortBody.fields.some((f) => f.field === "sortOrder" && f.code === "INVALID_VALUE")).toBe(
      true,
    );
  });

  test("hides response-validation fields from clients but keeps them internally", async () => {
    const app = new Elysia()
      .onError(({ error, code, request }) => {
        if (code === "VALIDATION" && error instanceof ValidationError) {
          return mapElysiaValidationError(error, request);
        }
      })
      .get(
        "/",
        // @ts-expect-error intentional invalid response for validation coverage
        () => ({ bad: true }),
        {
          response: t.Object({ ok: t.Literal(true) }),
        },
      );
    const response = await app.handle(new Request("http://localhost/"));
    const body = (await response.json()) as ReturnType<typeof mapElysiaValidationError>;
    expect(body.details.location).toBe("response");
    expect(body.details.fields.length).toBeGreaterThan(0);
    expect(body.clientDetails).toBeUndefined();
    expect(body.message).toBe("An unexpected error occurred");
  });
});
