import type { Queue } from "bullmq";
import type { Job } from "bullmq";
import { ConfigError } from "../config.js";
import type { RunJob, RunQueueStore } from "./run-queue.js";

/**
 * Opt-in BullMQ/Redis queue driver.
 *
 * ADR-0004 keeps the MySQL table as the default durable queue; this driver is
 * selected only when `config.queue.redis` is present (`HEALTHBRIDGE_REDIS_URL`
 * or `REDIS_URL`). It implements the same {@link RunQueueStore} contract the
 * `RunQueue` engine consumes, so executions, retries, leases and cancellation
 * behave identically whichever driver is selected:
 *
 *  - **Persist-before-report.** `enqueue` awaits the BullMQ write (job id =
 *    run id, so a duplicate enqueue is a no-op that keeps the existing state,
 *    exactly like the MySQL `ON DUPLICATE KEY UPDATE`) and throws when Redis
 *    is unreachable, so the API answers `503` instead of reporting a job that
 *    was never stored.
 *  - **Lease.** Claim state (`claimedBy`/`claimedAt`) lives in the job data.
 *    A claim whose lease is older than `visibilityTimeoutMs` is taken over,
 *    which is what makes restarts safe rather than merely survivable. Claims
 *    are read-then-write (BullMQ has no compare-and-swap on job data), so two
 *    replicas racing for the same job can both run it; that degrades to the
 *    at-least-once delivery ADR-0004 already accepts, and a re-run overwrites
 *    the same run row with the same checksums.
 *  - **Backoff.** `retry` records the error and the next eligible time
 *    (`availableAt`) before it returns, so a crash during the wait neither
 *    loses the job nor makes it immediately claimable again.
 *  - **Cancel.** `cancel` marks the job; the running replica's poll observes
 *    it through `cancelledAmong` and aborts at the next stage boundary, which
 *    is what makes cancellation work across replicas.
 *
 * BullMQ is the durable job log here, not the executor: the existing
 * `RunQueue` engine still drives execution, so no BullMQ `Worker` is created
 * and job data stays small (ids and claim bookkeeping, never payloads).
 * Terminal history lives in the run rows; `finish` removes the BullMQ job so
 * a restart can never resurrect it.
 *
 * The driver never talks to Redis through globals: construction goes through
 * {@link createBullMqJobStore} (real BullMQ `Queue`), while tests inject an
 * in-memory {@link BullMqQueueLike} behind the same seam — no live Redis is
 * required to exercise the lease/backoff/cancel logic.
 */

export const BULLMQ_DEFAULT_QUEUE_NAME = "healthbridge-runs";
export const BULLMQ_DEFAULT_KEY_PREFIX = "hbq";
const BULLMQ_RUN_JOB_NAME = "run";
/** Upper bound on waiting jobs scanned per claim; leftovers are picked up on the next poll. */
const MAX_CLAIM_SCAN = 2000;

/** Claim bookkeeping stored as the BullMQ job data. Small by design: ids and lease state only. */
export interface BullMqJobData {
  runId: string;
  workspaceId: string;
  status: "pending" | "claimed" | "cancelled";
  attempts: number;
  /** Epoch milliseconds: the job is claimable once `now >= availableAt` (retry backoff). */
  availableAt: number;
  claimedBy?: string;
  claimedAt?: number;
  lastError?: string;
}

/** The slice of a BullMQ job the store touches. Real jobs satisfy this structurally. */
export interface BullMqJobLike {
  readonly id?: string;
  data: BullMqJobData;
  updateData(data: BullMqJobData): Promise<void>;
  remove(): Promise<void>;
}

/**
 * The slice of BullMQ's `Queue` the store touches. Production passes a real
 * `Queue` (via {@link BullMqQueueAdapter}); tests pass an in-memory fake with
 * the same observable behavior.
 */
export interface BullMqQueueLike {
  add(data: BullMqJobData, opts: { jobId: string }): Promise<unknown>;
  getJob(jobId: string): Promise<BullMqJobLike | undefined>;
  /** Waiting jobs, oldest first (includes delayed jobs, filtered by `availableAt`). */
  getWaiting(): Promise<BullMqJobLike[]>;
  close(): Promise<void>;
}

/** Adapts a real BullMQ `Queue` to the seam above. */
export class BullMqQueueAdapter implements BullMqQueueLike {
  constructor(private readonly queue: Queue<BullMqJobData>) {}

