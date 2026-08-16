import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

type ValidationBody = {
  error: {
    code: string;
    message: string;
    details?: {
      location: string;
      fields: Array<{ field: string; code: string; message: string }>;
    };
  };
  request_id: string;
};

describe("central validation error contract — dashboard admins", () => {
  let h: IntegrationHarness;
  let superToken = "";
  let cityId = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_validation_admins",
    });

    cityId = await createActiveCity(h.client, "Validation City");
    await createStaffAccount(h.auth, h.client, {
      email: "super.validation@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    superToken = (
      await h.auth.dashboard.login({
        email: "super.validation@example.com",
        password,
        deviceName: "validation",
        ip: "127.0.0.1",
        requestId: "validation-login",
      })
    ).access_token;
  });

  afterAll(async () => {
    await h.close();
  });

  const postAdmin = (body: unknown) =>
    h.app.handle(
      jsonRequest("/api/v1/dashboard/admins", {
        method: "POST",
        token: superToken,
        body,
      }),
    );

  const getAdmins = (query: string) =>
    h.app.handle(
      jsonRequest(`/api/v1/dashboard/admins${query}`, {
        token: superToken,
      }),
    );

  test("POST missing email returns field details", async () => {
    const response = await postAdmin({
      password: "long-enough-password",
      cityId,
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toBe("The request contains invalid fields");
    expect(body.error.details?.location).toBe("body");
    expect(body.error.details?.fields).toContainEqual({
      field: "email",
      code: "REQUIRED",
      message: "email is required",
    });
    expect(body.request_id).toBeTruthy();
  });

  test("POST short password returns TOO_SHORT without leaking the value", async () => {
    const secret = "short";
    const response = await postAdmin({
      email: "admin.short@example.com",
      password: secret,
      cityId,
    });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(secret);
    const body = JSON.parse(text) as ValidationBody;
    expect(body.error.details?.fields).toContainEqual({
      field: "password",
      code: "TOO_SHORT",
      message: "password must be at least 12 characters",
    });
  });

  test("POST invalid cityId UUID returns INVALID_FORMAT", async () => {
    const response = await postAdmin({
      email: "admin.uuid@example.com",
      password: "long-enough-password",
      cityId: "not-a-uuid",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    expect(body.error.details?.fields).toContainEqual({
      field: "cityId",
      code: "INVALID_FORMAT",
      message: "cityId must be a valid UUID",
    });
  });

  test("POST empty displayName returns TOO_SHORT", async () => {
    const response = await postAdmin({
      email: "admin.empty@example.com",
      password: "long-enough-password",
      cityId,
      displayName: "",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    expect(
      body.error.details?.fields.some(
        (f) => f.field === "displayName" && f.code === "TOO_SHORT",
      ),
    ).toBe(true);
  });

  test("POST unknown field returns UNKNOWN_FIELD", async () => {
    const response = await postAdmin({
      email: "admin.extra@example.com",
      password: "long-enough-password",
      cityId,
      role: "SUPER_ADMIN",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    expect(body.error.message).toBe("The request contains invalid fields");
    expect(body.error.details?.fields).toContainEqual({
      field: "role",
      code: "UNKNOWN_FIELD",
      message: "role is not allowed",
    });
  });

  test("POST multiple invalid fields returns sorted unique details", async () => {
    const response = await postAdmin({
      password: "short",
      cityId: "bad",
      displayName: "",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    const fields = body.error.details?.fields ?? [];
    expect(fields.length).toBeGreaterThanOrEqual(3);
    const names = fields.map((f) => f.field);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("email");
    expect(names).toContain("password");
    expect(names).toContain("cityId");
  });

  test("POST invalid JSON returns parse message without internals", async () => {
    const response = await h.app.handle(
      new Request("http://localhost/api/v1/dashboard/admins", {
        method: "POST",
        headers: {
          authorization: `Bearer ${superToken}`,
          "content-type": "application/json",
        },
        body: '{"email":',
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    expect(body.error).toEqual({
      code: "VALIDATION_FAILED",
      message: "The request body contains invalid JSON",
    });
    expect(body.request_id).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/SyntaxError|Unexpected|stack/i);
  });

  test("GET page=0 and limit=101 are rejected with query details", async () => {
    const page = await getAdmins("?page=0");
    expect(page.status).toBe(422);
    const pageBody = (await page.json()) as ValidationBody;
    expect(pageBody.error.details?.location).toBe("query");
    expect(
      pageBody.error.details?.fields.some(
        (f) => f.field === "page" && f.code === "TOO_SMALL",
      ),
    ).toBe(true);

    const limit = await getAdmins("?limit=101");
    expect(limit.status).toBe(422);
    const limitBody = (await limit.json()) as ValidationBody;
    expect(
      limitBody.error.details?.fields.some(
        (f) => f.field === "limit" && f.code === "TOO_LARGE",
      ),
    ).toBe(true);
  });

  test("GET invalid sortOrder, cityId, and unknown query are rejected", async () => {
    const sort = await getAdmins("?sortOrder=up");
    expect(sort.status).toBe(422);
    const sortBody = (await sort.json()) as ValidationBody;
    expect(
      sortBody.error.details?.fields.some(
        (f) => f.field === "sortOrder" && f.code === "INVALID_VALUE",
      ),
    ).toBe(true);

    const city = await getAdmins("?cityId=not-uuid");
    expect(city.status).toBe(422);
    const cityBody = (await city.json()) as ValidationBody;
    expect(
      cityBody.error.details?.fields.some(
        (f) => f.field === "cityId" && f.code === "INVALID_FORMAT",
      ),
    ).toBe(true);

    const unknown = await getAdmins("?foo=1");
    expect(unknown.status).toBe(422);
    const unknownBody = (await unknown.json()) as ValidationBody;
    expect(
      unknownBody.error.details?.fields.some(
        (f) => f.field === "foo" && f.code === "UNKNOWN_FIELD",
      ),
    ).toBe(true);
  });

  test("GET without query succeeds", async () => {
    const response = await getAdmins("");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: unknown[];
      pagination: { page: number; limit: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(25);
  });

  test("response validation failures do not leak schema or values to the client", async () => {
    // Covered end-to-end by unit mapper; assert production client contract shape
    // when response location is reported (empty fields, no schema/stack).
    const { mapElysiaValidationError } = await import(
      "../../src/errors/validation-details"
    );
    const { Elysia, t, ValidationError } = await import("elysia");
    const events: Array<Record<string, unknown>> = [];
    const app = new Elysia()
      .onError(({ error, code, request }) => {
        if (code === "VALIDATION" && error instanceof ValidationError) {
          const mapped = mapElysiaValidationError(error, request);
          if (mapped.details.location === "response") {
            events.push({
              event: "response_validation_failed",
              fields: mapped.details.fields.map((f) => ({
                field: f.field,
                code: f.code,
              })),
            });
          }
          return {
            error: {
              code: "VALIDATION_FAILED",
              message: mapped.message,
              details: mapped.clientDetails,
            },
            request_id: "resp-val",
          };
        }
      })
      .get(
        "/boom",
        // @ts-expect-error intentional invalid response
        () => ({ secret: "should-not-leak", password: "x" }),
        { response: t.Object({ ok: t.Literal(true) }) },
      );
    const response = await app.handle(new Request("http://localhost/boom"));
    const text = await response.text();
    expect(text).not.toContain("should-not-leak");
    expect(text).not.toContain("password");
    expect(text).not.toMatch(/schema|TypeBox|stack/i);
    const body = JSON.parse(text) as ValidationBody;
    expect(body.error.details).toEqual({ location: "response", fields: [] });
    expect(events[0]?.event).toBe("response_validation_failed");
    expect(
      Array.isArray(events[0]?.fields) && (events[0]!.fields as unknown[]).length > 0,
    ).toBe(true);
  });
});
