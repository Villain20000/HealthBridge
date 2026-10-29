# HealthBridge OS — Gap Analysis & Implementation Plan

> **Historical planning snapshot.** This plan was written against the audited baseline
> `v3.0.0` and has been updated incrementally since; the statuses, test counts and
> “current state” notes below may be out of date and are not authoritative.
> Authoritative status lives in [README.md](README.md), [ROADMAP.md](ROADMAP.md) and
> [docs/capability-matrix.md](docs/capability-matrix.md). This file is kept for the
> reasoning trail, not as a status report.

**Plan version:** 1.3 (updated after the Phase C persistence/API work)
**Audited baseline:** repo state at `v3.0.0` manifests · **Current state:** `v3.2.0` + unreleased Phase C, 279 tests passing
**Audit method:** full read of every source file in `packages/*`, `apps/*`, `docker/*`, `datasets/`, `examples/`, plus manifest and lockfile inspection.

Legend — Priority: **P0** blocks correctness/security or makes a claim false · **P1** required for the Definition of Done · **P2** domain expansion · **P3** polish/community.
Effort: **S** < 1 day · **M** 1–3 days · **L** 1–2 weeks · **XL** > 2 weeks.
Status: `DONE` · `PARTIAL` · `OPEN`.
Status vocabulary for capabilities (must match UI/docs): `Supported` · `Partially supported` · `Metadata-only` · `Adapter available but optional` · `Planned` · `Unsupported`.

---

## Implementation status — v3.2.0 (Phase B complete)

Delivered on top of Phase A and verified by the suite (`npm run build`, `npm test` → 110 tests):

- **§1.4 closed**: `@healthbridge/target-builders` builds Patient / Observation / Specimen /
  DiagnosticReport plus a generic FHIR fallback, enforcing required elements, id hygiene,
  `meta.profile` and provenance, and rejecting what cannot be built.
- **§5 levels 1–3 now run in the pipeline**: `result.validation.levels` reports every level as
  executed or skipped with a reason; validation errors reject the record.
- **§17 partially closed**: run bundles, `healthbridge reproduce`, SDK `createRunBundle`/`reproduce`
  and deterministic `importedAt` make runs byte-reproducible (checksum compared, exit codes distinct).
- **§11 scenario lab started**: scenarios 1 (patient migration), 2 (laboratory), 3 (broken data) and
  4 (international formats) ship with data, mappings, expected resources/issues, READMEs and
  verification tests, including a PHI guard over traces.
- **CLI/SDK parity** is an automated test, not a claim.
- Trace redaction strengthened to structural-by-default (protocol v1.2, ADR-0003); required-rule
  conversion failures now escalate to `error` so records are rejected instead of exported partially.

Still open from Phase B: streaming CSV parse (the pipeline still accumulates results) and the
run-bundle version policy for engine upgrades.

## Implementation status — Phase C (unreleased)

Delivered and verified by the suite (`npx tsc -b`, `npm test` → 279 tests):

- **§12 partially closed**: `@healthbridge/auth` (hashed keys, scopes, roles, revocation,
  rotation, per-key rate limiting), `@healthbridge/storage` (content-addressed local-fs and
  in-memory drivers), `@healthbridge/persistence` (workspace-scoped repositories, 3 MySQL
  migrations, keyset pagination, idempotency, audit, trace storage) and `@healthbridge/api`
  (NestJS: workspaces, keys, assets, mappings, pipelines, async runs, resources, issues,
  traces, bundles, cancel/replay, SSE, audit, structured errors, request ids).
- **§13 partially closed**: tenant isolation enforced in repository signatures with a
  SQL-scoping test (ADR-0005), RBAC matrix in `docs/api.md`, secure upload handling (size
  limits, raw-body only, content-addressed), secret handling via env with fail-fast checks,
  rate limiting, audit trail.
- **§17 partially closed**: runs expose `bundle` over HTTP with mapping reference and
  checksums; `replay` re-executes a stored run.
