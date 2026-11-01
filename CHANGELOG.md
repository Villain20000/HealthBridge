# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased] — Operator Console v1 (Angular)

The placeholder landing page is gone: `apps/web` is a working, tested Angular 19 console over
the real API, and the base the Studio will grow from.

### Added

- **Operator Console** (standalone components + signals, lazy routes): connect (key in memory
  only), health/limits dashboard, runs list with cursor pagination and filters, run submission,
  run detail (lifecycle, validation issues, generated resources, traces, bundle), cancel,
  replay, asset upload with the server's size limit, mappings with versions, API-key
  administration, audit log, dark/light themes, keyboard-accessible navigation, WCAG 2.2
  AA-oriented contrast.
- **Pipelines**: create a named mapping + engine config, list them, and run one against an
  asset — the run it submits is a normal run, visible in Runs with its own detail page.
- **Live progress over SSE** using `fetch` + `ReadableStream`: custom `x-api-key` header,
  incremental frame parsing across chunk boundaries, `Last-Event-ID` reconnection, duplicate-id
  suppression, abort on navigation, and a connection indicator. Tested through the proxy.
- **Console server** (`apps/web/server.mjs`): static bundle + `/api` reverse proxy with
  streaming-safe SSE, piped uploads, `no-store` on API responses, CSP and the other security
  headers, request-id propagation, SPA fallback that never swallows `/api`, traversal guards.
- **API limits discovery (B6)**: `/healthz` now reports upload/body limits, rate limits,
  supported formats and execution limits; the console reads them instead of hardcoding.
  Download responses expose `x-checksum`/`x-request-id` for CORS callers (B1).
- **Testing**: 32 console unit tests (SSE parsing, error mapping, formatters, proxy contract),
  32 Playwright tests against a real API + proxy (and the same suite against Docker Compose),
  axe accessibility checks, and API regressions for oversized uploads and malformed JSON.
- **Opt-in adapters (metadata-only unless noted)**: FHIR REST client, DICOMweb (read-only QIDO/WADO, SSRF allowlist), CDISC ODM, MySQL read-only connector (partial, `transformToFHIR: true`), OMOP CDM staging, PDF metadata, EDF/WFDB, XLSX, VCF/FASTA, HL7 v2, CDA/XML, DICOM; FHIR NDJSON split into `@healthbridge/fhir-ndjson` and registered as the fourth built-in. Adapter conformance kit gates every adapter.
- **Engine depth**: rule-output chaining (`__rule.`), opt-in cross-record context, `convert_units` (validated UCUM subset), terminology level 5 executes end-to-end via injected provider, streaming CSV tokenization with bounded-memory pipeline batches and SDK streaming file input.
- **Live pausable execution**: chunked checkpoints with pause/resume/cancel (`POST /runs/:id/pause`, `/resume`), resumable byte-identical runs; static replay untouched and never labelled live.
- **Queue/storage options**: opt-in BullMQ driver and auto-selected S3 driver (fail fast when misconfigured); MySQL queue and local/memory storage remain the defaults.
- **SDK + client**: plugin manifest/signature gating, streaming file transform, `@healthbridge/client` typed REST client, `GET /assets/:id/schema`.
- **Validation depth**: MIABIS Core 2.0 profile validators, external FHIR validator adapter, operator-supplied local code tables (licence mandatory), validation centre + lineage + mapping-editor Studio pages.
- **Docs site + release automation**: dependency-free static site generator with link checking; manual-dispatch release workflow (build, pack, no publish without approval).

### Fixed

- **Oversized uploads returned 500.** body-parser's 413/400 errors fell through to the generic
  internal-error handler; they now map to `PAYLOAD_TOO_LARGE` and `INVALID_JSON` with request ids.
- **A 403 killed the session.** Only a 401 drops the key now; a scope failure renders the error
  and leaves the operator signed in.
- **Run-detail tabs showed a permanent spinner** because resources, traces and the bundle were
  only fetched when the tab was already active on load.
- **`docker compose` exposed the API to every interface.** The API port is bound to loopback;
  the console reaches it over the compose network.
- **Angular's critical-CSS inliner emitted an inline event handler**, which the CSP correctly
  blocked. Inlining is disabled rather than weakening `script-src`.

---

## [Unreleased] — Phase C: persistence, storage, auth and platform API

New packages and a working API. Everything below is exercised by the test suite
(279 tests, plus 13 live-MySQL) or explicitly labelled as not done.

### Fixed

- **Queued work no longer dies with the process.** The queue is a `run_jobs` table in database
  mode: enqueue persists before the `202`, claiming is atomic (`FOR UPDATE SKIP LOCKED`), a
  crashed worker's lease expires and the job is re-claimed, and cancellation crosses replicas.
  Delivery is at-least-once, which is safe because a transform is a pure function of its
  inputs. The database-mode smoke stops the API, leaves a queued run behind and waits for it
  to finish after the restart.
