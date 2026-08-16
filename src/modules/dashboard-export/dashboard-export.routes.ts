import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import { authIdentity, requestIdOf } from "../geography/shared";
import {
  dashboardExportQuery,
  dashboardListQuery,
  dashboardPaginated,
} from "../dashboard-lists/query";
import type { DashboardExportService } from "./dashboard-export.service";

const detail = (summary: string, description: string) => ({
  tags: ["Dashboard — Exports"],
  summary,
  description: `${description} Response Content-Type is application/vnd.openxmlformats-officedocument.spreadsheetml.sheet. Requires the resource read permission plus the matching export permission. City-scoped exports use the signed token city; SUPER_ADMIN cannot export city operations.`,
  security: [{ bearerAuth: [] }],
});

type Query = Record<string, string | undefined>;
const opt = () => t.Optional(t.String());
const q = (extra: Record<string, unknown> = {}) =>
  t.Object({ ...dashboardListQuery, ...extra }, { additionalProperties: false });
const eq = (extra: Record<string, unknown> = {}) =>
  t.Object({ ...dashboardExportQuery, ...extra }, { additionalProperties: false });

const eventFilters = {
  orderId: opt(),
  eventType: opt(),
  source: opt(),
  actorAccountId: opt(),
  createdFrom: opt(),
  createdTo: opt(),
};
const assignmentFilters = {
  orderId: opt(),
  driverId: opt(),
  status: opt(),
  source: opt(),
  closingReason: opt(),
  assignedFrom: opt(),
  assignedTo: opt(),
};
const offerFilters = {
  orderId: opt(),
  status: opt(),
  roundKind: opt(),
  closingReason: opt(),
  openedFrom: opt(),
  openedTo: opt(),
};
const offerOneFilters = {
  status: opt(),
  roundKind: opt(),
  closingReason: opt(),
  openedFrom: opt(),
  openedTo: opt(),
};
const handoffFilters = {
  orderId: opt(),
  fromDriverId: opt(),
  toDriverId: opt(),
  status: opt(),
  createdFrom: opt(),
  createdTo: opt(),
};
const returnFilters = {
  orderId: opt(),
  driverId: opt(),
  status: opt(),
  createdFrom: opt(),
  createdTo: opt(),
};
const collectionFilters = {
  orderId: opt(),
  assignmentId: opt(),
  driverId: opt(),
  confirmationSource: opt(),
  expectedMin: opt(),
  expectedMax: opt(),
  collectedMin: opt(),
  collectedMax: opt(),
  differenceMin: opt(),
  differenceMax: opt(),
  collectedFrom: opt(),
  collectedTo: opt(),
};

