# HealthBridge API (v1)

REST API over the same transformation engine the CLI and SDK use. It does not
re-implement any transformation logic: a run executes `@healthbridge/sdk`
against bytes in object storage, and every number it reports comes from the
engine's own `TransformationResult`.

Base path: `/api/v1` · Content type: `application/json` (uploads are raw bytes)

- [Running it](#running-it)
- [Authentication](#authentication)
- [Errors](#errors)
- [Endpoints](#endpoints)
- [Run lifecycle](#run-lifecycle)
- [What this API does *not* do](#what-this-api-does-not-do)

## Running it

```bash
# demo: in-memory persistence, in-memory objects, token printed at startup
npm run build && node apps/api/dist/main.js

# durable: MySQL for metadata, disk for objects
export DATABASE_URL=mysql://healthbridge:secret@127.0.0.1:3306/healthbridge
export HEALTHBRIDGE_KEY_PEPPER=$(openssl rand -base64 24)
export HEALTHBRIDGE_BOOTSTRAP_TOKEN=$(openssl rand -base64 24)
node apps/api/dist/main.js
```

Startup is fail-fast. These conditions refuse to start rather than degrade:

| Condition | Why |
| --- | --- |
| `NODE_ENV=production` without `DATABASE_URL` | in-memory mode loses data on restart |
| `DATABASE_URL` without `HEALTHBRIDGE_KEY_PEPPER` | keys would be stored with a predictable hash |
| `HEALTHBRIDGE_KEY_PEPPER` shorter than 16 chars | guessable |
| `DATABASE_URL` without `HEALTHBRIDGE_BOOTSTRAP_TOKEN` | nobody could create the first workspace |
| MySQL unreachable at boot | serving from an empty fallback would look like data loss |

`GET /healthz` reports `mode`, `persistence` and `queue`, so an operator can see which
mode is live without reading the config. It is also the **limits discovery** endpoint: a
client must read upload/body limits, rate limits, supported formats and execution limits
from here instead of hardcoding them.

```json
{
  "status": "ok",
  "mode": "database",
  "nodeEnv": "production",
  "persistence": "mysql",
  "storage": "local-fs",
  "queue": { "mode": "durable", "active": 0, "queued": 0 },
  "limits": {
    "maxUploadBytes": 67108864,
    "maxRequestBodyBytes": 1048576,
    "maxStoredResultBytes": 5242880,
    "maxTracesPerRun": 5000,
    "maxPreviewRecords": 25,
    "maxPreviewBytes": 524288,
    "maxPreviewInputBytes": 8388608,
    "rateLimit": { "burst": 120, "refillPerSecond": 20 },
    "queue": { "concurrency": 2, "maxAttempts": 2 }
  },
  "startedAt": "2026-01-01T00:00:00.000Z",
  "uptimeSeconds": 42
}
```

The supported upload formats are served by `GET /formats` (adapter capabilities), not
duplicated in `/healthz`.

An upload over `maxUploadBytes` returns `413` with code `PAYLOAD_TOO_LARGE`; a JSON body
over `maxRequestBodyBytes` returns `413` with the same code; malformed JSON returns `400`
`INVALID_JSON`. Both include a `requestId` for correlation.

The preview limits follow the same rule. `maxPreviewRecords` caps a preview at 25 records by
default and is clamped at 100 at load, so the reported value is the real maximum. A preview
reads an asset no larger than `maxPreviewInputBytes`; a larger asset returns `413`
`PAYLOAD_TOO_LARGE`. `maxPreviewBytes` is the byte budget of the preview response: detail is
dropped in order (sample, rejected records, coverage detail, issues) and listed in `omitted`.

Download responses carry `x-checksum` (the content-addressed SHA-256) and `x-request-id`.
Both are exposed via `access-control-expose-headers` for cross-origin callers, and
`/api/*` responses are `cache-control: no-store`.

## Authentication

Every request except `/healthz`, `/version`, `/formats` and `POST /workspaces`
needs an API key:

```
x-api-key: hb_<prefix>_<secret>
```

Keys are stored as an HMAC of the secret keyed with a server-side pepper. The
plaintext is shown **once**, at creation or rotation. `GET /keys` returns
prefixes and metadata, never the secret.

### Bootstrapping

`POST /api/v1/workspaces` requires the operator-held bootstrap token:

```
x-bootstrap-token: <HEALTHBRIDGE_BOOTSTRAP_TOKEN>
```

It returns the workspace and its owner key. The bootstrap token is
platform-level: it cannot read tenant data, and it is the only way to add a
workspace. Rotate it after setup.

The token must be at least 16 characters; the API refuses to start with a
shorter one. Attempts are rate limited per client IP by a fixed 15-minute
window (`HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT`, default 10); failed attempts count
too, and exhaustion returns `429 RATE_LIMITED` with a `retry-after` header.
The limiter is in-process, so a multi-replica deployment needs network-layer
protection as well. Do not expose workspace creation to the public internet.

### Roles and scopes

| Role | Scopes |
| --- | --- |
| `owner` | everything, including `workspaces:admin` (keys, audit) |
| `editor` | `assets:*`, `mappings:*`, `pipelines:*`, `runs:*` |
| `viewer` | `*:read` only |
| `service` | `runs:*`, `assets:*` — machine accounts, no catalogue or audit access |

Missing scope → `403 FORBIDDEN` with `details.requiredScope`, so a client can
tell "wrong key" from "wrong role".

Tenant isolation is enforced in the repository layer: every query takes a
`workspaceId`, and a record from another workspace is reported as `404 NOT_FOUND`
— not `403` — so identifiers cannot be probed.

## Errors

All failures use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "'assetId' is required and must be a non-empty string.",
    "requestId": "6f1c…",
    "details": { "...": "optional" }
  },
  "statusCode": 400
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | no key supplied |
| `MALFORMED_KEY` | 400 | key is not in `hb_…` format |
| `REVOKED_KEY` / `EXPIRED_KEY` | 401 | key is no longer usable |
| `FORBIDDEN` | 403 | key lacks the required scope |
| `RATE_LIMITED` | 429 | token bucket empty (`retry-after` set) |
| `NOT_FOUND` | 404 | not present **in this workspace** |
| `CONFLICT` | 409 | e.g. duplicate mapping version |
| `DRAFT_CONFLICT` | 409 | the supplied draft revision is stale (another save/delete/publish changed it); `details.currentRevision` carries the current revision |
| `IDEMPOTENCY_CONFLICT` | 422 | same `Idempotency-Key`, different payload |
| `MAPPING_VALIDATION_FAILED` | 422 | the spec (or a diff side) is structurally invalid; `details.issues` lists the problems and, for diff, `details.side` names the offending side |
| `VALIDATION_FAILED` | 400 | bad body or parameter |
| `INVALID_JSON` | 400 | body is not JSON |
| `PAYLOAD_TOO_LARGE` | 413 | upload or body over the limit |
| `RUN_NOT_CANCELLABLE` | 409 | run already finished |
| `QUEUE_UNAVAILABLE` | 503 | the run was recorded but could not be scheduled; retry with the same `Idempotency-Key` |
| `INTERNAL` | 500 | unexpected; quote `requestId` |

Internal messages (SQL, filesystem paths, stacks) are logged with the request id
and never returned.

## Endpoints

### Health and metadata

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/healthz` | public | liveness, mode, queue depth |
| GET | `/version` | public | engine, trace protocol, persistence |
| GET | `/formats` | public | adapter capability manifest |

### Workspaces and keys

| Method | Path | Scope |
| --- | --- | --- |
| POST | `/workspaces` | bootstrap token |
| GET | `/workspaces/current` | `runs:read` |
| DELETE | `/workspaces/current` | `workspaces:admin` |
| POST | `/keys` | `workspaces:admin` |
| GET | `/keys` | `workspaces:admin` |
| DELETE | `/keys/:id` | `workspaces:admin` |
| POST | `/keys/:id/rotate` | `workspaces:admin` |

```bash
curl -s localhost:3000/api/v1/workspaces \
  -H 'x-bootstrap-token: demo-bootstrap-token' \
  -H 'content-type: application/json' \
  -d '{"name":"Demo Clinic","slug":"demo-clinic"}'
```

### Assets

| Method | Path | Scope |
| --- | --- | --- |
| POST | `/assets?filename=patients.csv` | `assets:write` |
| GET | `/assets` | `assets:read` |
| GET | `/assets/:id` | `assets:read` |
| DELETE | `/assets/:id` | `assets:write` |
| GET | `/assets/:id/content` | `assets:read` |

Uploads are **raw bytes**, not multipart:

```bash
curl -s -X POST "localhost:3000/api/v1/assets?filename=patients.csv" \
  -H "x-api-key: $KEY" -H 'content-type: text/csv' \
  --data-binary @scenarios/01-hospital-patient-migration/data/patients.csv
```

The response includes `checksum` (`sha256:…`) and the detected `sourceFormat` /
`domain`. Objects are content-addressed, so re-uploading identical bytes stores
one object; the `metadata` row is what is tenant-scoped.

`GET /assets/:id/content` returns the exact bytes with `x-checksum` and `etag`.

### Mappings and pipelines

| Method | Path | Scope |
| --- | --- | --- |
| POST | `/mappings` | `mappings:write` |
| GET | `/mappings` | `mappings:read` |
| GET | `/mappings/:id` | `mappings:read` |
| GET | `/mappings/:name/versions` | `mappings:read` |
| POST | `/mappings/preview` | `mappings:write` + `assets:read` |
| GET | `/mappings/:name/draft` | `mappings:read` |
| PUT | `/mappings/:name/draft` | `mappings:write` |
| DELETE | `/mappings/:name/draft?revision=` | `mappings:write` |
| POST | `/mappings/:name/publish` | `mappings:write` |
| GET | `/mappings/:name/diff?from=&to=` | `mappings:read` |
| POST | `/pipelines` | `pipelines:write` |
| GET | `/pipelines` | `pipelines:read` |
| GET | `/pipelines/:id` | `pipelines:read` |

Posting an existing mapping `name` creates the next version. Versions are
immutable and a run references a mapping **id**, so editing a mapping cannot
silently change what an old run did.

#### Drafts, preview and publish

The Studio editor works on a server-side **draft** of a mapping, one per workspace and mapping
`name`. A draft is not a version: runs cannot reference it until it is published.

- `GET /mappings/:name/draft` returns `{ draft, latest, validation }`. `draft` is `null` when no
  draft exists, and `latest` is the newest published version (or `null`).
- `PUT /mappings/:name/draft` takes `{ spec, revision, baseVersion? }`. `revision` must equal the
  draft's current revision (`0` when there is no draft yet), otherwise the call fails with
  `409 DRAFT_CONFLICT`. A save that does not change the spec returns the current draft without a
  new revision or audit event. Invalid specs are stored on purpose so autosave survives
  mid-edit; the response's `validation` lists what is still wrong.
- `DELETE /mappings/:name/draft` returns `204`. With `?revision=` it fails with
  `409 DRAFT_CONFLICT` when the stored revision differs, and it succeeds when there is no draft.
- `POST /mappings/:name/publish` takes `{ revision }` and returns
  `{ mapping, created, validation, draftRetained? }`. A stale `revision` fails with
  `409 DRAFT_CONFLICT`, and an invalid draft fails with `MAPPING_VALIDATION_FAILED`. When the
  latest version already has the draft's spec, nothing new is created and `created` is `false`.
  The draft is deleted on success; `draftRetained: true` means that delete failed.
- `POST /mappings/preview` takes `{ spec, assetId, maxRecords?, adapterId? }` and dry-runs the
  spec against a stored asset. It requires **both** `mappings:write` and `assets:read`; a key
  without `assets:read` returns `403 FORBIDDEN` with `details.requiredScopes`. `maxRecords`
  defaults to `maxPreviewRecords` and is capped at 100. The response is
  `{ validation, preview }`: the outer `validation` is the structural result and `preview`
  reports `adapter` (`id`, `version`, `format`), `recordsProcessed`, `recordsSucceeded`,
  `recordsRejected`, `coverage`, `validation`, `issues` (max 200), `rejected` (max 10;
  `partialOutput` stripped), `sample` (max 10 target resources), `durationMs`, `truncated`,
  `omitted` (dropped labels such as `sample`, `rejected`, `coverage.detail` and `issues`) and
  `bytes`. A preview is dry-run only: it creates no run and no mapping version. The audit event
  records identifiers and counts (asset, adapter, `maxRecords`, rule count, processed/failed
  counts, bytes, `truncated`) — never specs, samples or record values.
  Without `adapterId`, the adapter id stored in the asset's metadata is used if that adapter is
  still registered. Otherwise the adapter is detected from the asset's content. Two failures
  return `400 VALIDATION_FAILED`, told apart by `error.details.reason`: `UNKNOWN_ADAPTER` (the
  `adapterId` you sent is not registered; `details.adapterId` echoes it) and
  `NO_COMPATIBLE_ADAPTER` (no registered adapter fits the asset).
- `GET /mappings/:name/diff` compares two specs. `from` defaults to `latest` and `to` defaults
  to `draft`.

### Runs

| Method | Path | Scope |
| --- | --- | --- |
| POST | `/runs` | `runs:write` |
| GET | `/runs?status=&limit=&cursor=` | `runs:read` |
| GET | `/runs/:id` | `runs:read` |
| DELETE | `/runs/:id` | `runs:write` |
| GET | `/runs/:id/resources` | `runs:read` |
| GET | `/runs/:id/issues` | `runs:read` |
| GET | `/runs/:id/traces` | `runs:read` |
| GET | `/runs/:id/bundle` | `runs:read` |
| GET | `/runs/:id/events` | `runs:read` (SSE) |
| POST | `/runs/:id/cancel` | `runs:write` |
| POST | `/runs/:id/pause` | `runs:write` |
| POST | `/runs/:id/resume` | `runs:write` |
| POST | `/runs/:id/replay` | `runs:write` |

```bash
curl -s -X POST localhost:3000/api/v1/runs \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: nightly-2024-05-01' \
  -d '{"assetId":"as_…","mappingId":"mp_…"}'
```

Allowed `options`: `maxRecords`, `importedAt` (ISO-8601, the reproducibility
anchor), `adapterId`, `pipelineVersion`. Anything else is rejected with
`VALIDATION_FAILED` rather than silently ignored.

### Audit

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/audit` | `audit:read` (owner) |

Append-only, tenant-scoped. Records workspace creation, key issue/rotate/revoke,
asset upload and deletion, mapping and pipeline creation, run creation, cancellation,
deletion and replay, and retention sweeps. An audit write failure is logged, never
allowed to break the request. Workspace deletion requests and purges are additionally
written to a platform audit that survives the workspace it describes.

## Deletion and retention

Three delete routes, all hard deletes. Every one writes an audit event.

- `DELETE /assets/:id` (`assets:write`) deletes the asset metadata row. It is refused
  with `409 CONFLICT` while any run in the workspace references the asset — delete or
  retain those runs first. The content-addressed object is removed only when no asset
  in **any** workspace references the same bytes; `blobDeleted` reports the outcome, so
  one tenant deleting an upload never blanks another tenant's identical file.
- `DELETE /runs/:id` (`runs:write`) deletes a terminal run (`completed`,
  `completed_with_warnings`, `failed`, `cancelled`) with its traces, resource-index rows
  and queued job. A live run returns `409 RUN_NOT_TERMINAL`; cancel it first. The
  idempotency keys that created the run are freed (`idempotencyKeysFreed`), so the same
  key can create a new run afterwards.
- `DELETE /workspaces/current` (`workspaces:admin`, owner) requires
  `{"confirm":"<workspace-slug>"}`. A wrong slug returns `400 VALIDATION_FAILED` and
  changes nothing. On success the workspace is soft-deleted, every key in it revoked,
  and a hard purge scheduled after `HEALTHBRIDGE_WORKSPACE_GRACE_DAYS`. Data is retained
  during the grace period so an operator can intervene. The purge removes the workspace
  and every tenant row — including the tenant audit trail — and keeps a
  `workspace.purged` record in the platform audit.

### Retention sweep

The API runs a retention sweep every `HEALTHBRIDGE_RETENTION_SWEEP_MS` (default hourly;
`0` disables the timer and leaves retention manual). Each workspace is swept when its
`retentionDays` is greater than `0` (default `90`; `0` keeps everything):

1. terminal runs whose finish time (or creation time) is older than the cutoff are
   deleted in bounded batches; traces and index rows cascade and idempotency keys are
   freed;
2. assets created before the cutoff with no remaining run reference are deleted, and
   their object is removed when no other workspace references it.

Assets still feeding a retained run are skipped, so provenance is never blanked. Each
sweep writes one `retention.swept` audit event per workspace that lost data. The sweep is
idempotent — running it twice deletes nothing the second time — and a failure in one
workspace is logged and skipped without aborting the others.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEALTHBRIDGE_RETENTION_SWEEP_MS` | `3600000` | Sweep interval in ms; `0` disables the timer |
| `HEALTHBRIDGE_WORKSPACE_GRACE_DAYS` | `7` | Days between a deletion request and the hard purge |

## Run lifecycle

```
POST /runs ──► queued ──► running ──► completed | completed_with_warnings
   │                        │        └► failed
   │                        └──────────► cancelling ──► cancelled
   └────────────────────────────────────► cancelled (cancelled while queued)
```

- `POST /runs` returns `202` with the run resource. The row is written **before**
  the job, and the job is persisted **before** the response, so `202` always means
  "a job exists". In database mode the job lives in `run_jobs` and survives a restart:
  the next process picks it up (proved by the database-mode smoke test).
- Delivery is **at-least-once**. A worker that dies mid-run leaves a lease that expires
  after `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` (default 5 minutes) and the job is re-claimed.
  Re-running is safe: the output is a pure function of the asset bytes, mapping version,
  options and `importedAt`, so the checksums repeat.
- `Idempotency-Key` is scoped per workspace. Same key + same request → the same
  run (`created: false`). Same key + different request → `422`.
  The key index stores the request as submitted (`assetId`, mapping reference,
  `pipelineId`, options), so a retry is recognised **even after the asset or mapping
  has been deleted**; a retry that swaps `mappingName` for the equivalent `mappingId`
  still matches, because the resolved payload is compared as a fallback. A key becomes
  reusable once its run leaves the retention window or its scheduling failed.
- Cancellation works **across replicas**: the job is marked `cancelled` in the database and
  whichever replica is executing it aborts at the next stage boundary. It is
  **cooperative**: the engine checks the abort signal at stage
  boundaries, so an in-flight record finishes before the run stops. A run that
  already finished returns `409 RUN_NOT_CANCELLABLE`; if the row changes or disappears
  between the read and the write, the call returns `409 CONFLICT` / `404 NOT_FOUND`
  instead of a stale success.

If the worker queue refuses the job, the run is **not** left claiming `queued`: it is
recorded as `failed` with `error.code = "QUEUE_UNAVAILABLE"`, the Idempotency-Key is
released (nothing executed) and the call returns `503`. Retrying the same request with the
same key then creates a fresh run instead of returning a ghost.
- `replay` creates a *new* run with the same asset, mapping and options.
- Output larger than `HEALTHBRIDGE_MAX_STORED_RESULT_BYTES` is not stored;
  `/resources` then returns `omitted: true` and the summary keeps the checksums
  and counts. This is reported, not hidden.
- Traces are stored up to `HEALTHBRIDGE_MAX_TRACES_PER_RUN`. Trace payloads use
  the structural-by-default redaction policy from ADR-0003 (protocol v1.2).

### Queue configuration (database mode)

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEALTHBRIDGE_QUEUE_CONCURRENCY` | `2` | Jobs this replica runs at once |
| `HEALTHBRIDGE_QUEUE_POLL_MS` | `500` | How often a replica looks for claimable work |
| `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` | `300000` | Lease length; an expired lease is re-claimable |
| `HEALTHBRIDGE_QUEUE_MAX_ATTEMPTS` | `2` | Attempts before a job is marked failed |

`GET /healthz` reports `queue.mode`: `durable` when jobs live in MySQL, `process` when they
live only in this process (demo mode).

### Live updates (SSE)

```
GET /api/v1/runs/:id/events
Accept: text/event-stream
```

Event types: `snapshot` (current run, always first), `queued`, `started`,
`progress` (`stage`, `stepName`, `percent`), `warning`, `done`, `error`,
`cancelled`, and `ping` heartbeats. A terminal event is always sent — including
to a client that subscribes after the run finished — so clients can rely on
`snapshot → … → terminal` and close the connection.

Fine-grained per-record progress is not streamed yet: the engine reports stage
boundaries, and the trace stream is available after the run. That limitation is
real and listed in the capability matrix.

## What this API does *not* do

Stated here rather than discovered in an incident:

- **Queue durability depends on the mode.** In database mode the queue is the
  `run_jobs` table: jobs survive a restart, leases expire and are recovered, and
  several replicas can claim from the same table without duplicating work (ADR-0004).
  In demo mode (no `DATABASE_URL`) the queue is in-process, so jobs are lost on restart
  and are not shared between replicas. A Redis/BullMQ driver exists as an opt-in
  (`HEALTHBRIDGE_REDIS_URL`/`REDIS_URL` selects it; unreachable Redis fails fast at
  boot, never silently falls back); the MySQL `run_jobs` table remains the default (ADR-0004).
- **No streaming uploads.** A body is buffered up to
  `HEALTHBRIDGE_MAX_UPLOAD_BYTES` before it is hashed and stored.
- **The machine contract is [docs/openapi.json](openapi.json)** (OpenAPI 3.1),
  generated from the controllers by `apps/api/src/generate-openapi.ts`
  (`npx tsx apps/api/src/generate-openapi.ts --check` fails on drift, and CI
  runs that check). This file keeps the narrative; the JSON file is the
  contract clients code against. The document is not served over HTTP.
- **Cancellation cannot interrupt a single record.** It stops at stage
  boundaries only.
- **No PHI redaction of stored output.** The engine redacts trace payloads, but
  resources are stored as produced — encryption at rest is a deployment
  responsibility (documented in SECURITY.md).
- **MySQL is verified against live MySQL 8.0 and 8.4 servers, but not in the default
  `npm test` run.** Migrations at boot, tenant scoping, unique-key races, the
  idempotency index, keyset pagination and audit storage are covered by
  `packages/persistence/test/mysql.integration.test.ts` (needs
  `HEALTHBRIDGE_TEST_MYSQL_URL`; CI runs it against a matrix of `mysql:8.0` and
  `mysql:8.4` services) and by the full API smoke in database mode:

  ```bash
  docker run -d --name hb-mysql -e MYSQL_ROOT_PASSWORD=root \
    -e MYSQL_DATABASE=healthbridge -p 33061:3306 mysql:8.4
  npm run build
  SMOKE_MODE=mysql SMOKE_DATABASE_URL=mysql://root:root@127.0.0.1:33061/healthbridge \
    bash scripts/smoke-api.sh
  ```

  `/healthz` reports `mode: "database"`, `persistence: "mysql"` and `queue.mode:
  "durable"` when the database path is active — check it before sending traffic. The MySQL driver (`mysql2`) is a
  declared dependency; without it the process refuses to start in database mode
  instead of silently falling back to memory.
