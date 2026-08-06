import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import { AppError } from "../../errors/app-error";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import {
  assertCityOperability,
  beginWithGeographyRetry,
  lockCityGeography,
} from "../geography/geography-locks";
import { dateValue, pageOf } from "../geography/shared";
import { buildPublicMediaUrl } from "../media/object-key";
import type { MediaService } from "../media/media.service";
import {
  normalizeArabicCategoryName,
  validateDisplayOrder,
} from "./arabic-name";
import {
  parseIqdPrice,
  validateAvailabilityWindows,
  type AvailabilityWindow,
  type Weekday,
} from "./product-availability";

type ProductStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

type ProductRow = {
  id: string;
  store_id: string;
  city_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  base_price: number | null;
  status: ProductStatus;
  is_available: boolean;
  display_order: number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

type ImageRow = {
  id: string;
  product_id: string;
  media_asset_id: string;
  display_order: number;
  is_primary: boolean;
  object_key: string;
  visibility: string;
  asset_status: string;
};

type SizeRow = {
  id: string;
  product_id: string;
  name: string;
  price: number;
  status: ProductStatus;
  is_available: boolean;
  is_default: boolean;
  display_order: number;
  archived_at: Date | string | null;
};

type AvailabilityRow = {
  id: string;
  product_id: string;
  day_of_week: Weekday;
  opens_at: string;
  closes_at: string;
};

type ParsedImageInput = {
  assetId: string;
  isPrimary: boolean;
  displayOrder: number;
};

type ParsedSizeInput = {
  name: string;
  price: number;
  isDefault: boolean;
  isAvailable: boolean;
  status: ProductStatus;
  displayOrder: number;
};

const PRODUCT_SELECT = `
  p.id::text as id,
  p.store_id::text as store_id,
  p.city_id::text as city_id,
  p.category_id::text as category_id,
  p.name,
  p.description,
  p.base_price,
  p.status::text as status,
  p.is_available,
  p.display_order,
  p.created_at,
  p.updated_at,
  p.archived_at
`;

const sortUuidAsc = (ids: string[]) =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const uniqueViolationConstraint = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const code = String(record.errno ?? record.code ?? "");
  const constraint = String(record.constraint ?? "");
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : null;
  const causeCode = cause ? String(cause.errno ?? cause.code ?? "") : "";
  const causeConstraint = cause ? String(cause.constraint ?? "") : "";
  if (code !== "23505" && causeCode !== "23505") return null;
  return constraint || causeConstraint || "unknown";
};

const parseOptionalDescription = (
  raw: unknown,
  required: boolean,
): string | null | undefined => {
  if (raw === undefined) {
    if (required) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid description");
    }
    return undefined;
  }
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid description");
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const parseImages = (raw: unknown): ParsedImageInput[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(
      422,
      "PRODUCT_REQUIRES_IMAGE",
      "At least one product image is required",
    );
  }
  if (raw.length > 10) {
    throw new AppError(
      422,
      "PRODUCT_IMAGE_LIMIT_EXCEEDED",
      "At most 10 product images are allowed",
    );
  }
  const images: ParsedImageInput[] = [];
  const seen = new Set<string>();
  let primaryCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product image");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.assetId !== "string" || !row.assetId) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product image");
    }
    if (typeof row.isPrimary !== "boolean") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product image");
    }
    if (seen.has(row.assetId)) {
      throw new AppError(422, "VALIDATION_FAILED", "Duplicate product image");
    }
    seen.add(row.assetId);
    if (row.isPrimary) primaryCount += 1;
    const displayOrder =
      row.displayOrder === undefined
        ? i
        : validateDisplayOrder(row.displayOrder);
    images.push({
      assetId: row.assetId,
      isPrimary: row.isPrimary,
      displayOrder,
    });
  }
  if (primaryCount !== 1) {
    throw new AppError(
      422,
      "PRODUCT_REQUIRES_PRIMARY_IMAGE",
      "Exactly one primary product image is required",
    );
  }
  return images;
};

const parseCreateSizes = (raw: unknown): ParsedSizeInput[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new AppError(422, "VALIDATION_FAILED", "Invalid product sizes");
  }
  const sizes: ParsedSizeInput[] = [];
  let defaultCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product size");
    }
    const row = item as Record<string, unknown>;
    const name = normalizeArabicCategoryName(row.name);
    const price = parseIqdPrice(row.price, "price");
    if (typeof row.isDefault !== "boolean") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product size");
    }
    const status = (row.status as ProductStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid size status");
    }
    if (row.isDefault && status !== "ACTIVE") {
      throw new AppError(
        422,
        "PRODUCT_REQUIRES_DEFAULT_SIZE",
        "Default size must be ACTIVE",
      );
    }
    if (row.isDefault) defaultCount += 1;
    const isAvailable =
      row.isAvailable === undefined ? true : Boolean(row.isAvailable);
    if (typeof isAvailable !== "boolean") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product size");
    }
    const displayOrder =
      row.displayOrder === undefined
        ? i
        : validateDisplayOrder(row.displayOrder);
    sizes.push({
      name,
      price,
      isDefault: row.isDefault,
      isAvailable,
      status,
      displayOrder,
    });
  }
  const activeDefaults = sizes.filter((s) => s.isDefault && s.status === "ACTIVE");
  if (sizes.length > 0 && activeDefaults.length !== 1) {
    throw new AppError(
      422,
      "PRODUCT_REQUIRES_DEFAULT_SIZE",
      "Exactly one ACTIVE default size is required",
    );
  }
  if (defaultCount > 1) {
    throw new AppError(
      422,
      "PRODUCT_REQUIRES_DEFAULT_SIZE",
      "Exactly one ACTIVE default size is required",
    );
  }
  return sizes;
};

