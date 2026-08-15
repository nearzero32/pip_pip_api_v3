import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { merchantContext } from "../auth/core/context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import { requireTrustedMerchantStore } from "../auth/merchant/merchant-access";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dateSchema,
  pageQuery,
  paginated,
  requestIdOf,
} from "../geography/shared";
import type { MediaService } from "../media/media.service";
import type { StoreService } from "../stores/store.service";
import type { ModifierService } from "./modifier.service";
import type { ProductService } from "./product.service";
import type { StoreCategoryService } from "./store-category.service";

const tag = ["Mobile — Merchant Catalog"];
const storeTag = ["Mobile — Merchant Store"];
const mediaTag = ["Mobile — Merchant Media"];

const merchantIdentity = (
  auth: AuthModule,
  request: Request,
  requestId: string,
) => authIdentity(auth, request, merchantContext, requestId);

const trustedStore = async (
  auth: AuthModule,
  request: Request,
  requestId: string,
) => {
  const identity = await merchantIdentity(auth, request, requestId);
  const scope = requireTrustedMerchantStore(identity);
  return { identity, ...scope };
};

const errors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};

const productStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const productDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  categoryId: t.Nullable(t.String({ format: "uuid" })),
  modifierGroupId: t.Nullable(t.String({ format: "uuid" })),
  name: t.String(),
  description: t.Nullable(t.String()),
  basePrice: t.Nullable(t.Integer({ exclusiveMinimum: 0 })),
  status: productStatus,
  isAvailable: t.Boolean(),
  displayOrder: t.Integer({ minimum: 0 }),
  images: t.Array(t.Any()),
  sizes: t.Array(t.Any()),
  availability: t.Array(t.Any()),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const storeCategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  parentCategoryId: t.Nullable(t.String({ format: "uuid" })),
  name: t.String(),
  status: productStatus,
  displayOrder: t.Integer({ minimum: 0 }),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const groupDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  name: t.String(),
  minSelect: t.Integer({ minimum: 0 }),
  maxSelect: t.Integer({ minimum: 1 }),
  status: productStatus,
  options: t.Array(t.Any()),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const mediaAssetDto = t.Object({
  id: t.String({ format: "uuid" }),
  status: t.String(),
  purpose: t.String(),
  visibility: t.String(),
  originalName: t.String(),
  contentType: t.String(),
  sizeBytes: t.Number(),
  url: t.Nullable(t.String()),
  uploadExpiresAt: t.Nullable(dateSchema),
  readyAt: t.Nullable(dateSchema),
  attachedAt: t.Nullable(dateSchema),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const merchantCatalogRoutes = (
  auth: AuthModule,
  deps: {
    products: ProductService;
    storeCategories: StoreCategoryService;
    modifiers: ModifierService;
    stores: StoreService;
    media: MediaService;
  },
) =>
  new Elysia({ name: "merchant-catalog-routes" })
    .onParse(parseAuthenticationBody)
    .patch(
      "/api/v1/mobile/merchant/store/order-acceptance",
      async ({ request, set, body }) => {
        const id = requestIdOf(set);
        const { identity } = await trustedStore(auth, request, id);
        return deps.stores.updateMerchantOrderAcceptance(identity, body, id);
      },
      {
        parse: "json",
        body: t.Object(
          {
            orderAcceptanceStatus: t.Union([
              t.Literal("ACCEPTING"),
              t.Literal("PAUSED"),
            ]),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: {
          tags: storeTag,
          security: [{ bearerAuth: [] }],
          summary: "Set own Store order acceptance (open/closed)",
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/media/upload-intents",
      async ({ request, set, body }) => {
        const id = requestIdOf(set);
        assertAllowedBodyKeys(
          body,
          new Set(["purpose", "fileName", "contentType", "sizeBytes"]),
        );
        const { identity } = await trustedStore(auth, request, id);
        return deps.media.createUploadIntent(identity, body, id);
      },
      {
        parse: "json",
        body: t.Object(
          {
            purpose: t.Literal("PRODUCT_IMAGE"),
            fileName: t.String({ minLength: 1, maxLength: 255 }),
            contentType: t.String({ minLength: 1, maxLength: 100 }),
            sizeBytes: t.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({
            asset: mediaAssetDto,
            upload: t.Object({
              method: t.Literal("PUT"),
              url: t.String(),
              headers: t.Object({ "Content-Type": t.String() }),
              expiresAt: dateSchema,
            }),
          }),
          ...errors,
        },
        detail: {
          tags: mediaTag,
          security: [{ bearerAuth: [] }],
          summary: "Create PRODUCT_IMAGE upload intent for Merchant Store City",
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/media/:assetId/confirm",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity } = await trustedStore(auth, request, id);
        return deps.media.confirm(identity, params.assetId, id);
      },
      {
        params: t.Object(
          { assetId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: mediaAssetDto, ...errors },
        detail: { tags: mediaTag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/products",
      async ({ request, set, query }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.products.list(identity, storeId, query);
      },
      {
        query: t.Object(
          {
            page: pageQuery.page,
            limit: pageQuery.limit,
            search: pageQuery.search,
            status: t.Optional(productStatus),
            categoryId: t.Optional(t.String({ maxLength: 64 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: paginated(productDto), ...errors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "List products for trusted Merchant Store",
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/products",
      async ({ request, set, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.products.create(identity, storeId, body, id);
      },
      {
        parse: "json",
        body: t.Any(),
        response: { 200: productDto, ...errors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "Create product in trusted Merchant Store",
        },
      },
    )
    .get(
      "/api/v1/mobile/merchant/products/:productId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.products.get(identity, storeId, params.productId);
      },
      {
        params: t.Object(
          { productId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: productDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .patch(
      "/api/v1/mobile/merchant/products/:productId",
      async ({ request, set, params, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.products.update(
          identity,
          storeId,
          params.productId,
          body,
          id,
        );
      },
      {
        params: t.Object(
          { productId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        parse: "json",
        body: t.Any(),
        response: { 200: productDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/api/v1/mobile/merchant/products/:productId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.products.archive(identity, storeId, params.productId, id);
      },
      {
        params: t.Object(
          { productId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: productDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/categories",
      async ({ request, set }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.storeCategories.list(identity, storeId, {});
      },
      {
        response: {
          200: t.Object({ data: t.Array(storeCategoryDto) }),
          ...errors,
        },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "List Store Categories for trusted Merchant Store",
        },
      },
    )
    .post(
      "/api/v1/mobile/merchant/categories",
      async ({ request, set, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.storeCategories.create(identity, storeId, body, id);
      },
      {
        parse: "json",
        body: t.Any(),
        response: { 200: storeCategoryDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/categories/:categoryId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.storeCategories.get(identity, storeId, params.categoryId);
      },
      {
        params: t.Object(
          { categoryId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: storeCategoryDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .patch(
      "/api/v1/mobile/merchant/categories/:categoryId",
      async ({ request, set, params, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.storeCategories.update(
          identity,
          storeId,
          params.categoryId,
          body,
          id,
        );
      },
      {
        params: t.Object(
          { categoryId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        parse: "json",
        body: t.Any(),
        response: { 200: storeCategoryDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/api/v1/mobile/merchant/categories/:categoryId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.storeCategories.archive(
          identity,
          storeId,
          params.categoryId,
          id,
        );
      },
      {
        params: t.Object(
          { categoryId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: storeCategoryDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/modifier-groups",
      async ({ request, set, query }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.listGroups(identity, storeId, query);
      },
      {
        query: t.Object(
          {
            page: pageQuery.page,
            limit: pageQuery.limit,
            search: pageQuery.search,
            status: t.Optional(productStatus),
          },
          { additionalProperties: false },
        ),
        response: { 200: paginated(groupDto), ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/api/v1/mobile/merchant/modifier-groups",
      async ({ request, set, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.createGroup(identity, storeId, body, id);
      },
      {
        parse: "json",
        body: t.Any(),
        response: { 200: groupDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/modifier-groups/:groupId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.getGroup(identity, storeId, params.groupId);
      },
      {
        params: t.Object(
          { groupId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: groupDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .patch(
      "/api/v1/mobile/merchant/modifier-groups/:groupId",
      async ({ request, set, params, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.updateGroup(
          identity,
          storeId,
          params.groupId,
          body,
          id,
        );
      },
      {
        params: t.Object(
          { groupId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        parse: "json",
        body: t.Any(),
        response: { 200: groupDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/api/v1/mobile/merchant/modifier-groups/:groupId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.archiveGroup(
          identity,
          storeId,
          params.groupId,
          id,
        );
      },
      {
        params: t.Object(
          { groupId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: groupDto, ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/api/v1/mobile/merchant/products/:productId/modifiers",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.getProductModifiers(
          identity,
          storeId,
          params.productId,
        );
      },
      {
        params: t.Object(
          { productId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .put(
      "/api/v1/mobile/merchant/products/:productId/modifiers/:optionId",
      async ({ request, set, params, body }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.upsertProductModifierOption(
          identity,
          storeId,
          params.productId,
          params.optionId,
          body,
          id,
        );
      },
      {
        params: t.Object(
          {
            productId: t.String({ format: "uuid" }),
            optionId: t.String({ format: "uuid" }),
          },
          { additionalProperties: false },
        ),
        parse: "json",
        body: t.Any(),
        response: { 200: t.Any(), ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/api/v1/mobile/merchant/products/:productId/modifiers/:optionId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        const { identity, storeId } = await trustedStore(auth, request, id);
        return deps.modifiers.removeProductModifierOption(
          identity,
          storeId,
          params.productId,
          params.optionId,
          id,
        );
      },
      {
        params: t.Object(
          {
            productId: t.String({ format: "uuid" }),
            optionId: t.String({ format: "uuid" }),
          },
          { additionalProperties: false },
        ),
        response: { 200: t.Any(), ...errors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    );
