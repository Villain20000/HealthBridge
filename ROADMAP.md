# HealthBridge OS — Roadmap

Status vocabulary for capabilities (must match the UI and `docs/capability-matrix.md`):
**Supported** · **Partially supported** · **Metadata-only** · **Adapter-required** · **Planned** · **Unsupported**.

Phase status: ✅ delivered · 🟡 delivered with stated gaps · ⬜ not started.

The rule for this file: an item is only ✅ when a test proves it. Everything else says what is
missing and why.

---

## Phase A — Honest foundation — ✅ delivered in v3.1.0

| Item | Status | Evidence |
|---|---|---|
| Canonical Medical Data Envelope (checksum, source location, encoding, classification, parse issues) | ✅ | `packages/shared-types`, `packages/core` |
| Adapter registry with honest capability manifests and detection scoring | ✅ | `packages/adapters/test/adapters.test.ts` (“adapter registry detection”), `packages/transformation-engine/test/pipeline.test.ts` (detect → adapter-selection stages) |
| CSV adapter (RFC 4180, encodings, delimiter detection, ragged rows) | ✅ | `packages/adapters/test/adapters.test.ts` |
| JSON adapter (object or array of objects) | ✅ | same |
| FHIR R4 JSON adapter (resource, Bundle, NDJSON) — structural inspection only | ✅ (partial capability) | same |
| Declarative mapping engine with 11 deterministic transforms and array-aware paths | ✅ | `packages/mapping-engine/test` |
| Trace protocol v1.x with redaction by default | ✅ | `packages/trace-protocol/test` |
| Deterministic issue/rejection reporting — no silent data loss | ✅ | pipeline tests + scenarios |
| SDK (`@healthbridge/sdk`) and CLI (`@healthbridge/cli`) over the same engine | ✅ | `packages/cli/test/cli.test.ts` |
| CLI exit codes, `--json`, YAML mappings, `trace show`, `init`, `demo generate` | ✅ | same |
| Documentation truth pass, capability matrix, ADRs | ✅ | this file, `docs/` |
| Detection scoring (FHIR before generic JSON) | ✅ | `packages/adapters/test/adapters.test.ts` |
| NDJSON/CSV line-level issue reporting | ✅ | same |
| Real `doctor` command with adapter health + self-test | ✅ | `packages/cli/test/cli.test.ts` |
| Test runner (node:test) | ✅ | `npm test` (full suite) |

---

## Phase B — Credible vertical slice — ✅ delivered in v3.2.0

| Item | Status | Notes |
|---|---|---|
| Target builders that enforce required elements per FHIR resource (`Patient`, `Observation`, `Specimen`, `DiagnosticReport`) and inject `meta.profile` | ✅ | `@healthbridge/target-builders` |
| Validation stages 1–3 inside the pipeline with executed/skipped reporting | ✅ | `result.validation.levels` |
| Run bundles (input checksum + adapter/mapping/pipeline versions + options) and `reproduce` | ✅ | CLI `--run-bundle`, SDK `createRunBundle`/`reproduce` |
| Synthetic scenario lab (4 scenarios with data, mapping, expectations, README, test) | ✅ | `scenarios/01…04` |
| CLI/SDK byte-parity test | ✅ | parity test in the suite |
| Deterministic `importedAt` provenance anchor | ✅ | `TransformOptions.importedAt` |
| Streaming parse for large CSV (no full-file buffering) | ⬜ | carried into Phase C/F; the pipeline still accumulates results |

---

## Phase C — Persistence and API — 🟡 delivered (unreleased)

| Item | Status | Evidence |
|---|---|---|
| MySQL schema + migration runner (workspaces, api keys, assets, mappings, pipelines, runs, run traces, audit events, idempotency, run_jobs) | ✅ | `packages/persistence` — 3 migrations; `migrations.test.ts` plus a live-MySQL suite verified against 8.0 and 8.4 |
| In-memory + MySQL repositories behind one workspace-scoped contract | ✅ | `memory.test.ts`, `sql-scoping.test.ts` (unscoped SQL fails the build), `mysql.integration.test.ts` (live) |
| Object storage (local filesystem + in-memory), content-addressed, verified on read | ✅ | `packages/storage` |
| Authentication: hashed API keys, scopes, roles, revocation, rotation, per-key rate limiting | ✅ | `packages/auth` |
| Async runs: queue with concurrency, retry, cancellation, progress events | ✅ | `apps/api/test/run-queue.test.ts` |
| Idempotent submissions, cursor pagination, structured errors, request ids, SSE progress | ✅ | `apps/api/test/api.e2e.test.ts` |
| Tenant isolation over HTTP | ✅ | e2e “isolates tenants”, ADR-0005 |
| Audit trail (append-only, tenant scoped, never breaks a request) | ✅ | `/api/v1/audit` |
| Run bundles, replay, traces and issues exposed over HTTP | ✅ | `/runs/:id/{bundle,replay,traces,issues}` |
| Fail-fast configuration (production without DB, missing pepper, unreachable MySQL) | ✅ | `apps/api/src/config.ts`; database-mode smoke in CI |
| Shared broker (Redis + BullMQ) with cross-replica workers | ➖ | not planned: `run_jobs` gives durable claiming across replicas; revisit only on queue fan-out needs (ADR-0004) |
| OpenAPI document committed and diffed in CI | ✅ | `docs/openapi.json` generated from controllers, CI fails on drift (not served over HTTP) |
| S3-compatible storage driver | ✅ | `S3StorageDriver` + env config, auto-selected in `app.context` when configured with fail-fast refusal; local/memory remain the default |
| Streaming uploads and streaming CSV parse | 🟡 | streaming CSV tokenization, bounded-memory pipeline batches and SDK streaming file input landed; API upload bodies still buffer within documented limits |

