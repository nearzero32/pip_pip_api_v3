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
import { AppError } from "../../../errors/app-error";
import { assertAllowedQueryKeys } from "../../geography/shared";
import {
  dashboardListQuery,
  dashboardPaginated,
} from "../../dashboard-lists/query";
import type { EmployeeRoleCode } from "./permissions";

const permissionLiteral = t.String({ minLength: 1, maxLength: 80 });

const adminCreateKeys = new Set(["email", "password", "cityId", "displayName"]);
const adminPatchKeys = new Set(["displayName", "cityId", "status"]);
const employeeCreateKeys = new Set(["email", "password", "role", "displayName"]);
const employeePatchKeys = new Set(["displayName", "status"]);
const permissionGrantKeys = new Set(["permission"]);
const adminListQueryKeys = new Set([
  "search",
  "page",
  "limit",
  "sortBy",
  "sortOrder",
  "cityId",
  "status",
  "createdFrom",
  "createdTo",
]);
const employeeListQueryKeys = new Set([
  "search",
  "page",
  "limit",
  "sortBy",
  "sortOrder",
  "status",
  "role",
  "permission",
  "createdFrom",
  "createdTo",
]);

/** Parse only — never throw AppError here (Elysia wraps onParse throws as PARSE).
 * Unknown keys are detected from the raw JSON (before normalize strips them)
 * and rejected in onBeforeHandle so clients get a proper AppError. */
const pendingUnknownBodyFields = new WeakMap<Request, string[]>();

const parseStaffBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  let allowed: Set<string> | null = null;
  if (method === "POST" && path.endsWith("/dashboard/admins")) {
    allowed = adminCreateKeys;
  } else if (method === "PATCH" && /\/dashboard\/admins\/[^/]+$/.test(path)) {
    allowed = adminPatchKeys;
  } else if (method === "POST" && path.endsWith("/dashboard/employees")) {
    allowed = employeeCreateKeys;
  } else if (method === "PATCH" && /\/dashboard\/employees\/[^/]+$/.test(path)) {
    allowed = employeePatchKeys;
  } else if (
    method === "POST" &&
    /\/dashboard\/employees\/[^/]+\/permissions$/.test(path)
  ) {
    allowed = permissionGrantKeys;
  }
  if (
    allowed &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    const unknown = Object.keys(body as Record<string, unknown>)
      .filter((key) => !allowed.has(key))
      .sort((a, b) => a.localeCompare(b));
    if (unknown.length > 0) {
      pendingUnknownBodyFields.set(context.request, unknown);
    }
  }
  return body;
};

const assertStaffBodyKeys = ({ request }: { request: Request }) => {
  const unknown = pendingUnknownBodyFields.get(request);
  if (!unknown || unknown.length === 0) return;
  pendingUnknownBodyFields.delete(request);
  throw new AppError(
    422,
    "VALIDATION_FAILED",
    "The request contains invalid fields",
    undefined,
    undefined,
    {
      location: "body",
      fields: unknown.map((field) => ({
        field,
        code: "UNKNOWN_FIELD",
        message: `${field} is not allowed`,
      })),
    },
  );
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
  permissions: t.Array(permissionLiteral),
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

const employeeRoleLiteral = t.Union([
  t.Literal("OPERATIONS"),
  t.Literal("ACCOUNTANT"),
  t.Literal("SUPPORT"),
]);

export const staffOrganizationRoutes = (auth: AuthModule) =>
  new Elysia({ name: "staff-organization-routes" })
    .onParse(parseStaffBody)
    .onBeforeHandle(assertStaffBodyKeys)
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
        parse: "json",
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
      async ({ request, set, query }) => {
        assertAllowedQueryKeys(request, adminListQueryKeys);
        return auth.staff.listAdmins(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          query,
        );
      },
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            cityId: t.Optional(t.String({ format: "uuid" })),
            status: t.Optional(t.String()),
            createdFrom: t.Optional(t.String()),
            createdTo: t.Optional(t.String()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: dashboardPaginated(adminDto),
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
        parse: "json",
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
        parse: "json",
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
      async ({ request, set, query }) => {
        assertAllowedQueryKeys(request, employeeListQueryKeys);
        return auth.staff.listEmployees(
          await auth.sessions.authenticate(
            bearer(request),
            dashboardContext,
            requestIdOf(set),
          ),
          query,
        );
      },
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            status: t.Optional(t.String()),
            role: t.Optional(t.String()),
            permission: t.Optional(t.String()),
            createdFrom: t.Optional(t.String()),
            createdTo: t.Optional(t.String()),
          },
          { additionalProperties: false },
        ),
        response: {
          200: dashboardPaginated(employeeDto),
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
        parse: "json",
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
        parse: "json",
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
