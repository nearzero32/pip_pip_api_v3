export type MediaObjectHead = {
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
};

export type MediaUploadUrl = {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
};

export interface MediaStorage {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<MediaUploadUrl>;
  createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<{ url: string; expiresAt: Date }>;
  headObject(objectKey: string): Promise<MediaObjectHead | null>;
  /** Ranged read of the object prefix for signature verification. */
  readPrefix(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  deleteObject(objectKey: string): Promise<void>;
}

export class MediaStorageError extends Error {
  override readonly name = "MediaStorageError";
  constructor(
    message: string,
    readonly operation: string,
  ) {
    super(message);
  }
}