- **`docker compose up` was broken on its pinned `mysql:8.4`**: `--default-authentication-plugin`
  was removed in 8.4, so MySQL aborted at startup with "unknown variable" and the API never
  started. Replaced with pinned charset/collation.
- **The `web` container served a 404.** `apps/web/src/index.html` did not exist and the server
  logged "Angular Web Studio" for a page that was never written. It now serves a real landing
  page and proxies `/api/*` to the API, so the stack has one origin.
- **A non-MySQL-8 server failed mid-migration with a syntax error.** Version is checked at
  boot; 5.7 and MariaDB are refused with the reason (collation + `SKIP LOCKED`).
- **`mysql2` was never a declared dependency**, so database mode could not boot at all —
  the failure was a clear message, but the MySQL path had never actually run. Added to
  `@healthbridge/persistence` and verified against a live MySQL 8.4 server.
- **A retry of a key created before the index existed no longer 404s after a deletion.**
  The legacy path compares the request against the run row directly (asset, mapping id,
  pipeline, options), refuses when it cannot prove equivalence, and backfills the index so
  later retries take the fingerprint path.
- **An idempotent retry no longer 404s when its asset or mapping was deleted afterwards.** The
  `Idempotency-Key` index records the request as submitted (asset, mapping reference, pipeline,
  options), so a retry resolves without touching the deleted rows; a retry written with
  `mappingId` where the original used `mappingName` still matches via the resolved payload.
- **`runs.idempotency_key` was missing from the MySQL updatable columns**, so the
  release-on-scheduling-failure fix (below) silently only worked in memory. Fixed.
- **Cancellation could answer `202` with a stale run** when the row changed between the read and
  the write. It now returns `409 CONFLICT` (row changed) or `404 NOT_FOUND` (row deleted) and
  audits the failed attempt instead of pretending the cancel landed.
- **The `run.replayed-idempotent` audit action was misnamed**: it fires when an insert loses a
  race, not when a client retries. Renamed to `run.create-raced`.
- **Documentation claimed 7 migrations**; the runner ships 2 (capability matrix and changelog
  corrected).
- **A run could be stranded as `queued` when the worker queue rejected the job.** The row now
  becomes `failed` with `error.code = "QUEUE_UNAVAILABLE"`, the `Idempotency-Key` is released
  because nothing executed, the attempt is audited as `run.queue-failed` (outcome `failure`) and
  the call returns `503` instead of a success. Covered by three tests in
  `apps/api/test/run.service.test.ts`.
- **`options.maxRecords` accepted `NaN` and `Infinity`**, which would have made the engine slice
  to zero records and export an empty bundle without an error. The guard is now
  `typeof === "number" && Number.isFinite(v) && v > 0`.
- **Audit metadata `wasRunning` was misleading** for cancellation: it reported whether the local
  queue accepted the cancel, not whether the run was running. Renamed to `queueAccepted`.

### Added

- **`apps/api/test/run.service.test.ts`**: 61 unit tests for the run lifecycle (create,
  idempotency, reads, cancel, replay, validation, error handling) with the database, queue and
  audit sink faked at their boundaries only.
- **Durable queue tests**: 6 unit tests over a fake store (persist-before-ack, restart pickup,
  retry backoff, cross-replica cancel, shutdown) and 5 live-MySQL tests (concurrent claim,
  lease expiry, backoff, cancelled/finished rows, duplicate enqueue), plus 4 tests for the
  server-version guard.
- **Compose stack smoke** (`scripts/smoke-compose.sh`, CI job `compose-smoke`): builds the
  images, waits for all three services, runs the full flow through the stack, checks the web
  proxy and asserts a `done` row in `run_jobs`.
- **Live MySQL integration suite** (`packages/persistence/test/mysql.integration.test.ts`,
  8 tests, gated by `HEALTHBRIDGE_TEST_MYSQL_URL`, run in CI against a `mysql:8.4` service):
  migrations apply once and re-run as a no-op, tenant scoping, `idempotency_key` cleared to
  real `NULL`, duplicate-key race returns the stored run, 71-character fingerprint fits
  `CHAR(71)`, index upsert, keyset pagination without overlap, audit round-trip.
- **Database-mode smoke** (`SMOKE_MODE=mysql bash scripts/smoke-api.sh`): migrations at boot,
  bootstrap, upload, run, idempotent retry and byte-identical download against MySQL.
