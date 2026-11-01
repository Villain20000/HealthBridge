# MISSING — full-app missing-feature backlog

This is the single, code-verified list of work that is **not implemented** in HealthBridge OS. It
exists because status is currently spread across `README.md`, `ROADMAP.md`, `PROGRESS.md`,
`docs/planned/` and `docs/plan-web-studio.md`, and those sources disagree with each other and with
the working tree.

What this file is:

- a prioritized backlog for product, platform/API, adapters, CLI/SDK, operations, security and
  quality work;
- a pointer to one canonical design spec per item where one exists;
- honest about the difference between committed code, uncommitted working-tree code and code that
  does not exist.

What this file is not:

- a design document, an implementation plan, a release note or a promise of dates;
- a replacement for the specs in `docs/planned/` and `docs/`;
- a list of deliberate non-goals (see [section 6](#6-deferred-and-non-goals)).

> **Verification baseline:** branch `main`, HEAD `c7533e6`, verified **2026-11-01**.
> Before this file was created, the working tree contained **142 dirty paths** — 87 untracked,
> 50 modified, 5 deleted. The tree was re-snapshotted after writing and showed 143 paths
> (88 untracked) — the additional path is this document. Evidence was read from the working tree,
> not from `git show HEAD`. Items marked `[WT]` rely on uncommitted files and are **not shipped or
> released**. No git remote and no release tag were configured.
>
> Verification commands: `git branch --show-current`, `git rev-parse --short HEAD`,
> `git status --porcelain=v1`, `git remote -v`, `git tag`.

---

## 1. How to read this file

### 1.1 Status

| Status | Meaning |
|---|---|
| `MISSING` | No API route, UI path, package code or workaround exists in any layer. |
| `PARTIAL` | A shipped or working-tree slice exists; the residual gap is named in the row. |
| `OPT-IN/UNWIRED` | Code exists but is not registered, default, discoverable or CI-gated. |
| `DEFERRED` | Consciously postponed; not release-blocking; a trigger is stated. |
| `DECISION` | A policy or scope choice must be made first; only appears in [section 5](#5-open-decisions). |
| `NON-GOAL` | Deliberate exclusion; only appears in [section 6](#6-deferred-and-non-goals). |

`CLOSED` is not a backlog status. Work that exists is recorded in
[Appendix B](#appendix-b--shipped-guard-list-and-verification-log), not listed as missing.
`[WT]` is a qualifier, not a status.

### 1.2 Priority

| Priority | Definition |
|---|---|
| `P0` | Release blocker: prevents a defensible public release or is a supported-path security/privacy defect. Zero open P0s before a release tag. |
| `P1` | Next: needed for coherent GA of an advertised capability, or removes a materially misleading claim. No reasonable workaround. |
| `P2` | Later: valuable, but opt-in or workaround exists. |
| `P3` | Opportunistic, research or trigger-dependent. |

Priority reflects consequence, not effort. Status and priority are independent.

### 1.3 Required fields

Every backlog row has:

- **ID** — stable and append-only (`AREA-NNN`); never reuse or renumber.
- **Capability and gap** — what a user cannot do today.
- **Status** and **Pri** — from the tables above.
- **Depends** — item IDs, `DEC-*` or `none`; no cycles.
- **Evidence** — at least one repository path plus a symbol, route or exported function.
- **Spec** — one canonical link, or `none`.
- **Acceptance (done when)** — 2–5 binary, externally observable checks; not implementation steps.

---

## 2. At a glance

### 2.1 Counts by area

| Area | Items | P0 | P1 | P2 | P3 |
|---|---:|---:|---:|---:|---:|
| Studio and product (`STU`) | 9 | 0 | 2 | 4 | 3 |
| Validation and clinical (`VAL`) | 3 | 0 | 0 | 3 | 0 |
| Platform and API (`API`) | 10 | 1 | 2 | 6 | 1 |
| Adapters (`ADP`) | 4 | 0 | 2 | 0 | 2 |
| CLI and SDK (`CLI`) | 1 | 0 | 0 | 0 | 1 |
| Operations and release (`OPS`) | 5 | 2 | 2 | 1 | 0 |
| Security and privacy (`SEC`) | 5 | 1 | 1 | 2 | 1 |
| Quality and documentation (`QUA`) | 4 | 0 | 2 | 2 | 0 |
| **Total** | **41** | **4** | **11** | **18** | **8** |

### 2.2 Counts by status

| Status | Count |
|---|---:|
| `MISSING` | 20 |
| `PARTIAL` | 15 |
| `OPT-IN/UNWIRED` | 2 |
| `DEFERRED` | 4 |

Open decisions: 6. Non-goals: 15 (not counted as backlog).

### 2.3 P0 release blockers

| ID | Blocker | Release gate |
|---|---|---|
| `API-001` | Retention and deletion are advertised but not enforced | Data can be deleted per policy and retention is audited |
| `OPS-001` | No publish pipeline or release tag, despite README claims | A tag publishes packages and images reproducibly |
| `OPS-002` | No production deployment, backup/restore or incident runbook | An operator can deploy, restore and roll back from docs |
| `SEC-001` | High-severity production advisories and a non-blocking audit | Audit is required and green, or exceptions are time-boxed |

---

## 3. Backlog

Rows are ordered by priority, then ID, inside each area. The `[WT]` qualifier means the evidence
is an uncommitted working-tree file.

### 3.1 Studio and product (`STU`)

What exists: Operator Console v1, Studio M0/M1 stored-trace debugger, mapping-studio API for
drafts/preview/publish/diff (committed). The mapping editor UI, per-run lineage and
validation-centre pages exist only in the working tree `[WT]`.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `STU-001` | Console discoverability and truthfulness: shipped lineage and validation pages are not linked from navigation or run detail; studio home renders `hb-planned` cards for features that exist; `ApiClient.formats()` has no screen. | `PARTIAL` | `P1` | none | `apps/web/src/app/layout/shell.ts` (nav); `apps/web/src/app/features/studio/studio-home.page.ts` (`PlannedCard` block); `apps/web/src/app/core/api-client.ts` (`formats()`) | [docs/console.md](docs/console.md) | Every shipped route in `app.routes.ts` is reachable from the shell or a run/asset page; no `hb-planned` card describes working code; a navigation E2E test proves both; `formats()` has a screen or is removed. |
| `STU-005` | Cookie-based BFF/OIDC: the console holds an API key in memory; there is no session endpoint, `HttpOnly` cookie, CSRF protection, server-side logout or SSO claim mapping. | `MISSING` | `P1` | none | `apps/web/src/app/core/auth.store.ts`; `apps/web/server.mjs`; `docs/planned/auth-bff-oidc.md` | [docs/planned/auth-bff-oidc.md](docs/planned/auth-bff-oidc.md) | No credential is readable from JavaScript, storage, the URL or logs; OIDC code exchange yields an `HttpOnly` session cookie with CSRF protection; logout invalidates server-side within one request; SSE keeps working; `x-api-key` remains valid for CLI/SDK. |
| `STU-002` | Debugger extensions and per-rule lineage: the stored-trace debugger steps only previous/next event; no breakpoints, jump-to-error, live step or live attach; rule conditions are printed, never evaluated, and trace events are record-level. | `MISSING` | `P2` | none | `apps/web/src/app/features/studio/debugger/debugger.page.ts`; `docs/plan-web-studio.md` (Phase 7+); `docs/planned/data-lineage.md` | [docs/plan-web-studio.md](docs/plan-web-studio.md) | Breakpoints, jump-to-first-error and step over stored traces work; every rule outcome is recorded and shown with rule id and an `observed` or `inferred` label; “live attach” is not advertised until a streaming trace feed exists; unit/E2E tests cover each control. |
| `STU-003` | Schema and asset explorers: no standalone schema route, no per-asset unmapped report, no paginated record browser and no generated-resource viewer; explorers exist only inside the mapping editor. | `PARTIAL` | `P2` | `API-006` | `apps/api/src/controllers/assets.controller.ts` (`GET :id/schema`) `[WT]`; `apps/web/src/app/features/mapping-editor/` `[WT]`; `docs/planned/schema-explorer.md`; `docs/planned/asset-explorer.md` | [docs/planned/schema-explorer.md](docs/planned/schema-explorer.md) | `/studio/schema/:assetId` renders adapter-produced types, nullability and redacted samples; a per-asset unmapped report exists without running a mapping; record preview pages server-side with redaction; unsupported adapters say `not supported`, never empty. |
| `STU-004` | Lineage aggregate and rollup: the lineage page derives a graph from stored traces in the browser; there is no server aggregate endpoint, no first-class nodes for unmapped or dropped fields, and no per-mapping workspace rollup. | `PARTIAL` | `P2` | none | `apps/web/src/app/features/lineage/` `[WT]`; `docs/planned/data-lineage.md` | [docs/planned/data-lineage.md](docs/planned/data-lineage.md) | `GET /api/v1/runs/:id/lineage` returns source, transform, target and dropped nodes with counted edges; a rollup per mapping version is available without scanning every run; the table view alone answers every lineage question. |
| `STU-006` | Multi-workspace and admin settings: identity is a key, not a user; there is no membership model, workspace switcher, workspace settings screen, retention configuration or user administration. | `MISSING` | `P2` | `STU-005` | `apps/api/src/controllers/workspaces.controller.ts` (create/current only; `retentionDays: 90`); `docs/planned/multi-workspace.md` | [docs/planned/multi-workspace.md](docs/planned/multi-workspace.md) | Membership rows grant roles; `GET /workspaces` lists memberships; switching is server-side and audited; a removed membership returns `403`; settings and retention can be updated with validation; no client-side filtering. |
| `STU-007` | Mapping canvas and source-field autocomplete: the rule-table editor exists, but there is no drag-and-drop graph and no field suggestions from the asset schema. | `DEFERRED` | `P3` | none | `apps/web/src/app/features/mapping-editor/mapping-editor.page.ts` `[WT]`; `docs/planned/studio-mapping-editor.md` (non-goals) | [docs/planned/studio-mapping-editor.md](docs/planned/studio-mapping-editor.md) | Canvas work starts only after the M2 exit criteria are met; autocomplete reads `GET /assets/:id/schema`; mapping semantics are not re-implemented in TypeScript; the non-goal is removed from the spec when this starts. |
| `STU-008` | Scenario lab and domain-depth explorers: 4 of 8 scenarios exist; large-file/streaming, genomics, imaging-metadata and research/consent scenarios are absent, as are domain explorers for imaging, genomics, biospecimen, research/consent and waveforms. | `MISSING` | `P3` | `ADP-003`, `ADP-004` | `scenarios/01-hospital-patient-migration` … `scenarios/04-international-formats` (4 of 8); `PLAN.md` §11 and §14 (historical planning snapshot) | none | Eight scenarios each ship data, mapping, expected issues, a README and a test; each domain explorer is labelled with the capability it actually has; no scenario uses real patient data. |
| `STU-009` | Public-health jurisdiction plugins: no jurisdiction profile plugin exists; Phase G remains open solely for this item. | `MISSING` | `P3` | `DEC-005` | `ROADMAP.md` Phase G | none | At least one jurisdiction plugin ships with a capability manifest, synthetic fixtures, conformance tests and docs; Phase G exit criteria are met. |

### 3.2 Validation and clinical (`VAL`)

What exists: structural validation levels 1–3 and local operator-supplied terminology tables
`[WT]`. Profile/terminology levels execute only when a validator or provider is injected.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `VAL-001` | Structural validation breadth: only Patient, Observation, Specimen and the generic `resourceType` requirement are checked; DiagnosticReport and other target resources lack checks; cardinality, choice types and references are not validated. | `PARTIAL` | `P2` | none | `packages/validation/src/index.ts`; `docs/capability-matrix.md` (validation levels) | none | DiagnosticReport and every target-builder resource have structural checks; cardinality, choice-type and reference failures produce `OperationOutcome` issues; executed and skipped levels are reported; tests cover each new check. |
| `VAL-002` | Validation centre: the per-run page exists `[WT]`, but there is no profile registry, no `POST /runs/:id/validate` job and no aggregation of issues across runs. | `PARTIAL` | `P2` | `API-006` | `apps/web/src/app/features/validation-centre/` `[WT]`; `apps/api/src/controllers/runs.controller.ts`; `docs/planned/fhir-validation-centre.md` | [docs/planned/fhir-validation-centre.md](docs/planned/fhir-validation-centre.md) | A profile registry can be listed and selected; validation runs as a durable job with progress; cross-run aggregation is available; every issue names its validator and version; an unexecuted level renders `not run`, never `passed`. |
| `VAL-003` | Licensed terminology servers: only local CSV/JSON code tables with licence metadata exist; there is no integration for LOINC, SNOMED CT, ICD-10/11, RxNorm or ATC. | `MISSING` | `P2` | `DEC-004` | `packages/validation/src/local-terminology.ts` `[WT]`; `ROADMAP.md` Phase F | [docs/planned/fhir-validation-centre.md](docs/planned/fhir-validation-centre.md) | A pluggable provider interface exists per code system with licence metadata; an unavailable provider degrades loudly to `not run`; no unlicensed codeset ships in the repo or image; tests use licensed fixtures or mocks. |

### 3.3 Platform and API (`API`)

What exists: durable MySQL `run_jobs` queue, SSE stage progress, idempotent runs, audit, tenant
isolation, S3 driver `[WT]`, pause/resume `[WT]`, OpenAPI document `[WT]`.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `API-001` | Retention and deletion: workspaces store `retentionDays` but no retention job or delete endpoint exists for assets, runs or workspaces; the API never calls storage `delete`. | `MISSING` | **`P0`** | none | `apps/api/src/controllers/workspaces.controller.ts` (`retentionDays: 90`); `apps/api/src/services/run.service.ts` (retention comments); `packages/storage` (`delete`) | none | Documented `DELETE` endpoints exist for assets, runs and workspaces with the stated policy; a scheduled retention job deletes expired rows and objects and writes audit events; idempotency keys are freed only with their run; tests cover each deletion path. |
| `API-002` | Streaming upload, download and JSON/NDJSON parse: `POST /assets` buffers up to the configured limit via `express.raw`; downloads buffer the object; the JSON adapter buffers; streaming CSV exists only in the SDK/library `[WT]`. | `PARTIAL` | `P1` | none | `apps/api/src/bootstrap.ts` (`express.raw`); `apps/api/src/controllers/assets.controller.ts` (`content` response); `packages/adapters/src/csv.ts` `[WT]`; `packages/sdk/src/csv-file-stream.ts` `[WT]` | [docs/live-execution.md](docs/live-execution.md) `[WT]` | Upload hashes while writing to a temporary content-addressed key and rejects over-limit input without buffering the whole body; download streams; JSON/NDJSON parses with bounded memory or the limitation is explicit in the API contract; a flat-memory test transforms a file larger than the container limit. |
| `API-003` | OpenAPI completeness and generated-client adoption: `CONTROLLERS` omits `MappingStudioController`; the drift test iterates the same incomplete list; the console hand-writes DTOs; `@healthbridge/client` lacks mapping-studio and pause/resume methods. | `PARTIAL` | `P1` | `DEC-001` | `apps/api/src/openapi.ts` (`CONTROLLERS`); `docs/openapi.json` `[WT]` (zero mapping-studio paths); `apps/api/test/openapi.test.ts`; `apps/web/src/app/core/api-types.ts`; `packages/client/src/index.ts` `[WT]` | [docs/openapi-client.md](docs/openapi-client.md) `[WT]` | Every controller registered in `app.module.ts` appears in `CONTROLLERS`; CI fails on any undocumented route, including mapping studio; the document is regenerated; the client covers preview, draft, publish, diff, pause, resume and schema; the console imports generated types or records a decision. |
| `API-004` | S3 depth: the driver supports single-part `PUT` only; no multipart upload, retries, bucket creation, versioning or lifecycle configuration. | `PARTIAL` | `P2` | none | `packages/storage/src/s3.ts` `[WT]`; `docs/storage.md` limitations | [docs/storage-drivers.md](docs/storage-drivers.md) `[WT]` | Objects above 5 GiB use multipart; retries are idempotent; lifecycle/retention configuration is supported; a MinIO contract test passes; credentials never appear in logs, errors, `/healthz` or bundles. |
| `API-005` | Horizontal scaling: rate limiting is per process, SSE streams are per process, pause/resume checkpoints are process-local and progress is stage-level only. | `PARTIAL` | `P2` | `DEC-002` | `apps/api/src/config.ts` (rate limits); `apps/api/src/controllers/runs.controller.ts` (SSE, pause/resume); `apps/api/src/jobs/run-worker.ts` | [docs/planned/queue-broker.md](docs/planned/queue-broker.md); [docs/live-execution.md](docs/live-execution.md) `[WT]` | A shared rate-limit backend exists or a gateway requirement is documented; SSE fan-out works across replicas or a poll fallback is documented; pause/resume survives a replica change; per-record progress is implemented only if the UI advertises it. |
| `API-006` | Record, resource and validation read endpoints: no `GET /assets/:id/records`, no `GET /runs/:id/resources/:resourceId`, no `POST /runs/:id/validate`. | `MISSING` | `P2` | none | `apps/api/src/controllers/assets.controller.ts`; `apps/api/src/controllers/runs.controller.ts`; `docs/planned/asset-explorer.md`; `docs/planned/fhir-validation-centre.md` | [docs/planned/asset-explorer.md](docs/planned/asset-explorer.md) | Asset records page server-side with the trace redaction policy; a single generated resource can be fetched by id; validation can be enqueued as a job with progress; each endpoint enforces its scope and tenant. |
| `API-007` | Readiness and upload hardening: only `/healthz` exists; upload `content-type` is trusted; there is no magic-byte sniffing or per-adapter byte cap. | `MISSING` | `P2` | none | `apps/api/src/controllers/health.controller.ts`; `apps/api/src/controllers/assets.controller.ts` (upload path) | none | `/readyz` reports database, storage and queue readiness; upload sniffing rejects a mismatched content type; each adapter declares and enforces a byte cap; hostile-input tests cover both. |
| `API-008` | Reproducibility policy: run bundles exist, but there is no compatibility matrix across engine upgrades, no stable-ordering guarantee beyond JSON byte comparison and no trace retention/purge rule. | `MISSING` | `P2` | none | `packages/sdk` (run bundles and `reproduce`); `PLAN.md` §17 | none | A bundle compatibility policy is documented per engine version; an incompatible bundle is refused with a coded error; output ordering is stable across platforms; trace retention is specified and enforced. |
| `API-009` | Observability: `/healthz` is the only operational signal; there are no metrics or traces, and no queue latency or retry histograms. | `MISSING` | `P2` | none | `apps/api/src` (no metrics/OTel wiring); `docs/planned/queue-broker.md` | [docs/planned/queue-broker.md](docs/planned/queue-broker.md) | A metrics or OpenTelemetry endpoint exports queue depth, claim latency and retry counts, plus request latency and error rate; a documented dashboard or scrape config exists; tests assert the metric names. |
| `API-010` | Queue broker depth: no dead-letter queue, delayed or priority jobs, per-tenant fairness or retry histograms; BullMQ is opt-in `[WT]` and MySQL `run_jobs` remains the default. | `DEFERRED` | `P3` | `DEC-002` | `apps/api/src/jobs/bullmq-queue.ts` `[WT]`; `apps/api/src/jobs/run-worker.ts`; `packages/persistence/src/migrations.ts` (`run_jobs`) | [docs/planned/queue-broker.md](docs/planned/queue-broker.md) | Work starts only when DEC-002 triggers are met; both drivers pass the same contract suite; DLQ, delayed jobs, priorities and fairness work; controllers and UI need no change when the driver switches. |

### 3.4 Adapters (`ADP`)

What exists: four built-in adapters (CSV, JSON, FHIR R4 JSON, FHIR NDJSON `[WT]`); 13 opt-in
adapters plus an external-validator adapter exist as library exports `[WT]`; all opt-ins are
`metadata-only` except the read-only MySQL connector.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `ADP-001` | Opt-in adapters are library-only: `createBuiltInAdapters()` returns four adapters; the other 13 are exported but no CLI flag, env var, plugin loader or API endpoint registers them, so `formats list` and `/formats` cannot show them. | `OPT-IN/UNWIRED` | `P1` | none | `packages/adapters/src/index.ts` (`createBuiltInAdapters`); `packages/cli/src/index.ts` (`formats list`); `apps/api/src/controllers/health.controller.ts` (`GET /formats`) | [docs/adapter-wave.md](docs/adapter-wave.md) `[WT]` | A documented and tested activation path (env, CLI flag or plugin loader) enables selected adapters; `/formats` and `formats list` show enabled adapters with their limitations; privileged adapters are never auto-loaded; tests cover the disabled and enabled states. |
| `ADP-002` | Runtime conformance and manifest verification: `runAdapterConformance` is called only from tests; `verifyPluginManifest` exists `[WT]` but `registerAdapter` bypasses it; CHANGELOG claims the conformance kit gates every adapter. | `OPT-IN/UNWIRED` | `P1` | none | `packages/adapters/src/kit.ts` (`runAdapterConformance`); `packages/sdk/src/plugins.ts` (`verifyPluginManifest`); `packages/sdk/src/index.ts` (`registerAdapter`) | [docs/adapter-wave.md](docs/adapter-wave.md) `[WT]`; [docs/hardening-and-release.md](docs/hardening-and-release.md) `[WT]` | Every registered adapter passes the conformance suite or is explicitly exempted with a reason; `registerAdapter` enforces the manifest approval or signature policy; CI runs the gate; tests prove a rejected adapter cannot register. |
| `ADP-003` | Clinical adapter depth: HL7 v2 only shapes ADT^A01 and ORU^R01; CDA is metadata-only; XLSX never evaluates formulas; DICOM/DICOMweb expose metadata only; FHIR REST is read-only; FHIR R5/STU3 are not declared supported. | `DEFERRED` | `P3` | none | adapter manifests in `packages/adapters/src/` (`hl7v2.ts`, `xml-cda.ts`, `xlsx.ts`, `dicom.ts`, `dicomweb.ts`, `fhir-rest.ts`) `[WT]`; `docs/capability-matrix.md` | [docs/capability-matrix.md](docs/capability-matrix.md) | Each adapter declares an explicit interpretation scope; new parsing behaviour has fixtures and tests; no adapter infers clinical meaning; R5/STU3 status is explicit in the manifest. |
| `ADP-004` | Research and omics adapter depth: OMOP serves staging CSVs without vocabulary lookup; VCF/FASTQ validate metadata only; PDF text extraction is opt-in and unverified; EDF/WFDB expose headers only; CDISC/ODM and MIABIS are metadata-only. | `DEFERRED` | `P3` | none | `packages/adapters/src/omop.ts`, `vcf.ts`, `fasta.ts`, `pdf.ts`, `edf.ts`, `cdisc-odm.ts` `[WT]`; `packages/validation/src/miabis.ts` `[WT]`; `docs/capability-matrix.md` | [docs/capability-matrix.md](docs/capability-matrix.md) | Each adapter declares extraction, vocabulary or annotation scope with licence constraints; new behaviour has fixtures and tests; metadata-only status changes only with the manifest and matrix. |

### 3.5 CLI and SDK (`CLI`)

What exists: CLI stdin, encoding/delimiter overrides, shell completions and per-command help
`[WT]`; SDK progress callbacks, streaming output and `AbortSignal` cancellation.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `CLI-001` | No streamed output path or `--watch` for very large runs; the CLI writes transformed output after the run completes. | `MISSING` | `P3` | none | `packages/cli/src/index.ts` (`transform`); no `createWriteStream` or `--watch` in `packages/cli/src`; `packages/cli/src/completions.ts` `[WT]` | [docs/cli.md](docs/cli.md) | `transform --format ndjson` streams resources to stdout or a file without buffering the full result; `--watch` reruns deterministically when the input changes; help and docs describe both; tests cover streaming and cancellation. |

### 3.6 Operations and release (`OPS`)

What exists: CI matrix, Docker Compose demo, packaging gate and a manual release-pack workflow.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `OPS-001` | No publish pipeline: `release.yml` builds, tests and packs tarballs but deliberately has no npm publish or GHCR push; README claims both; no release tag exists. | `MISSING` | **`P0`** | none | `.github/workflows/release.yml` (header and steps); `README.md` “Packaging and releases”; no git tags or remote | [docs/hardening-and-release.md](docs/hardening-and-release.md) `[WT]` | A tag-driven workflow publishes all 17 packages with provenance and pushes API/web images to GHCR after build, tests and pack pass; `NPM_TOKEN` and scope ownership are documented; a release fails without a changelog entry; PRs cannot publish. |
| `OPS-002` | No production deployment guide, backup/restore procedure, upgrade/rollback or incident runbook; the only compose file is a demo with demo credentials and no resource limits or seeding. | `MISSING` | **`P0`** | none | `README.md` “Docker Compose” (“no production deployment guide yet”); `docker/compose.demo.yaml`; `PLAN.md` §12 | none | A deployment guide covers MySQL, persistent storage, TLS, secrets, console access and health checks; a backup/restore drill is documented and tested; upgrade, rollback and incident runbooks exist; a production compose profile sets limits and seeding. |
| `OPS-003` | Configuration completeness: `.env.example` omits S3, Redis, key TTL, key-usage and preview-limit variables and duplicates queue variables; the README configuration table is also incomplete. | `PARTIAL` | `P1` | none | `.env.example` (queue duplicates; no S3/Redis); `apps/api/src/config.ts`; `README.md` “Configuration” | none | Every key parsed by `config.ts` appears exactly once in `.env.example` and in the README table; a check script or test fails on drift; no secret values are committed. |
| `OPS-004` | Missing required CI gates: component-DOM tests, benchmark regression, docs-site link checking, runtime adapter conformance and container scan/SBOM/signing are not required on pull requests. | `PARTIAL` | `P1` | `QUA-001` | `.github/workflows/ci.yml`; `.github/workflows/release.yml`; `docs/hardening-and-release.md` `[WT]` | [docs/hardening-and-release.md](docs/hardening-and-release.md) `[WT]` | Each listed gate runs on pull requests and is a required check; any temporary exception is written in the workflow with an owner and removal condition; a failing gate blocks merge. |
| `OPS-005` | No load/soak or cross-browser testing; Playwright runs Chromium only. | `MISSING` | `P2` | none | `PROGRESS.md` §7 (“Not run”); Playwright configuration | none | A repeatable load/soak profile with documented thresholds exists and runs nightly or on demand; Firefox and WebKit are covered or explicitly documented as unsupported on a named date. |

### 3.7 Security and privacy (`SEC`)

What exists: hashed API keys, scopes/roles, tenant isolation, rate limiting, trace redaction and a
security test suite `[WT]`.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `SEC-001` | Production dependency advisories remain, and `npm audit --omit=dev --audit-level=high` is non-blocking via `continue-on-error`; README and SECURITY do not state a clean audit. | `PARTIAL` | **`P0`** | none | `.github/workflows/ci.yml` (`dependency-audit`, `continue-on-error: true`); `SECURITY.md` | none | Zero high/critical production advisories, or every exception is documented with an owner and expiry; the audit job is required; Dependabot remains green; the README claim matches the result. |
| `SEC-003` | Encryption at rest and TLS: no KMS or envelope encryption exists, and TLS termination is entirely a deployment responsibility with no verified configuration. | `MISSING` | `P1` | `OPS-002` | `SECURITY.md` (“Data at rest and in transit”); `README.md` security section | none | The encryption architecture is documented; KMS/envelope encryption is implemented or a deployment checklist is verified end to end; TLS termination is in the runbook; no production PHI claim is made without both. |
| `SEC-002` | Plugin sandbox and signature: third-party adapters run in-process with full filesystem and network access; there is no sandbox and no cryptographic signature; the manifest gate is unreachable from `registerAdapter`. | `MISSING` | `P2` | none | `SECURITY.md` (“Plugins are privileged code”); `packages/sdk/src/plugins.ts` `[WT]`; `packages/sdk/src/index.ts` (`registerAdapter`) | [SECURITY.md](SECURITY.md) | A deny-by-default capability boundary or a documented sandbox limits filesystem and network access; signatures are verified before registration; tests prove an unapproved or tampered adapter cannot run; the threat model is updated. |
| `SEC-004` | Upload validation: the API trusts the declared content type; there is no magic-byte detection and no per-adapter byte cap. | `MISSING` | `P2` | `API-007` | `apps/api/src/controllers/assets.controller.ts` (upload path) | [SECURITY.md](SECURITY.md) | Supported formats are sniffed and mismatches rejected; each adapter enforces a byte cap; XXE and zip-bomb regression tests fail closed; no partial object is stored on rejection. |
| `SEC-005` | Secret management beyond environment variables, signed expiring exports and a written threat model are absent. | `MISSING` | `P3` | none | `SECURITY.md`; `PLAN.md` §13 | none | A threat-model document is committed; a secret-provider interface can replace env-only configuration; export links are signed and expire without bypassing API auth or redaction; tests cover expiry and revocation. |

### 3.8 Quality and documentation (`QUA`)

What exists: 313-test `node:test` suite, Playwright E2E, axe checks, a benchmark script `[WT]`, a
docs-site generator `[WT]` and two component specs `[WT]`.

| ID | Capability and gap | Status | Pri | Depends | Evidence | Spec | Acceptance (done when) |
|---|---|---|---|---|---|---|---|
| `QUA-001` | Component-DOM tests are not a CI gate; the harness exists `[WT]` but `test:unit` is not in CI and ConnectPage/RunsPage specs are absent. | `PARTIAL` | `P1` | none | `vitest.config.mts` `[WT]`; `apps/web/src/app/core/auth.store.spec.ts` `[WT]`; `apps/web/src/app/ui/primitives.spec.ts` `[WT]`; `.github/workflows/ci.yml` | [docs/planned/component-tests.md](docs/planned/component-tests.md) | A required headless `test:unit` job runs in under two minutes; specs cover StatusChip, ErrorPanel, ConnectPage validation, RunsPage filters/pagination and AuthStore 401/403 behaviour; assertions target roles and labels; no visual-regression or coverage-percentage gate is added. |
| `QUA-002` | Documentation truth pass: README, ROADMAP, PROGRESS and several planned specs contradict the code (see Appendix A); README claims publishing, wiring and testing that do not exist. | `PARTIAL` | `P1` | none | `README.md`; `ROADMAP.md`; `PROGRESS.md`; `docs/planned/*` | none | Every DRIFT row is corrected or explicitly deferred in this file; README claims match code and CI; a cross-document consistency check is documented; the baseline box in this file is updated on the next truth pass. |
| `QUA-003` | Capability matrix is hand-maintained and its counts are wrong: 3 vs 4 migrations, 13 vs 14 transforms and 15 vs 17 packages. | `PARTIAL` | `P2` | none | `docs/capability-matrix.md`; `packages/` (17 directories); `packages/persistence/src/migrations.ts` (4); `README.md` | none | The matrix is generated from adapter manifests and `package.json` and diffed in CI; statuses and counts match `/formats` and the code; a stale matrix fails the build. |
| `QUA-004` | No adapter authoring guide; CONTRIBUTING has only a checklist, so a new adapter has no end-to-end tutorial. | `MISSING` | `P2` | none | `CONTRIBUTING.md` (“New adapter checklist”); `PLAN.md` §15 | none | A guide covers manifest, fixtures, contract/conformance tests, capability-matrix update and CLI/API visibility; it is linked from README and CONTRIBUTING; a contributor can add an adapter without reading the source of an existing one. |

---

## 4. How the backlog is ordered

The ordering is deliberately consequence-first, not effort-first:

1. **P0** — release truth and safety: retention/deletion, publishing, deployment/recovery,
   dependency security.
2. **P1** — advertised capabilities that are currently misleading or incomplete: console
   discoverability, BFF auth, streaming upload, OpenAPI/client contract, adapter activation and
   conformance, configuration completeness, required CI gates, encryption, component tests and
   documentation truth.
3. **P2** — depth once the foundation is honest: debugger/lineage/schema/validation depth, S3
   depth, scaling, observability, readiness, reproducibility, plugin isolation, upload hardening,
   matrix generation and authoring guide.
4. **P3** — deferred scope: mapping canvas, extra scenarios, jurisdiction plugins, queue-broker
   depth, adapter interpretation depth, CLI streaming/watch, secret management and signed exports.

No dates are implied. `DEFERRED` items are not commitments.

---

## 5. Open decisions

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| `DEC-001` | Should OpenAPI be served over HTTP, or remain a committed document plus generated client? | Keep it committed and CI-diffed in v1; serve it only if a consumer requires it. | `API-003` |
| `DEC-002` | Should the project commit to a broker (Redis/BullMQ), or keep MySQL `run_jobs` as the only supported default? | Keep MySQL default; add broker features only when measured claim latency, contention or delayed work requires them. | `API-005`, `API-010` |
| `DEC-003` | Which identity provider and membership model should back the BFF and multi-workspace sessions? | OIDC with a server-side session store and a user-to-workspace membership table; no client-side filtering. | `STU-005`, `STU-006` |
| `DEC-004` | Which terminology systems will be licensed, and will validation use operator-supplied tables or a hosted server? | Decide code systems and licence procurement before building a provider; keep unlicensed codesets out of the repo. | `VAL-003` |
| `DEC-005` | Which public-health jurisdictions and profiles are in scope for Phase G? | Name the jurisdictions and profiles before writing a plugin. | `STU-009` |
| `DEC-006` | What is the production storage and encryption model: S3 plus KMS, or deployment-managed disk plus external encryption? | Choose S3 plus KMS/envelope encryption if the project will store PHI; otherwise publish a verified deployment checklist. | `SEC-002`, `SEC-003` |

---

## 6. Deferred and non-goals

These are deliberately excluded. They are **not** missing features and must not appear in the
backlog or its counts. If a non-goal is revisited, create a decision first.

| ID | Non-goal | Why excluded | Revisit trigger |
|---|---|---|---|
| `NG-001` | Autonomous diagnosis, triage or treatment advice | HealthBridge is a data interoperability layer, not clinical decision support. | Never; product boundary. |
| `NG-002` | Regulatory certification (CE, FDA, MDR class, HIPAA/GDPR compliance) | Requires a quality system, clinical evaluation and audits, not code. | A notified-body programme exists. |
| `NG-003` | Inferring clinical meaning from column names | Guessing produces confidently wrong FHIR. | A terminology-backed, reviewed inference feature is designed. |
| `NG-004` | Silent coercion of ambiguous dates, units or codes | Ambiguity is rejected and reported instead. | Never; invariant. |
| `NG-005` | Promise of complete PHI removal or anonymisation | Trace redaction protects traces; stored resources are the point. | A separately scoped anonymisation product. |
| `NG-006` | JavaScript-expression transforms in mappings | Mapping files would become an RCE path. | A sandboxed expression engine is designed and reviewed. |
| `NG-007` | Exactly-once queue semantics | At-least-once plus pure runs is sufficient and simpler. | A workload requires exactly-once side effects. |
| `NG-008` | CDN signed URLs that bypass API authentication and redaction | They would expose unredacted objects. | A redaction-preserving signed-URL design exists. |
| `NG-009` | Social login, self-service signup or password storage | The console is a single-operator administrative tool. | A multi-tenant identity product is scoped. |
| `NG-010` | Cross-workspace dashboards and cross-run lineage joins | Tenant isolation and query cost. | A batch analytics product is scoped. |
| `NG-011` | Record editing, ad-hoc query language or filtered-subset export | The explorer is read-only by design. | A separate data-editing product. |
| `NG-012` | Clinical validation, FHIR Shorthand authoring or a terminology server bundled in-repo | The project validates structure; terminology is licensed infrastructure. | A licensed deployment programme exists. |
| `NG-013` | Visual-regression snapshots and coverage-percentage gates | They add noise without proving behaviour. | A measured need appears. |
| `NG-014` | API stability before 1.0 and penetration-test claims | The API may change; external review is separate. | A 1.0 compatibility commitment or external audit is funded. |
| `NG-015` | DICOM pixel data/transcoding and clinical interpretation by adapters | The adapters are metadata and structure tools. | A dedicated imaging product is scoped. |

---

## Appendix A — Documentation contradictions

Audit only: these rows are not backlog items and have no priority or acceptance criteria. They
record where a document is wrong about the code so `QUA-002` can correct it. `[WT]` means the code
truth exists only in the working tree.

| ID | Document and section | Claim | Code truth | Correct statement | Disposition |
|---|---|---|---|---|---|
| `DRIFT-001` | `README.md` introduction and “What works today” | “Three format adapters” | Four built-ins: CSV, JSON, FHIR R4 JSON, FHIR NDJSON `[WT]`; 13 opt-ins exist `[WT]` | Four built-ins plus opt-in adapters | Correct in the next truth pass. |
| `DRIFT-002` | `README.md` “Packages” | “All 15 library packages” | `packages/` contains 17: `client` and `fhir-ndjson` are missing from the table | 17 packages | Correct count and add the two rows. |
| `DRIFT-003` | `README.md` “Limitations and non-goals” | S3 driver “is not yet wired into `app.context`” | `apps/api/src/app.context.ts` selects `S3StorageDriver` when configured `[WT]` | S3 is implemented and auto-selected; local/memory remain defaults | Correct and link `docs/storage.md`. |
| `DRIFT-004` | `README.md` “Packaging and releases” | Release workflow “publishes workspace packages … and pushes API/web images to GHCR” | `.github/workflows/release.yml` only builds, tests, packs and uploads tarballs; no publish or Docker push | No publish pipeline exists; see `OPS-001` | Correct the claim; do not describe publishing until `OPS-001` lands. |
| `DRIFT-005` | `README.md` “Configuration”; `.env.example` | `.env.example` documents the full set | Missing S3/Redis/TTL/key-usage/preview variables; queue concurrency and max-attempts are duplicated; README table omits the same keys | The example is incomplete; see `OPS-003` | Complete both when `OPS-003` lands. |
| `DRIFT-006` | `README.md` “Limitations and non-goals” | “there is no streaming upload or streaming CSV parse” | CSV tokenization, bounded batches and SDK file streaming exist `[WT]`; API upload still buffers | Streaming CSV exists in the engine/SDK; only API upload and JSON/NDJSON parse remain | Narrow the claim to the remaining gap. |
| `DRIFT-007` | `README.md` “Limitations and non-goals” | “No component-level DOM tests” | Vitest harness and two specs exist `[WT]`; no CI gate | A component-test harness exists; the gap is CI wiring and coverage | Point to `QUA-001`. |
| `DRIFT-008` | `ROADMAP.md` Phase D | “Still open: … pipeline runs in the UI” | `apps/web/src/app/features/pipelines/` creates, lists and runs pipelines; README and `PROGRESS.md` say shipped | Pipeline runs are shipped | Remove the open item. |
| `DRIFT-009` | `ROADMAP.md` Phase C closing paragraph | “The API stays Partial until the broker and OpenAPI items land” | OpenAPI document exists `[WT]`; the broker is explicitly “not planned” | The criterion is unsatisfiable as written; the API remains partial for streaming, progress and scaling reasons | Rewrite the exit criterion. |
| `DRIFT-010` | `ROADMAP.md` Phase B vs Phase C | Phase B marks streaming CSV not started; Phase C says it landed | CSV streaming landed `[WT]` | Phase B is stale; Phase C is correct | Reconcile Phase B. |
| `DRIFT-011` | `PROGRESS.md` snapshot and “Open work” | HEAD `b7eccb7`, tree clean, “Studio M2+ … no code”, OpenAPI open | HEAD `c7533e6`; 142 dirty paths; mapping-studio API is committed; OpenAPI and much Studio UI are `[WT]` | The snapshot is stale and the backlog order no longer matches reality | Update after the working tree is committed. |
| `DRIFT-012` | `docs/planned/*.md` “What is missing” sections | Studio, schema, lineage, validation, live execution, storage, OpenAPI, adapters, hardening and component tests are described as missing in whole | Shipped slices exist for each `[WT]` | The specs need “shipped slice” and “remaining gap” sections | Rewrite each spec when touched. |
| `DRIFT-013` | `docs/console.md` limitations | “No OpenAPI-generated client” and “No component-level DOM tests” | A generated-document/client package exists `[WT]`; the console still hand-writes DTOs; two component specs exist `[WT]` | Partially stale; the console does not consume the generated client | Correct and link `API-003`/`QUA-001`. |
| `DRIFT-014` | `docs/api.md` endpoint and configuration tables | Omits `GET /assets/:id/schema`, pause/resume semantics and S3/Redis configuration | Endpoints and configuration exist `[WT]` | The API reference is incomplete | Add the missing endpoints and env vars. |
| `DRIFT-015` | `ARCHITECTURE.md` §5; `docs/capability-matrix.md` | “Thirteen deterministic transforms”; “3 migrations” | Fourteen transforms; four migrations (`packages/persistence/src/migrations.ts`) | Update both counts | Correct in the next truth pass. |
| `DRIFT-016` | `vitest.config.mts`; `CHANGELOG.md` | Config points to a non-existent `docs/component-tests.md`; changelog says the conformance kit gates every adapter | The file is `docs/planned/component-tests.md`; conformance runs only in tests | Fix the pointer; qualify the conformance claim | Correct both; `ADP-002` makes the claim true. |

---

## Appendix B — Shipped guard list and verification log

Use this list to avoid filing implemented work as missing. “Committed” means present at HEAD
`c7533e6`; `[WT]` means present only in the uncommitted working tree.

### B.1 Committed at HEAD

| Capability | Evidence | Note |
|---|---|---|
| Core contracts, envelope, checksum and path utilities | `packages/shared-types`, `packages/core` | Do not reopen. |
| CSV, JSON and FHIR R4 JSON adapters | `packages/adapters/src/index.ts` | FHIR NDJSON is `[WT]`. |
| Mapping engine, deterministic transforms, rule chaining, coverage | `packages/mapping-engine` | README documents 14 transforms; verify with tests, not README counts. |
| Transformation pipeline and trace protocol | `packages/transformation-engine`, `packages/trace-protocol` | Trace redaction by default. |
| Structural validation, target builders and FHIR R4 types | `packages/validation`, `packages/target-builders`, `packages/fhir-r4` | Profile/terminology levels are opt-in. |
| Persistence, repository contracts, migrations, auth, local/memory storage | `packages/persistence`, `packages/auth`, `packages/storage` | Four migrations at HEAD. |
| CLI commands and SDK façade | `packages/cli`, `packages/sdk` | Stdin, overrides, completions and progress/cancellation are `[WT]`. |
| REST API, tenant isolation, queue, SSE, audit, idempotency | `apps/api/src` | Pause/resume, S3 and BullMQ are `[WT]`. |
| Operator Console v1 routes and pages | `apps/web/src/app/app.routes.ts`, `features/` | Lineage and validation pages are `[WT]` and unlinked. |
| Studio M0/M1 stored-trace debugger | `features/studio/debugger/` | No breakpoints, live step or live attach. |
| Mapping-studio API: draft, preview, publish, diff | `apps/api/src/controllers/mapping-studio.controller.ts` | The mapping-editor UI and route are `[WT]`. |

### B.2 Working tree only `[WT]`

| Capability | Evidence | Note |
|---|---|---|
| 13 opt-in adapters and the external validator adapter | `packages/adapters/src/{hl7v2,xml-cda,xlsx,dicom,dicomweb,fhir-rest,omop,vcf,fasta,pdf,edf,cdisc-odm,mysql-connector,fhir-validator}.ts` | Library exports only; not registered by default. |
| FHIR NDJSON package | `packages/fhir-ndjson/` | Fourth built-in when wired. |
| S3 object storage and driver selection | `packages/storage/src/s3.ts`, `apps/api/src/app.context.ts` | Single-part PUT only. |
| Pause/resume and chunked checkpoints | `apps/api/src/controllers/runs.controller.ts`, `apps/api/src/jobs/run-worker.ts` | Process-local. |
| Asset schema endpoint and embedded explorers | `apps/api/src/controllers/assets.controller.ts`, `apps/web/src/app/features/mapping-editor/` | No standalone schema route. |
| Lineage and validation-centre pages | `apps/web/src/app/features/lineage/`, `features/validation-centre/` | Unlinked; per-run only. |
| Mapping editor UI and route | `apps/web/src/app/features/mapping-editor/`, `app.routes.ts` | Rule table, preview and coverage; no canvas. |
| OpenAPI generator and committed document | `apps/api/src/openapi.ts`, `apps/api/src/generate-openapi.ts`, `docs/openapi.json` | Mapping-studio paths omitted. |
| `@healthbridge/client` | `packages/client/` | Handwritten DTOs; missing studio/pause/resume methods. |
| BullMQ queue driver | `apps/api/src/jobs/bullmq-queue.ts` | Opt-in; MySQL default. |
| CLI completions, help, overrides and stdin | `packages/cli/src/{completions,help,overrides}.ts`, `packages/cli/test/{flags,stdin}.test.ts` | Do not list as missing. |
| SDK streaming, progress and cancellation | `packages/sdk/src/index.ts` (`transformStream`, `onProgress`, `AbortSignal`), `packages/sdk/src/csv-file-stream.ts` | Do not list as missing. |
| Component-test harness and two specs | `vitest.config.mts`, `apps/web/src/app/{core/auth.store.spec.ts,ui/primitives.spec.ts}` | No CI gate. |
| Benchmark, docs-site and security suites | `scripts/benchmark.mjs`, `scripts/docs-site.mjs`, `packages/adapters/test/security.test.ts` | Some gates are not in CI. |
| Local terminology and MIABIS validators | `packages/validation/src/local-terminology.ts`, `packages/validation/src/miabis.ts` | Local tables only; no licensed server. |

### B.3 Verification log

| Check | Command | Result |
|---|---|---|
| Branch and commit | `git branch --show-current && git rev-parse --short HEAD` | `main`, `c7533e6` |
| Dirty paths | `git status --porcelain=v1 \| wc -l` | 142 (87 untracked, 50 modified, 5 deleted) |
| Remote and tags | `git remote -v`, `git tag` | none |
| Built-in adapters | `packages/adapters/src/index.ts` (`createBuiltInAdapters`) | four |
| Package count | `ls packages` | 17 |
| Mapping-studio paths in OpenAPI | `grep` on `docs/openapi.json` | zero |
| CI audit gate | `.github/workflows/ci.yml` | `continue-on-error: true` |
| Publish steps | `.github/workflows/release.yml` | none |
| Migration count | `packages/persistence/src/migrations.ts` | 4 |
| Console navigation | `apps/web/src/app/layout/shell.ts` | no lineage/validation links |

> This appendix is a snapshot, not a permanent truth. Re-run the commands when the working tree
> is committed or when an item here changes; update the baseline box at the top of this file.
