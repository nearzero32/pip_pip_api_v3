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
      role: "SUPER_ADMIN",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as ValidationBody;
    const fields = body.error.details?.fields ?? [];
    expect(fields.length).toBeGreaterThanOrEqual(4);
    const names = fields.map((f) => f.field);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("email");
    expect(names).toContain("password");
    expect(names).toContain("cityId");
    expect(names).toContain("role");
    expect(fields.some((f) => f.field === "role" && f.code === "UNKNOWN_FIELD")).toBe(
      true,
    );
  });

  test("POST invalid JSON variants stay PARSE-safe with request_id", async () => {
    const truncated = await h.app.handle(
      new Request("http://localhost/api/v1/dashboard/admins", {
        method: "POST",
        headers: {
          authorization: `Bearer ${superToken}`,
          "content-type": "application/json",
        },
        body: '{"email":',
      }),
    );
    expect(truncated.status).toBe(422);
    const truncatedBody = (await truncated.json()) as ValidationBody;
    expect(truncatedBody.error).toEqual({
      code: "VALIDATION_FAILED",
      message: "The request body contains invalid JSON",
    });
    expect(truncatedBody.request_id).toBeTruthy();
    expect(JSON.stringify(truncatedBody)).not.toMatch(/SyntaxError|Unexpected|stack/i);

    const empty = await h.app.handle(
      new Request("http://localhost/api/v1/dashboard/admins", {
        method: "POST",
        headers: {
          authorization: `Bearer ${superToken}`,
          "content-type": "application/json",
        },
        body: "",
      }),
    );
    expect(empty.status).toBe(422);
    const emptyBody = (await empty.json()) as ValidationBody;
    expect(emptyBody.error.code).toBe("VALIDATION_FAILED");
    expect(emptyBody.request_id).toBeTruthy();
    expect(JSON.stringify(emptyBody)).not.toMatch(/SyntaxError|Unexpected|stack/i);

    const wrongType = await h.app.handle(
      new Request("http://localhost/api/v1/dashboard/admins", {
        method: "POST",
        headers: {
          authorization: `Bearer ${superToken}`,
          "content-type": "text/plain",
        },
        body: "not-json",
      }),
    );
    expect(wrongType.status).toBe(422);
    const wrongBody = (await wrongType.json()) as ValidationBody;
    expect(wrongBody.error.code).toBe("VALIDATION_FAILED");
    expect(wrongBody.request_id).toBeTruthy();
    expect(JSON.stringify(wrongBody)).not.toContain("not-json");
  });

  test("POST null and array bodies are rejected without leaking payload", async () => {
    for (const payload of ["null", "[]", "[1]"]) {
      const response = await h.app.handle(
        new Request("http://localhost/api/v1/dashboard/admins", {
          method: "POST",
          headers: {
            authorization: `Bearer ${superToken}`,
            "content-type": "application/json",
          },
          body: payload,
        }),
      );
      expect(response.status).toBe(422);
      const text = await response.text();
      expect(text).not.toMatch(/"found"|"expected"|SyntaxError|stack/i);
      expect(text).not.toContain("[1]");
      const body = JSON.parse(text) as ValidationBody;
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.message).toBe("The request contains invalid fields");
      expect(body.error.details?.location).toBe("body");
      expect(body.error.details?.fields?.length).toBeGreaterThan(0);
      expect(body.request_id).toBeTruthy();
    }
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

  test("GET AppError query parsers return structured field details", async () => {
    const sortBy = await getAdmins("?sortBy=invalid");
    expect(sortBy.status).toBe(422);
    const sortByBody = (await sortBy.json()) as ValidationBody;
    expect(sortByBody.error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The request contains invalid fields",
    });
    expect(sortByBody.error.message).not.toBe("The request is invalid");
    expect(sortByBody.error.details?.location).toBe("query");
    expect(sortByBody.error.details?.fields).toContainEqual({
      field: "sortBy",
      code: "INVALID_VALUE",
      message: "sortBy has an invalid value",
    });

    const createdFrom = await getAdmins("?createdFrom=not-a-date");
    expect(createdFrom.status).toBe(422);
    const fromBody = (await createdFrom.json()) as ValidationBody;
    expect(
      fromBody.error.details?.fields.some(
        (f) => f.field === "createdFrom" && f.code === "INVALID_FORMAT",
      ),
    ).toBe(true);
    expect(JSON.stringify(fromBody)).not.toContain("not-a-date");

    const createdTo = await getAdmins("?createdTo=also-bad");
    expect(createdTo.status).toBe(422);
    const toBody = (await createdTo.json()) as ValidationBody;
    expect(
      toBody.error.details?.fields.some(
        (f) => f.field === "createdTo" && f.code === "INVALID_FORMAT",
      ),
    ).toBe(true);

    const range = await getAdmins("?createdFrom=2026-08-16&createdTo=2026-08-01");
    expect(range.status).toBe(422);
    const rangeBody = (await range.json()) as ValidationBody;
    expect(
      rangeBody.error.details?.fields.filter((f) => f.code === "INVALID_RANGE").map((f) => f.field).sort(),
    ).toEqual(["createdFrom", "createdTo"]);

    const status = await getAdmins("?status=NOT_A_STATUS");
    expect(status.status).toBe(422);
    const statusBody = (await status.json()) as ValidationBody;
    expect(statusBody.error.details?.fields).toContainEqual({
      field: "status",
      code: "INVALID_VALUE",
      message: "status has an invalid value",
    });
    expect(JSON.stringify(statusBody)).not.toContain("NOT_A_STATUS");
    expect(JSON.stringify(statusBody)).not.toMatch(/schema|staff_profile_status|stack/i);
  });
});