- **HTTP-level regression test for scheduler failure**: `POST /runs` returns a `503` envelope
  carrying the recorded `runId`, the run is readable as `failed`, and the same `Idempotency-Key`
  can be retried successfully.

- **`@healthbridge/auth`**: API keys (`hb_<prefix>_<secret>`), HMAC-SHA256 hashing with a
  server-side pepper, scopes, four least-privilege roles, revocation, rotation with
  overlap-free invalidation, per-key token-bucket rate limiting.
- **`@healthbridge/storage`**: content-addressed object storage with a local-filesystem
  driver and an in-memory driver for tests. Objects are keyed by SHA-256 of their bytes
  and verified on read; size limits are enforced before a write.
- **`@healthbridge/persistence`**: workspace-scoped repository contracts with in-memory and
  MySQL implementations, a real migration runner (2 migrations), keyset cursor pagination,
  idempotency records, append-only audit and trace storage.
  `sql-scoping.test.ts` fails the build if a generated statement loses its `workspace_id`
  predicate (ADR-0005).
- **`@healthbridge/api`**: NestJS REST API — workspaces, API keys, assets (raw upload +
  byte-identical download), mappings (immutable versions), pipelines, runs (async with
  idempotency keys), resources, issues, traces, data-free run bundles, cancel, replay,
  SSE progress, audit trail, rate limiting, structured error envelope and request ids.
- **Async run worker** (`RunQueue`): bounded concurrency, retry with backoff for
  infrastructure errors only, cooperative cancellation, progress events (ADR-0004).
- **Bootstrap flow**: `POST /workspaces` with an operator-held bootstrap token returns the
  owner key once; demo mode prints the generated token at startup.
- **Fail-fast configuration**: production without a database, a missing/short key pepper, or
  an unreachable MySQL refuses to start instead of degrading silently.
- **`docs/api.md`** (endpoint reference, error codes, lifecycle, explicit non-goals),
  **ADR-0004** (async runs and the queue) and **ADR-0005** (tenant isolation in the
  repository layer), plus `.env.example` and a demo compose stack with MySQL and volumes.
- **One test runner** (`scripts/run-tests.mjs`) so path mapping and decorator support are
  configured in exactly one place (`tsconfig.tsx.json`).

### Changed

- Persistence repositories now own the API-key store (`Repositories.apiKeys`), so auth and
  storage share one connection pool and one transaction boundary.
- Root `tsconfig.json` is again a pure solution file; the tsx/test configuration lives in
  `tsconfig.tsx.json`.

### Not done yet (stated, not implied)

- Redis/BullMQ: the queue is in-process; jobs are lost on restart and are not shared
  between replicas.
- OpenAPI document generation is not implemented; `docs/api.md` is the contract.
- Streaming CSV parse (carried over from Phase B) and streaming uploads.
- The web studio (`apps/web`) is still a placeholder.

## [3.2.0] — Phase B: target builders, validation stages, reproducible runs, scenario lab

### Added

- **`@healthbridge/target-builders`**: Patient, Observation, Specimen and DiagnosticReport
  builders plus a generic FHIR fallback. Enforces required elements, normalises invalid FHIR
  ids, prunes empty values, declares `meta.profile` and attaches a provenance extension
  (envelope, adapter, mapping, sensitivity, importedAt). A record that cannot be built is
  rejected with a reason instead of exported.
- **Validation inside the pipeline**: level 3 (FHIR structural) now runs as a real stage and
  `result.validation` reports every level 1–6 as `executed` or `skipped` with a reason.
  Validation errors reject the record.
- **Run bundles and `healthbridge reproduce`**: `--run-bundle` exports a data-free descriptor
  (mapping snapshot, versions, options, input/output checksums); `reproduce` re-runs it and
  compares checksums, with distinct exit codes for input mismatch and output divergence.
- **SDK**: `createRunBundle`, `reproduce`, `importedAt`/`pipelineVersion` options, richer
  `StoredRun` so `replay` reproduces options too.
- **Two transforms**: `to_reference` (typified references) and `codeable_concept` (system +
  code + display + text), plus explicit `params.codes` aliases for `format_gender_fhir`.
- **Synthetic scenario lab**: four verified scenarios (hospital patient migration, laboratory
  interoperability, broken hospital data, international formats) each with data, mapping,
  expected resources, expected issues, README and a verification test including a PHI guard.
- **`scenarios/harness.ts`**: shared assertions for pipeline stages, issue codes and trace redaction.
- **CLI/SDK parity test**: identical fixtures must produce identical output through both entry points.
- ADR-0003.

### Changed

- **Trace redaction is structural by default (protocol v1.2)**: scalar values are masked
  unless the key is structural/terminology; issue-message values are masked too.
- Required mapping rules now escalate conversion failures to `error`, so unparseable
  required values reject the record instead of producing a partial resource.
