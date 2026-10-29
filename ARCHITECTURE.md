# HealthBridge OS — Architecture

**Engine version:** 3.2.0 · **Trace protocol:** 1.2 · **API:** v1 · Reflects the code as it exists today, not the target state. Target state lives in `ROADMAP.md`.

## 1. Principle

Universal input, explicit capabilities, no silent data loss. A format is only described as supported up to the level its adapter and tests demonstrate. FHIR is an output format, not the internal data model.

## 2. Package graph

```text
shared-types            contracts: envelope, capabilities, issues, traces, coverage, data loss
  └─ trace-protocol     TraceCollector, redaction policy, report export
       └─ core          adapter registry (scored detection), checksum, sensitivity policy, path utils
            ├─ adapters           csv | json | fhir-r4-json  (one file per family)
            ├─ mapping-engine     rules, transforms, coverage, static validation
            └─ transformation-engine  detect → parse → map → report (uses adapters + mapping-engine)
                 └─ sdk        @healthbridge/sdk (offline facade + run store + replay)
                      ├─ cli   @healthbridge/cli
                      └─ api   @healthbridge/api (NestJS)
                            ├─ auth         API keys, scopes, roles, rate limiting
                            ├─ storage      content-addressed objects (local fs | memory)
                            └─ persistence  workspace-scoped repositories (memory | MySQL + migrations)
```

`mapping-engine` imports only `shared-types`, so the rule engine can be reused without the adapter layer.

## 3. Data flow

```text
input (path | buffer | string)
  → AdapterRegistry.detect()            scored candidates
  → adapter.parse(ctx)                  AsyncIterable<MedicalDataEnvelope>
      envelope: domain, source{format,checksum,encoding}, content, metadata,
                provenance{adapterId,version,recordIndex,sourceLocation},
                classification{sensitivity,reason}, parseIssues
  → MappingEngine.execute(source, mapping)
      targetData (array-aware paths), issues, coverage(leaves, mapped/rejected),
      ruleResults(status per rule)
  → TransformationPipeline
      aggregate coverage across records, rejectedRecords, dataLoss,
      duplicate-id + domain-mismatch + low-coverage warnings,
      TraceCollector events per stage
  → TransformationResult
```

## 4. Canonical envelope

Unchanged in spirit from the specification: `structured` payloads carry `data`; binary and document assets are referenced by URI (`binary-reference`, `document-reference`) so large files never enter MySQL. Every envelope carries a SHA-256 of the originating asset, the physical source location (`line 12`, `$[3]`), the encoding, and any parse issues.

Sensitivity is **policy-driven** (`classifySensitivity` + `SensitivityRule[]`); the default is conservative (`sensitive`, reason `default-conservative-healthcare-policy`), never inferred from the file extension.

## 5. Mapping engine

Declarative rules only. Thirteen deterministic transforms; unknown transform kinds are a hard error (`assertNever`). Conditions gate rules. Failures reject the *value* (and the record when `required`) instead of writing a wrong type. Coverage is computed on source **leaf paths**.

## 6. Trace protocol v1.2

Stages: `detect`, `adapter-selection`, `parse`, `mapping`, `export` (with `build` and `validate` reserved for the target-builder and validation work). Each event: run/correlation id, span id, stage, adapter and pipeline versions, record index/id/source path, duration, issues, status, and `redactionState`. Snippets are redacted by default (`docs/adr/ADR-0003-trace-redaction-policy.md`).

## 7. Error and issue model

`ValidationIssue { code, severity, message, path, location, ruleId, recordIndex, advice }` with stable codes: `MAPPING_*`, `CSV_STRUCTURE_WARNING`, `RAGGED_ROW`, `MALFORMED_JSON`, `MALFORMED_NDJSON_LINE`, `MISSING_REQUIRED_FIELD`, `INVALID_DATE_FORMAT`, `AMBIGUOUS_DATE_FORMAT`, `INVALID_NUMBER`, `GENDER_CODE_UNMAPPED`, `DOMAIN_MISMATCH`, `LOW_MAPPING_COVERAGE`, `DUPLICATE_RESOURCE_ID`, `NO_COMPATIBLE_ADAPTER`, `UNKNOWN_ADAPTER`, `ADAPTER_PARSE_ERROR`.

Statuses: `completed`, `completed_with_warnings`, `failed`. CLI exit codes are separate and documented in `docs/cli.md`.

## 8. Storage strategy

