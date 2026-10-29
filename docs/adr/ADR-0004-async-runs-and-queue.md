# ADR-0004: Async runs with a durable, database-backed queue

- **Status:** accepted (Phase C), revised 2026-10-29 — the in-process queue was replaced by
  a durable `run_jobs` table in database mode
- **Date:** 2026-10-29
- **Context:** The API must survive multi-minute transforms without holding an HTTP
  connection, and must report honest progress. The first version used an in-process queue,
  which meant a restart silently dropped queued work and only one replica could exist. A
  broker (Redis/BullMQ) would fix that but adds a second stateful service to keep alive,
  back up and monitor — for a deployment that already has MySQL.

## Decision

1. `POST /api/v1/runs` is **asynchronous**: it writes a run row, persists a job and
   returns `202` with a run resource. Clients poll `GET /runs/:id` or subscribe to
   `GET /runs/:id/events` (SSE).
2. The queue is **a table**, `run_jobs`, when a database is configured; demo mode keeps the
   in-process queue so the API still runs with no infrastructure. One engine
   (`apps/api/src/jobs/run-queue.ts`) drives both.
3. States are `pending → claimed → done | failed | cancelled`. `available_at` carries retry
   backoff, `claimed_at` the lease. Claiming is `SELECT … FOR UPDATE SKIP LOCKED` in a
   transaction, so replicas cannot take the same job.
4. Delivery is **at-least-once**. A worker that dies mid-run leaves a `claimed` row; once the
   lease exceeds `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` the next claim takes it over.
5. The run row is written **before** the job, and the job is persisted **before** the API
   answers `202`. If the job write fails the run is marked failed, the Idempotency-Key is
   released and the client gets `503 QUEUE_UNAVAILABLE`.
6. The API contract does not leak the queue implementation: no endpoint returns a job id,
   and clients never choose a queue priority.

## Consequences

**Good**

- Work survives restarts: a queued run is picked up by the next process (proved by the
  database-mode smoke, which stops the API, seeds a run and waits for completion).
- Several API replicas can run against one database without duplicating work.
- Cancellation crosses replicas: the receiving replica marks the job `cancelled`, and the
  replica executing it aborts at the next stage boundary.
- No new service: `docker compose up` still starts mysql + api + web.
- Re-running a job is safe because a transform is a pure function of (asset bytes, mapping
  version, options, `importedAt`) — at-least-once cannot produce a different result.

**Bad / accepted**

- At-least-once means a crashed worker's job can run twice; the second run overwrites the
  same row with the same checksums.
- SSE progress is **per replica**: a client connected to replica A does not see events
  emitted by replica B. The stream opens with a `snapshot` and `/runs/:id` is authoritative,
  so polling is always correct.
- Polling costs a query per interval per replica (`HEALTHBRIDGE_QUEUE_POLL_MS`, default
  500 ms). Fine at this scale; a broker would be the answer at high fan-out.
- `SKIP LOCKED` pins the schema to MySQL 8.0+. The server version is checked at boot and
  older versions or MariaDB are refused with the reason instead of failing mid-migration.

## Alternatives considered

- **BullMQ + Redis.** Real features (delayed jobs, priorities, a dashboard), but a second
  stateful service for a guarantee MySQL already provides here. Recorded as the option to
  revisit if queue fan-out or multi-tenant fairness becomes a problem.
- **Synchronous transform in the request.** A 10-minute import behind a reverse proxy
  returns 504 with no record of what happened.
- **Status-column polling without a job table** (`SELECT … WHERE status='queued'`). Simpler,
  but it conflates "the run is queued" with "someone is working on it", gives no place to
  record attempts, backoff or lease ownership, and would re-run a job forever after a crash
  loop.