  public async add(data: BullMqJobData, opts: { jobId: string }): Promise<unknown> {
    return this.queue.add(BULLMQ_RUN_JOB_NAME, data, { jobId: opts.jobId });
  }

  public async getJob(jobId: string): Promise<BullMqJobLike | undefined> {
    const job = await this.queue.getJob(jobId);
    return job ? new BullMqJobAdapter(job) : undefined;
  }

  public async getWaiting(): Promise<BullMqJobLike[]> {
    const jobs = await this.queue.getJobs(["waiting", "delayed"], 0, -1, true);
    return jobs.map((job) => new BullMqJobAdapter(job));
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Adapts a real BullMQ `Job` to the seam above. */
export class BullMqJobAdapter implements BullMqJobLike {
  constructor(private readonly job: Job<BullMqJobData>) {}

  public get id(): string | undefined {
    return this.job.id;
  }

  public get data(): BullMqJobData {
    return this.job.data;
  }

  public async updateData(data: BullMqJobData): Promise<void> {
    await this.job.updateData(data);
  }

  public async remove(): Promise<void> {
    await this.job.remove();
  }
}

export interface BullMqJobStoreOptions {
  queue: BullMqQueueLike;
  now?: () => Date;
}

/**
 * A {@link RunQueueStore} backed by BullMQ/Redis. Instantiate with
 * {@link createBullMqJobStore} in production or with an in-memory
 * {@link BullMqQueueLike} in tests.
 */
export class BullMqJobStore implements RunQueueStore {
  private readonly queue: BullMqQueueLike;
  private readonly now: () => Date;

  constructor(options: BullMqJobStoreOptions) {
    this.queue = options.queue;
    this.now = options.now ?? (() => new Date());
  }

  public async enqueue(job: RunJob): Promise<void> {
    // Persist before reporting: when this throws, the caller releases the run
    // and the client is told the truth instead of waiting for a job that never
    // existed. A job id that already exists keeps its state (duplicate enqueue
    // of the same run, e.g. a retried request, must not reset the lease).
    const existing = await this.queue.getJob(job.runId);
    if (existing) return;
    const data: BullMqJobData = {
      runId: job.runId,
      workspaceId: job.workspaceId,
      status: "pending",
      attempts: 0,
      availableAt: 0,
    };
    try {
      // BullMQ does not add a job whose id already exists; the pre-check above
      // is still needed so a duplicate enqueue resolves without depending on
      // that behavior, and the post-check below covers the replica race.
      await this.queue.add(data, { jobId: job.runId });
    } catch (error) {
      const raced = await this.queue.getJob(job.runId).catch(() => undefined);
      if (raced) return;
      throw error;
    }
  }

  public async claim(options: {
    workerId: string;
    limit: number;
    visibilityTimeoutMs: number;
  }): Promise<Array<{ runId: string; workspaceId: string; attempts: number }>> {
    const wanted = Math.max(1, Math.floor(options.limit));
    const leaseMs = Math.max(0, options.visibilityTimeoutMs);
    const nowMs = this.now().getTime();
    const claimed: Array<{ runId: string; workspaceId: string; attempts: number }> = [];
    const waiting = await this.queue.getWaiting();
    let scanned = 0;
    for (const listed of waiting) {
      if (claimed.length >= wanted || scanned >= MAX_CLAIM_SCAN) break;
      scanned++;
      const snapshot = listed.data;
      if (!snapshot || typeof snapshot.runId !== "string") continue;
      if (!isClaimable(snapshot, nowMs, leaseMs)) {
        // A cancel that outlived its worker would linger in `waiting` forever;
        // drop it the next time a claim scans past it.
        if (snapshot.status === "cancelled") {
          await listed.remove().catch(() => undefined);
        }
        continue;
      }
      // Re-read before writing: a concurrent claimer or a finish that landed
      // between the scan and this write wins instead of us double-running.
      const fresh = await this.queue.getJob(snapshot.runId).catch(() => undefined);
      if (!fresh || !isClaimable(fresh.data, nowMs, leaseMs)) continue;
      const current = fresh.data;
      const attempts = (current.attempts ?? 0) + 1;
      await fresh.updateData({
        ...current,
        status: "claimed",
        attempts,
        claimedBy: options.workerId,
        claimedAt: nowMs,
      });
      claimed.push({ runId: current.runId, workspaceId: current.workspaceId, attempts });
    }
    return claimed;
  }

  public async finish(runId: string, _outcome: "done" | "failed" | "cancelled", _error?: string): Promise<void> {
    // Terminal run state already lives in the run row (written by the worker
    // before this is called); dropping the queue entry means a restart can
    // never resurrect a finished job. A missing job is a no-op, mirroring the
    // MySQL zero-row update.
    const job = await this.queue.getJob(runId);
    if (!job) return;
    await job.remove();
  }

  public async retry(runId: string, error: string, delayMs: number): Promise<void> {
    const job = await this.queue.getJob(runId);
    if (!job) return;
    const nowMs = this.now().getTime();
    const current = job.data;
    await job.updateData({
      ...current,
      status: "pending",
      availableAt: nowMs + Math.max(0, delayMs),
      claimedBy: undefined,
      claimedAt: undefined,
      lastError: error.slice(0, 500),
    });
  }

  public async cancel(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(runId);
    if (!job) return false;
    const status = job.data?.status;
    if (status !== "pending" && status !== "claimed") return false;
    await job.updateData({ ...job.data, status: "cancelled" });
    return true;
  }

  public async cancelledAmong(runIds: string[]): Promise<string[]> {
    if (runIds.length === 0) return [];
    const cancelled: string[] = [];
    for (const runId of runIds) {
      const job = await this.queue.getJob(runId).catch(() => undefined);
      if (job?.data?.status === "cancelled") cancelled.push(runId);
    }
    return cancelled;
  }

  /** Drops the underlying Redis connections; called on API shutdown. */
  public async close(): Promise<void> {
    await this.queue.close();
  }
}

function isClaimable(data: BullMqJobData | undefined, nowMs: number, leaseMs: number): boolean {
  if (!data) return false;
  if (data.status === "cancelled") return false;
  // Backoff that has not elapsed yet (a retry recorded by another attempt).
  if (data.availableAt > nowMs) return false;
  if (data.status === "claimed" && (data.claimedAt ?? 0) >= nowMs - leaseMs) return false;
  return data.status === "pending" || data.status === "claimed";
}

export interface BullMqConnectionOptions {
  /** Redis URL, e.g. `redis://localhost:6379`. From `config.queue.redis`. */
  url: string;
  queueName?: string;
  prefix?: string;
  now?: () => Date;
}

/**
 * Builds a production `BullMqJobStore` against the Redis at `url`.
 *
 * Fails fast: when Redis is unreachable the queue is closed and a
 * `ConfigError` is thrown (with the endpoint redacted — credentials never
 * appear in the message). The caller must not fall back to another driver.
 */
export async function createBullMqJobStore(options: BullMqConnectionOptions): Promise<BullMqJobStore> {
  const queueName = options.queueName ?? BULLMQ_DEFAULT_QUEUE_NAME;
  const prefix = options.prefix ?? BULLMQ_DEFAULT_KEY_PREFIX;
  let QueueCtor: typeof Queue;
  try {
    ({ Queue: QueueCtor } = await import("bullmq"));
  } catch (error) {
    throw new ConfigError(
      `Redis queue is configured but the bullmq driver cannot be loaded: ${(error as Error)?.message ?? String(error)}`,
    );
  }
  // Boot gives up after a few fast attempts so a down Redis fails the boot
  // instead of hanging it; once connected the strategy flips to reconnecting
  // forever, so a later Redis restart stalls polls instead of killing the queue.
  const boot = { open: true };
  const queue = new QueueCtor<BullMqJobData>(queueName, {
    connection: {
      url: options.url,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy: (times: number): number | null =>
        boot.open ? (times <= 4 ? 100 * times : null) : Math.min(times * 200, 5000),
    },
    prefix,
  });
  try {
    await queue.waitUntilReady();
    boot.open = false;
  } catch (error) {
    await queue.close().catch(() => undefined);
    throw new ConfigError(
      `Redis queue is configured but unreachable at ${describeRedisEndpoint(options.url)}: ` +
        `${scrubSecrets((error as Error)?.message ?? String(error))}. ` +
        `Unset HEALTHBRIDGE_REDIS_URL/REDIS_URL to use the MySQL/process default, or start Redis.`,
    );
  }
  return new BullMqJobStore({ queue: new BullMqQueueAdapter(queue), now: options.now });
}

/** `redis://host:port` without credentials, so failures can be logged safely. */
function describeRedisEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname || "unknown-host"}:${parsed.port || "6379"}`;
  } catch {
    return "the configured Redis URL";
  }
}

/** Defensive scrub: never let a `user:pass@` fragment leak into an error message. */
function scrubSecrets(message: string): string {
  return message.replace(/:\/\/[^/\s@]*@/g, "://***@");
}
