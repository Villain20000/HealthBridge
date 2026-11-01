import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { createAppContext } from "../src/app.context.js";
import { ConfigError, loadConfig, loadTestConfig } from "../src/config.js";
import {
  BullMqJobStore,
  createBullMqJobStore,
  type BullMqJobData,
  type BullMqJobLike,
  type BullMqQueueLike,
} from "../src/jobs/bullmq-queue.js";
import { RunQueue, type RunEvent } from "../src/jobs/run-queue.js";

/**
 * The BullMQ driver, exercised through the same contract as the MySQL store.
 *
 * The store runs for real here; only the transport is faked. `FakeBullMqQueue`
 * is an in-memory stand-in for the Redis-backed BullMQ queue with the same
 * observable behavior for the commands the store uses (add-by-id is a no-op
 * on duplicates, reads observe the last write, removals disappear), so these
 * prove the driver's persist/lease/backoff/cancel logic with no live Redis.
 * The one thing a fake cannot prove — real BullMQ-over-Redis round trips —
 * is covered by the live test at the bottom, gated behind `REDIS_URL` like
 * the MySQL integration tests.
 */

interface FakeBullMqQueue {
  readonly jobs: Map<string, BullMqJobData>;
  readonly calls: string[];
  failAddsWith: unknown;
  readonly queue: BullMqQueueLike;
}

function createFakeBullMqQueue(): FakeBullMqQueue {
  const jobs = new Map<string, BullMqJobData>();
  const calls: string[] = [];
  const fake = {} as FakeBullMqQueue;

  async function getJob(jobId: string): Promise<BullMqJobLike | undefined> {
    const data = jobs.get(jobId);
    if (!data) return undefined;
    return {
      id: jobId,
      data: { ...data },
      updateData: async (next: BullMqJobData): Promise<void> => {
        if (!jobs.has(jobId)) throw new Error("Missing job");
        jobs.set(jobId, { ...next });
      },
      remove: async (): Promise<void> => {
        calls.push(`remove:${jobId}`);
        jobs.delete(jobId);
      },
    };
  }

  const queue: BullMqQueueLike = {
    add: async (data: BullMqJobData, opts: { jobId: string }): Promise<unknown> => {
      if (fake.failAddsWith !== undefined) throw fake.failAddsWith;
      if (jobs.has(opts.jobId)) return { id: opts.jobId };
      calls.push(`add:${opts.jobId}`);
      jobs.set(opts.jobId, { ...data });
      return { id: opts.jobId };
    },
    getJob,
    getWaiting: async (): Promise<BullMqJobLike[]> => {
      const waiting: BullMqJobLike[] = [];
      for (const jobId of jobs.keys()) {
        const found = await getJob(jobId);
        if (found) waiting.push(found);
      }
      return waiting;
    },
    close: async (): Promise<void> => {},
  };

  return Object.assign(fake, { jobs, calls, failAddsWith: undefined, queue });
}

const job = (runId: string) => ({ runId, workspaceId: "ws_1" });

function setup(now?: () => Date): { backend: FakeBullMqQueue; store: BullMqJobStore } {
  const backend = createFakeBullMqQueue();
  return { backend, store: new BullMqJobStore({ queue: backend.queue, now }) };
}

