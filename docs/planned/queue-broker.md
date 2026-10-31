# Broker-backed queue (Redis/BullMQ or similar) — planned, deliberately deferred

**Status:** ⬜ not implemented · **Phase:** C/F · **UI today:** the header shows `queue: process`
in demo mode and `queue: durable` with MySQL; both are labelled truthfully.

## Why it matters

At some throughput the database queue becomes the bottleneck and the database becomes a job
scheduler. A broker adds delayed retries, priorities and backpressure without table contention.

## What exists today (verified)

- `run_jobs` table: enqueue before `202`, atomic claim (`FOR UPDATE SKIP LOCKED`), lease expiry
  and re-claim after a crash, cross-replica cancellation (ADR-0004).
- At-least-once delivery, safe because a transform is a pure function of its inputs.
- `/healthz` exposes `queue.mode`, `active`, `queued` and the configured concurrency/attempts.

## What is missing

- No broker, no dead-letter queue, no scheduled/delayed jobs, no per-tenant fairness.
- No queue metrics beyond depth (no latency percentiles, no retry histogram).

## When to do it (decision criteria)

Move only when one of these is measured, not assumed: sustained claim latency above the poll
interval, `run_jobs` contention blocking OLTP queries, or a need for delayed/prioritised work.

## Proposed design

Keep the `RunQueue` interface. Add `job-store.redis.ts` implementing the same contract, chosen by
`HEALTHBRIDGE_QUEUE_DRIVER`. Keep the database implementation as the zero-dependency default; the
compose demo stays broker-free. Publish depth, claim latency and retry counts on `/healthz`.

## Acceptance criteria

- Both drivers pass the same contract suite (claim, lease expiry, cancellation, idempotency).
- Switching drivers requires no controller, service or UI change.
- A broker outage degrades to `503` with a clear code, never to lost work.
- `/healthz` reports the driver and its depth; the console badge follows it.

## Risks / non-goals

- Two storage systems means two failure modes and two backup stories; do not add one without the
  measured need above.
- No exactly-once semantics are promised, and none are needed.