/**
 * Soft-archive all non-archived products in a Store category.
 * Caller must already hold geography + store + category locks.
 * Products are locked in UUID ascending order before update.
 * Does not touch product_images / product_sizes / availability rows.
 */
export const archiveProductsForCategory = async (
  tx: SQL,
  storeId: string,
  cityId: string,
  categoryId: string,
): Promise<number> => {
  const rows = await tx<{ id: string }[]>`
    select id::text as id
    from products
    where store_id = ${storeId}
      and city_id = ${cityId}
      and category_id = ${categoryId}
      and status <> 'ARCHIVED'
    order by id asc
    for update`;
  if (rows.length === 0) return 0;
  await tx`
    update products set
      status = 'ARCHIVED',
      archived_at = now(),
      updated_at = now()
    where store_id = ${storeId}
      and city_id = ${cityId}
      and category_id = ${categoryId}
      and status <> 'ARCHIVED'`;
  return rows.length;
};

export class ProductService {
  constructor(
    private client: SQL,
    private media: MediaService,
    private config: MediaConfig,
  ) {}

  private async authorize(
    identity: AuthIdentity,
    permission:
      | "products.read"
      | "products.create"
      | "products.update"
      | "products.archive",
  ) {
    const cityId = await requireCityPermission(
      this.client,
      identity,
      permission,
    );
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private mapUniqueViolation(constraint: string): never {
    if (constraint.includes("products_store_name_active_uidx")) {
      throw new AppError(
        409,
        "PRODUCT_NAME_CONFLICT",
        "Product name already exists",
      );
    }
    if (constraint.includes("product_sizes_product_name_active_uidx")) {
      throw new AppError(
        409,
        "PRODUCT_SIZE_NAME_CONFLICT",
        "Product size name already exists",
      );
    }
    if (
      constraint.includes("product_images_media_asset_uidx") ||
      constraint.includes("product_images_product_primary_uidx")
    ) {
      throw new AppError(
        409,
        "MEDIA_NOT_ATTACHABLE",
        "Media asset cannot be attached",
      );
    }
    if (constraint.includes("product_sizes_product_default_active_uidx")) {
      throw new AppError(
        409,
        "PRODUCT_REQUIRES_DEFAULT_SIZE",
        "Exactly one ACTIVE default size is required",
      );
    }
    throw new AppError(409, "PRODUCT_NAME_CONFLICT", "Product conflict");
  }

  private async lockStore(
    tx: SQL,
    storeId: string,
    cityId: string,
    options?: { allowArchived?: boolean },
  ) {
    const [row] = await tx<{ id: string; status: string }[]>`
      select id::text as id, status::text as status
      from stores
      where id = ${storeId} and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    }
    if (!options?.allowArchived && row.status === "ARCHIVED") {
      throw new AppError(409, "STORE_ARCHIVED", "Store is archived");
    }
    return row;
  }

  private async lockCategory(
    tx: SQL,
    storeId: string,
    cityId: string,
    categoryId: string,
  ) {
    const [row] = await tx<{ id: string; status: string }[]>`
      select id::text as id, status::text as status
      from store_categories
      where id = ${categoryId}
        and store_id = ${storeId}
        and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(
        404,
        "STORE_CATEGORY_NOT_FOUND",
        "Store category not found",
      );
    }
    if (row.status === "ARCHIVED") {
      throw new AppError(
        409,
        "STORE_CATEGORY_ARCHIVED",
        "Store category is archived",
      );
    }
    return row;
  }