describe("BullMqJobStore with a faked queue", () => {
  it("should persist a job before reporting it as queued", async () => {
    const { backend, store } = setup();
    const order: string[] = [];
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 10_000,
      execute: async (queued) => {
        order.push(`execute:${queued.runId}`);
        return { status: "completed" };
      },
      onEvent: (event: RunEvent) => order.push(`event:${event.type}`),
    });

    await queue.enqueue(job("run_a"));

    assert.ok(backend.calls.includes("add:run_a"), "the job is written before enqueue resolves");
    await queue.idle();
    assert.deepEqual(
      order.filter((entry) => entry.startsWith("event:")),
      ["event:queued", "event:started", "event:done"],
    );
    assert.equal(backend.jobs.get("run_a"), undefined, "a finished job is removed, never resurrected");
    await queue.shutdown();
  });

  it("should reject the enqueue when the write refuses it", async () => {
    const { backend, store } = setup();
    backend.failAddsWith = Object.assign(new Error("Redis is down"), { code: "ECONNREFUSED" });
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 10_000,
      execute: async () => ({ status: "completed" }),
    });

    await assert.rejects(() => queue.enqueue(job("run_b")), /Redis is down/);
    assert.equal(queue.queued, 0, "nothing is left half-queued in this process");
    assert.equal(backend.jobs.get("run_b"), undefined);
    await queue.shutdown();
  });

  it("should pick up work that was already waiting — the restart case", async () => {
    const { backend, store } = setup();
    await store.enqueue(job("run_before_restart"));
    const executed: string[] = [];

    const queue = new RunQueue({
      concurrency: 2,
      maxAttempts: 2,
      store,
      pollIntervalMs: 5,
      execute: async (queued) => {
        executed.push(queued.runId);
        return { status: "completed" };
      },
    });

    const deadline = Date.now() + 2000;
    while (executed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await queue.idle();

    assert.deepEqual(executed, ["run_before_restart"]);
    assert.equal(backend.jobs.get("run_before_restart"), undefined);
    await queue.shutdown();
  });

  it("should record a retry with its backoff before waiting", async () => {
    let nowMs = 1_000_000;
    const { backend, store } = setup(() => new Date(nowMs));
    await store.enqueue(job("run_retry"));
    const claimed = await store.claim({ workerId: "w-1", limit: 1, visibilityTimeoutMs: 60_000 });
    assert.equal(claimed[0]?.attempts, 1);

    await store.retry("run_retry", "deadlock", 250);

    const entry = backend.jobs.get("run_retry");
    assert.equal(entry?.status, "pending");
    assert.equal(entry?.lastError, "deadlock");
    assert.equal(entry?.availableAt, nowMs + 250, "the backoff is recorded synchronously, before any wait");
    assert.equal(entry?.claimedBy, undefined, "the lease is released with the retry");

    // Still inside the backoff window: not claimable yet; afterwards it is.
    assert.deepEqual(await store.claim({ workerId: "w-1", limit: 1, visibilityTimeoutMs: 60_000 }), []);
    nowMs += 251;
    const reclaimed = await store.claim({ workerId: "w-1", limit: 1, visibilityTimeoutMs: 60_000 });
    assert.equal(reclaimed[0]?.runId, "run_retry");
    assert.equal(reclaimed[0]?.attempts, 2, "attempts keep counting across the retry");
  });

  it("should run the retry through the engine and then succeed", async () => {
    const { backend, store } = setup();
    let attempts = 0;
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 3,
      store,
      pollIntervalMs: 10_000,
      retryDelayMs: () => 5,
      execute: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
        return { status: "completed" };
      },
    });

    await queue.enqueue(job("run_retry_engine"));
    await queue.idle();

    assert.equal(attempts, 2);
    assert.equal(backend.jobs.get("run_retry_engine"), undefined);
    await queue.shutdown();
  });

  it("should hold the lease, then hand the job over after the visibility timeout", async () => {
    let nowMs = 2_000_000;
    const { store } = setup(() => new Date(nowMs));
    await store.enqueue(job("run_lease_a"));
    await store.enqueue(job("run_lease_b"));

    const first = await store.claim({ workerId: "w-1", limit: 2, visibilityTimeoutMs: 60_000 });
    assert.deepEqual(
      first.map((entry) => entry.runId).sort(),
      ["run_lease_a", "run_lease_b"],
    );
    assert.deepEqual(
      await store.claim({ workerId: "w-2", limit: 2, visibilityTimeoutMs: 60_000 }),
      [],
      "a held lease is not double-claimed",
    );

    nowMs += 60_001;
    const taken = await store.claim({ workerId: "w-2", limit: 2, visibilityTimeoutMs: 60_000 });
    assert.deepEqual(
      taken.map((entry) => entry.runId).sort(),
      ["run_lease_a", "run_lease_b"],
      "a lease older than the visibility timeout is taken over (crash recovery)",
    );
    assert.deepEqual(taken.map((entry) => entry.attempts).sort(), [2, 2]);
  });

  it("should keep a duplicate enqueue from resetting the lease", async () => {
    const { backend, store } = setup();
    await store.enqueue(job("run_dup"));
    await store.claim({ workerId: "w-1", limit: 1, visibilityTimeoutMs: 60_000 });

    await store.enqueue(job("run_dup"));

    const entry = backend.jobs.get("run_dup");
    assert.equal(entry?.status, "claimed");
    assert.equal(entry?.attempts, 1, "the duplicate keeps the existing state");
    assert.equal(entry?.claimedBy, "w-1");
  });

  it("should cancel a pending job and report unknown ids honestly", async () => {
    const { backend, store } = setup();
    assert.equal(await store.cancel("run_missing"), false);

    await store.enqueue(job("run_cancel"));
    assert.equal(await store.cancel("run_cancel"), true);
    assert.equal(backend.jobs.get("run_cancel")?.status, "cancelled");
    assert.equal(await store.cancel("run_cancel"), false, "already cancelled: nothing changed");
    assert.deepEqual(await store.cancelledAmong(["run_cancel", "run_missing"]), ["run_cancel"]);

    // A cancelled job is never claimed again, and a finished job is gone.
    assert.deepEqual(await store.claim({ workerId: "w-1", limit: 5, visibilityTimeoutMs: 60_000 }), []);
    await store.finish("run_cancel", "cancelled");
    assert.equal(backend.jobs.get("run_cancel"), undefined);
    assert.equal(await store.cancel("run_cancel"), false);
    assert.deepEqual(await store.cancelledAmong(["run_cancel"]), []);
  });

  it("should mark the job cancelled when another replica cancelled it mid-run", async () => {
    const { backend, store } = setup();
    let started = false;
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 5,
      execute: async (_queued, context) => {
        started = true;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 2000);
        });
        return { status: context.signal.aborted ? "cancelled" : "completed" };
      },
    });

    await queue.enqueue(job("run_cross_cancel"));
    const startDeadline = Date.now() + 1000;
    while (!started && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, 5));

    await store.cancel("run_cross_cancel"); // what a different replica would do
    await queue.idle();

    assert.equal(backend.jobs.get("run_cross_cancel"), undefined, "the abort is recorded, not left behind");
    await queue.shutdown();
  });

  it("should stop claiming once shut down", async () => {
    const { backend, store } = setup();
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 5,
      execute: async () => ({ status: "completed" }),
    });

    await queue.shutdown();
    await store.enqueue(job("run_after_shutdown"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(backend.jobs.get("run_after_shutdown")?.status, "pending", "the job waits for the next process");
  });
});

