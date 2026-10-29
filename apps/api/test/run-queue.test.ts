import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunQueue, type RunEvent } from "../src/jobs/run-queue.js";

const job = (id: string) => ({ runId: id, workspaceId: "ws_test" });

describe("RunQueue", () => {
  it("respects the configured concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const queue = new RunQueue({
      concurrency: 2,
      maxAttempts: 1,
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { status: "completed" };
      },
    });

    for (let index = 0; index < 6; index++) queue.enqueue(job(`run_${index}`));
    await queue.idle();

    assert.equal(peak, 2, "never more than two jobs in flight");
    assert.equal(queue.stats.completed, 6);
  });

  it("retries a transient failure and then succeeds", async () => {
    const attempts: number[] = [];
    const events: RunEvent[] = [];
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 3,
      retryDelayMs: () => 1,
      onEvent: (event) => events.push(event),
      execute: async (_job, context) => {
        attempts.push(context.attempt);
        if (context.attempt < 3) throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
        return { status: "completed" };
      },
    });

    queue.enqueue(job("run_retry"));
    await queue.idle();

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.ok(events.some((event) => event.type === "warning"));
    assert.equal(events.at(-1)?.type, "done");
  });

  it("does not retry a data error", async () => {
    let calls = 0;
    const events: RunEvent[] = [];
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 5,
      retryDelayMs: () => 1,
      onEvent: (event) => events.push(event),
      execute: async () => {
        calls++;
        throw Object.assign(new Error("bad record"), { code: "REQUIRED_FIELD_MISSING" });
      },
    });

    queue.enqueue(job("run_fail"));
    await queue.idle();

    assert.equal(calls, 1, "a malformed record will not fix itself on retry");
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(events.at(-1)?.payload?.message, "bad record");
  });

  it("cancels a queued job before it starts", async () => {
    const started: string[] = [];
    const events: RunEvent[] = [];
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      onEvent: (event) => events.push(event),
      execute: async (entry) => {
        started.push(entry.runId);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: "completed" };
      },
    });

    queue.enqueue(job("run_first"));
    queue.enqueue(job("run_second"));
    assert.equal(queue.cancel("run_second"), true);
    await queue.idle();

    assert.deepEqual(started, ["run_first"]);
    assert.ok(events.some((event) => event.type === "cancelled" && event.runId === "run_second"));
  });

  it("aborts a running job and reports cancellation", async () => {
    const events: RunEvent[] = [];
    let observed = false;
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      onEvent: (event) => events.push(event),
      execute: async (_job, context) => {
        while (!context.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
        observed = true;
        return { status: "cancelled" };
      },
    });

    queue.enqueue(job("run_long"));
    while (queue.active === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(queue.cancel("run_long"), true);
    await queue.idle();

    assert.equal(observed, true);
    assert.equal(events.at(-1)?.type, "cancelled");
  });

  it("reports queued and active counts while draining", async () => {
    const queue = new RunQueue({
      concurrency: 1,
      maxAttempts: 1,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "completed" };
      },
    });

    queue.enqueue(job("run_a"));
    queue.enqueue(job("run_b"));
    // The drain loop starts on a microtask; let it pick up the first job.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(queue.active, 1);
    assert.equal(queue.queued, 1, "b waits behind the concurrency limit");
    await queue.idle();
    assert.equal(queue.queued, 0);
    assert.equal(queue.active, 0);
  });
});
