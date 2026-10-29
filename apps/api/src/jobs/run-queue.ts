import { EventEmitter } from "node:events";
import type { TransformationResult } from "@healthbridge/shared-types";

/**
 * Run queue: bounded concurrency, retries with backoff, cooperative cancellation,
 * progress events.
 *
 * Two modes, one engine:
 *
 *  - **demo (no database)**: everything lives in this process. Jobs are lost on
 *    restart and cannot be shared between replicas; run rows are still written first,
 *    so a queued run that never started stays visible as `queued` instead of vanishing.
 *  - **database (`store` set)**: the queue is a table (`run_jobs`). Enqueue persists
 *    before it returns, every replica polls, claiming is atomic (`SKIP LOCKED`), a job
 *    whose worker died is re-claimed after the visibility timeout, and a cancellation
 *    issued against one replica aborts the worker running it on another.
 *
 * The in-memory list is only a local work-stealing cache in database mode.
 */

export type RunEventType = "queued" | "started" | "progress" | "status" | "warning" | "done" | "error" | "cancelled";

export interface RunEvent {
  runId: string;
  workspaceId: string;
  type: RunEventType;
  at: string;
  payload?: Record<string, unknown>;
}

export interface RunJob {
  runId: string;
  workspaceId: string;
}

export interface ProgressReport {
  stage: string;
  stepName: string;
  recordsProcessed?: number;
  recordsTotal?: number;
  percent?: number;
  message?: string;
}

export interface JobExecutor {
  (
    job: RunJob,
    context: {
      signal: AbortSignal;
      report: (progress: ProgressReport) => void;
      attempt: number;
    },
  ): Promise<{
    status: "completed" | "completed_with_warnings" | "failed" | "cancelled";
    result?: TransformationResult;
  }>;
}

/** Durable backing for the queue. Implemented by `MySqlJobStore`. */
export interface RunQueueStore {
  enqueue(job: RunJob): Promise<void>;
  claim(options: {
    workerId: string;
    limit: number;
    visibilityTimeoutMs: number;
  }): Promise<Array<{ runId: string; workspaceId: string; attempts: number }>>;
  finish(runId: string, outcome: "done" | "failed" | "cancelled", error?: string): Promise<void>;
  retry(runId: string, error: string, delayMs: number): Promise<void>;
  cancel(runId: string): Promise<boolean>;
  cancelledAmong(runIds: string[]): Promise<string[]>;
}

export interface RunQueueOptions {
  concurrency: number;
  maxAttempts: number;
  execute: JobExecutor;
  now?: () => Date;
  /** When present the queue is durable and shared between replicas. */
  store?: RunQueueStore;
  /** Identifies this process in `run_jobs.claimed_by`. */
  workerId?: string;
  /** How often to poll the store for claimable work. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** How long a claim survives a silent worker. Defaults to 5 minutes. */
  visibilityTimeoutMs?: number;
  /** Called for every emitted event; used to persist or forward progress. */
  onEvent?: (event: RunEvent) => void;
  /** Backoff between attempts; defaults to 250ms * attempt. */
  retryDelayMs?: (attempt: number) => number;
  log?: (message: string) => void;
}

interface PendingJob {
  job: RunJob;
  attempts: number;
}

export class RunQueue {
  private readonly pending: PendingJob[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly events = new EventEmitter();
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly execute: JobExecutor;
  private readonly now: () => Date;
  private readonly onEvent?: (event: RunEvent) => void;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly log: (message: string) => void;
  private readonly store?: RunQueueStore;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly visibilityTimeoutMs: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private completedJobs = 0;
  private startedJobs = 0;

  constructor(options: RunQueueOptions) {
    this.concurrency = Math.max(1, options.concurrency);
    this.maxAttempts = Math.max(1, options.maxAttempts);
    this.execute = options.execute;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => 250 * attempt);
    this.log = options.log ?? (() => undefined);
    this.store = options.store;
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 500);
    this.visibilityTimeoutMs = Math.max(1_000, options.visibilityTimeoutMs ?? 300_000);
    this.events.setMaxListeners(0);