const REDIS_ENV_KEYS = ["HEALTHBRIDGE_REDIS_URL", "REDIS_URL"] as const;

function snapshotRedisEnv(): Record<(typeof REDIS_ENV_KEYS)[number], string | undefined> {
  return {
    HEALTHBRIDGE_REDIS_URL: process.env.HEALTHBRIDGE_REDIS_URL,
    REDIS_URL: process.env.REDIS_URL,
  };
}

function restoreRedisEnv(snapshot: Record<(typeof REDIS_ENV_KEYS)[number], string | undefined>): void {
  for (const key of REDIS_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function clearRedisEnv(): void {
  for (const key of REDIS_ENV_KEYS) delete process.env[key];
}

describe("BullMQ queue driver selection", () => {
  it("keeps the historical default when redis is not configured", async () => {
    const snapshot = snapshotRedisEnv();
    try {
      clearRedisEnv();
      const config = loadTestConfig();
      assert.equal(config.queue.redis, undefined);
      const context = await createAppContext({ config });
      try {
        assert.equal(context.queue.durable, false, "no store: the in-process default is unchanged");
      } finally {
        await context.close();
      }
    } finally {
      restoreRedisEnv(snapshot);
    }
  });

  it("reads REDIS_URL as a fallback for HEALTHBRIDGE_REDIS_URL", () => {
    // loadTestConfig is hermetic (it does not read process.env), so the
    // fallback is proven through loadConfig with an explicit env instead.
    const fallback = loadConfig({
      NODE_ENV: "test",
      HEALTHBRIDGE_KEY_PEPPER: "test-pepper-at-least-16-chars",
      HEALTHBRIDGE_BOOTSTRAP_TOKEN: "test-bootstrap-token",
      HEALTHBRIDGE_STORAGE_DIR: "",
      REDIS_URL: "redis://localhost:6379",
    } as NodeJS.ProcessEnv);
    assert.equal(fallback.queue.redis?.url, "redis://localhost:6379");

    const precedence = loadConfig({
      NODE_ENV: "test",
      HEALTHBRIDGE_KEY_PEPPER: "test-pepper-at-least-16-chars",
      HEALTHBRIDGE_BOOTSTRAP_TOKEN: "test-bootstrap-token",
      HEALTHBRIDGE_STORAGE_DIR: "",
      HEALTHBRIDGE_REDIS_URL: "redis://primary:6379",
      REDIS_URL: "redis://fallback:6379",
    } as NodeJS.ProcessEnv);
    assert.equal(precedence.queue.redis?.url, "redis://primary:6379");
  });

  it("refuses a non-redis URL at config load", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          HEALTHBRIDGE_REDIS_URL: "http://localhost:6379",
        } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof ConfigError && /redis:\/\//.test(error.message),
    );
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          HEALTHBRIDGE_REDIS_URL: "not a url",
        } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof ConfigError && /valid redis/.test(error.message),
    );
  });

  it("fails fast when Redis is unreachable (never silently falls back)", async () => {
    const snapshot = snapshotRedisEnv();
    try {
      clearRedisEnv();
      // Nothing listens on port 9 (discard): the refusal is immediate.
      const config = loadTestConfig({
        queue: {
          ...loadTestConfig().queue,
          redis: { url: "redis://:s3cret-should-never-appear@127.0.0.1:9/0" },
        },
      });
      await assert.rejects(createAppContext({ config }), (error: unknown) => {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
        assert.match(error.message, /Redis queue is configured but unreachable/);
        assert.match(error.message, /127\.0\.0\.1/);
        assert.ok(!error.message.includes("s3cret-should-never-appear"), "credentials must not leak into errors");
        return true;
      });
    } finally {
      restoreRedisEnv(snapshot);
    }
  });

  it("fails fast through the factory with a redacted endpoint", async () => {
    await assert.rejects(
      createBullMqJobStore({ url: "redis://:s3cret-should-never-appear@127.0.0.1:9/0" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes("s3cret-should-never-appear"), "credentials must not leak into errors");
        assert.match(error.message, /redis:\/\/127\.0\.0\.1:9/);
        return true;
      },
    );
  });
});

/**
 * Live Redis coverage, gated behind REDIS_URL like the MySQL pattern: the
 * default suite never needs an external service, and this proves the real
 * BullMQ-over-Redis round trips (add/get/update/remove) the fake stands in for.
 */
const LIVE_REDIS_URL = process.env.REDIS_URL ?? process.env.HEALTHBRIDGE_REDIS_URL;

describe("BullMQ driver (live Redis)", { skip: LIVE_REDIS_URL ? false : "REDIS_URL is not set" }, () => {
  it("runs a job end to end through real Redis", async () => {
    const store = await createBullMqJobStore({
      url: LIVE_REDIS_URL!,
      queueName: `hb-test-${randomBytes(4).toString("hex")}`,
    });
    try {
      let executed = 0;
      const queue = new RunQueue({
        concurrency: 1,
        maxAttempts: 1,
        store,
        pollIntervalMs: 50,
        retryDelayMs: () => 5,
        execute: async () => {
          executed++;
          return { status: "completed" };
        },
      });
      await queue.enqueue(job("run_live"));
      await queue.idle();
      assert.equal(executed, 1);
      await queue.shutdown();
    } finally {
      await store.close();
    }
  });
});