export const dashboardExportRoutes = (
  auth: AuthModule,
  service: DashboardExportService,
) => {
  const identityOf = (
    request: Request,
    set: Parameters<typeof requestIdOf>[0],
  ) => authIdentity(auth, request, dashboardContext, requestIdOf(set));

  return new Elysia({ name: "dashboard-export-routes" })
    .get("/api/v1/dashboard/order-events", async ({ request, set, query }) =>
      service.listOrderEvents(await identityOf(request, set), query as Query),
      { query: q(eventFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Orders"], summary: "List order events", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/order-assignments", async ({ request, set, query }) =>
      service.listOrderAssignments(await identityOf(request, set), query as Query),
      { query: q(assignmentFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Orders"], summary: "List order assignments", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/order-offer-rounds", async ({ request, set, query }) =>
      service.listOrderOfferRounds(await identityOf(request, set), query as Query),
      { query: q(offerFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Order Offers"], summary: "List offer rounds", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/order-handoffs", async ({ request, set, query }) =>
      service.listOrderHandoffs(await identityOf(request, set), query as Query),
      { query: q(handoffFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Orders"], summary: "List driver handoffs", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/order-returns", async ({ request, set, query }) =>
      service.listOrderReturns(await identityOf(request, set), query as Query),
      { query: q(returnFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Orders"], summary: "List return workflows", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/order-collections", async ({ request, set, query }) =>
      service.listOrderCollections(await identityOf(request, set), query as Query),
      { query: q(collectionFilters), response: { 200: dashboardPaginated(t.Any()) },
        detail: { tags: ["Dashboard — Orders"], summary: "List collections", security: [{ bearerAuth: [] }] } },
    )
    .get("/api/v1/dashboard/governorates/export", async ({ request, set, query }) =>
      service.governorates(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ status: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export governorates", "SUPER_ADMIN plus governorates.export. Same filters as the governorates list.") },
    )
    .get("/api/v1/dashboard/cities/export", async ({ request, set, query }) =>
      service.cities(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ governorateId: opt(), status: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export cities", "SUPER_ADMIN plus cities.export. Same filters as the cities list.") },
    )
    .get("/api/v1/dashboard/zones/export", async ({ request, set, query }) =>
      service.zones(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ status: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export zones", "Requires zones.read and zones.export.") },
    )
    .get("/api/v1/dashboard/stores/export", async ({ request, set, query }) =>
      service.stores(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({
        status: opt(), mainCategoryId: opt(), zoneId: opt(),
        commissionRateMin: opt(), commissionRateMax: opt(), createdFrom: opt(), createdTo: opt(),
      }), detail: detail("Export stores", "Requires stores.read and stores.export.") },
    )
    .get("/api/v1/dashboard/store-commissions/export", async ({ request, set, query }) =>
      service.storeCommissions(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({
        status: opt(), commissionRateMin: opt(), commissionRateMax: opt(), createdFrom: opt(), createdTo: opt(),
      }), detail: detail("Export store commission rates", "Requires stores.commission.read and stores.commission.export.") },
    )
    .get("/api/v1/dashboard/store-commission-history/export", async ({ request, set, query }) =>
      service.storeCommissionHistory(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ storeId: opt() }),
        detail: detail("Export store commission history", "Requires stores.commission.read and stores.commission.history.export.") },
    )
    .get("/api/v1/dashboard/main-categories/export", async ({ request, set, query }) =>
      service.mainCategories(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ status: opt() }),
        detail: detail("Export main categories", "Requires main_categories.read and main_categories.export.") },
    )
    .get("/api/v1/dashboard/subcategories/export", async ({ request, set, query }) =>
      service.subcategories(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ mainCategoryId: opt(), status: opt() }),
        detail: detail("Export subcategories", "Requires subcategories.read and subcategories.export.") },
    )
    .get("/api/v1/dashboard/stores/:storeId/categories/export", async ({ request, set, params, query }) =>
      service.storeCategories(await identityOf(request, set), params.storeId, query as Query, requestIdOf(set)),
      { query: eq({ status: opt(), parentCategoryId: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export store categories", "Requires store_categories.read and store_categories.export.") },
    )
    .get("/api/v1/dashboard/stores/:storeId/products/export", async ({ request, set, params, query }) =>
      service.products(await identityOf(request, set), params.storeId, query as Query, requestIdOf(set)),
      { query: eq({
        status: opt(), categoryId: opt(), isAvailable: opt(), hasSizes: opt(),
        modifierGroupId: opt(), createdFrom: opt(), createdTo: opt(),
      }), detail: detail("Export store products", "Requires products.read and products.export.") },
    )
    .get("/api/v1/dashboard/stores/:storeId/modifier-groups/export", async ({ request, set, params, query }) =>
      service.modifierGroups(await identityOf(request, set), params.storeId, query as Query, requestIdOf(set)),
      { query: eq({ productId: opt(), status: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export modifier groups", "Requires modifiers.read and modifiers.export.") },
    )
    .get("/api/v1/dashboard/merchants/export", async ({ request, set, query }) =>
      service.merchants(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ status: opt(), storeId: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export merchants", "Requires merchants.read and merchants.export.") },
    )
    .get("/api/v1/dashboard/orders/export", async ({ request, set, query }) =>
      service.orders(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({
        status: opt(), storeId: opt(), customerId: opt(), driverId: opt(), assignmentId: opt(),
        custodyStatus: opt(), createdFrom: opt(), createdTo: opt(), deliveredFrom: opt(), deliveredTo: opt(),
        cancelledFrom: opt(), cancelledTo: opt(), hasActiveHandoff: opt(), hasActiveReturn: opt(),
        paymentMethod: opt(), paymentStatus: opt(), totalMin: opt(), totalMax: opt(),
        storeCommissionRateMin: opt(), storeCommissionRateMax: opt(),
      }), detail: detail("Export city orders", "Requires orders.read and orders.export.") },
    )
    .get("/api/v1/dashboard/order-events/export", async ({ request, set, query }) =>
      service.orderEvents(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(eventFilters),
        detail: detail("Export order events", "Requires orders.read and orders.events.export.") },
    )
    .get("/api/v1/dashboard/order-assignments/export", async ({ request, set, query }) =>
      service.orderAssignments(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(assignmentFilters),
        detail: detail("Export order assignments", "Requires orders.read and orders.assignments.export.") },
    )
    .get("/api/v1/dashboard/order-offer-rounds/export", async ({ request, set, query }) =>
      service.orderOfferRounds(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(offerFilters),
        detail: detail("Export order offer rounds", "Requires order_offers.read and order_offers.export.") },
    )
    .get("/api/v1/dashboard/orders/:orderId/offer-rounds/export", async ({ request, set, params, query }) =>
      service.orderOfferRounds(await identityOf(request, set), { ...(query as Query), orderId: params.orderId }, requestIdOf(set)),
      { query: eq(offerOneFilters),
        detail: detail("Export one order's offer rounds", "Requires order_offers.read and order_offers.export.") },
    )
    .get("/api/v1/dashboard/order-handoffs/export", async ({ request, set, query }) =>
      service.orderHandoffs(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(handoffFilters),
        detail: detail("Export driver handoffs", "Requires orders.read and orders.handoffs.export.") },
    )
    .get("/api/v1/dashboard/order-returns/export", async ({ request, set, query }) =>
      service.orderReturns(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(returnFilters),
        detail: detail("Export return workflows", "Requires orders.read and orders.returns.export.") },
    )
    .get("/api/v1/dashboard/order-collections/export", async ({ request, set, query }) =>
      service.orderCollections(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq(collectionFilters),
        detail: detail("Export delivery collections", "Requires orders.read and orders.collections.export.") },
    )
    .get("/api/v1/dashboard/drivers/assignment-candidates/export", async ({ request, set, query }) =>
      service.drivers(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ activeOrderCount: opt() }),
        detail: detail("Export assignment-candidate drivers", "Requires orders.assign and drivers.export.") },
    )
    .get("/api/v1/dashboard/employees/export", async ({ request, set, query }) =>
      service.employees(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ status: opt(), role: opt(), permission: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export employees", "Requires staff.export. ADMIN-owned employees only.") },
    )
    .get("/api/v1/dashboard/admins/export", async ({ request, set, query }) =>
      service.admins(await identityOf(request, set), query as Query, requestIdOf(set)),
      { query: eq({ cityId: opt(), status: opt(), createdFrom: opt(), createdTo: opt() }),
        detail: detail("Export city admins", "SUPER_ADMIN plus admins.export.") },
    )
    .get("/api/v1/dashboard/cities/:cityId/delivery-pricing/versions/export", async ({ request, set, params, query }) =>
      service.deliveryPricingVersions(await identityOf(request, set), params.cityId, query as Query, requestIdOf(set)),
      { query: eq({
        status: opt(), createdByAccountId: opt(), createdFrom: opt(), createdTo: opt(),
        activatedFrom: opt(), activatedTo: opt(),
      }), detail: detail("Export delivery pricing versions", "SUPER_ADMIN plus delivery_pricing.versions.export.") },
    );
};
