import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth-module";
import { dashboardContext } from "../core/context";
import {
  bearer,
  errorResponse,
  parseAuthenticationBody,
  requestIdOf,
  standardErrors,
} from "../http/shared";
import type { EmployeeRoleCode } from "./permissions";
import { assertAllowedBodyKeys } from "../../geography/shared";

const adminCreateKeys = new Set(["email", "password", "cityId", "displayName"]);
const adminPatchKeys = new Set(["displayName", "cityId", "status"]);
const employeeCreateKeys = new Set(["email", "password", "role", "displayName"]);
const employeePatchKeys = new Set(["displayName", "status"]);
const permissionGrantKeys = new Set(["permission"]);

const parseStaffBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/admins")) {
    assertAllowedBodyKeys(body, adminCreateKeys);
  }
  if (method === "PATCH" && /\/dashboard\/admins\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, adminPatchKeys);
  }
  if (method === "POST" && path.endsWith("/dashboard/employees")) {
    assertAllowedBodyKeys(body, employeeCreateKeys);
  }
  if (method === "PATCH" && /\/dashboard\/employees\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, employeePatchKeys);
  }
  if (
    method === "POST" &&
    /\/dashboard\/employees\/[^/]+\/permissions$/.test(path)
  ) {
    assertAllowedBodyKeys(body, permissionGrantKeys);
  }
  return body;
};

const adminDto = t.Object({
  accountId: t.String({ format: "uuid" }),
  email: t.String(),
  displayName: t.Nullable(t.String()),
  status: t.Union([
    t.Literal("INVITED"),
    t.Literal("ACTIVE"),
    t.Literal("DISABLED"),
    t.Literal("CLOSED"),
  ]),
  cityId: t.String({ format: "uuid" }),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const employeeDto = t.Object({
  accountId: t.String({ format: "uuid" }),
  email: t.String(),
  displayName: t.Nullable(t.String()),
  status: t.Union([
    t.Literal("INVITED"),
    t.Literal("ACTIVE"),
    t.Literal("DISABLED"),
    t.Literal("CLOSED"),
  ]),
  roles: t.Array(
    t.Union([
      t.Literal("OPERATIONS"),
      t.Literal("ACCOUNTANT"),
      t.Literal("SUPPORT"),
    ]),
  ),
  permissions: t.Array(
    t.Union([
      t.Literal("zones.read"),
      t.Literal("zones.create"),
      t.Literal("zones.update"),
      t.Literal("zones.archive"),
      t.Literal("media.read"),
      t.Literal("media.create"),
      t.Literal("media.delete"),
      t.Literal("main_categories.read"),
      t.Literal("main_categories.create"),
      t.Literal("main_categories.update"),
      t.Literal("main_categories.archive"),
      t.Literal("subcategories.read"),
      t.Literal("subcategories.create"),
      t.Literal("subcategories.update"),
      t.Literal("subcategories.archive"),
      t.Literal("stores.read"),
      t.Literal("stores.create"),
      t.Literal("stores.update"),
      t.Literal("stores.archive"),
    ]),
  ),
  cityId: t.String({ format: "uuid" }),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const staffErrors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};

const permissionLiteral = t.Union([
  t.Literal("zones.read"),
  t.Literal("zones.create"),
  t.Literal("zones.update"),
  t.Literal("zones.archive"),
  t.Literal("media.read"),
  t.Literal("media.create"),
  t.Literal("media.delete"),
  t.Literal("main_categories.read"),
  t.Literal("main_categories.create"),
  t.Literal("main_categories.update"),
  t.Literal("main_categories.archive"),
  t.Literal("subcategories.read"),
  t.Literal("subcategories.create"),
  t.Literal("subcategories.update"),
  t.Literal("subcategories.archive"),
  t.Literal("stores.read"),
  t.Literal("stores.create"),
  t.Literal("stores.update"),
  t.Literal("stores.archive"),
]);

const employeeRoleLiteral = t.Union([
  t.Literal("OPERATIONS"),
  t.Literal("ACCOUNTANT"),
  t.Literal("SUPPORT"),
]);

export const staffOrganizationRoutes = (auth: AuthModule) =>
  new Elysia({ name: "staff-organization-routes" })
    .onParse(parseStaffBody)
    .post(
      "/api/v1/dashboard/admins",
      async ({ request, set, body }) =>
        auth.staff.createAdmin(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          body,
        ),
      {
        body: t.Object(
          {
            email: t.String({ maxLength: 254 }),
            password: t.String({ minLength: 12, maxLength: 256 }),
            cityId: t.String({ format: "uuid" }),
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: adminDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
          summary: "Create a City ADMIN (SUPER_ADMIN only)",
        },
      },
    )
    .get(
      "/api/v1/dashboard/admins",
      async ({ request, set }) =>
        auth.staff.listAdmins(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
        ),
      {
        response: {
          200: t.Object({ data: t.Array(adminDto) }),
          ...staffErrors,
        },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/admins/:adminId",
      async ({ request, set, params }) =>
        auth.staff.getAdmin(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.adminId,
        ),
      {
        params: t.Object(
          { adminId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: adminDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/admins/:adminId",
      async ({ request, set, params, body }) =>
        auth.staff.updateAdmin(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.adminId,
          body,
        ),
      {
        params: t.Object(
          { adminId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        body: t.Object(
          {
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            cityId: t.Optional(t.String({ format: "uuid" })),
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("DISABLED")]),
            ),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: adminDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/employees",
      async ({ request, set, body }) =>
        auth.staff.createEmployee(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          {
            email: body.email,
            password: body.password,
            role: body.role as EmployeeRoleCode,
            ...(body.displayName !== undefined
              ? { displayName: body.displayName }
              : {}),
          },
        ),
      {
        body: t.Object(
          {
            email: t.String({ maxLength: 254 }),
            password: t.String({ minLength: 12, maxLength: 256 }),
            role: employeeRoleLiteral,
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: employeeDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
          summary: "Create an employee under the authenticated ADMIN",
        },
      },
    )
    .get(
      "/api/v1/dashboard/employees",
      async ({ request, set }) =>
        auth.staff.listEmployees(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
        ),
      {
        response: {
          200: t.Object({ data: t.Array(employeeDto) }),
          ...staffErrors,
        },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/employees/:employeeId",
      async ({ request, set, params }) =>
        auth.staff.getEmployee(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.employeeId,
        ),
      {
        params: t.Object(
          { employeeId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: employeeDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/employees/:employeeId",
      async ({ request, set, params, body }) =>
        auth.staff.updateEmployee(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.employeeId,
          body,
        ),
      {
        params: t.Object(
          { employeeId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        body: t.Object(
          {
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("DISABLED")]),
            ),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: employeeDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/employees/:employeeId/permissions",
      async ({ request, set, params, body }) =>
        auth.staff.grantEmployeePermission(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.employeeId,
          String(body.permission),
        ),
      {
        params: t.Object(
          { employeeId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        body: t.Object(
          { permission: permissionLiteral },
          { additionalProperties: false },
        ),
        response: { 200: employeeDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/employees/:employeeId/permissions/:permission",
      async ({ request, set, params }) =>
        auth.staff.revokeEmployeePermission(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          params.employeeId,
          String(params.permission),
        ),
      {
        params: t.Object(
          {
            employeeId: t.String({ format: "uuid" }),
            permission: permissionLiteral,
          },
          { additionalProperties: false },
        ),
        response: { 200: employeeDto, ...staffErrors },
        detail: {
          tags: ["Dashboard — Staff"],
          security: [{ bearerAuth: [] }],
        },
      },
    );