- Explicit date formats accept `.`/`/`/`-` separators (`DD.MM.YYYY` now works as documented).
- `TransformOptions.importedAt` makes provenance timestamps reproducible.

### Fixed

- **Bundles of runs without `--imported-at` did not reproduce**: the effective provenance
  timestamp is now recorded on the result and carried into the bundle
  (`ReproduceOutcome.inputChecksumMatches` also reports payload drift explicitly).
- Date format `DD.MM.YYYY` was silently treated as "auto" and reported as ambiguous.
- Builders' required-element defaults were computed on a copy and discarded (status/code
  were lost), caught by the new builder tests.
- Numbers were previously kept verbatim in traces; they are now masked like other values.

## [3.1.0] — Stabilisation release

First release where the core claims are backed by executed tests (`npm test` → 72 passing).

### Fixed — correctness

- **Trace redaction was a no-op.** `TraceCollector.emit()` spread caller data *after* the redacted snippets, so raw values overwrote them. Order fixed; regression test asserts SSNs, e-mails, phones, names and birth dates never reach a trace.
- **Target paths could not address arrays.** `name.0.given.0` produced `{"name":{"0":{"given":{"0":…}}}}`. Path writer now creates arrays for numeric segments and supports sparse indexes.
- **Three declared transforms were unimplemented** (`concat`, `split`, `default_value`) and silently passed values through. They are implemented, and an unhandled transform now throws instead of falling through.
- **Coverage was computed from the last record only.** It is now aggregated across all records on source leaf paths, with mapped and rejected field lists.
- **Failed records were silently dropped.** `TransformationResult.rejectedRecords` and `dataLoss` now carry the record, its issues and a partial output.
- **CSV parsing corrupting data.** Replaced `line.split(",")` with an RFC 4180 tokenizer: quoted delimiters, doubled quotes, embedded newlines, CRLF, UTF-8 BOM, UTF-16, Windows-1252 fallback, `, ; \t |` detection, ragged-row and duplicate-header reporting, physical line numbers.
- **FHIR payloads were detected as generic JSON** (`detect()` returned the first match). The registry now scores adapters and picks the most specific one.
- **Malformed NDJSON lines were swallowed** by `catch {}`. They are emitted as `MALFORMED_NDJSON_LINE` warnings and counted in the data-loss report.
- **Invalid transformed values were written into the target.** Date and number transforms now reject the value with an issue instead of emitting a wrong type; ambiguous dates (`03/04/2024`) are rejected with `AMBIGUOUS_DATE_FORMAT`.
- **`resourceType` was mapped from the patient id** in bundled examples, producing structurally invalid FHIR. Mappings now use an explicit `default_value` constant.

### Added

- `DataLossReport`, `RejectedRecord`, `RuleExecutionResult`, conditional rules (`when`), mapping static validation (`MappingEngine.validate`), `sourceDomains` mismatch detection, duplicate target id detection, low-coverage warning.
- Envelope: SHA-256 checksum, encoding, source location, policy-driven sensitivity classification, parse issues, unmapped fields.
- Trace protocol **v1.1**: staged events (`detect` → `export`), span ids, adapter/pipeline versions, redaction state, bounded snippets, run summary.
- CLI: exit-code contract (0–6), `--json` everywhere, `formats inspect`, `trace show`, `init`, `demo generate` (deterministic seeded broken-data profiles), `plugins list`, `examples list`, YAML mappings, `--out`, `--format ndjson`, `--fail-on`.
- SDK: file-path inputs, `inspect`, `detect`, `adapterHealth`, `registerAdapter`, in-memory run store, `replay`, `exportTrace`, typed `HealthBridgeError`.
- Adapter registry health reporting and per-adapter capability status.
- Test suite: 72 tests using the built-in `node:test` runner (no network required).
- Documentation: `ROADMAP.md`, `docs/capability-matrix.md`, `docs/cli.md`, `docs/adr/`, corrected `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, CI workflow.

### Changed

- `MedicalFormatAdapter` gained optional `score()`, `health()` and `ParseContext.onIssue`.
- `createCanonicalEnvelope()` now takes an options object instead of positional arguments.
- Package versions aligned to 3.1.0; engine version reported in every run.
- README no longer claims Angular, Docker database stack, HL7 v2/CDA/DICOM adapters, queues or audit persistence — none of these exist yet.

### Known limitations

- FHIR validation is structural only; profile, terminology and referential-integrity levels are not executed.
- No target-builder layer yet, so required-element enforcement depends on the mapping definition.
- CSV parsing buffers the file; streaming is planned.
- `apps/api` is in-memory and unauthenticated; `apps/web` is a placeholder.