- **Testing (§16)**: API e2e (14), queue behaviour (6), auth (13), storage (15),
  persistence (36) suites added; total 279 tests, offline.

Open after Phase C: OpenAPI document in CI, S3 storage driver,
streaming uploads, encryption at rest, and the Angular studio (§12/§15 remain partial).

## Implementation status — v3.1.0 (Phase A)

Verified on the audit machine with real executions (`npm run build`, `npm test`, CLI smoke, SDK example, `doctor`):

- **72 automated tests passing** (`node:test`, offline, no network): trace redaction, array target paths, all 11 transforms, date determinism, coverage aggregation, rejected-record reporting, CSV RFC 4180 / encodings / delimiters, detection ranking, NDJSON line issues, pipeline determinism, CLI exit codes and command behaviour.
- All §1 P0 defects below are **DONE** except 1.4 (target builders, Phase B).
- Real CLI: `doctor` (adapter health + self-test), `init`, `formats list|inspect`, `inspect`, `transform` (JSON/YAML mapping, `--out`, `--format ndjson`, `--json`, `--fail-on`), `validate`, `trace show`, `demo generate`, `plugins list`, `examples list`; exit codes 0–6 documented in `docs/cli.md` and tested.
- SDK: file/inline input, `inspect`, `detect`, `adapterHealth`, `registerAdapter`, in-memory run store, `replay`, `exportTrace`, typed `HealthBridgeError`.
- Docs truth-pass: `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, `docs/capability-matrix.md`, `docs/cli.md`, `docs/troubleshooting.md`, `docs/adr/ADR-0001`, `docs/adr/ADR-0002`, `.github/workflows/ci.yml`, issue and PR templates.
- Still open: Phase B–G (target builders, validation stages 1–3 in-pipeline, persistence/queue/auth, Angular studio and debugger, adapter wave 1, domain depth), plus `git init`/Changesets (2.4), lint gate (2.2) and the Docker stack rework (§12). None of these is claimed as working anywhere in the repo.

---

## 0. Verified baseline (what existed at v3.0.0)

| Layer | Then | Evidence |
|---|---|---|
| Canonical envelope type | type only | `packages/shared-types/src/index.ts` |
| Adapter registry + `MedicalFormatAdapter` | yes | `packages/core/src/index.ts` |
| Adapters | CSV, JSON, FHIR R4 JSON/NDJSON — 3 only | `packages/adapters/src/index.ts` (187 lines) |
| Mapping engine | 12 declared transforms, 9 implemented, dot-path writer | `packages/mapping-engine/src/index.ts` |
| Transformation pipeline | detect → parse → map (in memory) | `packages/transformation-engine/src/index.ts` |
| Trace protocol | v1.0 collector, broken redaction | `packages/trace-protocol/src/index.ts` |
| FHIR "validation" | ~70 lines, 3 resource types | `packages/validation/src/index.ts` |
| Lineage | synthetic edges from rules, not traces | `packages/lineage-engine/src/index.ts` |
| SDK | 3 methods | `packages/sdk/src/index.ts` |
| CLI | 5 commands, fake `doctor` | `packages/cli/src/index.ts` |
| API | 13 endpoints over `Map`s, no DB/auth | `apps/api/src/api.controller.ts` |
| Web Studio | **not Angular**; 20-line server for a missing file | `apps/web/src/main.ts` |
| Datasets / scenarios | 2 CSVs, no expectations | `datasets/` |
| Docker | api + web only | `docker/compose.demo.yaml` |
| Tests | one console script; `tsx` not even a devDependency | `packages/sdk/src/test-sdk.ts` |

---

## 1. P0 — Correctness and security defects

| # | Defect | Status | Fix shipped |
|---|---|---|---|
| 1.1 | **Trace redaction was a no-op** — caller fields spread after redacted snippets overwrote them (PHI leak into every stored trace). | DONE | Spread order inverted; key/value classification; bounded snippets; sentinel regression tests |
| 1.2 | **Nested path writer could not address arrays** — `name.0.given.0` emitted `{"name":{"0":…}}`. | DONE | Array-aware `setPath`/`getPath`; sparse-index tests |
| 1.3 | **Declared transforms unimplemented** (`concat`, `split`, `default_value`) and silently passed through. | DONE | Implemented; unknown kinds throw (`assertNever`); parameterised tests |
| DONE 1.4 | **No target-format construction layer** — nothing injects `resourceType`/required elements; bundled mappings produced invalid FHIR. | PARTIAL | Bundled mappings fixed via `default_value` constants; a real `TargetBuilder` per resource is Phase B |
| 1.5 | **Coverage report kept the last record only.** | DONE | Aggregated on source leaf paths across records (+ mapped/rejected path lists) |
| 1.6 | **Failed records vanished from the output.** | DONE | `rejectedRecords[]` + `dataLoss` (unmapped, rejected values, dropped indexes, adapter notes) |
| 1.7 | **Envelope fields never populated** (checksum, metadata, classification, unmapped). | DONE | SHA-256 checksum, encoding, source location, policy-driven sensitivity, parse issues |
| 1.8 | **CSV parser rejected valid CSV** (`split(",")`, no quotes/BOM/encoding/delimiter handling). | DONE | RFC 4180 tokenizer, UTF-16/BOM/Windows-1252, `, ; \t |` sniffing, ragged rows |
| 1.9 | **Record↔line index drift** from row filtering. | DONE | Physical line numbers tracked; `sourceLocation: "line N"` |
| 1.10 | **Detection was order-dependent** — FHIR payloads parsed as generic JSON. | DONE | Scored detection (`score()` + confidence), most-specific adapter wins |
| 1.11 | **NDJSON parse errors swallowed** by `catch {}`. | DONE | `MALFORMED_NDJSON_LINE` warnings via `ParseContext.onIssue` |
| 1.12 | **CLI could not run from a clean clone** (`npx tsx` not a devDependency; `dist` never built). | DONE | `tsx` devDependency, build/test scripts, CI smoke test |
| 1.13 | **`doctor` printed hard-coded "healthy".** | DONE | Real probes, adapter health, self-test, exit 5 when degraded |
| 1.14 | **README overstated shipped features** (DICOM/HL7v2/CDA, queues, audit persistence, Angular, isolation). | DONE | README rewritten against the real capability matrix; `ROADMAP.md` for the rest |

Also shipped beyond the original list, because the audit showed silent-wrong-output paths: invalid transformed dates/numbers now **reject the value** instead of writing a wrong type; ambiguous dates produce `AMBIGUOUS_DATE_FORMAT`; `DOMAIN_MISMATCH`, `LOW_MAPPING_COVERAGE` and `DUPLICATE_RESOURCE_ID` warnings; mapping static validation before execution.

---

## 2. P0 — Engineering foundation

| # | Gap | Status | Target |
|---|---|---|---|
| 2.1 | No test framework | DONE (core) / PARTIAL | `node:test` suite, 72 tests, offline. Coverage gate and per-adapter conformance kit still open |
| 2.2 | No lint/format gate | OPEN | ESLint (typescript-eslint, no-floating-promises, no-explicit-any ratchet), Prettier, `tsc --noEmit` in CI |
| 2.3 | No CI | DONE | `.github/workflows/ci.yml`: build, tests, CLI smoke, redaction check, SDK example, audit job |
| 2.4 | No git history / Changesets / `.dockerignore` | OPEN | `git init` + initial commit, Changesets, dist hygiene |
| 2.5 | No `engine` boundary; SDK re-exports everything | PARTIAL | `@healthbridge/engine` pure facade consumed by SDK/CLI/API/Web |
| 2.6 | All adapters in one package | OPEN | One package per adapter (`adapter-csv`, `adapter-hl7v2`, …) |
| 2.7 | No adapter kit / conformance suite | OPEN | `@healthbridge/adapter-kit` reference adapter + contract tests |
| 2.8 | No error taxonomy | DONE (SDK) / PARTIAL | `HealthBridgeError` with code/category; CLI exit mapping tested. API error model still open |

---

## 3. P1 — Adapter ecosystem

Status after v3.1.0: **3 adapters** (csv supported, json supported, fhir-r4-json partial). Everything below is `Planned` and must not appear as working in UI/README until its conformance tests run.

| Format | Target status | Required work |
|---|---|---|
| XLSX | Supported (P1) | Sheet enumeration, header detection, typed cells, formula warnings, row streaming |
| XML / CDA | CDA partial (P1) | **Safe parser (XXE/entity expansion disabled)** is a prerequisite; header/section metadata; no clinical NLP |
| HL7 v2 (2.3–2.9) | Partial (P1) | MSH/segment/field/component parsing, escape sequences, repetitions; ADT^A01 → Patient, ORU^R01 → Observation/DiagnosticReport; explicit Z-segment reporting |
| FHIR NDJSON package split | Supported (P1) | Split from FHIR JSON adapter; per-line issues (already implemented, needs packaging) |
| FHIR REST client | Partial (P1) | Paging, `_elements`, capability statement, SSRF allowlist, no PHI logging |
| DICOM metadata | Metadata-only (P1) | File-meta + dataset walk (explicit/implicit VR, endianness, deflated), private-tag preservation, PHI tag policy; no pixel transcoding. DICOMweb (QIDO/WADO/STOW) separate opt-in |
| MySQL connector | Partial (P2) | Read-only, allowlisted queries, chunked cursor streaming, secret-ref credentials |
| OMOP CDM | Adapter optional (P2) | Staging subset (`person/measurement/specimen`); no full OHDSI validation claim |
| VCF / BCF | Metadata + variants (P2) | Header/INFO/FORMAT, `referenceGenome` in envelope metadata, symbolic alleles, no clinical interpretation |
| FASTA / FASTQ | Metadata-only (P2) | Counts, length distribution, checksums, quality encoding; sequences never inlined into traces |
| PDF / documents | Metadata-only (P2) | Opt-in text extraction; OCR/NLP marked unverified |
| EDF / WFDB | Metadata-only (P3) | Channel/sampling/units metadata; waveform bytes external |
| MIABIS / CDISC | Planned (P3) | Specification review before any code |

Cross-cutting gap: no adapter health surfaces in the API yet (CLI/SDK have it), no configuration schema validation per adapter, no version-compatibility matrix (adapter ↔ trace protocol), no plugin trust gate or sandbox — installing a third-party adapter is arbitrary code execution, documented in `SECURITY.md`.

---

## 4. P1 — Mapping engine and Mapping Studio

Engine status: transforms (11), conditions, array paths, mapping validation, coverage, rejection reporting **DONE**. Still open:

1. Rule chaining (rule output → rule input) and cross-record context (e.g. `DiagnosticReport` referencing produced `Observation`s).
2. Date parsing with timezone/format variants beyond day precision; UCUM unit conversion (validated tables only); terminology lookup via injected provider (LOINC, SNOMED CT, ICD, RxNorm, ATC) with licence-aware loading.
3. Target builder integration (§1.4) so required elements are enforced by code, not by author discipline.
4. Immutable mapping versions and `mappingVersion` in every run bundle/trace.
5. Mapping Studio UI (all of §9): schema explorers, drag-and-drop, type badges, coverage heat map, draft autosave, undo/redo, version diff, import/export, no JS evaluation, keyboard-complete alternative to drag-and-drop.

---

## 5. P1 — Validation

| Level | Status | Gap |
|---|---|---|
| 1. Source structural | DONE | Adapter-level issues + `onIssue` channel |
| 2. Mapping definition | DONE | `MappingEngine.validate` (unknown transform, duplicate ids/targets, bad conditions) |
| 3. FHIR resource structure | PARTIAL | Patient/Observation/Specimen/`resourceType` only; needs cardinality, choice types, datatypes, references, Bundle rules |
| 4. Profile validation | OPEN | External validator adapter (HL7 validator / HAPI) with offline fallback |
| 5. Terminology validation | OPEN | Terminology adapters + licensed editions |
| 6. Referential integrity | OPEN | Cross-resource reference resolution in runs/Bundles |

Also open: validation as a mandatory pipeline stage, persistence of `validation_runs`/`validation_issues`, and `executedLevels` reporting in the result object (the CLI states the levels today).

---

## 6. P1 — Visual Transformation Debugger 2.0

Trace protocol v1.1 **DONE** (stages, spans, versions, redaction state, bounded snippets, summary). Everything else open: pipeline graph UI, step forward/back, jump-to-error, record inspection, field provenance, nested JSON diff, conditional breakpoints over stored envelopes, failure replay (SDK `replay` exists), run/pipeline comparison, profiling, debug report export, virtualised event list, Angular shell, keyboard navigation, reduced motion, deep links.

Constraint to keep: replay of stored traces only — never labelled live pausable execution until checkpoint/cancellation semantics exist.

---

## 7. P1 — SDK and CLI

**CLI — DONE:** command set, flags, YAML mappings, exit codes 0–6, `--json`, deterministic demo generator, trace rendering, plugin/example listing. **Open:** stdin input, streaming output for very large runs, `--delimiter`/encoding override flags, shell completions, per-command help pages, `--watch`.

**SDK — DONE:** path/inline input, inspect, detect, transform, adapter health, replay, trace export, run store, typed errors. **Open:** streaming results (`AsyncIterable<TargetResource>`), progress callback, cooperative cancellation inside long parses, plugin manifest/signature gating, `reproduce(runBundle)` file format, separate `@healthbridge/client` for the REST API.

---

## 8. P1 — Persistence, queue, storage

**Entirely open.** All §12 entities (`medical_assets`, `asset_versions`, `mapping_versions`, `execution_runs`, `execution_steps`, `trace_events`, `trace_artifacts`, `validation_runs`, `lineage_nodes/edges`, `workspaces`, `audit_events`, …) exist only as an in-memory `Map` in `apps/api`. Requires: ORM + migrations, FK/index design, tenant isolation helper, retention policy, immutable version ids, object storage adapters (`local-fs` default, S3-compatible optional), a durable job queue with retries, dead-letter, idempotency keys and real cancellation checkpoints. Binary assets (imaging, genomics, waveforms) must never enter MySQL.

---

## 9. P1 — REST API

**OPEN (experimental only).** Missing: authn/authz, workspace scoping, DTO validation (class-validator is an unused dependency), idempotent submissions, cursor pagination, rate limiting, RFC 9457 errors, SSE progress, cancellation, audit logging, upload limits/magic-byte checks, SSRF allowlist, `/healthz` + `/readyz`, OpenAPI committed and diffed in CI. Endpoints from the prompt still missing: `POST /pipelines`, `POST /pipelines/:id/execute`, `GET /runs/:id/issues`, `GET /runs/:id/lineage`, `POST /runs/:id/replay`, `GET /assets/:id/schema`, `GET /adapters` (health) — the last one and `/healthz` now exist on the current controller.

---

## 10. P1 — Web Studio

**OPEN — planned in [docs/plan-web-studio.md](docs/plan-web-studio.md).** `apps/web` is a placeholder static server and there is no Angular dependency in the lockfile. Required: Angular 17+ standalone workspace with Signals and router; navigation shells for all §16 screens; release gate per screen (implement or show an explicit `Planned` card — no fake charts); dashboard bound to real metrics (needs §8); WCAG 2.1 AA; keyboard-complete mapping editor; `aria-live` run progress; reduced-motion handling.

---

## 11. P1 — Synthetic Medical Data Lab

**PARTIAL** — four of the eight scenarios are delivered (hospital patient migration, laboratory
interoperability, broken hospital data, international formats), each with data, mapping,
expected resources/issues, README and a verification test including a PHI guard. The remaining
four (large-file/streaming, genomics, imaging metadata, research/consent) are open. Each scenario needs: `README.md`, source dataset, mapping, expected valid output, expected issue list, trace fixture, reproduction command and an automated verification test. Scenario 8 additionally needs a streaming pipeline and a benchmark baseline. All artefacts must carry a "synthetic, not clinically validated" notice; seeds must be deterministic.

---

## 12. P1 — Docker and self-hosting

**PARTIAL.** `docker/compose.demo.yaml` runs MySQL 8.4 with a health check, the API wired to it
(`DATABASE_URL`, migrations at boot) and named volumes for MySQL data and objects, plus
`.env.example`. The images now use `npm ci` with the lockfile and run as `node`. MySQL is no
longer only unit-tested: `packages/persistence/test/mysql.integration.test.ts` and a
database-mode API smoke run against live 8.0 and 8.4 servers in CI, and `scripts/smoke-compose.sh`
smokes the composed stack (images, health, full flow, web proxy, `run_jobs` row) in CI. Still
open: resource limits, seeding and backup/restore docs.

---

## 13. P1 — Privacy, security, safety

**DONE:** redaction by default with tests, no telemetry, offline CLI, policy-driven sensitivity classification, documented plugin trust boundary, PHI-free CLI summaries.

**PARTIAL (Phase C):** RBAC matrix and error codes documented (`docs/api.md`), tenant-isolation tests over HTTP and in SQL (ADR-0005), API keys hashed with a server pepper, per-key rate limiting, audited privileged actions, upload size limits and raw-body-only ingestion, fail-fast secret checks.

**OPEN:** threat model, retention/purge configuration, SSRF/safe-parser hardening (XXE prerequisites), encryption at rest, secret management beyond env vars, dependency/container scanning in CI (audit job added), signed expiring exports, pseudonymisation vs anonymisation guidance in-product, explicit refusal statements for clinical decision-making beyond the README.

---

## 14. P2 — Domain depth (imaging, genomics, signals, research)

Unchanged from plan v1.0: imaging metadata explorer, genomic provenance (`referenceGenome`, assembly, checksums), biospecimen lineage graph, research/consent metadata, waveform metadata with external binaries. Each needs an explicit "no clinical interpretation" boundary in code and UI.

---

## 15. P2 — Documentation and community

**DONE:** README, ROADMAP, CHANGELOG, ARCHITECTURE, SECURITY, CONTRIBUTING, SUPPORT, CODE_OF_CONDUCT, capability matrix, CLI reference, troubleshooting, two ADRs, CI, issue/PR templates.
**OPEN:** docs site, adapter development tutorial (blocked on the adapter kit), compatibility matrix, more ADRs (detection scoring, issue codes, data-loss reporting), dependency licence audit, release automation.

---

## 16. P2 — Testing and QA

| Suite | Status |
|---|---|
| Core engine unit | DONE (57 engine tests) |
| CLI behaviour/exit codes | DONE (19 tests) |
| Adapter conformance kit | OPEN — fixtures exist inline; shared contract suite pending |
| FHIR validation parity with external validator | OPEN |
| CLI/SDK parity | DONE — automated byte-parity test |
| Debugger tests | OPEN (no debugger; scenario trace assertions exist) |
| Docker smoke | OPEN (CI covers the CLI, not compose) |
| API e2e (HTTP, real engine) | DONE (14 tests) |
| Auth (keys, scopes, roles, rotation, rate limit) | DONE (13 tests) |
| Storage (content addressing, limits, verification) | DONE (15 tests) |
| Persistence (memory + SQL scoping + migrations) | DONE (36 tests) |
| Queue (concurrency, retry, cancellation, events) | DONE (6 tests) |
| Security suite (XXE, zip bomb, oversized input, tenant isolation) | PARTIAL — tenant isolation and upload limits covered; XXE/zip-bomb fixtures open |
| Playwright / axe accessibility | OPEN |
| Performance benchmarks | OPEN |

---

## 17. P2 — Reproducibility and provenance

**DONE for the engine, PARTIAL for the platform.** Runs return `inputChecksum`, `outputChecksum`, `adapterId`, `adapterVersion`, `engineVersion`, `runId` and traces; `--run-bundle` + `healthbridge reproduce` compare output checksums; the API exposes `GET /runs/:id/bundle` (data-free, with mapping reference and checksums) and `POST /runs/:id/replay`. Open: bundle version policy across engine upgrades, stable ordering guarantees beyond JSON comparison, trace retention/purge rules.

---

## 18. Recommended execution order (remaining)

**Phase B — credible vertical slice (~1.5 weeks):** target builders for Patient/Observation/Specimen/DiagnosticReport; validation stages 1–3 inside the pipeline with `executedLevels`; run bundles + `reproduce`; scenarios 1, 2, 5, 6 with verification tests; CLI/SDK parity test; streaming CSV parse.

**Phase C — persistence and API (~2 weeks):** MySQL schema + migrations + seeds, storage adapters, BullMQ worker, authn/authz/workspaces, remaining endpoints, SSE progress, cancellation, audit log; compose dev stack with 5 healthy services and an async 100k-row transform.

**Phase D — studio and debugger (~2.5 weeks):** real Angular app, three-pane debugger over stored traces, timeline, provenance, diff, replay, validation centre, lineage view, real dashboard, roadmap-status cards, a11y pass, Playwright journeys.

**Phase E — adapter wave 1 (~2 weeks):** XLSX, XML/CDA metadata (safe parser first), HL7 v2 (ADT/ORU), FHIR NDJSON package, FHIR REST client, DICOM metadata + conformance suite per adapter.

**Phase F — domain depth and hardening (~2–3 weeks):** MySQL connector, OMOP staging, VCF/FASTA/FASTQ metadata, PDF metadata with opt-in extraction, terminology adapters, external validator, security suite, benchmarks, docs site, release packaging (publish only with explicit authorisation).

**Phase G — later:** EDF/WFDB, MIABIS, CDISC, public-health plugins, DICOMweb, live pausable execution (only with genuine checkpoint/cancellation semantics).

---

## 19. Definition-of-Done checklist

- [ ] Working implementation, no mock returning fabricated data
- [ ] Public interface documented
- [ ] Tests written **and executed**, results reported
- [ ] Errors mapped to the shared taxonomy with actionable advice
- [ ] Security/privacy review (payloads, logs, traces, exports, authorisation)
- [ ] Capability status accurate and identical in manifest, README, UI, docs
- [ ] Reproducible: run descriptor + replay path
- [ ] Works on Windows, macOS, Linux (or limitation documented)
- [ ] Limitations and support boundary documented, including "not clinically validated"
- [ ] No new false claim added anywhere

---

## 20. Claim / reality registry

| Claim | Reality at v3.0.0 | At v3.1.0 |
|---|---|---|
| DICOM metadata, HL7 v2, CDA adapters | absent | still absent — listed as `Planned` in README/ROADMAP |
| "Visual Transformation Debugger 2.0" | data structures only | trace protocol v1.1 shipped; **no UI** — remains roadmap |
| "NestJS API with background queues and audit persistence" | in-memory Maps | unchanged; README marks the API experimental |
| "Angular Web Studio with Signals" | 20-line static server | README states `Planned`; `apps/web` still a placeholder |
| "Workspace isolation and audit logging" | absent | README no longer claims it |
| "Docker Compose self-hosting" | api + web only | unchanged; marked experimental |
| "Payload redaction by default" | broken (no-op) | **now true**, with regression tests |
| "CSV/JSON/FHIR adapters" | present but corrupting | true and tested, with documented limitations |