The API stays **Partial** until the broker and OpenAPI items land: a single-replica queue is a
real limitation for a platform that wants to claim horizontal scaling.

---

## Phase D — Studio and debugger — 🟨 (Operator Console v1 shipped)

**Done:** Angular 19 Operator Console (standalone components, signals, lazy routes) —
connect, health/limits, dashboard on real metrics, runs (cursor pagination, submit, cancel,
replay), run detail (issues, resources, traces, bundle), SSE live progress through the
proxy, asset upload, mappings, API keys, audit log, dark/light themes, axe checks and
Playwright journeys against the API and the Docker Compose stack. See
[docs/console.md](docs/console.md).

**Still open:** VS Code-style three-pane debugger extensions over stored traces · pipeline runs in the UI · cookie-based BFF/OIDC.

**Shipped:** rule-table mapping editor, read-only schema explorers, lineage view, validation centre, `GET /assets/:id/schema`.


Static trace replay must not be labelled as live execution (standing rule); live pausable execution shipped (see Phase G below).


## Phase E — Adapter wave 1 — ✅ (opt-in adapters; NDJSON split into its own package)

XLSX ✅ · generic XML and CDA metadata ✅ · HL7 v2 (ADT, ORU) ✅ · FHIR NDJSON split into `@healthbridge/fhir-ndjson` ✅ ·
FHIR REST client ✅ (paging, capability statement, SSRF allowlist) · DICOM metadata ✅
(explicit/implicit VR, private tags, PHI tag policy) · adapter development kit and shared
conformance test suite.

## Phase F — Domain depth and hardening — 🟡 (adapters, UCUM, terminology wiring, security suite, benchmarks landed)

MySQL connector (read-only, streaming) ✅ · OMOP CDM staging subset ✅ · VCF metadata and variants ✅ ·
FASTA/FASTQ metadata ✅ · PDF metadata with opt-in text extraction ✅ · rule chaining + cross-record context ✅ · UCUM `convert_units` ✅ · streaming CSV + bounded pipeline ✅ · terminology: local code-table provider ✅
(operator-supplied tables; licensed-server integration for LOINC/SNOMED/ICD/RxNorm/ATC still open) ·
external FHIR validator adapter ✅ (opt-in, SSRF allowlist) · terminology level-5 executes when a provider is injected · security test suite ✅
(XXE, zip bombs, oversized inputs, tenant isolation) · benchmarks ✅ · plugin manifest gating ✅ · @healthbridge/client ✅ · docs site ✅ · release
automation.

## Phase G — Later — ⬜

EDF/WFDB metadata ✅ (metadata-only ingester) · MIABIS profiles ✅ (opt-in validators; biobank flows reuse the generic lineage view) · CDISC/ODM study metadata ✅ (metadata-only) ·
public-health jurisdiction plugins (remaining) · DICOMweb ✅ (read-only QIDO/WADO, SSRF allowlist) · live pausable execution ✅ (chunked checkpoints, pause/resume; v1 process-local, replay untouched)
(checkpoint semantics verified; static trace replay is never labelled live — kept as the standing rule).
Phase G header stays open until public-health jurisdiction plugins land.

---

## Explicitly unsupported (and why)

| Item | Why it is not on the roadmap as a feature |
|---|---|
| Autonomous diagnosis, triage or treatment advice | Out of scope: this is a data interoperability layer, not a clinical decision-support system. |
| Regulatory certification claims (CE, FDA, MDR class) | Requires a quality management system, clinical evaluation and notified-body audit — not a code change. |
| Inference of clinical meaning from column names | Guessing that `sex` means administrative gender, or that a value is a LOINC code, produces confidently wrong FHIR. |
| Silent coercion of ambiguous dates, units or codes | Rejected with an issue instead; ambiguity is reported, never resolved by guessing. |
| Promise of complete PHI removal | Redaction protects traces; stored resources are the point of the tool. Pseudonymisation is not anonymisation. |
| JavaScript-expression transforms in mappings | Arbitrary code in a mapping file is a remote-code-execution path for a file format that gets emailed around. |
