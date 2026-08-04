import type { SQL } from "bun";
import type { MediaConfig } from "../../config/env";
import type { Logger } from "../../observability/logger";
import {
  MediaStorageError,
  type MediaStorage,
} from "./media-storage";

const CLEANUP_BATCH = 100;

type CleanupCandidate = {
  id: string;
  object_key: string;
  status: string;
  upload_expires_at: Date | string;
  ready_at: Date | string | null;
};

/**
 * Multi-replica-safe media cleanup using FOR UPDATE SKIP LOCKED and deletion leases.
 * Does not require Redis. Overlapping runs in the same process are skipped.
 */
export class MediaCleanupWorker {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private client: SQL,
    private storage: MediaStorage,
    private config: MediaConfig,
    private logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.warn({
          event: "media_cleanup_run_failed",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
    }, this.config.mediaCleanupIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.running && Date.now() < deadline) {
      await Bun.sleep(25);
    }
  }

  async runOnce(): Promise<{
    queued: number;
    claimed: number;
    deleted: number;
    failed: number;
  }> {
    if (this.running || this.stopped) {
      return { queued: 0, claimed: 0, deleted: 0, failed: 0 };
    }
    this.running = true;
    let queued = 0;
    let claimed = 0;
    let deleted = 0;
    let failed = 0;
    try {
      queued += await this.queueExpiredUploads();
      queued += await this.queueAbandonedReady();
      const claim = await this.claimDeletePending();
      claimed = claim.length;
      for (const row of claim) {
        if (this.stopped) break;
        const ok = await this.deleteClaimed(row);
        if (ok) deleted += 1;
        else failed += 1;
      }
      this.logger.info({
        event: "media_cleanup_summary",
        queued,
        claimed,
        deleted,
        failed,
      });
      return { queued, claimed, deleted, failed };
    } finally {
      this.running = false;
    }
  }

  private async queueExpiredUploads(): Promise<number> {
    const rows = await this.client<{ id: string }[]>`
      with due as (
        select id from media_assets
        where status = 'PENDING_UPLOAD'
          and upload_expires_at <= now()
        order by upload_expires_at asc
        limit ${CLEANUP_BATCH}
        for update skip locked
      )
      update media_assets m set
        status = 'DELETE_PENDING',
        delete_requested_at = coalesce(m.delete_requested_at, now()),
        updated_at = now()
      from due
      where m.id = due.id
      returning m.id::text as id`;
    return rows.length;
  }

  private async queueAbandonedReady(): Promise<number> {
    const rows = await this.client<{ id: string }[]>`
      with due as (
        select id from media_assets
        where status = 'READY'
          and attached_at is null
          and ready_at <= now() - make_interval(hours => ${this.config.mediaUnattachedTtlHours})
        order by ready_at asc
        limit ${CLEANUP_BATCH}
        for update skip locked
      )
      update media_assets m set
        status = 'DELETE_PENDING',
        delete_requested_at = coalesce(m.delete_requested_at, now()),
        updated_at = now()
      from due
      where m.id = due.id
      returning m.id::text as id`;
    return rows.length;
  }

  private async claimDeletePending(): Promise<CleanupCandidate[]> {
    return this.client.begin(async (tx) => {
      const rows = await tx<CleanupCandidate[]>`
        select
          id::text as id,
          object_key,
          status::text as status,
          upload_expires_at,
          ready_at
        from media_assets
        where status = 'DELETE_PENDING'
          and (delete_lease_until is null or delete_lease_until <= now())
          and (
            ready_at is not null
            or upload_expires_at <= now()
          )
        order by delete_requested_at asc nulls first, id asc
        limit ${CLEANUP_BATCH}
        for update skip locked`;
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id);
      await tx`
        update media_assets set
          delete_lease_until = now() + make_interval(secs => ${this.config.mediaDeleteLeaseSeconds}),
          updated_at = now()
        where id in ${tx(ids)}`;
      return rows;
    });
  }

  private async deleteClaimed(row: CleanupCandidate): Promise<boolean> {
    try {
      await this.storage.deleteObject(row.object_key);
      await this.client`
        update media_assets set
          status = 'DELETED',
          deleted_at = now(),
          delete_attempts = delete_attempts + 1,
          delete_lease_until = null,
          updated_at = now()
        where id = ${row.id} and status = 'DELETE_PENDING'`;
      return true;
    } catch (error) {
      if (error instanceof MediaStorageError && error.message === "NotFound") {
        await this.client`
          update media_assets set
            status = 'DELETED',
            deleted_at = now(),
            delete_attempts = delete_attempts + 1,
            delete_lease_until = null,
            updated_at = now()
          where id = ${row.id} and status = 'DELETE_PENDING'`;
        return true;
      }
      this.logger.warn({
        event: "media_cleanup_delete_failed",
        asset_id: row.id,
        operation:
          error instanceof MediaStorageError ? error.operation : "deleteObject",
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      await this.client`
        update media_assets set
          delete_attempts = delete_attempts + 1,
          last_delete_error_at = now(),
          delete_lease_until = null,
          updated_at = now()
        where id = ${row.id} and status = 'DELETE_PENDING'`;
      return false;
    }
  }
}