MySQL for relational metadata, object storage for binaries, and — in database mode — a
durable job queue that is itself a MySQL table (ADR-0004). Demo mode keeps an in-process
queue so the API still runs with no infrastructure.

```
POST /assets        raw bytes → SHA-256 → object store (content-addressed) → asset row
POST /runs          run row (queued) → run_jobs row → claim → 202
worker              load asset bytes + mapping version → SDK transform → persist
                    status, counts, checksums, coverage, validation, summary, traces
GET  /runs/:id      run row; /resources serves the stored output (or reports omission)
```

### Queue

`run_jobs` holds one row per scheduled run: `pending` → `claimed` → `done | failed | cancelled`,
with `available_at` carrying retry backoff and `claimed_at` the lease.

- **Enqueue persists before the API answers 202.** If the insert fails the run is marked
  failed, the Idempotency-Key is released and the client gets `503`, so "accepted" always
  means "a job exists".
- **Claiming is atomic**: `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction, so two
  replicas polling at the same instant cannot take the same job.
- **A crashed worker's job comes back**: once `claimed_at` is older than
  `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` (default 5 min) the next claim takes it over. Delivery is
  therefore **at-least-once**; the transformation is a pure function of (asset bytes, mapping
  version, options, importedAt), so re-running produces the same output and the same checksums.
- **Cancellation crosses replicas**: the replica that receives `POST /runs/:id/cancel` marks
  the job `cancelled`; whichever replica is executing it aborts at the next stage boundary.
- **Restart recovery is tested, not asserted**: `scripts/smoke-api.sh` (database mode) stops the
  API, leaves a queued run plus its job row behind, restarts it and waits for completion.

Progress events (SSE) stay per-process: a client connected to replica A does not see events
emitted by replica B. The stream always opens with a `snapshot`, and `/runs/:id` is
authoritative, so a client can poll instead. Sharing events would need a broker — the one
thing this design deliberately avoids.

Objects are verified against their checksum on read, so a truncated or swapped file fails
loudly instead of producing silently wrong FHIR. Runs reference **mapping ids**, and mapping
versions are immutable, so a stored run can always be re-executed against the exact rules
that produced it.

Tenant scoping is part of every repository signature (`workspaceId` first), and
`sql-scoping.test.ts` fails the build if a generated statement loses its predicate
(ADR-0005). The workspace id always comes from the authenticated key, never from the URL
or body.

## 9. Operator Console (frontend)

`apps/web` is a real Angular 19 application, served by a dependency-free Node process that
also proxies `/api/*` (one origin, SSE-safe, no caching of API responses). Structure:

- `core/` — transport and session: `ApiClient` (typed DTOs, one `Page<T>` for every list
  envelope, `ApiProblem` for every failure), an interceptor that adds `x-api-key` and
  `x-request-id`, `AuthStore` (memory-only key), and `sse.ts` (`fetch` + `ReadableStream`
  because `EventSource` cannot send headers).
- `ui/` — status chip, empty state, error panel, loading state, planned-feature card.
- `layout/` — the authenticated shell: nav, API/queue mode badges, theme toggle, disconnect.
- `features/` — lazy-loaded routes: connect, dashboard, runs, run detail, assets, mappings,
  keys, audit.

Rules that keep the Studio additive: standalone components, signals, feature folders, typed
clients, design tokens in `styles.css`, and no HTTP in components. Details, security model,
proxy contract and test strategy: [docs/console.md](docs/console.md).

## 10. Testing

`node:test` via `npm test` (run through `scripts/run-tests.mjs`, plus live-MySQL tests that run
when `HEALTHBRIDGE_TEST_MYSQL_URL` is set) covering redaction,
path semantics, transforms, date determinism, coverage, rejection reporting, CSV
tokenizer/encodings, detection ranking, NDJSON issue reporting, pipeline determinism, CLI
behaviour/exit codes, CLI/SDK parity, four scenario packages, API keys/roles/rate limiting,
object storage, repository contracts (memory + SQL scoping + migrations), the run queue
(concurrency, retry, cancellation, durable claiming, cross-replica cancellation) and the
HTTP API end to end.

The API is also smoke-tested as a real process over real HTTP (`scripts/smoke-api.sh`,
wired into CI, in demo mode and against MySQL): bootstrap → upload → mapping → run →
resources/traces/bundle → idempotent resubmission → byte-identical download, and — in
database mode — a restart that resumes a queued run. `scripts/smoke-compose.sh` does the
same against the composed stack (mysql + api + web). Playwright and layered security suites (XXE, zip
bombs) arrive with the surfaces they test.
