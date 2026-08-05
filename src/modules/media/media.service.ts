import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import { requireCityPermission } from "../auth/staff/authorization";
import { assertActiveCity } from "../auth/staff/dashboard-scope";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { dateValue } from "../geography/shared";
import {
  buildCategoryImageObjectKey,
  buildPublicMediaUrl,
  buildStoreCoverObjectKey,
  buildStoreLogoObjectKey,
  isAllowedImageContentType,
  validateOriginalFileName,
} from "./object-key";
import {
  MediaStorageError,
  type MediaStorage,
} from "./media-storage";
import { assertImageSignatureMatches } from "./signatures";

export const MEDIA_OPEN_ASSET_QUOTA_PER_CREATOR = 20;
const SIGNATURE_PREFIX_BYTES = 32;

type MediaRow = {
  id: string;
  city_id: string;
  purpose: string;
  visibility: string;
  status: string;
  object_key: string;
  original_name: string;
  expected_content_type: string;
  expected_size_bytes: string | number;
  verified_content_type: string | null;
  verified_size_bytes: string | number | null;
  etag: string | null;
  created_by_account_id: string;
  upload_expires_at: Date | string;
  ready_at: Date | string | null;
  attached_at: Date | string | null;
  delete_requested_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asNumber = (value: string | number | null | undefined): number | null => {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

export const mediaAssetDto = (
  row: MediaRow,
  publicBaseUrl: string,
): any => {
  const status = row.status;
  const visibility = row.visibility as "PUBLIC" | "PRIVATE";
  const contentType =
    row.verified_content_type ?? row.expected_content_type;
  const sizeBytes =
    asNumber(row.verified_size_bytes) ?? asNumber(row.expected_size_bytes) ?? 0;
  return {
    id: row.id,
    status,
    purpose: row.purpose,
    visibility,
    originalName: row.original_name,
    contentType,
    sizeBytes,
    url: buildPublicMediaUrl(
      publicBaseUrl,
      row.object_key,
      visibility,
      status,
    ),
    uploadExpiresAt:
      status === "PENDING_UPLOAD" ? dateValue(row.upload_expires_at) : null,
    readyAt: dateValue(row.ready_at),
    attachedAt: dateValue(row.attached_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
};

const storageUnavailable = () =>
  new AppError(
    503,
    "MEDIA_STORAGE_UNAVAILABLE",
    "Media storage is temporarily unavailable",
  );

const mapStorageError = (
  error: unknown,
  logger: Logger,
  meta: Record<string, unknown>,
): never => {
  const operation =
    error instanceof MediaStorageError ? error.operation : "unknown";
  logger.warn({
    event: "media_storage_error",
    operation,
    error_name: error instanceof Error ? error.name : "UnknownError",
    ...meta,
  });
  throw storageUnavailable();
};

export class MediaService {
  constructor(
    private client: SQL,
    private storage: MediaStorage,
    private config: MediaConfig,
    private logger: Logger,
  ) {}

  /** Expose object key only for tests that assert key generation. */
  async getObjectKeyForTests(assetId: string, cityId: string): Promise<string | null> {
    const [row] = await this.client<{ object_key: string }[]>`
      select object_key from media_assets
      where id = ${assetId} and city_id = ${cityId}`;
    return row?.object_key ?? null;
  }

  private async authorize(
    identity: AuthIdentity,
    permission: "media.read" | "media.create" | "media.delete",
  ): Promise<string> {
    const cityId = await requireCityPermission(this.client, identity, permission);
    await assertActiveCity(this.client, cityId);
    return cityId;
  }

  private async loadCityScoped(
    assetId: string,
    cityId: string,
  ): Promise<MediaRow> {
    const [row] = await this.client<MediaRow[]>`
      select
        id::text as id,
        city_id::text as city_id,
        purpose::text as purpose,
        visibility::text as visibility,
        status::text as status,
        object_key,
        original_name,
        expected_content_type,
        expected_size_bytes,
        verified_content_type,
        verified_size_bytes,
        etag,
        created_by_account_id::text as created_by_account_id,
        upload_expires_at,
        ready_at,
        attached_at,
        delete_requested_at,
        deleted_at,
        created_at,
        updated_at
      from media_assets
      where id = ${assetId} and city_id = ${cityId}`;
    if (!row) throw new AppError(404, "MEDIA_NOT_FOUND", "Media asset not found");
    return row;
  }

  async createUploadIntent(
    identity: AuthIdentity,
    body: unknown,
    requestId: string,
  ) {
    const cityId = await this.authorize(identity, "media.create");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
    }
    const input = body as Record<string, unknown>;
    for (const forbidden of [
      "cityId",
      "objectKey",
      "visibility",
      "status",
      "url",
      "bucket",
    ]) {
      if (forbidden in input) {
        throw new AppError(422, "VALIDATION_FAILED", "The request is invalid");
      }
    }
    if (
      input.purpose !== "CATEGORY_IMAGE" &&
      input.purpose !== "STORE_LOGO" &&
      input.purpose !== "STORE_IMAGE"
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Unsupported media purpose");
    }
    const purpose = input.purpose as
      | "CATEGORY_IMAGE"
      | "STORE_LOGO"
      | "STORE_IMAGE";
    const contentType = String(input.contentType ?? "");
    if (!isAllowedImageContentType(contentType)) {
      throw new AppError(422, "VALIDATION_FAILED", "Unsupported media content type");
    }
    let fileName: string;
    try {
      fileName = validateOriginalFileName(String(input.fileName ?? ""));
    } catch {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid file name");
    }
    const sizeBytes = input.sizeBytes;
    if (
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > this.config.mediaMaxImageBytes
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid media size");
    }

    const assetId = crypto.randomUUID();
    const objectKey =
      purpose === "CATEGORY_IMAGE"
        ? buildCategoryImageObjectKey(cityId, assetId, contentType)
        : purpose === "STORE_LOGO"
          ? buildStoreLogoObjectKey(cityId, assetId, contentType)
          : buildStoreCoverObjectKey(cityId, assetId, contentType);
    const uploadExpiresAt = new Date(
      Date.now() + this.config.r2UploadUrlTtlSeconds * 1000,
    );
    let upload;
    try {
      upload = await this.storage.createUploadUrl({
        objectKey,
        contentType,
        expiresInSeconds: this.config.r2UploadUrlTtlSeconds,
      });
    } catch (error) {
      mapStorageError(error, this.logger, {
        asset_id: assetId,
        city_id: cityId,
        request_id: requestId,
      });
    }

    await this.client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`media:quota:${identity.accountId}`}, 0))`;
      const [count] = await tx<{ n: string }[]>`
        select count(*)::text as n
        from media_assets
        where created_by_account_id = ${identity.accountId}
          and (
            (status = 'PENDING_UPLOAD' and upload_expires_at > now())
            or (status = 'READY' and attached_at is null)
          )`;
      if (Number(count?.n ?? 0) >= MEDIA_OPEN_ASSET_QUOTA_PER_CREATOR) {
        throw new AppError(
          429,
          "MEDIA_UPLOAD_QUOTA_EXCEEDED",
          "Too many open media upload intents",
        );
      }
      await tx`
        insert into media_assets (
          id, city_id, purpose, visibility, status,
          object_key, original_name, expected_content_type, expected_size_bytes,
          created_by_account_id, upload_expires_at
        ) values (
          ${assetId},
          ${cityId},
          ${purpose}::media_asset_purpose,
          'PUBLIC',
          'PENDING_UPLOAD',
          ${objectKey},
          ${fileName},
          ${contentType},
          ${sizeBytes},
          ${identity.accountId},
          ${uploadExpiresAt}
        )`;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MEDIA_UPLOAD_INTENT_CREATED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ asset_id: assetId, city_id: cityId, purpose })}::jsonb
      )`;

    const row = await this.loadCityScoped(assetId, cityId);
    return {
      asset: mediaAssetDto(row, this.config.r2PublicBaseUrl),
      upload: {
        method: "PUT" as const,
        url: upload!.url,
        headers: { "Content-Type": contentType },
        expiresAt: upload!.expiresAt.toISOString(),
      },
    };
  }

  async confirm(identity: AuthIdentity, assetId: string, requestId: string) {
    const cityId = await this.authorize(identity, "media.create");
    const existing = await this.loadCityScoped(assetId, cityId);

    if (existing.status === "READY") {
      return mediaAssetDto(existing, this.config.r2PublicBaseUrl);
    }
    if (
      existing.status === "DELETE_PENDING" ||
      existing.status === "DELETED"
    ) {
      throw new AppError(
        409,
        "MEDIA_NOT_CONFIRMABLE",
        "Media asset cannot be confirmed",
      );
    }
    if (existing.status !== "PENDING_UPLOAD") {
      throw new AppError(
        409,
        "MEDIA_NOT_CONFIRMABLE",
        "Media asset cannot be confirmed",
      );
    }
    if (new Date(existing.upload_expires_at).getTime() <= Date.now()) {
      throw new AppError(410, "MEDIA_UPLOAD_EXPIRED", "Media upload intent expired");
    }

    let head;
    try {
      head = await this.storage.headObject(existing.object_key);
    } catch (error) {
      mapStorageError(error, this.logger, {
        asset_id: assetId,
        city_id: cityId,
        request_id: requestId,
      });
    }
    if (!head) {
      throw new AppError(409, "MEDIA_UPLOAD_MISSING", "Uploaded media object is missing");
    }
    if (
      head.contentLength == null ||
      head.contentLength !== asNumber(existing.expected_size_bytes) ||
      head.contentLength > this.config.mediaMaxImageBytes
    ) {
      throw new AppError(
        409,
        "MEDIA_UPLOAD_MISMATCH",
        "Uploaded media does not match the upload intent",
      );
    }
    if (head.contentType !== existing.expected_content_type) {
      throw new AppError(
        409,
        "MEDIA_UPLOAD_MISMATCH",
        "Uploaded media does not match the upload intent",
      );
    }

    let prefix: Uint8Array;
    try {
      prefix = await this.storage.readPrefix(
        existing.object_key,
        SIGNATURE_PREFIX_BYTES,
      );
    } catch (error) {
      if (error instanceof MediaStorageError && error.message === "NotFound") {
        throw new AppError(
          409,
          "MEDIA_UPLOAD_MISSING",
          "Uploaded media object is missing",
        );
      }
      mapStorageError(error, this.logger, {
        asset_id: assetId,
        city_id: cityId,
        request_id: requestId,
      });
    }
    assertImageSignatureMatches(prefix!, existing.expected_content_type);

    await assertActiveCity(this.client, cityId);

    const updated = await this.client.begin(async (tx) => {
      const [locked] = await tx<MediaRow[]>`
        select
          id::text as id,
          city_id::text as city_id,
          purpose::text as purpose,
          visibility::text as visibility,
          status::text as status,
          object_key,
          original_name,
          expected_content_type,
          expected_size_bytes,
          verified_content_type,
          verified_size_bytes,
          etag,
          created_by_account_id::text as created_by_account_id,
          upload_expires_at,
          ready_at,
          attached_at,
          delete_requested_at,
          deleted_at,
          created_at,
          updated_at
        from media_assets
        where id = ${assetId} and city_id = ${cityId}
        for update`;
      if (!locked) throw new AppError(404, "MEDIA_NOT_FOUND", "Media asset not found");
      if (locked.status === "READY") return locked;
      if (
        locked.status === "DELETE_PENDING" ||
        locked.status === "DELETED" ||
        locked.status !== "PENDING_UPLOAD"
      ) {
        throw new AppError(
          409,
          "MEDIA_NOT_CONFIRMABLE",
          "Media asset cannot be confirmed",
        );
      }
      if (new Date(locked.upload_expires_at).getTime() <= Date.now()) {
        throw new AppError(
          410,
          "MEDIA_UPLOAD_EXPIRED",
          "Media upload intent expired",
        );
      }
      const [row] = await tx<MediaRow[]>`
        update media_assets set
          status = 'READY',
          verified_content_type = ${locked.expected_content_type},
          verified_size_bytes = ${asNumber(locked.expected_size_bytes)},
          etag = ${head!.etag},
          ready_at = now(),
          updated_at = now()
        where id = ${assetId}
        returning
          id::text as id,
          city_id::text as city_id,
          purpose::text as purpose,
          visibility::text as visibility,
          status::text as status,
          object_key,
          original_name,
          expected_content_type,
          expected_size_bytes,
          verified_content_type,
          verified_size_bytes,
          etag,
          created_by_account_id::text as created_by_account_id,
          upload_expires_at,
          ready_at,
          attached_at,
          delete_requested_at,
          deleted_at,
          created_at,
          updated_at`;
      return row!;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MEDIA_UPLOAD_CONFIRMED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ asset_id: assetId, city_id: cityId })}::jsonb
      )`;

    return mediaAssetDto(updated, this.config.r2PublicBaseUrl);
  }

  async get(identity: AuthIdentity, assetId: string) {
    const cityId = await this.authorize(identity, "media.read");
    const row = await this.loadCityScoped(assetId, cityId);
    return mediaAssetDto(row, this.config.r2PublicBaseUrl);
  }

  async delete(identity: AuthIdentity, assetId: string, requestId: string) {
    const cityId = await this.authorize(identity, "media.delete");
    const result = await this.client.begin(async (tx) => {
      const [locked] = await tx<MediaRow[]>`
        select
          id::text as id,
          city_id::text as city_id,
          purpose::text as purpose,
          visibility::text as visibility,
          status::text as status,
          object_key,
          original_name,
          expected_content_type,
          expected_size_bytes,
          verified_content_type,
          verified_size_bytes,
          etag,
          created_by_account_id::text as created_by_account_id,
          upload_expires_at,
          ready_at,
          attached_at,
          delete_requested_at,
          deleted_at,
          created_at,
          updated_at
        from media_assets
        where id = ${assetId} and city_id = ${cityId}
        for update`;
      if (!locked) throw new AppError(404, "MEDIA_NOT_FOUND", "Media asset not found");
      if (locked.attached_at != null) {
        throw new AppError(409, "MEDIA_IN_USE", "Media asset is attached and cannot be deleted");
      }
      if (locked.status === "DELETE_PENDING" || locked.status === "DELETED") {
        return locked;
      }
      const [row] = await tx<MediaRow[]>`
        update media_assets set
          status = 'DELETE_PENDING',
          delete_requested_at = coalesce(delete_requested_at, now()),
          updated_at = now()
        where id = ${assetId}
        returning
          id::text as id,
          city_id::text as city_id,
          purpose::text as purpose,
          visibility::text as visibility,
          status::text as status,
          object_key,
          original_name,
          expected_content_type,
          expected_size_bytes,
          verified_content_type,
          verified_size_bytes,
          etag,
          created_by_account_id::text as created_by_account_id,
          upload_expires_at,
          ready_at,
          attached_at,
          delete_requested_at,
          deleted_at,
          created_at,
          updated_at`;
      return row!;
    });

    await this.client`
      insert into audit_logs (
        event_type, actor_account_id, outcome, request_correlation_id, redacted_metadata
      ) values (
        'MEDIA_DELETE_REQUESTED',
        ${identity.accountId},
        'SUCCESS',
        ${requestId},
        ${JSON.stringify({ asset_id: assetId, city_id: cityId })}::jsonb
      )`;

    return mediaAssetDto(result, this.config.r2PublicBaseUrl);
  }

  /**
   * Claim a READY unattached asset inside the caller's transaction.
   * Concurrent claims: only one winner (FOR UPDATE + attached_at null check).
   */
  async claimAsset(
    tx: SQL,
    input: {
      assetId: string;
      cityId: string;
      purpose: "CATEGORY_IMAGE" | "STORE_LOGO" | "STORE_IMAGE";
      visibility?: "PUBLIC" | "PRIVATE";
    },
  ): Promise<void> {
    const [locked] = await tx<{
      status: string;
      purpose: string;
      visibility: string;
      attached_at: Date | string | null;
      city_id: string;
    }[]>`
      select
        status::text as status,
        purpose::text as purpose,
        visibility::text as visibility,
        attached_at,
        city_id::text as city_id
      from media_assets
      where id = ${input.assetId}
      for update`;
    if (
      !locked ||
      locked.city_id !== input.cityId ||
      locked.purpose !== input.purpose ||
      locked.status !== "READY" ||
      locked.attached_at != null ||
      (input.visibility !== undefined && locked.visibility !== input.visibility)
    ) {
      throw new AppError(
        409,
        "MEDIA_NOT_ATTACHABLE",
        "Media asset cannot be attached",
      );
    }
    await tx`
      update media_assets set attached_at = now(), updated_at = now()
      where id = ${input.assetId} and attached_at is null and status = 'READY'`;
  }

  /** Release attachment and queue R2 deletion inside the caller's transaction. */
  async releaseAsset(
    tx: SQL,
    input: { assetId: string; cityId: string },
  ): Promise<void> {
    const [locked] = await tx<{
      city_id: string;
      attached_at: Date | string | null;
      status: string;
    }[]>`
      select city_id::text as city_id, attached_at, status::text as status
      from media_assets
      where id = ${input.assetId}
      for update`;
    if (!locked || locked.city_id !== input.cityId) {
      throw new AppError(404, "MEDIA_NOT_FOUND", "Media asset not found");
    }
    await tx`
      update media_assets set
        attached_at = null,
        status = 'DELETE_PENDING',
        delete_requested_at = coalesce(delete_requested_at, now()),
        updated_at = now()
      where id = ${input.assetId}`;
  }
}
