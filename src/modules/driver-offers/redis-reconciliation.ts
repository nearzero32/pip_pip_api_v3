import type { SQL } from "bun";
import type { Logger } from "../../observability/logger";
import {
  hydrateDriverRuntimeFromPostgres,
  type DriverRuntimeState,
  type DriverRuntimeStoreLike,
  type RuntimeCasResult,
} from "./driver-runtime";

export type RedisReconJobType = "DRIVER_RUNTIME" | "CITY_OPEN_OFFERS";
export type RedisReconJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "DEAD";

export type RedisReconConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseSeconds: number;
  retentionDays: number;
};

export const DEFAULT_REDIS_RECON: RedisReconConfig = {
  enabled: true,
  pollIntervalMs: 2_000,
  batchSize: 25,
  maxAttempts: 12,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  /** Must exceed max documented single-job Redis rebuild time. */
  leaseSeconds: 90,
  retentionDays: 7,
};

export type ClaimedReconJob = {
  id: string;
  jobType: RedisReconJobType;
  resourceId: string;
  cityId: string | null;
  expectedRevision: number | null;
  /** Snapshot of expected_revision at claim time (city coalescing). */
  claimedRevision: number | null;
  attemptCount: number;
  lockedBy: string;
};

const sanitizeError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}:${message}`.slice(0, 240);
};

const backoffMs = (attempt: number, config: RedisReconConfig) => {
  const exp = Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.min(config.retryMaxMs, exp);
};

/** Bump per-driver revision inside the business transaction. */
export async function bumpDriverRuntimeRevision(
  tx: SQL,
  driverId: string,
): Promise<number> {
  const [row] = await tx<{ revision: number }[]>`
    insert into driver_runtime_revisions (driver_id, revision, updated_at)
    values (${driverId}, 1, now())
    on conflict (driver_id) do update set
      revision = driver_runtime_revisions.revision + 1,
      updated_at = now()
    returning revision`;
  return Number(row!.revision);
}

/** Bump per-city open-offers revision inside the business transaction. */
export async function bumpCityOpenOfferRevision(
  tx: SQL,
  cityId: string,
): Promise<number> {
  const [row] = await tx<{ revision: number }[]>`
    insert into city_open_offer_revisions (city_id, revision, updated_at)
    values (${cityId}, 1, now())
    on conflict (city_id) do update set
      revision = city_open_offer_revisions.revision + 1,
      updated_at = now()
    returning revision`;
  return Number(row!.revision);
}

export async function enqueueDriverRuntimeRecon(
  tx: SQL,
  input: { driverId: string; expectedRevision: number; cityId?: string | null },
): Promise<string> {
  const inserted = await tx<{ id: string }[]>`
    insert into redis_reconciliation_jobs (
      job_type, resource_id, city_id, expected_revision, status, next_attempt_at
    ) values (
      'DRIVER_RUNTIME', ${input.driverId}, ${input.cityId ?? null},
      ${input.expectedRevision}, 'PENDING', now()
    )
    on conflict (job_type, resource_id, expected_revision)
      where (job_type = 'DRIVER_RUNTIME')
    do nothing
    returning id::text`;
  if (inserted[0]) return inserted[0].id;
  const [existing] = await tx<{ id: string }[]>`
    select id::text from redis_reconciliation_jobs
    where job_type = 'DRIVER_RUNTIME'
      and resource_id = ${input.driverId}
      and expected_revision = ${input.expectedRevision}`;
  if (!existing)
    throw new Error("Failed to enqueue DRIVER_RUNTIME reconciliation job");
  await tx`
    update redis_reconciliation_jobs
    set status = case when status in ('COMPLETED', 'DEAD') then 'PENDING' else status end,
        completed_at = case when status in ('COMPLETED', 'DEAD') then null else completed_at end,
        next_attempt_at = least(next_attempt_at, now()),
        updated_at = now(),
        last_error = case when status in ('COMPLETED', 'DEAD') then null else last_error end
    where id = ${existing.id}`;
  return existing.id;
}

/**
 * Coalesce CITY_OPEN_OFFERS work onto one active job while raising expected_revision.
 * A PROCESSING job that finishes after a mid-flight bump must requeue (lost-wakeup safe).
 */
export async function enqueueCityOpenOffersRecon(
  tx: SQL,
  cityId: string,
): Promise<{ jobId: string; revision: number }> {
  const revision = await bumpCityOpenOfferRevision(tx, cityId);
  const [existing] = await tx<{ id: string; expected_revision: number }[]>`
    select id::text, expected_revision
    from redis_reconciliation_jobs
    where job_type = 'CITY_OPEN_OFFERS'
      and resource_id = ${cityId}
      and status in ('PENDING', 'PROCESSING')
    for update`;
  if (existing) {
    await tx`
      update redis_reconciliation_jobs
      set expected_revision = greatest(expected_revision, ${revision}),
          next_attempt_at = least(next_attempt_at, now()),
          updated_at = now()
      where id = ${existing.id}`;
    return { jobId: existing.id, revision };
  }
  const [row] = await tx<{ id: string }[]>`
    insert into redis_reconciliation_jobs (
      job_type, resource_id, city_id, expected_revision, status, next_attempt_at
    ) values (
      'CITY_OPEN_OFFERS', ${cityId}, ${cityId}, ${revision}, 'PENDING', now()
    )
    returning id::text`;
  return { jobId: row!.id, revision };
}

export async function markReconJobCompleted(
  client: SQL,
  jobId: string,
  ownership?: { lockedBy: string },
): Promise<boolean> {
  const rows = ownership
    ? await client<{ id: string }[]>`
        update redis_reconciliation_jobs
        set status = 'COMPLETED',
            completed_at = now(),
            updated_at = now(),
            locked_at = null,
            locked_by = null,
            last_error = null
        where id = ${jobId}
          and status = 'PROCESSING'
          and locked_by = ${ownership.lockedBy}
        returning id::text`
    : await client<{ id: string }[]>`
        update redis_reconciliation_jobs
        set status = 'COMPLETED',
            completed_at = now(),
            updated_at = now(),
            locked_at = null,
            locked_by = null,
            last_error = null
        where id = ${jobId}
          and status in ('PENDING', 'PROCESSING')
        returning id::text`;
  return rows.length > 0;
}

export async function markReconJobsCompleted(
  client: SQL,
  jobIds: string[],
): Promise<void> {
  if (jobIds.length === 0) return;
  // Immediate post-commit may only complete unclaimed jobs.
  // Never steal COMPLETED from a worker that holds locked_by.
  await client`
    update redis_reconciliation_jobs
    set status = 'COMPLETED',
        completed_at = now(),
        updated_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = null
    where id in ${client(jobIds)}
      and status = 'PENDING'`;
}

/**
 * Derive Redis runtime from PostgreSQL + optional existing Redis state.
 * Never invent AVAILABLE when Redis key is missing.
 */
export function deriveRuntimeForRecon(input: {
  hydrated: DriverRuntimeState;
  expectedRevision: number;
  existing: DriverRuntimeState | null;
  jobCreatedAtMs: number;
}): DriverRuntimeState {
  const { hydrated, expectedRevision, existing, jobCreatedAtMs } = input;
  if (hydrated.activeOrderCount > 0) {
    return {
      ...hydrated,
      workStatus: "BUSY",
      revision: expectedRevision,
      updatedAt: new Date().toISOString(),
    };
  }
  if (
    existing &&
    existing.workStatus === "AVAILABLE" &&
    existing.revision != null &&
    existing.revision > expectedRevision
  ) {
    return existing;
  }
  if (
    existing &&
    existing.workStatus === "AVAILABLE" &&
    new Date(existing.updatedAt).getTime() > jobCreatedAtMs &&
    (existing.revision ?? 0) >= expectedRevision
  ) {
    return {
      ...existing,
      activeOrderCount: 0,
      revision: Math.max(existing.revision ?? 0, expectedRevision),
    };
  }
  return {
    ...hydrated,
    workStatus: "OFFLINE",
    revision: expectedRevision,
    updatedAt: new Date().toISOString(),
  };
}

export class RedisReconciliationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private readonly workerId = crypto.randomUUID();

  constructor(
    private client: SQL,
    private runtime: DriverRuntimeStoreLike,
    private config: RedisReconConfig,
    private logger: Logger,
    private reconcileCityOffers: (
      cityId: string,
      revision: number,
    ) => Promise<unknown>,
  ) {}

  /** Stable ownership token for lease / completion tests. */
  get ownershipToken(): string {
    return this.workerId;
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.warn({
          event: "redis_recon_run_failed",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info({
      event: "redis_recon_worker_started",
      poll_interval_ms: this.config.pollIntervalMs,
      batch_size: this.config.batchSize,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + 5_000;
    while (this.running && Date.now() < deadline) await Bun.sleep(25);
    this.logger.info({ event: "redis_recon_worker_stopped" });
  }

  async runOnce(): Promise<{ claimed: number; completed: number; failed: number }> {
    if (!this.config.enabled || this.running || this.stopped) {
      return { claimed: 0, completed: 0, failed: 0 };
    }
    this.running = true;
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    try {
      await this.cleanupRetention();
      const jobs = await this.claimDueJobs();
      claimed = jobs.length;
      for (const job of jobs) {
        if (this.stopped) break;
        try {
          const outcome = await this.processJob(job);
          if (outcome === "done") completed += 1;
        } catch (error) {
          failed += 1;
          await this.failJob(job, error);
        }
      }
      if (claimed > 0) {
        this.logger.info({
          event: "redis_recon_summary",
          claimed,
          completed,
          failed,
        });
      }
      return { claimed, completed, failed };
    } finally {
      this.running = false;
    }
  }

  private async claimDueJobs(): Promise<ClaimedReconJob[]> {
    return this.client.begin(async (tx) => {
      const rows = await tx<
        {
          id: string;
          job_type: string;
          resource_id: string;
          city_id: string | null;
          expected_revision: number | null;
          attempt_count: number;
        }[]
      >`
        select id::text, job_type::text, resource_id::text, city_id::text,
               expected_revision, attempt_count
        from redis_reconciliation_jobs
        where status in ('PENDING', 'PROCESSING')
          and next_attempt_at <= now()
          and (
            status = 'PENDING'
            or locked_at is null
            or locked_at <= now() - make_interval(secs => ${this.config.leaseSeconds})
          )
          and status <> 'DEAD'
        order by next_attempt_at asc, created_at asc
        limit ${this.config.batchSize}
        for update skip locked`;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx`
        update redis_reconciliation_jobs
        set status = 'PROCESSING',
            locked_at = now(),
            locked_by = ${this.workerId},
            attempt_count = attempt_count + 1,
            updated_at = now()
        where id in ${tx(ids)}`;
      return rows.map((r) => ({
        id: r.id,
        jobType: r.job_type as RedisReconJobType,
        resourceId: r.resource_id,
        cityId: r.city_id,
        expectedRevision: r.expected_revision,
        claimedRevision: r.expected_revision,
        attemptCount: Number(r.attempt_count) + 1,
        lockedBy: this.workerId,
      }));
    });
  }

  /** Heartbeat: extend lease while still owning the row. */
  private async renewLease(job: ClaimedReconJob): Promise<boolean> {
    const rows = await this.client<{ id: string }[]>`
      update redis_reconciliation_jobs
      set locked_at = now(), updated_at = now()
      where id = ${job.id}
        and status = 'PROCESSING'
        and locked_by = ${job.lockedBy}
      returning id::text`;
    return rows.length > 0;
  }

  /**
   * Atomic COMPLETED vs REQUEUE under row lock.
   * Decision uses locked_by + PROCESSING + expected/city revision vs claimed_revision
   * inside one UPDATE (no unlocked SELECT→decide→UPDATE race).
   */
  private async completeOrRequeueCity(
    job: ClaimedReconJob,
  ): Promise<"COMPLETED" | "REQUEUED" | "LOST_OWNERSHIP"> {
    const claimed = Number(job.claimedRevision ?? 0);
    const cityId = job.cityId ?? job.resourceId;
    return this.client.begin(async (tx) => {
      const rows = await tx<{ status: string }[]>`
        with city as (
          select coalesce(
            (select revision from city_open_offer_revisions where city_id = ${cityId}),
            0
          ) as revision
        ),
        updated as (
          update redis_reconciliation_jobs j
          set
            status = case
              when greatest(j.expected_revision, city.revision) > ${claimed}
                then 'PENDING'::redis_reconciliation_job_status
              else 'COMPLETED'::redis_reconciliation_job_status
            end,
            expected_revision = greatest(j.expected_revision, city.revision),
            completed_at = case
              when greatest(j.expected_revision, city.revision) > ${claimed}
                then null
              else now()
            end,
            locked_at = null,
            locked_by = null,
            next_attempt_at = case
              when greatest(j.expected_revision, city.revision) > ${claimed}
                then now()
              else j.next_attempt_at
            end,
            updated_at = now(),
            last_error = null
          from city
          where j.id = ${job.id}
            and j.status = 'PROCESSING'
            and j.locked_by = ${job.lockedBy}
          returning j.status::text
        )
        select status from updated`;
      if (rows.length === 0) return "LOST_OWNERSHIP";
      return rows[0]!.status === "PENDING" ? "REQUEUED" : "COMPLETED";
    });
  }

  private async processJob(
    job: ClaimedReconJob,
  ): Promise<"done" | "skipped"> {
    if (!(await this.renewLease(job))) {
      return "skipped";
    }

    if (job.jobType === "CITY_OPEN_OFFERS") {
      const cityId = job.cityId ?? job.resourceId;
      const revision = Number(job.claimedRevision);
      if (!Number.isFinite(revision) || revision <= 0)
        throw new Error("CITY_OPEN_OFFERS job missing claimedRevision");
      await this.reconcileCityOffers(cityId, revision);
      if (!(await this.renewLease(job))) return "skipped";
      const outcome = await this.completeOrRequeueCity(job);
      if (outcome === "LOST_OWNERSHIP") return "skipped";
      return "done";
    }

    const expectedRevision = job.expectedRevision;
    if (expectedRevision == null)
      throw new Error("DRIVER_RUNTIME job missing expectedRevision");

    const [pgRev] = await this.client<{ revision: number }[]>`
      select revision from driver_runtime_revisions
      where driver_id = ${job.resourceId}`;
    const currentPgRevision = Number(pgRev?.revision ?? 0);
    if (expectedRevision < currentPgRevision) {
      const ok = await markReconJobCompleted(this.client, job.id, {
        lockedBy: job.lockedBy,
      });
      return ok ? "done" : "skipped";
    }

    const [jobRow] = await this.client<{ created_at: Date }[]>`
      select created_at from redis_reconciliation_jobs where id = ${job.id}`;
    const jobCreatedAtMs = new Date(jobRow!.created_at).getTime();

    const hydrated = await hydrateDriverRuntimeFromPostgres(
      this.client,
      job.resourceId,
    );
    if (!hydrated) {
      await this.runtime.invalidateRuntime(job.resourceId);
      const ok = await markReconJobCompleted(this.client, job.id, {
        lockedBy: job.lockedBy,
      });
      return ok ? "done" : "skipped";
    }

    if (!(await this.renewLease(job))) return "skipped";

    const existing = await this.runtime.getRuntime(job.resourceId);
    const next = deriveRuntimeForRecon({
      hydrated,
      expectedRevision,
      existing,
      jobCreatedAtMs,
    });

    // Atomic Redis CAS — never GET→compare→SET in TypeScript for the write path.
    const cas: RuntimeCasResult = await this.runtime.setRuntimeWithCas(next);
    if (
      cas !== "APPLIED" &&
      cas !== "ALREADY_CURRENT" &&
      cas !== "STALE_REJECTED"
    ) {
      throw new Error(`Unexpected CAS result: ${String(cas)}`);
    }

    const ok = await markReconJobCompleted(this.client, job.id, {
      lockedBy: job.lockedBy,
    });
    return ok ? "done" : "skipped";
  }

  private async failJob(job: ClaimedReconJob, error: unknown): Promise<void> {
    const err = sanitizeError(error);
    if (job.attemptCount >= this.config.maxAttempts) {
      const dead = await this.client<{ id: string }[]>`
        update redis_reconciliation_jobs
        set status = 'DEAD',
            completed_at = now(),
            updated_at = now(),
            locked_at = null,
            locked_by = null,
            last_error = ${err},
            next_attempt_at = now()
        where id = ${job.id}
          and status = 'PROCESSING'
          and locked_by = ${job.lockedBy}
        returning id::text`;
      if (dead.length > 0) {
        this.logger.error({
          event: "redis_recon_job_dead",
          job_id: job.id,
          job_type: job.jobType,
          attempts: job.attemptCount,
        });
      }
      return;
    }
    const delay = backoffMs(job.attemptCount, this.config);
    await this.client`
      update redis_reconciliation_jobs
      set status = 'PENDING',
          updated_at = now(),
          locked_at = null,
          locked_by = null,
          last_error = ${err},
          next_attempt_at = now() + make_interval(secs => ${Math.ceil(delay / 1000)})
      where id = ${job.id}
        and status = 'PROCESSING'
        and locked_by = ${job.lockedBy}`;
  }

  private async cleanupRetention(): Promise<void> {
    await this.client`
      delete from redis_reconciliation_jobs
      where status in ('COMPLETED', 'DEAD')
        and completed_at is not null
        and completed_at < now() - make_interval(days => ${this.config.retentionDays})`;
  }
}

/** Enqueue a durable DRIVER_RUNTIME sync (logout / invalidate paths). */
export async function scheduleDriverRuntimeSync(
  client: SQL,
  driverId: string,
  cityId?: string | null,
): Promise<string> {
  return client.begin(async (tx) => {
    const revision = await bumpDriverRuntimeRevision(tx, driverId);
    return enqueueDriverRuntimeRecon(tx, {
      driverId,
      expectedRevision: revision,
      cityId: cityId ?? null,
    });
  });
}

/** Post-commit: apply Redis mutation; on success complete jobs; on failure leave Pending. */
export async function applyRedisAfterCommit(input: {
  client: SQL;
  jobIds: string[];
  apply: () => Promise<void>;
  logger?: Logger;
  event?: string;
}): Promise<boolean> {
  try {
    await input.apply();
    await markReconJobsCompleted(input.client, input.jobIds);
    return true;
  } catch (error) {
    input.logger?.warn({
      event: input.event ?? "redis_post_commit_apply_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
      job_count: input.jobIds.length,
    });
    return false;
  }
}

export function loadRedisReconConfig(
  env: Record<string, string | undefined> = process.env,
): RedisReconConfig {
  const parseBool = (name: string, fallback: boolean) => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "1" || raw === "true" || raw === "yes") return true;
    if (raw === "0" || raw === "false" || raw === "no") return false;
    return fallback;
  };
  const parseIntStrict = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = env[name]?.trim();
    if (!raw || !/^\d+$/.test(raw)) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
    return n;
  };
  return {
    enabled: parseBool("REDIS_RECON_ENABLED", DEFAULT_REDIS_RECON.enabled),
    pollIntervalMs: parseIntStrict(
      "REDIS_RECON_POLL_INTERVAL_MS",
      DEFAULT_REDIS_RECON.pollIntervalMs,
      500,
      300_000,
    ),
    batchSize: parseIntStrict(
      "REDIS_RECON_BATCH_SIZE",
      DEFAULT_REDIS_RECON.batchSize,
      1,
      500,
    ),
    maxAttempts: parseIntStrict(
      "REDIS_RECON_MAX_ATTEMPTS",
      DEFAULT_REDIS_RECON.maxAttempts,
      1,
      100,
    ),
    retryBaseMs: parseIntStrict(
      "REDIS_RECON_RETRY_BASE_MS",
      DEFAULT_REDIS_RECON.retryBaseMs,
      100,
      60_000,
    ),
    retryMaxMs: parseIntStrict(
      "REDIS_RECON_RETRY_MAX_MS",
      DEFAULT_REDIS_RECON.retryMaxMs,
      1_000,
      600_000,
    ),
    leaseSeconds: parseIntStrict(
      "REDIS_RECON_LEASE_SECONDS",
      DEFAULT_REDIS_RECON.leaseSeconds,
      5,
      600,
    ),
    retentionDays: parseIntStrict(
      "REDIS_RECON_RETENTION_DAYS",
      DEFAULT_REDIS_RECON.retentionDays,
      1,
      90,
    ),
  };
}