  private async lockProduct(
    tx: SQL,
    storeId: string,
    cityId: string,
    productId: string,
    options?: { allowArchived?: boolean },
  ) {
    const [row] = await tx<{
      id: string;
      status: string;
      category_id: string | null;
      base_price: number | null;
      name: string;
      description: string | null;
      is_available: boolean;
      display_order: number;
    }[]>`
      select
        id::text as id,
        status::text as status,
        category_id::text as category_id,
        base_price,
        name,
        description,
        is_available,
        display_order
      from products
      where id = ${productId}
        and store_id = ${storeId}
        and city_id = ${cityId}
      for update`;
    if (!row) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    }
    if (!options?.allowArchived && row.status === "ARCHIVED") {
      throw new AppError(409, "PRODUCT_ARCHIVED", "Product is archived");
    }
    return row;
  }

  private async claimProductImages(
    tx: SQL,
    cityId: string,
    assetIds: string[],
  ) {
    for (const assetId of sortUuidAsc(assetIds)) {
      await this.media.claimAsset(tx, {
        assetId,
        cityId,
        purpose: "PRODUCT_IMAGE",
        visibility: "PUBLIC",
      });
    }
  }

  private async insertImages(
    tx: SQL,
    productId: string,
    storeId: string,
    cityId: string,
    images: ParsedImageInput[],
  ) {
    for (const image of images) {
      await tx`
        insert into product_images (
          product_id, store_id, city_id, media_asset_id, display_order, is_primary
        ) values (
          ${productId},
          ${storeId},
          ${cityId},
          ${image.assetId},
          ${image.displayOrder},
          ${image.isPrimary}
        )`;
    }
  }

  private async insertSizes(
    tx: SQL,
    productId: string,
    storeId: string,
    cityId: string,
    sizes: ParsedSizeInput[],
  ) {
    for (const size of sizes) {
      await tx`
        insert into product_sizes (
          product_id, store_id, city_id, name, price, status,
          is_available, is_default, display_order
        ) values (
          ${productId},
          ${storeId},
          ${cityId},
          ${size.name},
          ${size.price},
          ${size.status}::product_status,
          ${size.isAvailable},
          ${size.isDefault},
          ${size.displayOrder}
        )`;
    }
  }

  private async replaceAvailabilityRows(
    tx: SQL,
    productId: string,
    storeId: string,
    cityId: string,
    windows: AvailabilityWindow[],
  ) {
    await tx`
      delete from product_availability_windows
      where product_id = ${productId}
        and store_id = ${storeId}
        and city_id = ${cityId}`;
    for (const window of windows) {
      await tx`
        insert into product_availability_windows (
          product_id, store_id, city_id, day_of_week, opens_at, closes_at
        ) values (
          ${productId},
          ${storeId},
          ${cityId},
          ${window.dayOfWeek}::weekday,
          ${window.opensAt}::time,
          ${window.closesAt}::time
        )`;
    }
  }

  private async loadProductRow(
    storeId: string,
    productId: string,
    cityId: string,
    db: SQL = this.client,
  ): Promise<ProductRow> {
    const rows = (await db.unsafe(
      `select ${PRODUCT_SELECT}
       from products p
       where p.id = $1::uuid
         and p.store_id = $2::uuid
         and p.city_id = $3::uuid`,
      [productId, storeId, cityId],
    )) as ProductRow[];
    const row = rows[0];
    if (!row) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    }
    return row;
  }

  private async loadImages(
    productIds: string[],
    db: SQL = this.client,
  ): Promise<ImageRow[]> {
    if (productIds.length === 0) return [];
    const ids = db.array(productIds, "UUID");
    return (await db`
      select
        pi.id::text as id,
        pi.product_id::text as product_id,
        pi.media_asset_id::text as media_asset_id,
        pi.display_order,
        pi.is_primary,
        m.object_key,
        m.visibility::text as visibility,
        m.status::text as asset_status
      from product_images pi
      join media_assets m on m.id = pi.media_asset_id
      where pi.product_id = any(${ids})
      order by pi.display_order asc, pi.id asc`) as ImageRow[];
  }

  private async loadSizes(
    productIds: string[],
    db: SQL = this.client,
  ): Promise<SizeRow[]> {
    if (productIds.length === 0) return [];
    const ids = db.array(productIds, "UUID");
    return (await db`
      select
        id::text as id,
        product_id::text as product_id,
        name,
        price,
        status::text as status,
        is_available,
        is_default,
        display_order,
        archived_at
      from product_sizes
      where product_id = any(${ids})
      order by display_order asc, id asc`) as SizeRow[];
  }

  private async loadAvailability(
    productIds: string[],
    db: SQL = this.client,
  ): Promise<AvailabilityRow[]> {
    if (productIds.length === 0) return [];
    const ids = db.array(productIds, "UUID");
    return (await db`
      select
        id::text as id,
        product_id::text as product_id,
        day_of_week::text as day_of_week,
        to_char(opens_at, 'HH24:MI') as opens_at,
        to_char(closes_at, 'HH24:MI') as closes_at
      from product_availability_windows
      where product_id = any(${ids})
      order by day_of_week asc, opens_at asc, id asc`) as AvailabilityRow[];
  }

  private imageDto(row: ImageRow) {
    return {
      id: row.id,
      assetId: row.media_asset_id,
      url: buildPublicMediaUrl(
        this.config.r2PublicBaseUrl,
        row.object_key,
        (row.visibility as "PUBLIC" | "PRIVATE") ?? "PRIVATE",
        row.asset_status,
      ),
      isPrimary: Boolean(row.is_primary),
      displayOrder: Number(row.display_order),
    };
  }

  private sizeDto(row: SizeRow) {
    return {
      id: row.id,
      name: row.name,
      price: Number(row.price),
      status: row.status,
      isAvailable: Boolean(row.is_available),
      isDefault: Boolean(row.is_default),
      displayOrder: Number(row.display_order),
      archivedAt: dateValue(row.archived_at),
    };
  }

  private availabilityDto(row: AvailabilityRow) {
    return {
      id: row.id,
      dayOfWeek: row.day_of_week,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    };
  }

  private productDto(
    row: ProductRow,
    images: ImageRow[],
    sizes: SizeRow[],
    availability: AvailabilityRow[],
  ): any {
    return {
      id: row.id,
      storeId: row.store_id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      basePrice: row.base_price == null ? null : Number(row.base_price),
      status: row.status,
      isAvailable: Boolean(row.is_available),
      displayOrder: Number(row.display_order),
      images: images.map((image) => this.imageDto(image)),
      sizes: sizes.map((size) => this.sizeDto(size)),
      availability: availability.map((window) => this.availabilityDto(window)),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      archivedAt: dateValue(row.archived_at),
    };
  }

  private async getDto(
    storeId: string,
    productId: string,
    cityId: string,
  ): Promise<any> {
    const row = await this.loadProductRow(storeId, productId, cityId);
    const [images, sizes, availability] = await Promise.all([
      this.loadImages([productId]),
      this.loadSizes([productId]),
      this.loadAvailability([productId]),
    ]);
    return this.productDto(row, images, sizes, availability);
  }

  private assertCreatePricing(
    basePriceRaw: unknown,
    sizes: ParsedSizeInput[],
  ): number | null {
    if (sizes.length === 0) {
      if (basePriceRaw === undefined || basePriceRaw === null) {
        throw new AppError(
          422,
          "PRODUCT_REQUIRES_PRICE",
          "basePrice is required when the product has no sizes",
        );
      }
      return parseIqdPrice(basePriceRaw, "basePrice");
    }
    if (basePriceRaw !== undefined && basePriceRaw !== null) {
      throw new AppError(
        422,
        "PRODUCT_PRICE_WITH_SIZES",
        "basePrice must be null when the product has sizes",
      );
    }
    return null;
  }

  async create(
    identity: AuthIdentity,
    storeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }

    const name = normalizeArabicCategoryName(input.name);
    const description = parseOptionalDescription(input.description, false);
    const status = (input.status as ProductStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product status");
    }
    const isAvailable =
      input.isAvailable === undefined ? true : Boolean(input.isAvailable);
    if (typeof isAvailable !== "boolean") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid isAvailable");
    }
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );
    let categoryId: string | null = null;
    if ("categoryId" in input && input.categoryId != null) {
      if (typeof input.categoryId !== "string") {
        throw new AppError(422, "VALIDATION_FAILED", "Invalid categoryId");
      }
      categoryId = input.categoryId;
    }
    const images = parseImages(input.images);
    const sizes = parseCreateSizes(input.sizes);
    const basePrice = this.assertCreatePricing(input.basePrice, sizes);
    const availability =
      input.availability === undefined
        ? []
        : validateAvailabilityWindows(
            Array.isArray(input.availability)
              ? (input.availability as AvailabilityWindow[])
              : (() => {
                  throw new AppError(
                    422,
                    "INVALID_PRODUCT_AVAILABILITY",
                    "Invalid availability window",
                  );
                })(),
          );

    let productId = "";
    try {
      productId = await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        if (categoryId) {
          await this.lockCategory(tx, storeId, cityId, categoryId);
        }
        await this.claimProductImages(
          tx,
          cityId,
          images.map((image) => image.assetId),
        );
        const [inserted] = await tx<{ id: string }[]>`
          insert into products (
            store_id, city_id, category_id, name, description, base_price,
            status, is_available, display_order, created_by_account_id
          ) values (
            ${storeId},
            ${cityId},
            ${categoryId},
            ${name},
            ${description ?? null},
            ${basePrice},
            ${status}::product_status,
            ${isAvailable},
            ${displayOrder},
            ${identity.accountId}
          )
          returning id::text as id`;
        const id = inserted!.id;
        await this.insertImages(tx, id, storeId, cityId, images);
        await this.insertSizes(tx, id, storeId, cityId, sizes);
        await this.replaceAvailabilityRows(tx, id, storeId, cityId, availability);
        return id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId, categoryId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async list(
    identity: AuthIdentity,
    storeId: string,
    input: {
      status?: string;
      categoryId?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const cityId = await this.authorize(identity, "products.read");
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");

    const { page, limit } = pageOf(input.page, input.limit);
    const offset = (page - 1) * limit;
    const search = input.search?.trim() || null;
    const status = input.status?.trim() || null;
    if (
      status &&
      !["ACTIVE", "INACTIVE", "ARCHIVED"].includes(status)
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const categoryId =
      input.categoryId === undefined ||
      input.categoryId === "null" ||
      input.categoryId === ""
        ? input.categoryId === "null"
          ? "NULL"
          : null
        : input.categoryId;

    if (categoryId && categoryId !== "NULL") {
      const [category] = await this.client<{ id: string }[]>`
        select id::text as id from store_categories
        where id = ${categoryId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
      if (!category) {
        throw new AppError(
          404,
          "STORE_CATEGORY_NOT_FOUND",
          "Store category not found",
        );
      }
    }

    const rows = (await this.client.unsafe(
      `select ${PRODUCT_SELECT}
       from products p
       where p.store_id = $1::uuid
         and p.city_id = $2::uuid
         and ($3::text is null or p.status = $3::product_status)
         and ($3::text is not null or p.status <> 'ARCHIVED')
         and (
           $4::text is null
           or ($4::text = 'NULL' and p.category_id is null)
           or p.category_id = $4::uuid
         )
         and ($5::text is null or p.name ilike ('%' || $5 || '%'))
       order by p.display_order asc, p.created_at asc, p.id asc
       limit $6::int offset $7::int`,
      [storeId, cityId, status, categoryId, search, limit, offset],
    )) as ProductRow[];

    const [count] = (await this.client.unsafe(
      `select count(*)::text as total
       from products p
       where p.store_id = $1::uuid
         and p.city_id = $2::uuid
         and ($3::text is null or p.status = $3::product_status)
         and ($3::text is not null or p.status <> 'ARCHIVED')
         and (
           $4::text is null
           or ($4::text = 'NULL' and p.category_id is null)
           or p.category_id = $4::uuid
         )
         and ($5::text is null or p.name ilike ('%' || $5 || '%'))`,
      [storeId, cityId, status, categoryId, search],
    )) as { total: string }[];

    const productIds = rows.map((row) => row.id);
    const [images, sizes, availability] = await Promise.all([
      this.loadImages(productIds),
      this.loadSizes(productIds),
      this.loadAvailability(productIds),
    ]);
    const imagesByProduct = new Map<string, ImageRow[]>();
    const sizesByProduct = new Map<string, SizeRow[]>();
    const availabilityByProduct = new Map<string, AvailabilityRow[]>();
    for (const image of images) {
      const list = imagesByProduct.get(image.product_id) ?? [];
      list.push(image);
      imagesByProduct.set(image.product_id, list);
    }
    for (const size of sizes) {
      const list = sizesByProduct.get(size.product_id) ?? [];
      list.push(size);
      sizesByProduct.set(size.product_id, list);
    }
    for (const window of availability) {
      const list = availabilityByProduct.get(window.product_id) ?? [];
      list.push(window);
      availabilityByProduct.set(window.product_id, list);
    }

    return {
      data: rows.map((row) =>
        this.productDto(
          row,
          imagesByProduct.get(row.id) ?? [],
          sizesByProduct.get(row.id) ?? [],
          availabilityByProduct.get(row.id) ?? [],
        ),
      ),
      page,
      limit,
      total: Number(count?.total ?? 0),
    };
  }

  async get(identity: AuthIdentity, storeId: string, productId: string) {
    const cityId = await this.authorize(identity, "products.read");
    const [store] = await this.client<{ id: string }[]>`
      select id::text as id from stores
      where id = ${storeId} and city_id = ${cityId}`;
    if (!store) throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    return this.getDto(storeId, productId, cityId);
  }

  async update(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "storeId",
      "archivedAt",
      "createdAt",
      "updatedAt",
      "createdByAccountId",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const keys = [
      "name",
      "description",
      "categoryId",
      "basePrice",
      "status",
      "isAvailable",
      "displayOrder",
    ];
    if (!keys.some((key) => key in input)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Use DELETE to archive a product",
      );
    }
    if (
      "status" in input &&
      input.status !== undefined &&
      !["ACTIVE", "INACTIVE"].includes(String(input.status))
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid product status");
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);

        let requestedCategory: string | null | undefined;
        const categoryChanging = "categoryId" in input;
        if (categoryChanging) {
          if (input.categoryId === null) {
            requestedCategory = null;
          } else if (typeof input.categoryId === "string") {
            requestedCategory = input.categoryId;
          } else {
            throw new AppError(422, "VALIDATION_FAILED", "Invalid categoryId");
          }
        }

        if (requestedCategory) {
          await this.lockCategory(tx, storeId, cityId, requestedCategory);
        }

        const locked = await this.lockProduct(tx, storeId, cityId, productId);
        const nonArchivedSizes = await tx<{ id: string }[]>`
          select id::text as id from product_sizes
          where product_id = ${productId}
            and store_id = ${storeId}
            and status <> 'ARCHIVED'`;

        const name =
          "name" in input ? normalizeArabicCategoryName(input.name) : null;
        const description =
          "description" in input
            ? parseOptionalDescription(input.description, true)
            : undefined;
        const status =
          "status" in input ? (input.status as ProductStatus) : null;
        const isAvailable =
          "isAvailable" in input ? Boolean(input.isAvailable) : null;
        const displayOrder =
          "displayOrder" in input
            ? validateDisplayOrder(input.displayOrder)
            : null;

        let nextBasePrice: number | null | undefined;
        if ("basePrice" in input) {
          if (nonArchivedSizes.length > 0) {
            if (input.basePrice !== null && input.basePrice !== undefined) {
              throw new AppError(
                422,
                "PRODUCT_PRICE_WITH_SIZES",
                "basePrice must be null when the product has sizes",
              );
            }
            nextBasePrice = null;
          } else {
            if (input.basePrice === null || input.basePrice === undefined) {
              throw new AppError(
                422,
                "PRODUCT_REQUIRES_PRICE",
                "basePrice is required when the product has no sizes",
              );
            }
            nextBasePrice = parseIqdPrice(input.basePrice, "basePrice");
          }
        }

        const nextCategory = categoryChanging
          ? (requestedCategory ?? null)
          : locked.category_id;
        const nextDescription =
          description !== undefined ? description : locked.description;
        const nextBase =
          nextBasePrice !== undefined ? nextBasePrice : locked.base_price;

        await tx`
          update products set
            category_id = ${nextCategory},
            name = coalesce(${name}, name),
            description = ${nextDescription},
            base_price = ${nextBase},
            status = coalesce(${status}::product_status, status),
            is_available = coalesce(${isAvailable}, is_available),
            display_order = coalesce(${displayOrder}, display_order),
            updated_at = now()
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async archive(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.archive");
    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId, { allowArchived: true });
      const locked = await this.lockProduct(tx, storeId, cityId, productId, {
        allowArchived: true,
      });
      if (locked.status === "ARCHIVED") return;
      await tx`
        update products set
          status = 'ARCHIVED',
          archived_at = now(),
          updated_at = now()
        where id = ${productId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async replaceImages(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    imagesRaw: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    const images = parseImages(imagesRaw);

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        await this.lockProduct(tx, storeId, cityId, productId);

        const existing = await tx<
          { id: string; media_asset_id: string }[]
        >`
          select id::text as id, media_asset_id::text as media_asset_id
          from product_images
          where product_id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;

        const existingAssetIds = new Set(
          existing.map((row) => row.media_asset_id),
        );
        const nextAssetIds = new Set(images.map((image) => image.assetId));
        const toClaim = images
          .map((image) => image.assetId)
          .filter((assetId) => !existingAssetIds.has(assetId));
        const toRelease = [...existingAssetIds].filter(
          (assetId) => !nextAssetIds.has(assetId),
        );

        await this.claimProductImages(tx, cityId, toClaim);

        await tx`
          delete from product_images
          where product_id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
        await this.insertImages(tx, productId, storeId, cityId, images);

        for (const assetId of sortUuidAsc(toRelease)) {
          await this.media.releaseAsset(tx, { assetId, cityId });
        }

        await tx`
          update products set updated_at = now()
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_IMAGES_REPLACED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async addSize(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of ["cityId", "storeId", "productId"]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    const name = normalizeArabicCategoryName(input.name);
    const price = parseIqdPrice(input.price, "price");
    if (typeof input.isDefault !== "boolean") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid isDefault");
    }
    const status = (input.status as ProductStatus | undefined) ?? "ACTIVE";
    if (status !== "ACTIVE" && status !== "INACTIVE") {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid size status");
    }
    if (input.isDefault && status !== "ACTIVE") {
      throw new AppError(
        422,
        "PRODUCT_REQUIRES_DEFAULT_SIZE",
        "Default size must be ACTIVE",
      );
    }
    const isAvailable =
      input.isAvailable === undefined ? true : Boolean(input.isAvailable);
    const displayOrder = validateDisplayOrder(
      input.displayOrder === undefined ? 0 : input.displayOrder,
    );
    const transitionFromBasePrice = input.transitionFromBasePrice === true;

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        const product = await this.lockProduct(tx, storeId, cityId, productId);

        const existingSizes = await tx<
          { id: string; is_default: boolean; status: string }[]
        >`
          select
            id::text as id,
            is_default,
            status::text as status
          from product_sizes
          where product_id = ${productId}
            and store_id = ${storeId}
            and status <> 'ARCHIVED'
          for update`;

        // First size on a basePrice product: require transitionFromBasePrice=true
        // to clear base_price atomically in the same transaction.
        if (existingSizes.length === 0 && product.base_price != null) {
          if (!transitionFromBasePrice) {
            throw new AppError(
              422,
              "PRODUCT_PRICE_WITH_SIZES",
              "Set transitionFromBasePrice=true to clear basePrice when adding the first size",
            );
          }
          if (!input.isDefault || status !== "ACTIVE") {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "The first size must be the ACTIVE default",
            );
          }
          await tx`
            update products set
              base_price = null,
              updated_at = now()
            where id = ${productId}
              and store_id = ${storeId}
              and city_id = ${cityId}`;
        } else if (product.base_price != null) {
          throw new AppError(
            422,
            "PRODUCT_PRICE_WITH_SIZES",
            "basePrice must be null when the product has sizes",
          );
        } else if (existingSizes.length === 0 && !input.isDefault) {
          throw new AppError(
            422,
            "PRODUCT_REQUIRES_DEFAULT_SIZE",
            "Exactly one ACTIVE default size is required",
          );
        }

        if (input.isDefault) {
          await tx`
            update product_sizes set
              is_default = false,
              updated_at = now()
            where product_id = ${productId}
              and store_id = ${storeId}
              and is_default = true
              and status = 'ACTIVE'`;
        } else {
          const hasDefault = existingSizes.some(
            (size) => size.is_default && size.status === "ACTIVE",
          );
          if (!hasDefault && status === "ACTIVE") {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "Exactly one ACTIVE default size is required",
            );
          }
        }

        await tx`
          insert into product_sizes (
            product_id, store_id, city_id, name, price, status,
            is_available, is_default, display_order
          ) values (
            ${productId},
            ${storeId},
            ${cityId},
            ${name},
            ${price},
            ${status}::product_status,
            ${isAvailable},
            ${input.isDefault},
            ${displayOrder}
          )`;

        await tx`
          update products set updated_at = now()
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_SIZE_ADDED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async updateSize(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    sizeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    const keys = [
      "name",
      "price",
      "status",
      "isAvailable",
      "isDefault",
      "displayOrder",
      "replacementDefaultSizeId",
    ];
    if (!keys.some((key) => key in input)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    if ("status" in input && input.status === "ARCHIVED") {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Use DELETE to archive a product size",
      );
    }

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        await this.lockProduct(tx, storeId, cityId, productId);

        const [size] = await tx<{
          id: string;
          status: string;
          is_default: boolean;
          name: string;
          price: number;
          is_available: boolean;
          display_order: number;
        }[]>`
          select
            id::text as id,
            status::text as status,
            is_default,
            name,
            price,
            is_available,
            display_order
          from product_sizes
          where id = ${sizeId}
            and product_id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}
          for update`;
        if (!size) {
          throw new AppError(
            404,
            "PRODUCT_SIZE_NOT_FOUND",
            "Product size not found",
          );
        }
        if (size.status === "ARCHIVED") {
          throw new AppError(
            409,
            "PRODUCT_SIZE_NOT_FOUND",
            "Product size not found",
          );
        }

        const nextName =
          "name" in input ? normalizeArabicCategoryName(input.name) : size.name;
        const nextPrice =
          "price" in input ? parseIqdPrice(input.price, "price") : size.price;
        const nextStatus =
          "status" in input
            ? (input.status as ProductStatus)
            : (size.status as ProductStatus);
        if (nextStatus !== "ACTIVE" && nextStatus !== "INACTIVE") {
          throw new AppError(422, "VALIDATION_FAILED", "Invalid size status");
        }
        const nextIsAvailable =
          "isAvailable" in input
            ? Boolean(input.isAvailable)
            : size.is_available;
        const nextDisplayOrder =
          "displayOrder" in input
            ? validateDisplayOrder(input.displayOrder)
            : size.display_order;
        let nextIsDefault =
          "isDefault" in input ? Boolean(input.isDefault) : size.is_default;

        if (nextIsDefault && nextStatus !== "ACTIVE") {
          throw new AppError(
            422,
            "PRODUCT_REQUIRES_DEFAULT_SIZE",
            "Default size must be ACTIVE",
          );
        }

        const losingDefault =
          size.is_default &&
          (!nextIsDefault || nextStatus !== "ACTIVE");
        if (losingDefault) {
          const replacementId =
            typeof input.replacementDefaultSizeId === "string"
              ? input.replacementDefaultSizeId
              : null;
          if (!replacementId) {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "replacementDefaultSizeId is required",
            );
          }
          if (replacementId === sizeId) {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "replacementDefaultSizeId is required",
            );
          }
          const [replacement] = await tx<{
            id: string;
            status: string;
          }[]>`
            select id::text as id, status::text as status
            from product_sizes
            where id = ${replacementId}
              and product_id = ${productId}
              and store_id = ${storeId}
              and city_id = ${cityId}
            for update`;
          if (!replacement || replacement.status !== "ACTIVE") {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "replacementDefaultSizeId must reference an ACTIVE size",
            );
          }
          await tx`
            update product_sizes set
              is_default = false,
              updated_at = now()
            where product_id = ${productId}
              and is_default = true
              and status = 'ACTIVE'`;
          await tx`
            update product_sizes set
              is_default = true,
              updated_at = now()
            where id = ${replacementId}
              and product_id = ${productId}`;
          nextIsDefault = false;
        } else if (nextIsDefault && !size.is_default) {
          await tx`
            update product_sizes set
              is_default = false,
              updated_at = now()
            where product_id = ${productId}
              and is_default = true
              and status = 'ACTIVE'
              and id <> ${sizeId}`;
        }

        await tx`
          update product_sizes set
            name = ${nextName},
            price = ${nextPrice},
            status = ${nextStatus}::product_status,
            is_available = ${nextIsAvailable},
            is_default = ${nextIsDefault},
            display_order = ${nextDisplayOrder},
            updated_at = now()
          where id = ${sizeId}
            and product_id = ${productId}`;

        await tx`
          update products set updated_at = now()
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_SIZE_UPDATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId, sizeId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async archiveSize(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    sizeId: string,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    const input =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    try {
      await beginWithGeographyRetry(this.client, async (tx) => {
        const state = await lockCityGeography(tx, cityId);
        assertCityOperability(state);
        await this.lockStore(tx, storeId, cityId);
        await this.lockProduct(tx, storeId, cityId, productId);

        const siblings = await tx<
          {
            id: string;
            status: string;
            is_default: boolean;
          }[]
        >`
          select
            id::text as id,
            status::text as status,
            is_default
          from product_sizes
          where product_id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}
            and status <> 'ARCHIVED'
          order by id asc
          for update`;

        const size = siblings.find((row) => row.id === sizeId);
        if (!size) {
          throw new AppError(
            404,
            "PRODUCT_SIZE_NOT_FOUND",
            "Product size not found",
          );
        }

        const remaining = siblings.filter((row) => row.id !== sizeId);
        if (remaining.length === 0) {
          if (input.basePrice === undefined || input.basePrice === null) {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_PRICE",
              "basePrice is required when archiving the last size",
            );
          }
          const basePrice = parseIqdPrice(input.basePrice, "basePrice");
          await tx`
            update product_sizes set
              status = 'ARCHIVED',
              is_default = false,
              archived_at = now(),
              updated_at = now()
            where id = ${sizeId}
              and product_id = ${productId}`;
          await tx`
            update products set
              base_price = ${basePrice},
              updated_at = now()
            where id = ${productId}
              and store_id = ${storeId}
              and city_id = ${cityId}`;
          return;
        }

        if (size.is_default) {
          const replacementId =
            typeof input.replacementDefaultSizeId === "string"
              ? input.replacementDefaultSizeId
              : null;
          if (!replacementId) {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "replacementDefaultSizeId is required",
            );
          }
          const replacement = remaining.find(
            (row) => row.id === replacementId && row.status === "ACTIVE",
          );
          if (!replacement) {
            throw new AppError(
              422,
              "PRODUCT_REQUIRES_DEFAULT_SIZE",
              "replacementDefaultSizeId must reference an ACTIVE size",
            );
          }
          await tx`
            update product_sizes set
              is_default = false,
              updated_at = now()
            where product_id = ${productId}
              and is_default = true
              and status = 'ACTIVE'`;
          await tx`
            update product_sizes set
              is_default = true,
              updated_at = now()
            where id = ${replacementId}
              and product_id = ${productId}`;
        }

        await tx`
          update product_sizes set
            status = 'ARCHIVED',
            is_default = false,
            archived_at = now(),
            updated_at = now()
          where id = ${sizeId}
            and product_id = ${productId}`;

        await tx`
          update products set updated_at = now()
          where id = ${productId}
            and store_id = ${storeId}
            and city_id = ${cityId}`;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint) this.mapUniqueViolation(constraint);
      throw error;
    }

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_SIZE_ARCHIVED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId, sizeId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }

  async replaceAvailability(
    identity: AuthIdentity,
    storeId: string,
    productId: string,
    windowsRaw: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "products.update");
    if (!Array.isArray(windowsRaw)) {
      throw new AppError(
        422,
        "INVALID_PRODUCT_AVAILABILITY",
        "Invalid availability window",
      );
    }
    const windows = validateAvailabilityWindows(
      windowsRaw as AvailabilityWindow[],
    );

    await beginWithGeographyRetry(this.client, async (tx) => {
      const state = await lockCityGeography(tx, cityId);
      assertCityOperability(state);
      await this.lockStore(tx, storeId, cityId);
      await this.lockProduct(tx, storeId, cityId, productId);
      await this.replaceAvailabilityRows(
        tx,
        productId,
        storeId,
        cityId,
        windows,
      );
      await tx`
        update products set updated_at = now()
        where id = ${productId}
          and store_id = ${storeId}
          and city_id = ${cityId}`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'PRODUCT_AVAILABILITY_REPLACED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ storeId, productId })}::jsonb
      )`;

    return this.getDto(storeId, productId, cityId);
  }
}
