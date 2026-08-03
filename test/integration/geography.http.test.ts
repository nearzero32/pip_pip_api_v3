import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CITY_GOVERNORATE_FK_CONSTRAINT,
  isCityGovernorateForeignKeyViolation,
} from "../../src/modules/geography/city/city.service";
import {
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  seededGovernorateId,
  type IntegrationHarness,
} from "./helpers";

describe("M3-A Geography HTTP routes", () => {
  let harness: IntegrationHarness;
  const password = "fixed staff password";
  let superToken = "";
  let supportToken = "";
  let customerToken = "";
  let driverToken = "";
  let cityId = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_geo_http",
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "geo-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "geo-support@example.com",
      password,
      roles: ["SUPPORT"],
    });
    superToken = (
      await harness.auth.dashboard.login({
        email: "geo-super@example.com",
        password,
        deviceName: "s",
        ip: "s",
        requestId: "s",
      })
    ).access_token;
    supportToken = (
      await harness.auth.dashboard.login({
        email: "geo-support@example.com",
        password,
        deviceName: "p",
        ip: "p",
        requestId: "p",
      })
    ).access_token;

    harness.clock.advance();
    const challenge = await harness.auth.customer.requestOtp({
      phone: "+9647703200001",
      ip: "gc",
      requestId: "gc",
    });
    customerToken = (
      await harness.auth.customer.verifyOtp({
        challengeId: challenge,
        otp: harness.delivery.deliveries.at(-1)!.otp,
        deviceName: "c",
        ip: "gcv",
        requestId: "gcv",
      })
    ).access_token;
    await createDriverAccount(harness.client, "+9647703200010", "123456");
    driverToken = (
      await harness.auth.driver.login({
        phone: "+9647703200010",
        code: "123456",
        deviceName: "d",
        ip: "gd",
        requestId: "gd",
      })
    ).access_token;
  }, 60000);

  afterAll(async () => {
    await harness.close();
  });

  describe("Governorates", () => {
    test("Dashboard authentication and audience isolation", async () => {
      const ok = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/governorates", { token: superToken }),
      );
      expect(ok.status).toBe(200);
      for (const token of [customerToken, driverToken]) {
        const denied = await harness.app.handle(
          jsonRequest("/api/v1/dashboard/governorates", { token }),
        );
        expect(denied.status).toBe(401);
      }
    });

    test("SUPER_ADMIN update succeeds; non-SUPER_ADMIN rejected", async () => {
      const updated = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { displayOrder: 42 },
        }),
      );
      expect(updated.status).toBe(200);
      expect((await updated.json() as { displayOrder: number }).displayOrder).toBe(
        42,
      );
      const forbidden = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: supportToken,
          body: { displayOrder: 1 },
        }),
      );
      expect(forbidden.status).toBe(403);
    });

    test("empty PATCH, unknown properties, and name modification are rejected", async () => {
      const empty = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: {},
        }),
      );
      expect(empty.status).toBe(422);
      const unknown = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "ACTIVE", unexpected: true },
        }),
      );
      expect(unknown.status).toBe(422);
      const name = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { nameEn: "Hacked" },
        }),
      );
      expect(name.status).toBe(422);
    });

    test("unknown Governorate returns 404", async () => {
      const response = await harness.app.handle(
        jsonRequest(
          "/api/v1/dashboard/governorates/99999999-9999-4999-8999-999999999999",
          {
            method: "PATCH",
            token: superToken,
            body: { status: "ACTIVE" },
          },
        ),
      );
      expect(response.status).toBe(404);
      expect(
        (await response.json() as { error: { code: string } }).error.code,
      ).toBe("GOVERNORATE_NOT_FOUND");
    });

    test("changing Governorate status does not modify stored City statuses", async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "مدينة حالة",
            nameEn: "Status City",
            latitude: 33.1,
            longitude: 44.1,
            displayOrder: 10,
          },
        }),
      );
      const city = (await created.json()) as { id: string; status: string };
      cityId = city.id;
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}/activate`, {
          method: "POST",
          token: superToken,
        }),
      );
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "INACTIVE" },
        }),
      );
      const [row] = await harness.client<
        { city_status: string; governorate_status: string }[]
      >`select c.status city_status,g.status governorate_status from cities c join governorates g on g.id=c.governorate_id where c.id=${cityId}`;
      expect(row).toEqual({
        city_status: "ACTIVE",
        governorate_status: "INACTIVE",
      });
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "ACTIVE" },
        }),
      );
    });
  });

  describe("Cities", () => {
    test("create as DRAFT; reject status/archivedAt; coordinates and camelCase DTO", async () => {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "مدينة جديدة",
            nameEn: "New City",
            latitude: 33.3152,
            longitude: 44.3661,
            displayOrder: 3,
          },
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("DRAFT");
      expect(typeof body.latitude).toBe("number");
      expect(typeof body.longitude).toBe("number");
      expect(body).toHaveProperty("governorateId");
      expect(body).toHaveProperty("nameAr");
      expect(body).toHaveProperty("displayOrder");
      expect(body).not.toHaveProperty("governorate_id");
      expect(body).not.toHaveProperty("name_ar");
      expect(body).not.toHaveProperty("display_order");
      cityId = String(body.id);

      const withStatus = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "x",
            nameEn: "x",
            latitude: 1,
            longitude: 1,
            displayOrder: 0,
            status: "ACTIVE",
          },
        }),
      );
      expect(withStatus.status).toBe(422);
      const withArchived = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "x",
            nameEn: "x",
            latitude: 1,
            longitude: 1,
            displayOrder: 0,
            archivedAt: new Date().toISOString(),
          },
        }),
      );
      expect(withArchived.status).toBe(422);
    });

    test("rejects invalid coordinates, negative displayOrder, empty and unknown-only PATCH", async () => {
      const badLat = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "x",
            nameEn: "x",
            latitude: 91,
            longitude: 0,
            displayOrder: 0,
          },
        }),
      );
      expect(badLat.status).toBe(422);
      const badOrder = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "x",
            nameEn: "x",
            latitude: 0,
            longitude: 0,
            displayOrder: -1,
          },
        }),
      );
      expect(badOrder.status).toBe(422);
      const empty = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}`, {
          method: "PATCH",
          token: superToken,
          body: {},
        }),
      );
      expect(empty.status).toBe(422);
      const unknownOnly = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}`, {
          method: "PATCH",
          token: superToken,
          body: { mystery: 1 },
        }),
      );
      expect(unknownOnly.status).toBe(422);
    });

    test("invalid Governorate on create and update returns INVALID_GOVERNORATE", async () => {
      const missing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const create = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: missing,
            nameAr: "فاشل",
            nameEn: "Fail",
            latitude: 1,
            longitude: 1,
            displayOrder: 0,
          },
        }),
      );
      expect(create.status).toBe(422);
      const createBody = (await create.json()) as {
        error: { code: string; message: string };
      };
      expect(createBody.error.code).toBe("INVALID_GOVERNORATE");
      expect(JSON.stringify(createBody)).not.toContain(
        CITY_GOVERNORATE_FK_CONSTRAINT,
      );

      const update = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}`, {
          method: "PATCH",
          token: superToken,
          body: { governorateId: missing },
        }),
      );
      expect(update.status).toBe(422);
      const updateBody = (await update.json()) as {
        error: { code: string };
      };
      expect(updateBody.error.code).toBe("INVALID_GOVERNORATE");
      expect(JSON.stringify(updateBody)).not.toContain(
        CITY_GOVERNORATE_FK_CONSTRAINT,
      );
    });

    test("unrelated 23503 is not mapped to INVALID_GOVERNORATE", () => {
      expect(
        isCityGovernorateForeignKeyViolation({
          errno: "23503",
          constraint: "cities_governorate_id_governorates_id_fk",
        }),
      ).toBeTrue();
      expect(
        isCityGovernorateForeignKeyViolation({
          errno: "23503",
          constraint: "account_roles_account_id_accounts_id_fk",
        }),
      ).toBeFalse();
      expect(
        isCityGovernorateForeignKeyViolation({
          code: "ERR_POSTGRES_SERVER_ERROR",
          cause: {
            errno: "23503",
            constraint: "some_other_fk",
          },
        }),
      ).toBeFalse();
    });

    test("list filtering, search, pagination, ordering, and detail DTO", async () => {
      await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "بغداد شرق",
            nameEn: "Alpha City",
            latitude: 33.2,
            longitude: 44.2,
            displayOrder: 1,
          },
        }),
      );
      await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "بغداد غرب",
            nameEn: "Beta City",
            latitude: 33.2,
            longitude: 44.2,
            displayOrder: 2,
          },
        }),
      );
      const listed = await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/cities?governorateId=${seededGovernorateId}&status=DRAFT&search=Alpha&page=1&limit=10`,
          { token: superToken },
        ),
      );
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as {
        data: { nameEn: string; displayOrder: number }[];
        page: number;
        limit: number;
        total: number;
      };
      expect(page.page).toBe(1);
      expect(page.limit).toBe(10);
      expect(page.data.every((row) => row.nameEn.includes("Alpha"))).toBeTrue();
      const detail = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}`, {
          token: superToken,
        }),
      );
      expect(detail.status).toBe(200);
      const dto = (await detail.json()) as Record<string, unknown>;
      expect(dto).toMatchObject({
        id: cityId,
        governorateId: seededGovernorateId,
      });
      expect(typeof dto.latitude).toBe("number");
    });

    test("non-SUPER_ADMIN mutations return 403; no hard-delete route", async () => {
      const forbidden = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: supportToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "مرفوض",
            nameEn: "Denied",
            latitude: 1,
            longitude: 1,
            displayOrder: 0,
          },
        }),
      );
      expect(forbidden.status).toBe(403);
      const deleted = await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${cityId}`, {
          method: "DELETE",
          token: superToken,
        }),
      );
      expect(deleted.status).toBe(404);
    });
  });

  describe("State transitions", () => {
    const transition = (id: string, action: string) =>
      harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${id}/${action}`, {
          method: "POST",
          token: superToken,
        }),
      );

    test("allowed transitions and DTO; ARCHIVED is terminal and sets archivedAt", async () => {
      const make = async (name: string) => {
        const response = await harness.app.handle(
          jsonRequest("/api/v1/dashboard/cities", {
            method: "POST",
            token: superToken,
            body: {
              governorateId: seededGovernorateId,
              nameAr: name,
              nameEn: name,
              latitude: 32,
              longitude: 44,
              displayOrder: 5,
            },
          }),
        );
        return ((await response.json()) as { id: string }).id;
      };

      const draftToActive = await make("t-draft-active");
      let response = await transition(draftToActive, "activate");
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe("ACTIVE");

      const draftToArchived = await make("t-draft-archived");
      response = await transition(draftToArchived, "archive");
      expect(response.status).toBe(200);
      const archived = (await response.json()) as {
        status: string;
        archivedAt: string | null;
      };
      expect(archived.status).toBe("ARCHIVED");
      expect(archived.archivedAt).toBeTruthy();

      const active = await make("t-active-path");
      await transition(active, "activate");
      response = await transition(active, "suspend");
      expect((await response.json() as { status: string }).status).toBe(
        "SUSPENDED",
      );
      response = await transition(active, "activate");
      expect((await response.json() as { status: string }).status).toBe("ACTIVE");
      response = await transition(active, "archive");
      expect((await response.json() as { status: string }).status).toBe(
        "ARCHIVED",
      );

      const suspended = await make("t-suspended-archive");
      await transition(suspended, "activate");
      await transition(suspended, "suspend");
      response = await transition(suspended, "archive");
      expect((await response.json() as { status: string }).status).toBe(
        "ARCHIVED",
      );

      const terminal = await transition(draftToArchived, "activate");
      expect(terminal.status).toBe(409);
      expect(
        (await terminal.json() as { error: { code: string } }).error.code,
      ).toBe("INVALID_CITY_STATUS_TRANSITION");
    });

    test("invalid transitions return 409", async () => {
      const created = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/cities", {
          method: "POST",
          token: superToken,
          body: {
            governorateId: seededGovernorateId,
            nameAr: "invalid-t",
            nameEn: "invalid-t",
            latitude: 30,
            longitude: 40,
            displayOrder: 6,
          },
        }),
      );
      const id = ((await created.json()) as { id: string }).id;
      const suspendDraft = await transition(id, "suspend");
      expect(suspendDraft.status).toBe(409);
    });
  });

  describe("Mobile routes", () => {
    let activeVisible = "";
    let draftId = "";
    let suspendedId = "";
    let archivedId = "";
    let inactiveGovCity = "";

    beforeAll(async () => {
      const create = async (nameEn: string) => {
        const response = await harness.app.handle(
          jsonRequest("/api/v1/dashboard/cities", {
            method: "POST",
            token: superToken,
            body: {
              governorateId: seededGovernorateId,
              nameAr: nameEn,
              nameEn,
              latitude: 33.5,
              longitude: 44.5,
              displayOrder: 20,
            },
          }),
        );
        return ((await response.json()) as { id: string }).id;
      };
      activeVisible = await create("Mobile Active");
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${activeVisible}/activate`, {
          method: "POST",
          token: superToken,
        }),
      );
      draftId = await create("Mobile Draft");
      suspendedId = await create("Mobile Suspended");
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${suspendedId}/activate`, {
          method: "POST",
          token: superToken,
        }),
      );
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${suspendedId}/suspend`, {
          method: "POST",
          token: superToken,
        }),
      );
      archivedId = await create("Mobile Archived");
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${archivedId}/archive`, {
          method: "POST",
          token: superToken,
        }),
      );
      inactiveGovCity = await create("Inactive Gov City");
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/cities/${inactiveGovCity}/activate`, {
          method: "POST",
          token: superToken,
        }),
      );
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "INACTIVE" },
        }),
      );
      const [row] = await harness.client<
        { status: string }[]
      >`select status from cities where id=${inactiveGovCity}`;
      expect(row!.status).toBe("ACTIVE");
    });

    afterAll(async () => {
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "ACTIVE" },
        }),
      );
    });

    test("Customer and Driver see only ACTIVE cities under ACTIVE governorates", async () => {
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "ACTIVE" },
        }),
      );
      for (const path of [
        "/api/v1/mobile/customer/cities",
        "/api/v1/mobile/driver/cities",
      ]) {
        const response = await harness.app.handle(jsonRequest(path));
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          data: Record<string, unknown>[];
        };
        const ids = body.data.map((row) => row.id);
        expect(ids).toContain(activeVisible);
        expect(ids).not.toContain(draftId);
        expect(ids).not.toContain(suspendedId);
        expect(ids).not.toContain(archivedId);
        for (const row of body.data) {
          expect(typeof row.latitude).toBe("number");
          expect(typeof row.longitude).toBe("number");
          expect(row).not.toHaveProperty("status");
          expect(row).not.toHaveProperty("archivedAt");
          expect(row).not.toHaveProperty("governorate_id");
          expect(row).not.toHaveProperty("name_ar");
          expect(row).toHaveProperty("governorate");
        }
      }

      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "INACTIVE" },
        }),
      );
      const hidden = await harness.app.handle(
        jsonRequest("/api/v1/mobile/customer/cities"),
      );
      const hiddenIds = (
        (await hidden.json()) as { data: { id: string }[] }
      ).data.map((row) => row.id);
      expect(hiddenIds).not.toContain(activeVisible);
      expect(hiddenIds).not.toContain(inactiveGovCity);
    });

    test("mobile city lists are public and query cannot override visibility", async () => {
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
          method: "PATCH",
          token: superToken,
          body: { status: "ACTIVE" },
        }),
      );
      expect(
        (await harness.app.handle(jsonRequest("/api/v1/mobile/customer/cities")))
          .status,
      ).toBe(200);
      expect(
        (await harness.app.handle(jsonRequest("/api/v1/mobile/driver/cities")))
          .status,
      ).toBe(200);
      const override = await harness.app.handle(
        jsonRequest(
          "/api/v1/mobile/customer/cities?status=DRAFT&mobile=false",
        ),
      );
      expect(override.status).toBe(200);
      const overrideIds = (
        (await override.json()) as { data: { id: string; nameEn?: string }[] }
      ).data.map((row) => row.id);
      expect(overrideIds).not.toContain(draftId);
      expect(overrideIds).toContain(activeVisible);
    });
  });
});
