import {
  MediaStorageError,
  type MediaObjectHead,
  type MediaStorage,
  type MediaUploadUrl,
} from "./media-storage";

type StoredObject = {
  contentType: string;
  body: Uint8Array;
  etag: string;
};

/** In-memory MediaStorage for unit/integration tests. Never talks to R2. */
export class FakeMediaStorage implements MediaStorage {
  readonly objects = new Map<string, StoredObject>();
  failNextDelete = false;
  failNextHead = false;
  createUploadUrlCalls = 0;

  async createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<MediaUploadUrl> {
    this.createUploadUrlCalls += 1;
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return {
      url: `https://fake-r2.test/upload/${encodeURIComponent(input.objectKey)}?contentType=${encodeURIComponent(input.contentType)}`,
      headers: { "Content-Type": input.contentType },
      expiresAt,
    };
  }

  async createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<{ url: string; expiresAt: Date }> {
    return { url: `https://fake-r2.test/download/${encodeURIComponent(input.objectKey)}`, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  /** Simulate a successful browser PUT to the presigned target. */
  putObject(objectKey: string, contentType: string, body: Uint8Array): void {
    this.objects.set(objectKey, {
      contentType,
      body,
      etag: `"fake-${body.length}-${contentType}"`,
    });
  }

  async headObject(objectKey: string): Promise<MediaObjectHead | null> {
    if (this.failNextHead) {
      this.failNextHead = false;
      throw new MediaStorageError("HeadFailed", "headObject");
    }
    const object = this.objects.get(objectKey);
    if (!object) return null;
    return {
      contentType: object.contentType,
      contentLength: object.body.length,
      etag: object.etag,
    };
  }

  async readPrefix(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    const object = this.objects.get(objectKey);
    if (!object) throw new MediaStorageError("NotFound", "readPrefix");
    return object.body.slice(0, maxBytes);
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new MediaStorageError("DeleteFailed", "deleteObject");
    }
    this.objects.delete(objectKey);
  }
}
