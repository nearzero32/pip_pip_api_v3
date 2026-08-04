import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MediaConfig } from "../../config/env";
import {
  MediaStorageError,
  type MediaObjectHead,
  type MediaStorage,
  type MediaUploadUrl,
} from "./media-storage";

const toUint8Array = async (
  body: AsyncIterable<Uint8Array> | ReadableStream | Uint8Array | undefined,
): Promise<Uint8Array> => {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export class R2MediaStorage implements MediaStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: MediaConfig) {
    this.bucket = config.r2Bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: config.r2Endpoint,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
      forcePathStyle: false,
    });
  }

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<MediaUploadUrl> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      });
      const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
      const url = await getSignedUrl(this.client, command, {
        expiresIn: input.expiresInSeconds,
      });
      return {
        url,
        headers: { "Content-Type": input.contentType },
        expiresAt,
      };
    } catch (error) {
      throw new MediaStorageError(
        error instanceof Error ? error.name : "UploadUrlError",
        "createUploadUrl",
      );
    }
  }

  async headObject(objectKey: string): Promise<MediaObjectHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return {
        contentType: result.ContentType ?? null,
        contentLength:
          typeof result.ContentLength === "number" ? result.ContentLength : null,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
        return null;
      }
      throw new MediaStorageError(
        error instanceof Error ? error.name : "HeadObjectError",
        "headObject",
      );
    }
  }

  async readPrefix(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
        }),
      );
      return toUint8Array(result.Body as AsyncIterable<Uint8Array> | undefined);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
        throw new MediaStorageError("NotFound", "readPrefix");
      }
      throw new MediaStorageError(
        error instanceof Error ? error.name : "ReadPrefixError",
        "readPrefix",
      );
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) return;
      throw new MediaStorageError(
        error instanceof Error ? error.name : "DeleteObjectError",
        "deleteObject",
      );
    }
  }
}
