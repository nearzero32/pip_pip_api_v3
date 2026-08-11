import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  DriverRuntimeStore,
  evaluateRuntimeCasInMemory,
  hydrateDriverRuntimeFromPostgres,
  type DriverRuntimeState,
  type RuntimeCasResult,
} from "../../src/modules/driver-offers/driver-runtime";
import {
  bumpDriverRuntimeRevision,
  deriveRuntimeForRecon,
  enqueueCityOpenOffersRecon,
  enqueueDriverRuntimeRecon,
  applyRedisAfterCommit,
  loadRedisReconConfig,
  markReconJobCompleted,
  RedisReconciliationWorker,
} from "../../src/modules/driver-offers/redis-reconciliation";
import { silentLogger } from "../../src/observability/logger";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  type IntegrationHarness,
} from "./helpers";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";

const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380";

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(pollMs);
  }
  throw new Error("waitUntil timeout");
}

describe("M4-B redis reconciliation + hydration outage", () => {
  let h: IntegrationHarness;
  let city = "";
  let store = "";
  let product = "";
  let customer = "";
  let addressId = "";
  let adminIdentity!: AuthIdentity;
  let realRuntime!: DriverRuntimeStore;

  const deliveryPricingInput = {
    baseFee: 1000,
    includedDistanceMeters: 1000,
    pricePerKm: 500,
    roundingStep: 250,
    maximumDeliveryDistanceMeters: 50000,
    routingFallbackEnabled: true,
    fallbackOnNoRoute: true,
    fallbackOnProviderFailure: true,
    fallbackExtraDistanceMeters: 300,
  };
  const driverPricingInput = {
    pricingBase: 1000,
    roundingUnit: 250,
    pricingStages: [
      { afterSeconds: 0, increasePercentage: 0 },
      { afterSeconds: 30, increasePercentage: 20 },
    ],
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_recon" });
    city = await createActiveCity(h.client, "Recon City");
    const [actor] = await h.client<
      { id: string }[]
    >`insert into accounts default values returning id`;
    const superIdentity: AuthIdentity = {
      accountId: actor!.id,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["SUPER_ADMIN"],
      scopeType: "GLOBAL",
      cityId: null,
      storeId: null,
    };
    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(city_id, purpose, visibility, status, object_key, original_name, expected_content_type, expected_size_bytes, verified_content_type, verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at)
      values (${city}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png', 'image/png', 1, 'image/png', 1, ${actor!.id}, now(), now(), now()) returning id`;
    const [logo] = await h.client<{ id: string }[]>`
      insert into media_assets(city_id, purpose, visibility, status, object_key, original_name, expected_content_type, expected_size_bytes, verified_content_type, verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at)
      values (${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png', 'image/png', 1, 'image/png', 1, ${actor!.id}, now(), now(), now()) returning id`;
    const [cat] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${city}, 'مطاعم', ${media!.id}, 'ACTIVE', ${actor!.id}) returning id`;
    const [s] = await h.client<{ id: string }[]>`
      insert into stores(city_id, main_category_id, name, phone, address, location, logo_asset_id, status, order_acceptance_status, created_by_account_id)
      values (${city}, ${cat!.id}, 'Recon Store', '+9647001111100', 'Address', ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id}, 'ACTIVE', 'ACCEPTING', ${actor!.id}) returning id`;
    store = s!.id;
    const [z] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (${city}, 'Delivery', ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326), 'ACTIVE') returning id`;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store}, ${z!.id}, ${city})`;
    const [p] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج', 2000, true, 'ACTIVE', ${actor!.id}) returning id`;
    product = p!.id;
    await h.deliveryPricing.create(superIdentity, city, deliveryPricingInput);
    const versions = await h.deliveryPricing.list(superIdentity, city);
    await h.deliveryPricing.activate(superIdentity, city, versions[0]!.id);
    h.routingProvider.setResult({ distanceMeters: 1000, durationSeconds: 120 });
    await h.cityDriverPricing.put(
      superIdentity,
      city,
      driverPricingInput,
      "p",
      crypto.randomUUID(),
    );
    const [c] = await h.client<
      { id: string }[]
    >`insert into accounts default values returning id`;
    customer = c!.id;
    await h.client`insert into customer_profiles(account_id) values (${customer})`;
    const addr = await h.addresses.create(customer, city, {
      label: "البيت",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    addressId = addr.id;
    const adminId = await createStaffAccount(h.auth, h.client, {
      email: "recon-admin@example.com",
      password: "fixed dashboard password",
      roles: ["ADMIN"],
      cityId: city,
    });
    adminIdentity = {
      accountId: adminId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["ADMIN"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };
    realRuntime = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      sql: h.client,
      degraded: { ttlMs: 500, maxEntries: 8, advisoryLockTimeoutMs: 500 },
    });
  }, 120_000);

  afterAll(async () => {
    await realRuntime.close();
    await h.close();
  });

  test("cancel closes assignment and enqueues recon; worker can heal runtime", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const order = await h.orders.create(customer, city, {
      storeId: store,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" });
    const round = await h.offers.openRound(
      adminIdentity,
      order.id,
      "r",
      crypto.randomUUID(),
    );
    await h.offers.claim(
      {
        accountId: driverId,
        sessionId: null as unknown as string,
        applicationType: "DRIVER_APP",
        roles: [],
        scopeType: null,
        cityId: city,
        storeId: null,
      },
      round.id,
      crypto.randomUUID(),
      "c",
    );

    await h.orders.cancelByDashboard(adminIdentity, order.id, "اختبار");

    const [assignment] = await h.client<{ cancelled_at: Date | null }[]>`
      select cancelled_at from order_driver_assignments where order_id = ${order.id}`;
    expect(assignment?.cancelled_at).not.toBeNull();

    const jobs = await h.client<
      { id: string; status: string; job_type: string }[]
    >`
      select id::text, status::text, job_type::text from redis_reconciliation_jobs
      where resource_id in (${driverId}, ${city})
      order by created_at desc`;
    expect(jobs.length).toBeGreaterThan(0);

    const auditsAfterCancel = await h.client<{ count: number }[]>`
      select count(*)::int as count from audit_logs
      where target_id = ${order.id}`;

    await h.client`
      update redis_reconciliation_jobs
      set status = 'PENDING', next_attempt_at = now() - interval '1 second',
          completed_at = null, locked_at = null, locked_by = null
      where resource_id = ${driverId}`;
    await realRuntime.invalidateRuntime(driverId);

    const worker = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      {
        ...loadRedisReconConfig(),
        enabled: true,
        pollIntervalMs: 60_000,
        maxAttempts: 5,
      },
      silentLogger,
      (cityId, revision) => h.offers.reconcileCityOffers(cityId, revision),
    );
    const result = await worker.runOnce();
    expect(result.claimed).toBeGreaterThan(0);
    const runtime = await realRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("OFFLINE");
    const [pending] = await h.client<{ count: number }[]>`
      select count(*)::int as count from redis_reconciliation_jobs
      where resource_id = ${driverId} and status = 'PENDING'`;
    expect(pending!.count).toBe(0);

    const auditsAfterWorker = await h.client<{ count: number }[]>`
      select count(*)::int as count from audit_logs
      where target_id = ${order.id}`;
    expect(auditsAfterWorker![0]!.count).toBe(auditsAfterCancel![0]!.count);
  });

  test("two workers claim one job — single logical completion", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const jobId = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      return enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
    });
    const cfg = {
      ...loadRedisReconConfig(),
      enabled: true,
      batchSize: 10,
      maxAttempts: 8,
    };
    const w1 = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      cfg,
      silentLogger,
      async () => ({}),
    );
    const w2 = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      cfg,
      silentLogger,
      async () => ({}),
    );
    const [a, b] = await Promise.all([w1.runOnce(), w2.runOnce()]);
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(1);
    expect(a.claimed + b.claimed).toBeLessThanOrEqual(2);
    await w1.runOnce();
    await w2.runOnce();
    const [done] = await h.client<{ status: string }[]>`
      select status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(done!.status).toBe("COMPLETED");
  });

  test("Redis CAS: N+1 wins when N resumes later (atomic Lua)", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const base: Omit<
      DriverRuntimeState,
      "revision" | "workStatus" | "updatedAt"
    > = {
      driverId,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
    };
    let releaseN!: () => void;
    const holdN = new Promise<void>((r) => {
      releaseN = r;
    });
    let nEntered = false;

    const gated = {
      getRuntime: (id: string) => realRuntime.getRuntime(id),
      invalidateRuntime: (id: string) => realRuntime.invalidateRuntime(id),
      setRuntimeWithCas: async (
        state: DriverRuntimeState,
      ): Promise<RuntimeCasResult> => {
        if (state.revision === 1) {
          nEntered = true;
          await holdN;
        }
        return realRuntime.setRuntimeWithCas(state);
      },
      setRuntime: async (state: DriverRuntimeState) => {
        await gated.setRuntimeWithCas(state);
      },
    };

    const pN = gated.setRuntimeWithCas({
      ...base,
      workStatus: "OFFLINE",
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    await waitUntil(async () => nEntered);
    const rN1 = await realRuntime.setRuntimeWithCas({
      ...base,
      workStatus: "AVAILABLE",
      revision: 2,
      updatedAt: new Date().toISOString(),
    });
    expect(rN1).toBe("APPLIED");
    releaseN();
    const rN = await pN;
    expect(rN).toBe("STALE_REJECTED");
    const runtime = await realRuntime.getRuntime(driverId);
    expect(runtime?.revision).toBe(2);
    expect(runtime?.workStatus).toBe("AVAILABLE");
  });

  test("Redis CAS: missing key + newer PG revision — stale job does not recreate old state", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const oldRev = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      await enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
      return rev;
    });
    await h.client.begin(async (tx: SQL) =>
      bumpDriverRuntimeRevision(tx, driverId),
    );
    await realRuntime.invalidateRuntime(driverId);
    await h.client`
      update redis_reconciliation_jobs
      set status = 'PENDING', next_attempt_at = now() - interval '1 second', completed_at = null,
          locked_at = null, locked_by = null
      where resource_id = ${driverId} and expected_revision = ${oldRev}`;
    const worker = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true },
      silentLogger,
      async () => ({}),
    );
    await worker.runOnce();
    const runtime = await realRuntime.getRuntime(driverId);
    // Job N skipped because PG is N+1; key stays missing (no stale recreate).
    expect(runtime).toBeNull();
    const [row] = await h.client<{ status: string }[]>`
      select status::text from redis_reconciliation_jobs
      where resource_id = ${driverId} and expected_revision = ${oldRev}`;
    expect(row!.status).toBe("COMPLETED");
  });

  test("Redis CAS idempotent same revision + unrevisioned cannot clobber", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const state: DriverRuntimeState = {
      driverId,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "AVAILABLE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
      revision: 5,
      updatedAt: new Date().toISOString(),
    };
    expect(await realRuntime.setRuntimeWithCas(state)).toBe("APPLIED");
    expect(await realRuntime.setRuntimeWithCas(state)).toBe("ALREADY_CURRENT");
    const { revision: _ignored, ...withoutRevision } = state;
    expect(
      await realRuntime.setRuntimeWithCas({
        ...withoutRevision,
        workStatus: "OFFLINE",
        updatedAt: new Date().toISOString(),
      }),
    ).toBe("STALE_REJECTED");
    const runtime = await realRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("AVAILABLE");
    expect(runtime?.revision).toBe(5);
    expect(evaluateRuntimeCasInMemory(runtime, { ...state, revision: 4 })).toBe(
      "STALE_REJECTED",
    );
  });

  test("CITY_OPEN_OFFERS lost wakeup during PROCESSING coalesces to R+1", async () => {
    // Isolate city jobs for this city
    await h.client`
      update redis_reconciliation_jobs
      set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
      where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
        and status in ('PENDING', 'PROCESSING')`;

    const { jobId } = await h.client.begin((tx: SQL) =>
      enqueueCityOpenOffersRecon(tx, city),
    );
    const [before] = await h.client<{ expected_revision: number }[]>`
      select expected_revision from redis_reconciliation_jobs where id = ${jobId}`;
    const r0 = Number(before!.expected_revision);

    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    let rebuiltFor: number[] = [];

    const worker = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true, leaseSeconds: 60 },
      silentLogger,
      async (cityId, revision) => {
        entered = true;
        await barrier;
        rebuiltFor.push(Date.now());
        await h.offers.reconcileCityOffers(cityId, revision);
      },
    );

    const run = worker.runOnce();
    await waitUntil(async () => entered);

    const afterEnqueue = await h.client.begin((tx: SQL) =>
      enqueueCityOpenOffersRecon(tx, city),
    );
    expect(afterEnqueue.jobId).toBe(jobId);
    const [mid] = await h.client<
      { expected_revision: number; status: string }[]
    >`
      select expected_revision, status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(mid!.status).toBe("PROCESSING");
    expect(Number(mid!.expected_revision)).toBeGreaterThan(r0);

    release();
    await run;

    const [after] = await h.client<
      { status: string; expected_revision: number }[]
    >`
      select status::text, expected_revision from redis_reconciliation_jobs where id = ${jobId}`;
    // Must requeue rather than COMPLETE with stale city snapshot.
    expect(after!.status).toBe("PENDING");
    expect(Number(after!.expected_revision)).toBeGreaterThan(r0);

    const worker2 = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true },
      silentLogger,
      (cityId, revision) => h.offers.reconcileCityOffers(cityId, revision),
    );
    await worker2.runOnce();
    const [final] = await h.client<{ status: string }[]>`
      select status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(final!.status).toBe("COMPLETED");
    const [due] = await h.client<{ count: number }[]>`
      select count(*)::int as count from redis_reconciliation_jobs
      where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
        and status in ('PENDING', 'PROCESSING')`;
    expect(due!.count).toBe(0);
    expect(rebuiltFor.length).toBeGreaterThanOrEqual(1);
  });

  test("enqueue during PROCESSING raises target revision (no lost wakeup)", async () => {
    await h.client`
      update redis_reconciliation_jobs
      set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
      where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
        and status in ('PENDING', 'PROCESSING')`;
    const { jobId } = await h.client.begin((tx: SQL) =>
      enqueueCityOpenOffersRecon(tx, city),
    );
    await h.client`
      update redis_reconciliation_jobs
      set status = 'PROCESSING', locked_at = now(), locked_by = 'holder',
          next_attempt_at = now()
      where id = ${jobId}`;
    const [r1] = await h.client<{ expected_revision: number }[]>`
      select expected_revision from redis_reconciliation_jobs where id = ${jobId}`;
    await h.client.begin((tx: SQL) => enqueueCityOpenOffersRecon(tx, city));
    const [r2] = await h.client<
      { expected_revision: number; status: string }[]
    >`
      select expected_revision, status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(r2!.status).toBe("PROCESSING");
    expect(Number(r2!.expected_revision)).toBeGreaterThan(
      Number(r1!.expected_revision),
    );
  });

  test("lease crash recovery: B waits for expiry; late A cannot complete", async () => {
    // Drain unrelated due jobs so claim counts stay isolated to this scenario.
    const drain = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true, batchSize: 100 },
      silentLogger,
      (cityId, revision) => h.offers.reconcileCityOffers(cityId, revision),
    );
    await drain.runOnce();
    await drain.runOnce();

    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const jobId = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      return enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
    });

    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });
    let aEntered = false;
    const gatedRuntime = {
      getRuntime: (id: string) => realRuntime.getRuntime(id),
      invalidateRuntime: (id: string) => realRuntime.invalidateRuntime(id),
      setRuntimeWithCas: async (state: DriverRuntimeState) => {
        aEntered = true;
        await holdA;
        return realRuntime.setRuntimeWithCas(state);
      },
      setRuntime: async (state: DriverRuntimeState) => {
        await gatedRuntime.setRuntimeWithCas(state);
      },
    };

    const leaseSeconds = 1;
    const workerA = new RedisReconciliationWorker(
      h.client,
      gatedRuntime as any,
      {
        ...loadRedisReconConfig(),
        enabled: true,
        leaseSeconds,
        retryBaseMs: 1,
        retryMaxMs: 1,
      },
      silentLogger,
      async () => ({}),
    );
    const runA = workerA.runOnce();
    await waitUntil(async () => aEntered);

    const workerB = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true, leaseSeconds },
      silentLogger,
      async () => ({}),
    );
    const earlyB = await workerB.runOnce();
    expect(earlyB.claimed).toBe(0);

    await waitUntil(
      async () => {
        await workerB.runOnce();
        const [row] = await h.client<
          { status: string; locked_by: string | null }[]
        >`
        select status::text, locked_by from redis_reconciliation_jobs where id = ${jobId}`;
        return row?.status === "COMPLETED";
      },
      8_000,
      50,
    );

    const [afterB] = await h.client<
      { status: string; locked_by: string | null }[]
    >`
      select status::text, locked_by from redis_reconciliation_jobs where id = ${jobId}`;
    expect(afterB!.status).toBe("COMPLETED");
    expect(afterB!.locked_by).toBeNull();

    releaseA();
    await runA;
    const late = await markReconJobCompleted(h.client, jobId, {
      lockedBy: workerA.ownershipToken,
    });
    expect(late).toBe(false);
    const [final] = await h.client<{ status: string }[]>`
      select status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(final!.status).toBe("COMPLETED");
  });

  test("restart lifecycle: instance A stop → instance B heals job", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const jobId = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      return enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
    });

    // Leave job pending: A would fail Redis after "PG success" simulation
    const boom = {
      getRuntime: async () => null,
      setRuntimeWithCas: async () => {
        throw new Error("redis_down");
      },
      setRuntime: async () => {
        throw new Error("redis_down");
      },
      invalidateRuntime: async () => {},
    };

    const auditsBefore = await h.client<{ count: number }[]>`
      select count(*)::int as count from audit_logs`;

    const workerA = new RedisReconciliationWorker(
      h.client,
      boom as any,
      {
        ...loadRedisReconConfig(),
        enabled: true,
        pollIntervalMs: 200,
        maxAttempts: 8,
        retryBaseMs: 50,
        retryMaxMs: 200,
        leaseSeconds: 30,
      },
      silentLogger,
      async () => ({}),
    );
    workerA.start();
    await waitUntil(async () => {
      const [row] = await h.client<{ attempt_count: number; status: string }[]>`
        select attempt_count, status::text from redis_reconciliation_jobs where id = ${jobId}`;
      return Number(row?.attempt_count ?? 0) >= 1 || row?.status === "PENDING";
    }, 5_000);
    await workerA.stop();

    const [stuck] = await h.client<{ status: string }[]>`
      select status::text from redis_reconciliation_jobs where id = ${jobId}`;
    expect(["PENDING", "PROCESSING"]).toContain(stuck!.status);

    const workerB = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      {
        ...loadRedisReconConfig(),
        enabled: true,
        pollIntervalMs: 100,
        leaseSeconds: 5,
        retryBaseMs: 50,
        retryMaxMs: 200,
      },
      silentLogger,
      async () => ({}),
    );
    workerB.start();
    await waitUntil(async () => {
      const [row] = await h.client<{ status: string }[]>`
        select status::text from redis_reconciliation_jobs where id = ${jobId}`;
      return row?.status === "COMPLETED";
    }, 15_000);
    await workerB.stop();

    const runtime = await realRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("OFFLINE");
    expect(runtime?.revision).toBeGreaterThan(0);

    // A stopped: further runOnce should no-op (stopped flag)
    const afterStop = await workerA.runOnce();
    expect(afterStop.claimed).toBe(0);

    const auditsAfter = await h.client<{ count: number }[]>`
      select count(*)::int as count from audit_logs`;
    expect(auditsAfter![0]!.count).toBe(auditsBefore![0]!.count);
  });

  test("stale recon does not overwrite newer AVAILABLE revision", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const oldRev = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      await enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
      return rev;
    });
    const newRev = await h.client.begin(async (tx: SQL) =>
      bumpDriverRuntimeRevision(tx, driverId),
    );
    await realRuntime.setRuntime({
      driverId,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "AVAILABLE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
      revision: newRev,
      updatedAt: new Date().toISOString(),
    });
    await h.client`
      update redis_reconciliation_jobs
      set status = 'PENDING', next_attempt_at = now() - interval '1 second', completed_at = null
      where resource_id = ${driverId} and expected_revision = ${oldRev}`;
    const worker = new RedisReconciliationWorker(
      h.client,
      realRuntime,
      { ...loadRedisReconConfig(), enabled: true },
      silentLogger,
      async () => ({}),
    );
    await worker.runOnce();
    const runtime = await realRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("AVAILABLE");
    expect(runtime?.revision).toBe(newRev);
  });

  test("deriveRuntimeForRecon: missing redis + zero assignments → OFFLINE", () => {
    const derived = deriveRuntimeForRecon({
      hydrated: {
        driverId: "d",
        cityId: "c",
        eligibilityStatus: "ELIGIBLE",
        workStatus: "OFFLINE",
        activeOrderCount: 0,
        eligibilityVersion: 1,
        updatedAt: new Date().toISOString(),
      },
      expectedRevision: 3,
      existing: null,
      jobCreatedAtMs: Date.now() - 10_000,
    });
    expect(derived.workStatus).toBe("OFFLINE");
    expect(derived.revision).toBe(3);
  });

  test("active assignments → BUSY via hydrate derivation", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const order = await h.orders.create(customer, city, {
      storeId: store,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" });
    const round = await h.offers.openRound(
      adminIdentity,
      order.id,
      "r",
      crypto.randomUUID(),
    );
    await h.offers.claim(
      {
        accountId: driverId,
        sessionId: null as unknown as string,
        applicationType: "DRIVER_APP",
        roles: [],
        scopeType: null,
        cityId: city,
        storeId: null,
      },
      round.id,
      crypto.randomUUID(),
      "c",
    );
    await realRuntime.invalidateRuntime(driverId);
    const hydrated = await hydrateDriverRuntimeFromPostgres(h.client, driverId);
    expect(hydrated?.workStatus).toBe("BUSY");
    expect(hydrated?.activeOrderCount).toBeGreaterThan(0);
  });

  test("redis fully down: 12 concurrent hydrates run once via singleflight", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const storeRt = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      sql: h.client,
      degraded: { ttlMs: 2_000, maxEntries: 16, advisoryLockTimeoutMs: 1_000 },
    });
    (storeRt as any).client = {
      get: async () => {
        throw new Error("down");
      },
      send: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
      close: () => {},
    };
    let hydrations = 0;
    const hydrate = async () => {
      hydrations += 1;
      await Bun.sleep(40);
      return (await hydrateDriverRuntimeFromPostgres(h.client, driverId))!;
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        storeRt.getOrHydrateRuntime(driverId, hydrate),
      ),
    );
    expect(hydrations).toBe(1);
    expect(results.every((r) => r.workStatus === "OFFLINE")).toBe(true);
    expect(results.every((r) => r.driverId === driverId)).toBe(true);
    expect(storeRt.degradedCacheSize()).toBe(1);
    await storeRt.close();
  });

  test("failed singleflight does not stick; retry succeeds", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const storeRt = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      sql: h.client,
      degraded: { ttlMs: 50, maxEntries: 8, advisoryLockTimeoutMs: 500 },
    });
    (storeRt as any).client = {
      get: async () => {
        throw new Error("down");
      },
      send: async () => {
        throw new Error("down");
      },
      del: async () => 0,
      close: () => {},
    };
    let calls = 0;
    await expect(
      storeRt.getOrHydrateRuntime(driverId, async () => {
        calls++;
        throw new Error("hydrate_boom");
      }),
    ).rejects.toThrow("hydrate_boom");
    expect(storeRt.singleflightSize()).toBe(0);
    const ok = await storeRt.getOrHydrateRuntime(driverId, async () => {
      calls++;
      return (await hydrateDriverRuntimeFromPostgres(h.client, driverId))!;
    });
    expect(ok.workStatus).toBe("OFFLINE");
    expect(calls).toBe(2);
    await storeRt.close();
  });

  test("degraded cache is bounded and TTL expires", async () => {
    const storeRt = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      degraded: { ttlMs: 80, maxEntries: 3, advisoryLockTimeoutMs: 200 },
    });
    (storeRt as any).client = {
      get: async () => null,
      send: async () => {
        throw new Error("down");
      },
      del: async () => 0,
      close: () => {},
    };
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      await storeRt.getOrHydrateRuntime(id, async () => ({
        driverId: id,
        cityId: city,
        eligibilityStatus: "ELIGIBLE",
        workStatus: "OFFLINE",
        activeOrderCount: 0,
        eligibilityVersion: 1,
        updatedAt: new Date().toISOString(),
      }));
    }
    expect(storeRt.degradedCacheSize()).toBeLessThanOrEqual(3);
    await Bun.sleep(120);
    const missId = crypto.randomUUID();
    let hydrations = 0;
    await storeRt.getOrHydrateRuntime(missId, async () => {
      hydrations++;
      return {
        driverId: missId,
        cityId: city,
        eligibilityStatus: "ELIGIBLE",
        workStatus: "OFFLINE",
        activeOrderCount: 0,
        eligibilityVersion: 1,
        updatedAt: new Date().toISOString(),
      };
    });
    expect(hydrations).toBe(1);
    await storeRt.close();
  });

  test("terminal DEAD after max attempts", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const jobId = await h.client.begin(async (tx: SQL) => {
      const rev = await bumpDriverRuntimeRevision(tx, driverId);
      return enqueueDriverRuntimeRecon(tx, {
        driverId,
        expectedRevision: rev,
        cityId: city,
      });
    });
    const boomRuntime = {
      getRuntime: async () => {
        throw new Error("always");
      },
      setRuntime: async () => {
        throw new Error("always");
      },
      setRuntimeWithCas: async () => {
        throw new Error("always");
      },
      invalidateRuntime: async () => {
        throw new Error("always");
      },
    } as any;
    const worker = new RedisReconciliationWorker(
      h.client,
      boomRuntime,
      {
        ...loadRedisReconConfig(),
        maxAttempts: 2,
        retryBaseMs: 1,
        retryMaxMs: 1,
      },
      silentLogger,
      async () => {
        throw new Error("no");
      },
    );
    await worker.runOnce();
    await h.client`update redis_reconciliation_jobs set next_attempt_at = now() - interval '1 second' where id = ${jobId}`;
    await worker.runOnce();
    const [row] = await h.client<{ status: string; attempt_count: number }[]>`
      select status::text, attempt_count from redis_reconciliation_jobs where id = ${jobId}`;
    expect(row!.status).toBe("DEAD");
    expect(row!.attempt_count).toBeGreaterThanOrEqual(2);
  });

  test("city open offers recon enqueued once while pending", async () => {
    await h.client`
      update redis_reconciliation_jobs
      set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
      where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
        and status in ('PENDING', 'PROCESSING')`;
    const a = await h.client.begin((tx: SQL) =>
      enqueueCityOpenOffersRecon(tx, city),
    );
    const b = await h.client.begin((tx: SQL) =>
      enqueueCityOpenOffersRecon(tx, city),
    );
    expect(a.jobId).toBe(b.jobId);
    const [count] = await h.client<{ count: number }[]>`
      select count(*)::int as count from redis_reconciliation_jobs
      where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
        and status in ('PENDING', 'PROCESSING')`;
    expect(count!.count).toBe(1);
    const [rev] = await h.client<{ expected_revision: number }[]>`
      select expected_revision from redis_reconciliation_jobs where id = ${a.jobId}`;
    expect(Number(rev!.expected_revision)).toBeGreaterThan(0);
  });

  test("CITY Redis CAS: late A=R cannot overwrite B=R+1 after lease transfer", async () => {
    const redis = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      sql: h.client,
    });
    try {
      await h.client`
        update redis_reconciliation_jobs
        set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
        where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
          and status in ('PENDING', 'PROCESSING')`;

      const order = await h.orders.create(customer, city, {
        storeId: store,
        addressId,
        paymentMethod: "CASH",
        items: [{ productId: product, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      });
      await h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" });
      const round = await h.offers.openRound(
        adminIdentity,
        order.id,
        "cas-r",
        crypto.randomUUID(),
      );

      // Seed real Redis to match PG open snapshot at current city revision.
      const seed = await h.client.begin((tx: SQL) =>
        enqueueCityOpenOffersRecon(tx, city),
      );
      const seedOffers = [
        {
          offerId: round.id,
          orderId: order.id,
          cityId: city,
          openedAt: new Date().toISOString(),
          pricingBaseSnapshot: 1000,
          roundingUnitSnapshot: 250,
          pricingStagesSnapshot: [
            { afterSeconds: 0, increasePercentage: 0 },
          ] as any,
          pricingVersionSnapshot: 1,
        },
      ];
      expect(
        await redis.rebuildCityOpenOffersWithCas(
          city,
          seed.revision,
          seedOffers,
        ),
      ).toBe("APPLIED");
      await h.client`
        update redis_reconciliation_jobs
        set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
        where id = ${seed.jobId}`;

      const { jobId, revision: rClaim } = await h.client.begin((tx: SQL) =>
        enqueueCityOpenOffersRecon(tx, city),
      );

      let releaseA!: () => void;
      const holdA = new Promise<void>((r) => {
        releaseA = r;
      });
      let aEntered = false;
      let aCas: RuntimeCasResult | null = null;
      let aClaimedRevision = 0;

      const workerA = new RedisReconciliationWorker(
        h.client,
        redis,
        {
          ...loadRedisReconConfig(),
          enabled: true,
          leaseSeconds: 1,
          batchSize: 10,
        },
        silentLogger,
        async (cityId, revision) => {
          aClaimedRevision = revision;
          const snap = await h.client<
            {
              id: string;
              order_id: string;
              city_id: string;
              opened_at: Date;
              pricing_base_snapshot: number;
              rounding_unit_snapshot: number;
              pricing_stages_snapshot: unknown;
              pricing_version_snapshot: number;
            }[]
          >`select id::text, order_id::text, city_id::text, opened_at,
                   pricing_base_snapshot, rounding_unit_snapshot,
                   pricing_stages_snapshot, pricing_version_snapshot
            from order_offer_rounds
            where city_id = ${cityId} and status = 'OPEN'
            order by opened_at asc, id asc`;
          aEntered = true;
          await holdA;
          aCas = await redis.rebuildCityOpenOffersWithCas(
            cityId,
            revision,
            snap.map((row) => ({
              offerId: row.id,
              orderId: row.order_id,
              cityId: row.city_id,
              openedAt: new Date(row.opened_at).toISOString(),
              pricingBaseSnapshot: Number(row.pricing_base_snapshot),
              roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
              pricingStagesSnapshot: row.pricing_stages_snapshot as any,
              pricingVersionSnapshot: Number(row.pricing_version_snapshot),
            })),
          );
        },
      );

      const runA = workerA.runOnce();
      await waitUntil(async () => aEntered);
      expect(aClaimedRevision).toBe(rClaim);

      const earlyB = new RedisReconciliationWorker(
        h.client,
        redis,
        { ...loadRedisReconConfig(), enabled: true, leaseSeconds: 1 },
        silentLogger,
        async (cityId, revision) => {
          await h.offers.reconcileCityOffers(cityId, revision);
          // Force real Redis write with the claimed revision (harness OfferService is Fake).
          const rows = await h.client<
            {
              id: string;
              order_id: string;
              city_id: string;
              opened_at: Date;
              pricing_base_snapshot: number;
              rounding_unit_snapshot: number;
              pricing_stages_snapshot: unknown;
              pricing_version_snapshot: number;
            }[]
          >`select id::text, order_id::text, city_id::text, opened_at,
                   pricing_base_snapshot, rounding_unit_snapshot,
                   pricing_stages_snapshot, pricing_version_snapshot
            from order_offer_rounds
            where city_id = ${cityId} and status = 'OPEN'
            order by opened_at asc, id asc`;
          await redis.rebuildCityOpenOffersWithCas(
            cityId,
            revision,
            rows.map((row) => ({
              offerId: row.id,
              orderId: row.order_id,
              cityId: row.city_id,
              openedAt: new Date(row.opened_at).toISOString(),
              pricingBaseSnapshot: Number(row.pricing_base_snapshot),
              roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
              pricingStagesSnapshot: row.pricing_stages_snapshot as any,
              pricingVersionSnapshot: Number(row.pricing_version_snapshot),
            })),
          );
        },
      );
      expect((await earlyB.runOnce()).claimed).toBe(0);

      // R+1 in PG: stop open round + coalesce job revision (no Fake Redis path).
      await h.client`
        update order_offer_rounds
        set status = 'STOPPED', closed_at = now(), stopped_at = now(),
            stop_reason = 'cas-stop', updated_at = now()
        where id = ${round.id} and status = 'OPEN'`;
      const bumped = await h.client.begin((tx: SQL) =>
        enqueueCityOpenOffersRecon(tx, city),
      );
      expect(bumped.revision).toBeGreaterThan(rClaim);
      expect(bumped.jobId).toBe(jobId);

      const workerB = new RedisReconciliationWorker(
        h.client,
        redis,
        { ...loadRedisReconConfig(), enabled: true, leaseSeconds: 1 },
        silentLogger,
        async (cityId, revision) => {
          const rows = await h.client<
            {
              id: string;
              order_id: string;
              city_id: string;
              opened_at: Date;
              pricing_base_snapshot: number;
              rounding_unit_snapshot: number;
              pricing_stages_snapshot: unknown;
              pricing_version_snapshot: number;
            }[]
          >`select id::text, order_id::text, city_id::text, opened_at,
                   pricing_base_snapshot, rounding_unit_snapshot,
                   pricing_stages_snapshot, pricing_version_snapshot
            from order_offer_rounds
            where city_id = ${cityId} and status = 'OPEN'
            order by opened_at asc, id asc`;
          await redis.rebuildCityOpenOffersWithCas(
            cityId,
            revision,
            rows.map((row) => ({
              offerId: row.id,
              orderId: row.order_id,
              cityId: row.city_id,
              openedAt: new Date(row.opened_at).toISOString(),
              pricingBaseSnapshot: Number(row.pricing_base_snapshot),
              roundingUnitSnapshot: Number(row.rounding_unit_snapshot),
              pricingStagesSnapshot: row.pricing_stages_snapshot as any,
              pricingVersionSnapshot: Number(row.pricing_version_snapshot),
            })),
          );
        },
      );
      await waitUntil(
        async () => {
          await workerB.runOnce();
          const [row] = await h.client<{ status: string }[]>`
          select status::text from redis_reconciliation_jobs where id = ${jobId}`;
          return row?.status === "COMPLETED";
        },
        8_000,
        50,
      );

      const redisRevBeforeLateA = await redis.getCityOpenOffersRevision(city);
      expect(redisRevBeforeLateA).toBeGreaterThan(rClaim);
      const idsBeforeLateA = await redis.listOpenOfferIds(city, 50);
      expect(idsBeforeLateA).not.toContain(round.id);

      const [jobBeforeLateA] = await h.client<
        {
          status: string;
          locked_by: string | null;
          expected_revision: number;
        }[]
      >`select status::text, locked_by, expected_revision from redis_reconciliation_jobs where id = ${jobId}`;

      releaseA();
      await runA;
      expect(aCas === "STALE_REJECTED").toBe(true);

      const late = await markReconJobCompleted(h.client, jobId, {
        lockedBy: workerA.ownershipToken,
      });
      expect(late).toBe(false);

      const redisRev = await redis.getCityOpenOffersRevision(city);
      expect(redisRev).toBe(redisRevBeforeLateA);
      expect(redisRev).toBeGreaterThan(rClaim);
      const ids = await redis.listOpenOfferIds(city, 50);
      expect(ids).not.toContain(round.id);

      const [jobAfter] = await h.client<
        {
          status: string;
          locked_by: string | null;
          expected_revision: number;
        }[]
      >`select status::text, locked_by, expected_revision from redis_reconciliation_jobs where id = ${jobId}`;
      expect(jobAfter!.status).toBe(jobBeforeLateA!.status);
      expect(jobAfter!.locked_by).toBe(jobBeforeLateA!.locked_by);
      expect(Number(jobAfter!.expected_revision)).toBe(
        Number(jobBeforeLateA!.expected_revision),
      );

      const [due] = await h.client<{ count: number }[]>`
        select count(*)::int as count from redis_reconciliation_jobs
        where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
          and status in ('PENDING', 'PROCESSING')
          and next_attempt_at <= now()`;
      expect(due!.count).toBe(0);
    } finally {
      await redis.close();
    }
  });

  test("immediate post-commit cannot complete worker-claimed CITY job; CAS orders writes", async () => {
    const redis = new DriverRuntimeStore(redisUrl, "test", silentLogger, {
      sql: h.client,
    });
    try {
      await h.client`
        update redis_reconciliation_jobs
        set status = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
        where job_type = 'CITY_OPEN_OFFERS' and resource_id = ${city}
          and status in ('PENDING', 'PROCESSING')`;

      const { jobId, revision } = await h.client.begin((tx: SQL) =>
        enqueueCityOpenOffersRecon(tx, city),
      );

      let release!: () => void;
      const barrier = new Promise<void>((r) => {
        release = r;
      });
      let entered = false;

      const worker = new RedisReconciliationWorker(
        h.client,
        redis,
        { ...loadRedisReconConfig(), enabled: true, leaseSeconds: 60 },
        silentLogger,
        async (cityId, rev) => {
          entered = true;
          await barrier;
          await redis.rebuildCityOpenOffersWithCas(cityId, rev, []);
        },
      );
      const run = worker.runOnce();
      await waitUntil(async () => entered);

      const [claimed] = await h.client<
        { status: string; locked_by: string | null }[]
      >`
        select status::text, locked_by from redis_reconciliation_jobs where id = ${jobId}`;
      expect(claimed!.status).toBe("PROCESSING");
      expect(claimed!.locked_by).toBe(worker.ownershipToken);

      await applyRedisAfterCommit({
        client: h.client,
        jobIds: [jobId],
        apply: async () => {
          await redis.rebuildCityOpenOffersWithCas(city, revision, []);
        },
      });

      const [still] = await h.client<
        { status: string; locked_by: string | null }[]
      >`
        select status::text, locked_by from redis_reconciliation_jobs where id = ${jobId}`;
      expect(still!.status).toBe("PROCESSING");
      expect(still!.locked_by).toBe(worker.ownershipToken);

      const newer = revision + 5;
      expect(
        (await redis.rebuildCityOpenOffersWithCas(city, newer, [])) ===
          "APPLIED",
      ).toBe(true);
      expect(
        (await redis.rebuildCityOpenOffersWithCas(city, revision, [])) ===
          "STALE_REJECTED",
      ).toBe(true);
      expect(await redis.getCityOpenOffersRevision(city)).toBe(newer);

      release();
      await run;
    } finally {
      await redis.close();
    }
  });
});
