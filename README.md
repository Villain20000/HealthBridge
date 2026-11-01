# HealthBridge OS

[![CI](https://github.com/Villain20000/HealthBridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Villain20000/HealthBridge/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

> Open-source medical data interoperability, transformation and debugging toolkit.
>
> **Status: developer preview (v3.2.0).** Four built-in format adapters (CSV, JSON,
> FHIR R4 JSON, FHIR NDJSON) plus 13 opt-in adapters, a platform API with
> persistence, authentication, an asynchronous run queue (durable MySQL default, opt-in
> BullMQ), retention enforcement and a generated OpenAPI contract, and a working Angular
> **Operator Console** on top of it. Everything else is listed honestly in
> [ROADMAP.md](ROADMAP.md) — this repository does not advertise features it has not implemented.

**Where to look:** [PROGRESS.md](PROGRESS.md) — implemented and verified work plus the
ordered backlog. [docs/planned/](docs/planned/README.md) — a written spec for every
capability that is **not** built yet (no fake UI, no implied features).

HealthBridge OS is a developer layer that sits between incompatible healthcare systems. It
imports a dataset, builds a format-independent envelope, applies a declarative mapping, and
reports exactly what was mapped, what was rejected and what was lost — with a redacted trace
of every step.

**Not a hospital information system. Not an electronic medical record. Not a diagnostic tool.
Not a clinical decision-support system.**

---

## Table of contents

- [Why HealthBridge OS](#why-healthbridge-os)
- [What works today](#what-works-today)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [CLI](#cli)
- [Mapping engine](#mapping-engine)
- [Trace protocol and PHI safety](#trace-protocol-and-phi-safety)
- [REST API](#rest-api)
- [Operator Console](#operator-console)
- [Docker Compose](#docker-compose)
- [Configuration](#configuration)
- [Security](#security)
- [Verified scenarios](#verified-scenarios)
- [Testing and CI](#testing-and-ci)
- [Packaging and releases](#packaging-and-releases)
- [Repository layout](#repository-layout)
- [Design principles](#design-principles)
- [Limitations and non-goals](#limitations-and-non-goals)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why HealthBridge OS

Healthcare integrations fail in quiet ways: a date is guessed instead of rejected, a gender
code falls through to `unknown`, an unmapped column disappears, and nobody can explain why the
output looks the way it does. The result is a file that parses but is clinically or
operationally wrong.

HealthBridge OS is built around the opposite default:

- **Detect, parse, map, report.** Every dataset goes through the same pipeline and produces the
  same structured result, whether you run it from the CLI, the SDK or the API.
- **No silent data loss.** Unmapped source fields, rejected values and failed records are
  counted and reported (`coverage`, `dataLoss`, `rejectedRecords`, `issues`).
- **Deterministic transformations.** Ambiguous dates are rejected rather than guessed;
  transform failures reject the value instead of writing something wrong.
- **Redacted traces by default.** Every stage emits a trace event, and patient-data scalars are
  masked unless you explicitly opt out for local debugging.
- **Reproducible runs.** A run bundle records versions, mapping, options and checksums — but
  never patient data — so the same output can be replayed and verified byte for byte.
- **Honest capability manifests.** Adapters publish what they can actually do, including their
  limitations, and the CLI prints the same status the code enforces.

The project is useful for migration spikes, interface debugging, synthetic-data generation,
pipeline regression testing, and as a foundation for a visual transformation debugger.

---

## What works today

| Capability | Status | Notes |
|---|---|---|
| CSV / TSV adapter (RFC 4180) | **Supported** | Quoted and multiline cells, CRLF, BOM, UTF-16, Windows-1252 fallback, `, ; \t \|` delimiter detection, ragged-row and duplicate-header reporting |
| JSON adapter | **Supported** | Object or array of objects; no streaming JSON parser |
| FHIR R4 JSON adapter | **Partial** | Single resource and `Bundle` (NDJSON lives in `@healthbridge/fhir-ndjson`); structural inspection only — no profile or terminology validation |
| Canonical Medical Data Envelope | **Supported** | SHA-256 checksum, physical source location, encoding, domain classification, parse issues, unmapped fields |
| Declarative mapping engine | **Supported** | 14 deterministic transforms (incl. `convert_units` on a validated UCUM subset), conditional rules, rule-output chaining (`__rule.`), opt-in cross-record context (`allowCrossRecordContext`), array-aware target paths, coverage and rejection reporting, static mapping validation |
| Trace protocol v1.2 | **Supported** | Staged events, span ids, protocol version, structural redaction by default |
| CLI (`@healthbridge/cli`) | **Supported** | `doctor`, `init`, `formats`, `inspect`, `transform`, `validate`, `trace`, `reproduce`, `demo`, `plugins`, `examples` |
| TypeScript SDK (`@healthbridge/sdk`) | **Supported** | File or inline input, inspect, detect, transform, replay, trace export, run bundle verification |
| FHIR validation | **Partial** | Structural checks for Patient, Observation, Specimen and the generic `resourceType` requirement; profile, terminology and referential levels are **not** executed and the CLI says so |
| NestJS REST API (`@healthbridge/api`) | **Partial** | MySQL or in-memory persistence, HMAC API keys with scopes and roles, tenant isolation, async runs with idempotency, SSE progress, traces/bundles/replay, audit trail. The queue is the durable `run_jobs` table in database mode and in-process only in demo mode (no broker); OpenAPI committed at `docs/openapi.json` and diffed in CI (not served over HTTP) — see [docs/api.md](docs/api.md) |
| Operator Console (`apps/web`) | **Supported (v1)** | Angular 19, standalone components + signals: connect, health, dashboard, runs (cursor pagination, submit, cancel, replay), run detail with issues/resources/traces/bundle, live SSE progress, asset upload, mappings, pipelines (create + run), API keys, audit log, dark/light themes. API key kept in memory only. Studio slices shipped: mapping rule-table editor (keyboard-complete, client-side static validation, version history), read-only schema explorers, lineage graph view and validation centre; the VS Code-style three-pane debugger extensions remain planned — see [docs/console.md](docs/console.md) and [docs/plan-web-studio.md](docs/plan-web-studio.md) |
| MySQL connector | **Partial (opt-in)** | Read-only allowlisted SELECT with chunked streaming via `mysql-connector` (`transformToFHIR: true`); not in the built-in set. All other adapters (HL7 v2, CDA/XML, VCF, FASTA/FASTQ, XLSX, DICOM, FHIR REST, OMOP, PDF, EDF/WFDB) are opt-in `metadata-only` — see [ROADMAP.md](ROADMAP.md) and [docs/capability-matrix.md](docs/capability-matrix.md) |

The CLI and the console read the same adapter manifests, so the status they print matches the
table above and the tests behind it.

---

## Architecture

```text
                 ┌──────────────────────────────────────────────────────────────┐
 input file ───► │ Adapter registry ─► adapter.parse() ─► Canonical envelope    │
 (CSV/JSON/FHIR) │        │                                              │      │
                 │        ▼                                              ▼      │
                 │  scored detection                            Mapping engine   │
                 │                                                      │      │
                 │                                                      ▼      │
                 │  TraceCollector ◄────────────── Transformation pipeline      │
                 └──────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
                CLI result          SDK result       TransformationResult
                                                        │
                                              REST API (NestJS) ─► MySQL + object storage
                                                        ▲
                                         Angular Console ─► /api proxy
```

The same pipeline runs everywhere. The REST API does not re-implement transformation logic: a
run executes `@healthbridge/sdk` against bytes in object storage, and every number it reports
comes from the engine's own `TransformationResult`. The console talks only to the API.

### Data flow

1. **Detect** — the adapter registry scores candidates by format, structure and file evidence.
2. **Parse** — the selected adapter yields `MedicalDataEnvelope` records. Each envelope carries
   the source format, SHA-256 checksum, encoding, physical location (`line 12`, `$[3]`),
   sensitivity classification and parse issues.
3. **Map** — declarative rules read source paths and write array-aware target paths. Conditions
   gate rules; a failed transform rejects the value, and a missing required value rejects the
   record.
4. **Report** — coverage is computed on source leaf paths, then aggregated across records into
   rejected records, data-loss entries and warnings such as duplicate resource ids or low
   coverage.
5. **Trace** — every stage emits an event with span ids, versions, durations, issues and a
   redaction state. Resources are stored as produced; traces are redacted by default.

### Packages

All 17 library packages are named under the `@healthbridge/*` scope at version 3.2.0. They are
built with TypeScript project references and are installable independently (not yet on npm — see
[Packaging and releases](#packaging-and-releases)).

| Package | Purpose |
|---|---|
| `@healthbridge/shared-types` | Public contracts: envelope, capabilities, issues, traces, coverage, data loss |
| `@healthbridge/trace-protocol` | Trace collector, redaction policy, report export |
| `@healthbridge/core` | Adapter registry, checksum, sensitivity policy, path utilities |
| `@healthbridge/adapters` | CSV, JSON and FHIR R4 JSON adapters (plus 13 opt-in adapters; NDJSON in `@healthbridge/fhir-ndjson`) |
| `@healthbridge/fhir-ndjson` | FHIR NDJSON adapter (fourth built-in) |
| `@healthbridge/client` | Typed REST client over the platform API |
| `@healthbridge/mapping-engine` | Declarative rules, 14 deterministic transforms, chaining, opt-in cross-record context, coverage, static validation |
| `@healthbridge/transformation-engine` | Pipeline: detect → parse → map → report |
| `@healthbridge/fhir-r4` | FHIR R4 resource interfaces |
| `@healthbridge/validation` | Structural FHIR validation and `OperationOutcome` output |
| `@healthbridge/lineage-engine` | Lineage graph builder |
| `@healthbridge/sdk` | Offline façade over the engine, run bundles and replay |
| `@healthbridge/cli` | Command-line interface |
| `@healthbridge/auth` | API keys, roles, scopes, token-bucket rate limiting |
| `@healthbridge/storage` | Content-addressed object storage (local filesystem, memory, opt-in S3) |
| `@healthbridge/persistence` | Workspace-scoped repositories (memory and MySQL, migrations) |
| `@healthbridge/target-builders` | Target-format builders that turn mapped objects into valid resources |

`packages/mapping-engine` imports only `shared-types`, so the rule engine can be reused without
the adapter layer. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full package graph and data
model.

---

## Quickstart

### Prerequisites

- **Node.js >= 22** (the CI matrix covers 22 and 24)
- npm 11+ (the repository pins `packageManager: npm@11.19.1`)
- No database, Redis or Docker needed for the CLI, SDK or the offline test suite

### Install and build

```bash
git clone https://github.com/Villain20000/HealthBridge.git
cd HealthBridge
npm ci
npm run build
npm test
```

`npm test` runs the full `node:test` suite through `scripts/run-tests.mjs`. It is offline by
default; the live-MySQL integration suite runs only when `HEALTHBRIDGE_TEST_MYSQL_URL` is set.

### First transformation

```bash
# environment self-check: probes adapters and runs a real CSV → mapping → trace self-test
node packages/cli/dist/bin.js doctor

# see what is actually supported, per adapter
node packages/cli/dist/bin.js formats list

# inspect a synthetic dataset
node packages/cli/dist/bin.js inspect datasets/synthetic-patients.csv

# transform to FHIR R4 Patient resources
node packages/cli/dist/bin.js transform datasets/synthetic-patients.csv \
  --mapping examples/patient-mapping.json --out patients.fhir.json

# structural validation (exits 3 when invalid)
node packages/cli/dist/bin.js validate patients.fhir.json --json

# deterministic broken-data generator for debugging practice
node packages/cli/dist/bin.js demo generate --profile broken-dates --seed 42 --records 10

# SDK example: transform, inspect coverage, replay the same run
npx tsx examples/run-sdk-example.ts
```

`transform` prints a one-line summary to stderr —
`status=… records=x/y coverage=z% unmapped=n rejected=n run=…` — and writes the resources to
`--out` or stdout. Use `--json` to get the full result envelope, including coverage, issues,
data loss and traces.

The CLI is **not published to npm yet**. Until the first release, install it from a local
checkout with `npm link --workspace @healthbridge/cli` (the command is then `healthbridge`), or
run `node packages/cli/dist/bin.js` directly after `npm run build`.

### SDK

```typescript
import { readFileSync } from "node:fs";
import { HealthBridge } from "@healthbridge/sdk";

// The SDK takes a parsed MappingDefinition; the CLI also accepts YAML files.
const mapping = JSON.parse(readFileSync("./mapping.json", "utf8"));
const bridge = new HealthBridge({ debug: { payloadMode: "redacted" } });

const result = await bridge.transform({
  input: "./patients.csv", // path, buffer or inline string
  mapping,
});

console.log(result.status); // completed | completed_with_warnings | failed
console.log(result.coverage.coveragePercentage);
console.log(result.rejectedRecords); // never silently dropped
console.log(result.dataLoss); // unmapped fields, rejected values, dropped records
console.log(result.traces[0].stage); // redacted trace events
```

The SDK is the same engine the CLI and API use. Run `npx tsx examples/run-sdk-example.ts` for a
complete example that inspects coverage, exports a run bundle and replays it.

### REST API in demo mode

```bash
npm run build
node apps/api/dist/main.js # in-memory persistence, prints a bootstrap token

TOKEN=<token printed at startup>
curl -s localhost:3000/api/v1/healthz

# create the first workspace; the owner key is returned once
curl -s localhost:3000/api/v1/workspaces \
  -H "x-bootstrap-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Demo Clinic","slug":"demo-clinic"}'
```

Then upload an asset (`POST /assets`), create a mapping (`POST /mappings`) and submit a run
(`POST /runs`). The full reference — endpoints, roles, error codes, lifecycle, SSE and limits —
is [docs/api.md](docs/api.md). With `DATABASE_URL` set, the API uses MySQL 8.0+ (migrations run
at boot) and refuses to start if the database is unreachable, older than 8.0, MariaDB, missing
`HEALTHBRIDGE_KEY_PEPPER`, or started in production without a database. Each refusal names the
reason; `/healthz` reports the active `mode`, `persistence` and `queue.mode`.

### Operator Console

```bash
npm run build          # API + packages
npm run build:web      # Angular bundle
npm run start:api      # terminal 1: demo mode, prints a bootstrap token
npm run start:web      # terminal 2: static bundle + /api proxy on :4200
```

Open `http://localhost:4200`, paste the bootstrap token under **First run? Create a workspace**,
and the console signs in with the returned key. The key lives in memory: reloading the tab signs
you out by design. The console is a **single-operator administrative tool**, not multi-user
auth: serve it over HTTPS behind your own access control and never expose it publicly. Details:
[docs/console.md](docs/console.md).

---

## CLI

Executable: `node packages/cli/dist/bin.js` (or `healthbridge` after linking/installing).

| Command | What it does |
|---|---|
| `doctor [--json]` | Probes Node, platform, registered adapters and runs a real self-test. Returns 5 when degraded; never prints a hard-coded "healthy" |
| `init [--dir <path>] [--force]` | Creates `healthbridge.config.json` and `mappings/patient.json`; refuses to overwrite without `--force` |
| `formats list [--json]` | Table or JSON manifests: format, version, honest status, capability flags |
| `formats inspect <file> [--json]` | Detection candidates with confidences plus a schema summary |
| `inspect <file> [--json] [--adapter <id>] [--max-records <n>]` | Schema, inferred types, nullability and warnings (encoding, delimiter confidence, ragged rows, duplicate headers) |
| `transform <file> [--mapping <file.json\|file.yaml>] [--adapter <id>] [--max-records <n>] [--out <file>] [--format json\|ndjson] [--json] [--fail-on warning]` | Apply a mapping and write resources; defaults to the built-in patient mapping |
| `validate <file> [--standard fhir-r4] [--json]` | Structural FHIR R4 checks; prints which levels ran; exits 3 when invalid |
| `trace show <file> [--json]` | Timeline table for a run export or an exported trace report |
| `reproduce <bundle> --input <file> [--json]` | Re-runs a bundle's pipeline and compares the output checksum |
| `demo generate --profile broken-dates [--seed 42] [--records 25] [--out <file>]` | Deterministic synthetic data with invalid/ambiguous dates, duplicate/blank ids and mixed gender codes |
| `plugins list` | Adapters actually registered (third-party adapters are privileged code) |
| `examples list` | Bundled examples and datasets |

### Reproducible runs

`transform` can export a **run bundle**: a self-describing JSON descriptor containing the
mapping, adapter and engine versions, options and checksums. It never contains patient data.

```bash
healthbridge transform patients.csv --mapping mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z --run-bundle run.bundle.json --out patients.fhir.json

healthbridge reproduce run.bundle.json --input patients.csv            # exit 0 = byte-identical
healthbridge reproduce run.bundle.json --input patients.csv --json     # machine-readable result
```

`--imported-at` pins the provenance timestamp; without it every run is internally consistent,
but timestamps differ, so the output checksum changes.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error (unknown command, missing flag, bad standard) |
| 2 | Invalid input (file missing, unparsable JSON, wrong input for a bundle) |
| 3 | Validation failed (`validate`, `reproduce` mismatch, or `--fail-on warning`) |
| 4 | Adapter error (no adapter, run failed) |
| 5 | Internal error (environment self-test failed) |
| 6 | Cancelled (reserved) |

---

## Mapping engine

A mapping is declarative JSON or YAML. It names the source and target formats, the target
resource type and a list of rules:

```json
{
  "id": "patient-csv-to-fhir",
  "name": "CSV Patient to FHIR R4 Patient",
  "version": "1.1.0",
  "sourceFormat": "csv",
  "targetFormat": "fhir-r4",
  "targetResourceType": "Patient",
  "sourceDomains": ["clinical"],
  "rules": [
    {
      "id": "r1",
      "sourcePath": "patient_id",
      "targetPath": "id",
      "transform": "identity",
      "required": true
    },
    {
      "id": "r2",
      "sourcePath": "birth_date",
      "targetPath": "birthDate",
      "transform": "parse_date_iso",
      "params": { "inputFormat": "DD/MM/YYYY" }
    },
    {
      "id": "r3",
      "sourcePath": "note",
      "targetPath": "note.0.text",
      "transform": "trim",
      "when": [{ "path": "note", "op": "matches", "value": "^keep" }]
    }
  ]
}
```

### Transforms

All 14 transforms are deterministic and covered by tests. Unknown transform kinds are a hard
error; there is no JavaScript evaluation anywhere.

| Transform | Behaviour |
|---|---|
| `identity` | Pass the value through unchanged |
| `uppercase` / `lowercase` | Locale-independent case conversion of the text form |
| `trim` | Remove surrounding whitespace |
| `parse_date_iso` | Parse against an explicit `params.inputFormat` (or an unambiguous auto format) and emit an ISO date; ambiguous dates are rejected |
| `format_gender_fhir` | Map common and locale-specific gender aliases to FHIR `male` / `female` / `other` / `unknown`; unmapped codes are reported |
| `concat` | Join `params.paths` (or the current value) with `params.separator` |
| `split` | Split on `params.separator` and take `params.index` (default first) |
| `number_to_string` | Format a finite number with optional `decimals` and `decimalSeparator` |
| `string_to_number` | Parse a number with optional `decimalSeparator` / `thousandsSeparator`; optional `integer` enforcement |
| `default_value` | Use `rule.defaultValue` when the source value is missing |
| `to_reference` | Build a FHIR `Reference` (`<type>/<id>`, default type `Patient`); empty ids are rejected |
| `codeable_concept` | Build a `CodeableConcept` from `params.system` plus optional `displayPath` / `textPath`; a system is mandatory |
| `convert_units` | Convert between units of the same dimension on a validated UCUM subset (`params.from`/`params.to`, `mcg` alias supported); unknown units and cross-dimension conversions are hard errors |

### Conditions and paths

Rules support conditions with `exists`, `not_exists`, `equals`, `not_equals`, `in`, `not_in`,
`matches`, `gt`, `gte`, `lt` and `lte`. Numeric path segments create arrays
(`name.0.given.0` → `name[0].given[0]`). `required: true` turns a missing value into an error
issue and rejects the record.

Mapping validation runs before any record is mapped: unknown transforms, duplicate rule ids and
duplicate target paths are rejected with advice. See [docs/cli.md](docs/cli.md) for the full
mapping reference.

---

## Trace protocol and PHI safety

Trace protocol **v1.2** emits one timeline per run. Stages are `detect`, `adapter-selection`,
`parse`, `mapping` and `export` (`build` and `validate` are reserved for the target-builder and
validation work). Each event carries:

- run and correlation ids, span id
- stage, adapter/pipeline versions, record index and source path
- status, duration and issues
- `redactionState`

Redaction is **structural by default**: object keys, array shapes and terminology fields
(codes, units, statuses) stay readable; patient-data scalars are masked, and values quoted
inside issue messages are masked too. Direct identifiers (SSN, MRN, national id, phone, email,
address, tokens) and quasi-identifiers (names, birth dates, postal codes, city) are masked;
clinical codes and quantities are preserved for debugging. Long strings and arrays are
truncated.

The policy is documented in
[docs/adr/ADR-0003-trace-redaction-policy.md](docs/adr/ADR-0003-trace-redaction-policy.md)
(which supersedes ADR-0002). The SDK's `debug.payloadMode: "full"` writes unredacted payloads
and must only be used locally; nothing in this repository sends trace data anywhere.

**PHI boundary.** The repository ships synthetic data only. Stored output resources are not
redacted — redaction applies to traces. Production use requires encryption at rest, access
control, retention enforcement and a TLS-terminated deployment; those are deployment
responsibilities today.

---

## REST API

Base path: `/api/v1` · JSON bodies · raw bytes for uploads. The full contract, with request and
response examples, is [docs/api.md](docs/api.md).

### Endpoints

| Area | Endpoints | Scope |
|---|---|---|
| Health | `GET /healthz`, `GET /version`, `GET /formats` | public |
| Workspaces | `POST /workspaces`, `GET /workspaces/current` | bootstrap token; `runs:read` |
| Keys | `POST /keys`, `GET /keys`, `DELETE /keys/:id`, `POST /keys/:id/rotate` | `workspaces:admin` |
| Assets | `POST /assets?filename=…`, `GET /assets`, `GET /assets/:id`, `GET /assets/:id/content` | `assets:write` / `assets:read` |
| Mappings | `POST /mappings`, `GET /mappings`, `GET /mappings/:id`, `GET /mappings/:name/versions` | `mappings:write` / `mappings:read` |
| Pipelines | `POST /pipelines`, `GET /pipelines`, `GET /pipelines/:id` | `pipelines:write` / `pipelines:read` |
| Runs | `POST /runs`, `GET /runs`, `GET /runs/:id`, `/resources`, `/issues`, `/traces`, `/bundle`, `/events`, `POST /cancel`, `POST /replay` | `runs:write` / `runs:read` |
| Audit | `GET /audit` | `audit:read` (owner) |

`GET /healthz` is also the **limits discovery endpoint**: clients read upload/body limits, rate
limits, execution limits and queue mode from it instead of hardcoding them. `GET /version`
reports engine, trace-protocol and persistence versions, and `GET /formats` serves the adapter
capability manifests.

### Authentication

Every endpoint except `/healthz`, `/version`, `/formats` and `POST /workspaces` requires an API
key:

```text
x-api-key: hb_<prefix>_<secret>
```

Keys are random 32-byte secrets stored only as `HMAC-SHA256(pepper, secret)`. The plaintext is
shown **once**, at issue or rotation; listing keys returns prefixes and metadata only.

`POST /workspaces` is the bootstrap endpoint. It requires the operator-held bootstrap token in
`x-bootstrap-token`, and it is the only way to create a workspace. The token must be at least
**16 characters**; attempts are rate limited per client IP by a fixed 15-minute window
(`HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT`, default 10), failed attempts count, and exhaustion returns
`429` with `retry-after`. Rotate the token after setup and never expose workspace creation to
the public internet.

### Roles and scopes

| Role | Scopes |
|---|---|
| `owner` | everything, including `workspaces:admin` (keys, audit) |
| `editor` | `assets:*`, `mappings:*`, `pipelines:*`, `runs:*` |
| `viewer` | `*:read` only |
| `service` | `runs:*`, `assets:*` — machine accounts without catalogue or audit access |

Missing scope → `403 FORBIDDEN` with `details.requiredScope`. Tenant isolation is enforced in
the repository layer: every query takes a `workspaceId`, and a record from another workspace is
reported as `404 NOT_FOUND` (not `403`) so identifiers cannot be probed.

### Errors

All failures share one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "'assetId' is required and must be a non-empty string.",
    "requestId": "6f1c…",
    "details": {}
  },
  "statusCode": 400
}
```

Codes include `UNAUTHENTICATED`, `MALFORMED_KEY`, `REVOKED_KEY`, `EXPIRED_KEY`, `FORBIDDEN`,
`RATE_LIMITED`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `VALIDATION_FAILED`,
`INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `RUN_NOT_CANCELLABLE`, `QUEUE_UNAVAILABLE` and `INTERNAL`.
Internal messages (SQL, filesystem paths, stacks) are logged with the request id and never
returned.

### Run lifecycle

```text
POST /runs ──► queued ──► running ──► completed | completed_with_warnings
   │                        │        └► failed
   │                        └──────────► cancelling ──► cancelled
   └────────────────────────────────────► cancelled (cancelled while queued)
```

- `POST /runs` returns `202` only after the run row and the job row exist, so an accepted run
  always has a job behind it.
- In database mode the queue is the `run_jobs` table: claiming uses
  `SELECT … FOR UPDATE SKIP LOCKED`, expired leases are re-claimed, and delivery is
  **at-least-once**. Re-running is safe because output is a pure function of the asset bytes,
  mapping version, options and `importedAt`.
- `Idempotency-Key` is scoped per workspace. The same key and request return the same run
  (`created: false`); the same key with a different request returns `422`.
- Cancellation crosses replicas: the job is marked cancelled in the database and the executing
  replica aborts at the next stage boundary. It is cooperative, not an instant kill.
- `replay` creates a new run with the same asset, mapping and options.
- Output larger than `HEALTHBRIDGE_MAX_STORED_RESULT_BYTES` is not stored; `/resources` then
  returns `omitted: true` while the summary keeps the checksums and counts.

### Live progress (SSE)

`GET /api/v1/runs/:id/events` streams `snapshot` first, then `queued`, `started`, `progress`
(`stage`, `stepName`, `percent`), `warning`, `done`, `error` or `cancelled`, plus `ping`
heartbeats. A terminal event is always sent, even to a client that subscribes after the run
finished. Progress is stage-level, not per record; SSE connections are per process, so clients
behind another replica can poll `/runs/:id` instead.

---

## Operator Console

The Angular application in `apps/web` is the **HealthBridge Operator Console v1**: a real,
key-authenticated administrative UI over the platform API.

| Area | Implemented | Notes |
|---|---|---|
| Connect / session | Yes | API base URL + API key, memory only, explicit Disconnect |
| Health and limits | Yes | `/healthz` read live: mode, persistence, storage, queue, uptime, limits, versions |
| Dashboard | Yes | Health cards, execution/rate limits, per-status counts, recent runs |
| Runs list | Yes | Cursor pagination, status filters, submit a new run |
| Run detail | Yes | Lifecycle, counts, issues, generated resources, traces, run bundle, cancel, replay |
| Live progress | Yes | `fetch` + `ReadableStream` SSE, reconnect with `Last-Event-ID`, connection chip |
| Assets | Yes | Upload, list, download, checksum display; upload limit read from the API |
| Mappings | Yes | Import spec, versions, inspect the stored spec |
| Pipelines | Yes | Create (mapping + engine config), list, run against an asset |
| API keys | Yes | List, create (secret shown once), rotate, revoke |
| Audit | Yes | Paginated audit log with outcomes and request ids |
| Themes | Yes | Dark and light, follows the OS by default, manual toggle |
| Accessibility | Yes | Skip link, focus-visible rings, labelled controls, axe-checked in CI |

The console never simulates a successful operation: a button either calls the API and renders
the response, or is not rendered.

**Security model.** The key lives in an Angular signal (`AuthStore`), never in
`localStorage`, `sessionStorage`, IndexedDB, cookies, the URL or a log line. Reloading the tab
destroys it. A `401` clears the session; a `403` keeps it and shows the error code and request
id. `EventSource` cannot send headers, so live progress uses `fetch` with a `ReadableStream`
and `x-api-key` on the request. Serve the console over HTTPS behind an access-control layer
(VPN, SSO proxy, private network); it is not hardened against a hostile page in the same browser
profile or an attacker with local machine access. Details: [docs/console.md](docs/console.md).

`apps/web/server.mjs` is a dependency-free Node process that serves the built bundle and proxies
`/api/*` to the API container on the same origin. It streams SSE chunk by chunk, pipes uploads
without buffering, sends `Cache-Control: no-store` for API responses, applies CSP and security
headers, supports SPA fallback only for `GET`/`HEAD` without a file extension, and refuses
dotfiles and traversal escapes. Hashed assets cache for a year; `index.html` is `no-store`.

```bash
npm run test:e2e               # Playwright, Chromium, real API + real proxy
npm run test:web               # SSE parser, error mapping, proxy contract
```

---

## Docker Compose

The demo stack runs MySQL, the API and the console together:

```bash
docker compose -f docker/compose.demo.yaml up -d --wait
docker compose -f docker/compose.demo.yaml logs -f api
# UI: http://127.0.0.1:4200  (bootstrap token: demo-bootstrap-token)
```

| Service | Image / build | Port | Notes |
|---|---|---|---|
| `mysql` | `mysql:8.4` | internal 3306, not published | utf8mb4, named volume `mysql-data` |
| `api` | `docker/Dockerfile.api` | `127.0.0.1:${API_PORT:-3000}` | loopback only; durable queue in MySQL; objects in `object-data` volume |
| `web` | `docker/Dockerfile.web` | `${WEB_PORT:-4200}:4200` | serves the SPA and proxies `/api/*` to `api:3000` |

The compose file sets **demo** credentials for pepper and bootstrap token. Override
`HEALTHBRIDGE_KEY_PEPPER` and `HEALTHBRIDGE_BOOTSTRAP_TOKEN` before using the stack for anything
beyond a local demo, and set `TRUST_PROXY=1` when TLS terminates in front of the web container.

```bash
bash scripts/smoke-compose.sh   # full flow against the running stack
```

`scripts/smoke-compose.sh` repeats the full flow against the running stack and verifies the UI
is served; `SMOKE_MODE=mysql bash scripts/smoke-api.sh` additionally proves that a queued run
resumes after an API restart. There is **no production deployment guide yet**; the minimum requirements
are a MySQL 8.0+ database, persistent object storage, a strong pepper and bootstrap token, TLS,
access control in front of the console, and a plan for retention and backups.

---

## Configuration

The API reads environment variables directly; it does **not** auto-load a `.env` file. Export
them in your shell or pass them through Compose. `.env.example` documents the full set.

### API

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `DATABASE_URL` and refuses demo mode |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `DATABASE_URL` | unset | `mysql://` URL. Unset = demo mode with in-memory persistence |
| `HEALTHBRIDGE_KEY_PEPPER` | random in demo; required with DB | Mixed into every API key hash; minimum 16 characters |
| `HEALTHBRIDGE_BOOTSTRAP_TOKEN` | random in demo; required with DB | Only credential that can create a workspace; minimum 16 characters |
| `HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT` | `10` | Bootstrap attempts per client IP per fixed 15-minute window |
| `HEALTHBRIDGE_STORAGE_DIR` | `./.data/objects` | Local object storage root |
| `HEALTHBRIDGE_MAX_UPLOAD_BYTES` | `67108864` (64 MiB) | Maximum asset upload |
| `HEALTHBRIDGE_MAX_BODY_BYTES` | `1048576` (1 MiB) | Maximum JSON request body |
| `HEALTHBRIDGE_RATE_LIMIT_BURST` / `HEALTHBRIDGE_RATE_LIMIT_RPS` | `120` / `20` | Per-key token bucket |
| `HEALTHBRIDGE_MAX_STORED_RESULT_BYTES` | `5242880` (5 MiB) | Beyond this, run output is reported as omitted |
| `HEALTHBRIDGE_MAX_TRACES_PER_RUN` | `5000` | Trace events stored per run |
| `HEALTHBRIDGE_QUEUE_CONCURRENCY` | `2` | Jobs this replica runs at once |
| `HEALTHBRIDGE_QUEUE_POLL_MS` | `500` | How often a replica looks for work |
| `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` | `300000` (5 min) | Job lease; an expired lease is re-claimable |
| `HEALTHBRIDGE_QUEUE_MAX_ATTEMPTS` | `2` | Attempts before a job is marked failed |
| `HEALTHBRIDGE_SSE_HEARTBEAT_MS` | `15000` | SSE `ping` interval |
| `HEALTHBRIDGE_CORS_ORIGINS` | empty | Comma-separated allowed browser origins |
| `HEALTHBRIDGE_KEY_TTL_DAYS` | unset | Optional API key expiry |
| `HEALTHBRIDGE_RECORD_KEY_USAGE` | `true` | Record key usage timestamps |

### Console server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4200` | Listen port |
| `API_ORIGIN` | `http://127.0.0.1:3000` | Upstream API origin for the `/api` proxy |
| `API_PREFIX` | `/api` | Only this prefix is proxied |
| `STATIC_DIR` | `dist/web/browser` | Built Angular bundle |
| `PROXY_TIMEOUT_MS` | `0` | Upstream socket timeout; `0` keeps SSE open |
| `TRUST_PROXY` | unset | `1` emits HSTS when TLS terminates upstream |

Invalid or unsafe configuration is refused at boot with a named reason rather than silently
degraded. See [docs/troubleshooting.md](docs/troubleshooting.md) if a refusal message looks
unexpected.

---

## Security

- **Report vulnerabilities privately.** Use the
  [private security advisory flow](https://github.com/Villain20000/HealthBridge/security/advisories/new);
  do not open a public issue for anything that could expose patient data. See
  [SECURITY.md](SECURITY.md) for the response targets and the full security-relevant behaviour.
- **Synthetic data only in this repository.** Never commit real patient data, credentials or
  production traces. Uploads and traces are not anonymisation.
- **Demo mode is not a deployment.** It uses in-memory persistence, prints the bootstrap token
  and loses data on restart. Production refuses to start without a database, a pepper and a
  bootstrap token.
- **Keys are hashed with a server-side pepper.** Rotating the pepper invalidates every key at
  once. Keys are shown once and never recoverable.
- **Tenant isolation is enforced in repository signatures** and asserted by the SQL-scoping
  test; the workspace id comes from the authenticated key, never from the URL or body.
- **Rate limiting is in-process.** A per-key token bucket and a per-IP bootstrap window stop a
  runaway client, not a distributed attacker. Multi-replica deployments need network-layer
  protection.
- **Plugins are privileged code.** A third-party adapter runs in-process with full filesystem
  and network access; there is no sandbox or signature check.
- **No telemetry.** The engine makes no outbound network calls; the CLI and SDK are offline.

There is no encryption at rest in this repository: TLS termination and storage encryption are
deployment responsibilities. Do not deploy with real patient data without adding both.

---

## Verified scenarios

Four end-to-end scenarios run in CI, each with data, mapping, expected output, expected issues,
a README and a test that also guards against PHI in traces:

| Scenario | Pipeline | Expected outcome |
|---|---|---|
| `scenarios/01-hospital-patient-migration` | CSV → `Patient` | 3/3 resources, valid, 63 % field coverage |
| `scenarios/02-laboratory-interop` | CSV → `Observation`, `DiagnosticReport` | LOINC + UCUM via `codeable_concept` / `to_reference`, 3/3 valid |
| `scenarios/03-broken-hospital-data` | CSV → `Patient` | 2/4 exported, 2 rejected with reasons, duplicate reported |
| `scenarios/04-international-formats` | `;`-CSV, `DD.MM.YYYY`, decimal comma → `Patient` | Unicode preserved, locale aliases honoured |

```bash
node packages/cli/dist/bin.js transform scenarios/02-laboratory-interop/data/lab-results.csv \
  --mapping scenarios/02-laboratory-interop/mapping/observation.json
```

Every run can be reproduced: `--run-bundle` exports a data-free descriptor and
`healthbridge reproduce bundle.json --input data.csv` must return the same output checksum. The
reproducibility check is part of CI, including a negative case where a different input must be
refused.

---

## Testing and CI

| Command | Scope |
|---|---|
| `npm run build` | TypeScript project references for every package and the API |
| `npm test` | Full offline `node:test` suite: adapters, transforms, paths, redaction, coverage, CLI/SDK parity, scenarios, auth, storage, repository contracts, queue and HTTP API |
| `npm run test:web` | Console logic: SSE frame parser boundaries, error mapping, formatters, key masking, proxy contract |
| `npm run test:e2e` | Playwright + axe against a real API, real proxy and seeded data; keyboard and 390 px checks |
| `npm run test:mysql` | Live MySQL integration suite (needs `HEALTHBRIDGE_TEST_MYSQL_URL`) |
| `npm run test:api:smoke` | Real process, real HTTP: bootstrap → upload → mapping → run → download |
| `npm run test:sdk` | Runs the SDK example end to end |
| `npm run lint` / `npm run format:check` | ESLint 10 + typescript-eslint, Prettier |
| `npm run check:pack` | Verifies every publishable tarball contains `dist`, README and LICENSE |

CI adds gates that are easy to skip locally:

- Node 22 and 24 across Ubuntu, Windows and macOS: build, lint, format, pack check, full tests,
  console build and console unit tests, browser-bundle scan for Node-only imports.
- A MySQL 8.0/8.4 matrix runs migrations, repository tests and a database-mode API smoke.
- A Docker Compose smoke boots MySQL + API + web and exercises the full flow.
- Playwright runs against the built stack and against the composed containers, with axe
  accessibility checks in both themes.
- CLI smoke verifies real exit codes; a reproducibility job proves byte-identical replay and
  refusal of a different input; a scenario job runs all four scenarios; a trace job fails if
  PHI shapes leak into traces.
- CodeQL runs on pushes and pull requests; Dependabot keeps npm, Actions and Docker
  dependencies updated weekly (npm and Actions updates are grouped).

The live-MySQL suite is not part of the default `npm test` run, so a clean checkout stays
offline. `/healthz` reports `persistence: "mysql"` when the database path is active.

---

## Packaging and releases

All 17 library packages declare `license`, `engines.node >= 22`, `files`, keywords and
`publishConfig.access: public`, and ship their README and LICENSE. `npm run check:pack` asserts
that each tarball actually contains `dist`, the README and the LICENSE.

They are **not published to npm yet**. Until the first release, use a local checkout or
`npm link --workspace <name>`. The release workflow
([.github/workflows/release.yml](.github/workflows/release.yml)) is manual-dispatch only: it
builds, fully tests and packs every workspace into `dist/` tarballs uploaded as workflow
artifacts. There is deliberately no registry publish or image push step — publishing stays
"only with explicit authorisation". No release has been cut from this repository yet.

---

## Repository layout

```text
apps/api                     NestJS REST API (runs, assets, mappings, keys, audit)
apps/web                     Angular Operator Console + static/API proxy server
packages/shared-types        Public contracts, envelope, trace and data-loss types
packages/core                Adapter registry, checksum, classification, path utilities
packages/adapters            CSV, JSON, FHIR R4 JSON adapters (+13 opt-in; NDJSON in packages/fhir-ndjson)
packages/mapping-engine      Declarative rules, deterministic transforms, coverage
packages/transformation-engine  Pipeline: detect → parse → map → report
packages/trace-protocol      Trace collector, redaction policy, report export
packages/fhir-r4             FHIR R4 resource interfaces
packages/validation          Structural FHIR validation + OperationOutcome
packages/lineage-engine      Lineage graph builder
packages/sdk                 @healthbridge/sdk (offline, no NestJS required)
packages/auth                API keys, scopes, roles, rate limiting
packages/storage             Content-addressed object storage (local fs, memory, opt-in S3)
packages/persistence         Workspace-scoped repositories (memory + MySQL, migrations)
packages/client              @healthbridge/client (typed REST client)
packages/fhir-ndjson         FHIR NDJSON adapter (fourth built-in)
packages/cli                 @healthbridge/cli
datasets                     Deterministic synthetic fixtures
examples                     Runnable mapping and SDK examples
scenarios                    Four end-to-end golden scenarios
docs                         API/CLI/console references, capability matrix, ADRs
docker                       Dockerfiles and the demo Compose stack
scripts                      Test runner, packaging gate, smoke scripts
```

---

## Design principles

1. **Universal input, explicit capabilities.** Every adapter publishes a capability manifest
   with an honest status: `supported`, `partial`, `metadata-only`, `adapter-required`,
   `planned`, `unsupported`.
2. **No silent data loss.** Unmapped source fields, rejected values and failed records are
   reported (`coverage`, `dataLoss`, `rejectedRecords`).
3. **No raw PHI in traces.** Redaction is structural by default (protocol v1.2); structure and
   terminology codes stay, scalars are masked, including values quoted in issue messages.
4. **Deterministic transforms.** Dates are parsed against an explicit or unambiguous format —
   `03/04/2024` is rejected rather than guessed. Transform failures reject the value instead of
   writing something wrong.
5. **Reproducibility.** A run is a pure function of input bytes, mapping version, options and
   the provenance timestamp; run bundles prove it.
6. **FHIR is an output format, not the internal model.**
7. **Plugins are privileged code.** Installing a third-party adapter means running its code;
   there is no sandbox yet.

---

## Limitations and non-goals

This is a developer preview. The API may change before 1.0.

- **Adapters.** CSV/TSV, JSON, FHIR R4 JSON/Bundle and FHIR NDJSON are built in. HL7 v2,
  CDA/XML, DICOM, XLSX, VCF, FASTA/FASTQ, FHIR REST, OMOP, PDF, EDF/WFDB and a read-only MySQL source connector exist as opt-in adapters (`registerAdapter`; metadata-only except MySQL, which is partial). No adapter interprets clinical content.
- **FHIR validation.** Structural checks only. Profile, terminology and referential-integrity
  validation are not executed; the CLI reports exactly which levels ran.
- **Uploads.** Request bodies are buffered up to the configured limit; there is no streaming
  upload. Streaming CSV tokenization, bounded-memory pipeline batches and SDK streaming file
  input exist; API upload and JSON/NDJSON parse still buffer.
- **API contract.** `docs/openapi.json` is generated from the controllers, committed and
  drift-checked in CI (`generate-openapi --check`); it is not served over HTTP —
  `docs/api.md` remains the human-readable contract. The generator omits the mapping-studio
  controller and the console still hand-writes DTOs instead of consuming
  `@healthbridge/client`.
- **Storage.** Local filesystem or memory by default; an S3-compatible driver exists
  (`S3StorageDriver`) and is auto-selected in `app.context` when `HEALTHBRIDGE_S3_ENDPOINT` /
  `HEALTHBRIDGE_S3_BUCKET` are set.
- **Retention and deletion.** `DELETE /assets/:id`, `DELETE /runs/:id` and
  `DELETE /workspaces/current` exist with a scheduled retention sweeper
  (`HEALTHBRIDGE_RETENTION_SWEEP_MS`, `HEALTHBRIDGE_WORKSPACE_GRACE_DAYS`); see
  `docs/api.md` for the policy.
- **Multi-tenancy in the console.** One workspace per session; switching workspaces means
  switching keys.
- **Authentication for operators.** API keys only; no OIDC/BFF. The console is a single-operator
  tool.
- **Encryption.** No encryption at rest and no built-in TLS termination.
- **Rate limiting.** Per-process, not shared between replicas.
- **Progress.** SSE reports stage boundaries, not per-record progress, and streams are
  per-process.
- **Queue semantics.** At-least-once delivery. Re-running is safe because runs are pure, but a
  worker can repeat work after a lease expiry.
- **Plugins.** Unsupported/untrusted adapters run in-process without a sandbox.
- **Frontend tests.** A Vitest harness and two specs exist (`auth.store.spec.ts`,
  `ui/primitives.spec.ts`) but are not yet gated in CI; behaviour is otherwise covered by
  Playwright and the logic layer by unit tests.
- **Compliance.** HealthBridge OS does not certify HIPAA, GDPR, MDR, FDA or any other regime,
  does not anonymise data, and must not be used for autonomous diagnosis or clinical
  decision-making.

See [docs/capability-matrix.md](docs/capability-matrix.md) for per-format status and
[ROADMAP.md](ROADMAP.md) for what is deliberately unsupported and why.

---

## FAQ

**Is HealthBridge OS HIPAA or GDPR compliant?**
No. It is a developer toolkit, not a certified system. Compliance depends on your deployment,
agreements, access control, encryption and retention. The project explicitly does not claim
certification.

**Can I use it with real patient data?**
Not without additional controls. The repository ships synthetic data only, stores resources
unencrypted, and has no retention enforcement. Add TLS, encryption at rest, access control,
retention/deletion and a security review first.

**Do I need MySQL or Docker?**
No for the CLI, SDK and offline tests. The API runs in demo mode with in-memory persistence for
evaluation. Production requires MySQL 8.0+ and persistent object storage.

**Does it replace FHIR?**
No. FHIR is a target format. The internal model is the canonical envelope, and mappings decide
which FHIR resources are produced.

**Can I add my own transform?**
The transform set is fixed and deterministic by design — no JavaScript evaluation in mappings.
Add the transform to `mapping-engine`, with tests and a capability-matrix update, in the same
change. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Why not Redis/BullMQ?**
The MySQL `run_jobs` table is the default because it already provides restart safety, lease
recovery and cross-replica claiming without another service; an opt-in BullMQ driver exists
(`HEALTHBRIDGE_REDIS_URL`) for deployments that need it. ADR-0004 records the decision and
the conditions under which it would be revisited.

**How do I report a security issue?**
Use the [private advisory flow](https://github.com/Villain20000/HealthBridge/security/advisories/new).
Never post real patient data, credentials or production traces publicly.

---

## Roadmap

| Phase | Status | Focus |
|---|---|---|
| A — Honest foundation | Delivered (v3.1.0) | Contracts, adapters, deterministic engine, CLI |
| B — Credible vertical slice | Delivered (v3.2.0) | Mapping depth, trace protocol, validation, scenarios |
| C — Persistence and API | Delivered (unreleased) | MySQL, tenant isolation, queue, SSE, audit, object storage |
| D — Studio and debugger | In progress | Operator Console v1 shipped; rule-table mapping editor, schema explorers, lineage view, validation centre shipped; debugger extensions remain |
| E — Adapter wave 1 | Delivered (opt-in) | XLSX, CDA/XML metadata, HL7 v2 ADT/ORU, FHIR REST client, DICOM metadata landed; FHIR NDJSON split into `@healthbridge/fhir-ndjson` and registered as the fourth built-in |
| F — Domain depth and hardening | Mostly delivered | MySQL/OMOP/VCF/FASTA/PDF adapters, UCUM `convert_units`, terminology level-5 wiring, local code-table provider, security suite, benchmarks, external FHIR validator, docs site, release automation landed; licensed-server terminology integration (LOINC/SNOMED/ICD/RxNorm/ATC) remains |
| G — Later | Mostly delivered | EDF/WFDB, MIABIS validators, CDISC/ODM, DICOMweb, live pausable execution (chunked checkpoints, pause/resume; v1 process-local) landed; public-health jurisdiction plugins remain |

Details, exit criteria and explicit non-goals: [ROADMAP.md](ROADMAP.md).

---

## Contributing

Contributions are welcome. The project optimises for honest, verifiable capability:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
2. Run `npm ci && npm run build && npm test` before opening a PR.
3. Add tests with the code. New adapters need manifests, fixtures, contract tests, a capability
   matrix row and a CLI listing in the same change.
4. Never include real patient data, credentials or production traces. Synthetic data only.
5. Conventional commits (`feat(cli): …`, `fix(trace): …`, `docs: …`); the PR template asks what
   changed, what was executed and what remains limited.

Questions and feature requests: [GitHub Discussions](https://github.com/Villain20000/HealthBridge/discussions)
or the issue templates. Support expectations: [SUPPORT.md](SUPPORT.md).

---

## License

Apache-2.0. See [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md). Changelog:
[CHANGELOG.md](CHANGELOG.md).
