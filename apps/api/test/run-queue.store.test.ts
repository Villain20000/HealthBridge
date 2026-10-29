import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunQueue, type RunEvent, type RunQueueStore } from "../src/jobs/run-queue.js";

/**
 * The durable mode of the queue, exercised through a fake store.
 *
 * These assert the contract the API relies on: enqueue is persisted before it returns,
 * work that was already waiting in the store at boot is picked up, retries record their
 * backoff, and a cancellation issued by another replica aborts the work here.
 */

interface StoredJob {
  runId: string;
  workspaceId: string;
  status: "pending" | "claimed" | "done" | "failed" | "cancelled";
  attempts: number;
  availableAt: number;
  claimedBy?: string;
  claimedAt?: number;
  lastError?: string;
}

class FakeStore implements RunQueueStore {
  public readonly jobs = new Map<string, StoredJob>();
  public readonly calls: string[] = [];
  public claimCalls = 0;

  public async enqueue(job: { runId: string; workspaceId: string }): Promise<void> {
    this.calls.push(`enqueue:${job.runId}`);
    if (this.jobs.has(job.runId)) return;
    this.jobs.set(job.runId, {
      runId: job.runId,
      workspaceId: job.workspaceId,
      status: "pending",
      attempts: 0,
      availableAt: 0,
    });
  }

  public async claim(options: { workerId: string; limit: number; visibilityTimeoutMs: number }) {
    this.claimCalls++;
    const now = Date.now();
    const claimed: Array<{ runId: string; workspaceId: string; attempts: number }> = [];
    for (const job of this.jobs.values()) {
      if (claimed.length >= options.limit) break;
      if (job.availableAt > now) continue;
      const takeable =
        job.status === "pending" ||
        (job.status === "claimed" && (job.claimedAt ?? 0) < now - options.visibilityTimeoutMs);
      if (!takeable) continue;
      job.status = "claimed";
      job.claimedBy = options.workerId;
      job.claimedAt = now;
      job.attempts += 1;
      claimed.push({ runId: job.runId, workspaceId: job.workspaceId, attempts: job.attempts });
    }
    return claimed;
  }

  public async finish(runId: string, outcome: "done" | "failed" | "cancelled", error?: string): Promise<void> {
    this.calls.push(`finish:${runId}:${outcome}`);
    const job = this.jobs.get(runId);
    if (job) {
      job.status = outcome;
      job.lastError = error;
    }
  }

  public async retry(runId: string, error: string, delayMs: number): Promise<void> {
    this.calls.push(`retry:${runId}:${delayMs}`);
    const job = this.jobs.get(runId);
    if (job) {
      job.status = "pending";
      job.lastError = error;
      job.availableAt = Date.now() + delayMs;
      job.claimedBy = undefined;
    }
  }

  public async cancel(runId: string): Promise<boolean> {
    this.calls.push(`cancel:${runId}`);
    const job = this.jobs.get(runId);
    if (!job || (job.status !== "pending" && job.status !== "claimed")) return false;
    job.status = "cancelled";
    return true;
  }

  public async cancelledAmong(runIds: string[]): Promise<string[]> {
    return runIds.filter((runId) => this.jobs.get(runId)?.status === "cancelled");
  }
}

const job = (runId: string) => ({ runId, workspaceId: "ws_1" });

describe("RunQueue with a durable store", () => {
  it("should persist a job before reporting it as queued", async () => {
    const store = new FakeStore();
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

    assert.ok(store.calls.includes("enqueue:run_a"), "the job is written before enqueue resolves");
    await queue.idle();
    assert.deepEqual(
      order.filter((entry) => entry.startsWith("event:")),
      ["event:queued", "event:started", "event:done"],
    );
    assert.equal(store.jobs.get("run_a")?.status, "done");
    await queue.shutdown();
  });

  it("should reject the enqueue when the store refuses the write", async () => {
    const store = new FakeStore();
    store.enqueue = async () => {
      throw Object.assign(new Error("store down"), { code: "ER_CON_COUNT_ERROR" });
    };
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 10_000,
      execute: async () => ({ status: "completed" }),
    });

    await assert.rejects(() => queue.enqueue(job("run_b")), /store down/);
    assert.equal(queue.queued, 0, "nothing is left half-queued in this process");
    await queue.shutdown();
  });

  it("should pick up work that was already waiting in the store — the restart case", async () => {
    const store = new FakeStore();
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
    assert.equal(store.jobs.get("run_before_restart")?.status, "done");
    await queue.shutdown();
  });

  it("should record a retry with its backoff before waiting", async () => {
    const store = new FakeStore();
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

    await queue.enqueue(job("run_retry"));
    await queue.idle();

    assert.ok(
      store.calls.some((call) => call.startsWith("retry:run_retry:")),
      store.calls.join(","),
    );
    assert.equal(store.jobs.get("run_retry")?.status, "done");
    assert.equal(attempts, 2);
    await queue.shutdown();
  });

  it("should mark the job cancelled when another replica cancelled it mid-run", async () => {
    const store = new FakeStore();
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

    assert.equal(store.jobs.get("run_cross_cancel")?.status, "cancelled");
    await queue.shutdown();
  });

  it("should stop claiming once shut down", async () => {
    const store = new FakeStore();
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      store,
      pollIntervalMs: 5,
      execute: async () => ({ status: "completed" }),
    });

    await queue.shutdown();
    const after = store.claimCalls;
    await store.enqueue(job("run_after_shutdown"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(store.claimCalls, after, "no polling after shutdown");
    assert.equal(store.jobs.get("run_after_shutdown")?.status, "pending", "the job waits for the next process");
  });
});