    if (this.store) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
      // Do not hold the process open just for polling.
      this.pollTimer.unref?.();
      void this.poll();
    }
  }

  /** True when work survives this process and is shared with other replicas. */
  public get durable(): boolean {
    return Boolean(this.store);
  }

  /**
   * Claims whatever the store has available and starts it. Also aborts local work that
   * another replica cancelled — that is what makes cancellation work across replicas,
   * since the abort controller only exists in the process running the job.
   */
  private async poll(): Promise<void> {
    if (!this.store || this.polling) return;
    this.polling = true;
    try {
      const free = this.concurrency - this.running.size;
      if (free > 0) {
        const claimed = await this.store.claim({
          workerId: this.workerId,
          limit: free,
          visibilityTimeoutMs: this.visibilityTimeoutMs,
        });
        for (const record of claimed) {
          if (this.running.has(record.runId) || this.pending.some((entry) => entry.job.runId === record.runId)) {
            continue;
          }
          // The store already counted this attempt; drain() adds one.
          this.pending.push({
            job: { runId: record.runId, workspaceId: record.workspaceId },
            attempts: Math.max(0, record.attempts - 1),
          });
        }
        if (claimed.length > 0) await this.drain();
      }

      if (this.running.size > 0) {
        const cancelled = await this.store.cancelledAmong([...this.running.keys()]);
        for (const runId of cancelled) {
          const controller = this.running.get(runId);
          if (controller && !controller.signal.aborted) {
            this.log(`run ${runId} was cancelled by another worker; aborting locally`);
            controller.abort();
          }
        }
      }
    } catch (error) {
      this.log(`queue poll failed: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  public async enqueue(job: RunJob): Promise<void> {
    // Persist before acknowledging: if this throws, the caller releases the run and the
    // client is told the truth instead of waiting for a job that never existed.
    if (this.store) {
      await this.store.enqueue(job);
      this.emit({ runId: job.runId, workspaceId: job.workspaceId, type: "queued" });
      // Claim it here instead of running it as an unclaimed row: a crash mid-run then
      // leaves a `claimed` job that recovers after the visibility timeout, never a
      // `pending` duplicate another replica would start in parallel.
      const claimed = await this.store.claim({
        workerId: this.workerId,
        limit: 1,
        visibilityTimeoutMs: this.visibilityTimeoutMs,
      });
      for (const record of claimed) {
        if (this.pending.some((entry) => entry.job.runId === record.runId) || this.running.has(record.runId)) continue;
        this.pending.push({
          job: { runId: record.runId, workspaceId: record.workspaceId },
          attempts: Math.max(0, record.attempts - 1),
        });
      }
      await this.drain();
      return;
    }

    this.pending.push({ job, attempts: 0 });
    this.emit({ runId: job.runId, workspaceId: job.workspaceId, type: "queued" });
    queueMicrotask(() => void this.drain());
  }

  /** Requests cancellation. Returns false when the run is not queued or running here. */
  public cancel(runId: string): boolean {
    const controller = this.running.get(runId);
    if (controller) {
      controller.abort();
      return true;
    }
    const index = this.pending.findIndex((entry) => entry.job.runId === runId);
    if (index >= 0) {
      const [removed] = this.pending.splice(index, 1);
      void this.store?.cancel(runId).catch((error: unknown) => this.log(`cancel persist failed: ${String(error)}`));
      this.emit({ runId, workspaceId: removed.job.workspaceId, type: "cancelled" });
      return true;
    }
    if (this.store) {
      // Another replica may be running it: mark the job so its poll aborts the work.
      void this.store.cancel(runId).catch((error: unknown) => this.log(`cancel persist failed: ${String(error)}`));
      return true;
    }
    return false;
  }

  public isQueuedOrRunning(runId: string): boolean {
    return this.running.has(runId) || this.pending.some((entry) => entry.job.runId === runId);
  }

  public subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const channel = `run:${runId}`;
    this.events.on(channel, listener);
    return () => this.events.off(channel, listener);
  }

  public get active(): number {
    return this.running.size;
  }

  public get queued(): number {
    return this.pending.length;
  }

  public get stats(): { started: number; completed: number; active: number; queued: number } {
    return {
      started: this.startedJobs,
      completed: this.completedJobs,
      active: this.running.size,
      queued: this.pending.length,
    };
  }

  /** Resolves when nothing is queued or running. Used by tests and shutdown. */
  public async idle(): Promise<void> {
    while (this.pending.length > 0 || this.running.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Aborts everything in flight; used on graceful shutdown. */
  public async shutdown(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const [runId, controller] of this.running) {
      controller.abort();
      this.emit({ runId, workspaceId: "", type: "cancelled", payload: { reason: "server-shutdown" } });
    }
    await this.idle();
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;

    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      const controller = new AbortController();
      this.running.set(entry.job.runId, controller);
      entry.attempts++;
      this.startedJobs++;
      this.emit({
        runId: entry.job.runId,
        workspaceId: entry.job.workspaceId,
        type: "started",
        payload: { attempt: entry.attempts },
      });

      void this.runJob(entry, controller).finally(() => {
        this.running.delete(entry.job.runId);
        this.completedJobs++;
        void this.drain();
      });
    }
  }

  private async runJob(entry: PendingJob, controller: AbortController): Promise<void> {
    const { job } = entry;
    try {
      const outcome = await this.execute(job, {
        signal: controller.signal,
        attempt: entry.attempts,
        report: (progress) =>
          this.emit({
            runId: job.runId,
            workspaceId: job.workspaceId,
            type: "progress",
            payload: { ...progress },
          }),
      });
      this.emit({
        runId: job.runId,
        workspaceId: job.workspaceId,
        type: outcome.status === "cancelled" ? "cancelled" : outcome.status === "failed" ? "error" : "done",
        payload: { status: outcome.status },
      });
      await this.persist(
        job.runId,
        outcome.status === "failed" ? "failed" : outcome.status === "cancelled" ? "cancelled" : "done",
      );
    } catch (error) {
      const retryable = isRetryable(error) && entry.attempts < this.maxAttempts && !controller.signal.aborted;
      this.log(
        `run ${job.runId} attempt ${entry.attempts} failed: ${(error as Error)?.message ?? String(error)}` +
          (retryable ? " (will retry)" : ""),
      );

      if (retryable) {
        this.emit({
          runId: job.runId,
          workspaceId: job.workspaceId,
          type: "warning",
          payload: { message: "Transient failure, retrying.", attempt: entry.attempts },
        });
        const delay = this.retryDelayMs(entry.attempts);
        // Record the retry (and its backoff) before sleeping, so a crash during the
        // wait does not lose the job or make it immediately claimable again.
        await this.store?.retry(job.runId, message(error), delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.pending.unshift(entry);
        return;
      }

      this.emit({
        runId: job.runId,
        workspaceId: job.workspaceId,
        type: "error",
        payload: { message: (error as Error)?.message ?? "Run failed" },
      });
      await this.persist(job.runId, "failed", message(error));
    }
  }

  /** Failures to write the job row must not crash the worker or hide the run status. */
  private async persist(runId: string, outcome: "done" | "failed" | "cancelled", error?: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.finish(runId, outcome, error);
    } catch (persistError) {
      this.log(
        `could not record job ${runId} as ${outcome}: ${(persistError as Error)?.message ?? String(persistError)}`,
      );
    }
  }

  private emit(event: Omit<RunEvent, "at">): void {
    const full: RunEvent = { ...event, at: this.now().toISOString() };
    this.onEvent?.(full);
    this.events.emit(`run:${event.runId}`, full);
  }
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

/** Only infrastructure-ish failures are retried; a data problem will not fix itself. */
function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ER_LOCK_DEADLOCK" || code === "INTERNAL";
}
