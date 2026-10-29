# HealthBridge OS

> Open-source medical data interoperability, transformation and debugging toolkit.
>
> **Status: developer preview (v3.2.0 + unreleased Phase C).** Three format adapters, a platform API with persistence, authentication and an async run queue, and a working Angular **Operator Console** over it. Everything else is listed honestly in [ROADMAP.md](ROADMAP.md) — this repository does not advertise features it has not implemented.

HealthBridge OS is a developer layer that sits between incompatible healthcare systems. It imports a dataset, builds a format-independent envelope, applies a declarative mapping, and reports exactly what was mapped, what was rejected and what was lost — with a redacted trace of every step.

**Not a hospital information system. Not a diagnostic tool. Not a clinical decision-support system.**

---

## What works today (verified by the test suite)

| Capability | Status | Notes |
|---|---|---|
| CSV adapter (RFC 4180) | **Supported** | Quoted/multiline cells, CRLF, BOM, UTF-16, Windows-1252 fallback, `, ; \t \|` delimiter detection, ragged-row and duplicate-header reporting |
| JSON adapter | **Supported** | Object or array of objects |
| FHIR R4 JSON adapter | **Partial** | Single resource, `Bundle`, NDJSON; structural inspection only — no profile or terminology validation |
| Canonical Medical Data Envelope | **Supported** | SHA-256 checksum, source location, encoding, classification, parse issues, unmapped fields |
| Declarative mapping engine | **Supported** | 11 deterministic transforms, conditions, array-aware target paths, coverage and rejection reporting |
| Trace protocol v1.1 | **Supported** | Redacted by default, staged events, span ids, protocol version |
| CLI (`@healthbridge/cli`) | **Supported** | `doctor`, `init`, `formats`, `inspect`, `transform`, `validate`, `trace`, `demo`, `plugins`, `examples` |
| TypeScript SDK (`@healthbridge/sdk`) | **Supported** | File or inline input, inspect, detect, transform, replay, trace export |
| FHIR validation | **Partial** | Structural checks for Patient, Observation, Specimen (+ `resourceType`); profile/terminology/referential levels are **not** executed and the CLI says so |
| NestJS REST API (`@healthbridge/api`) | **Partial** | MySQL or in-memory persistence, hashed API keys with scopes, tenant isolation, async runs with idempotency, SSE progress, traces/bundles/replay, audit trail. The queue is the durable `run_jobs` table in database mode and in-process only in demo mode (no broker); no OpenAPI document is served yet — see [docs/api.md](docs/api.md) |
| Operator Console (`apps/web`) | **Supported (v1)** | Angular 19, standalone + signals: connect, health, dashboard, runs (cursor pagination, submit, cancel, replay), run detail with issues/resources/traces/bundle, live SSE progress, asset upload, mappings, pipelines (create + run), API keys, audit log, dark/light themes. API key kept in memory only. The full Studio (visual debugger, mapping editor, schema/lineage explorers) is **planned** — see [docs/console.md](docs/console.md) and [docs/plan-web-studio.md](docs/plan-web-studio.md) |
| HL7 v2, CDA, DICOM, XLSX, VCF, OMOP, MySQL connector | **Planned** | See [ROADMAP.md](ROADMAP.md) |

The CLI prints real capability status; the table above is generated from the same manifests.

---

## Quickstart (offline, no account, no database)

Requires Node.js >= 22. Clone the repository, then run:

```bash
git clone https://github.com/Villain20000/HealthBridge.git
cd HealthBridge
npm ci
npm run build
npm test                      # the full node:test suite (offline)

# environment self-check (probes adapters and runs a real self-test)
node packages/cli/dist/bin.js doctor

# see what is actually supported
node packages/cli/dist/bin.js formats list

# inspect a dataset
node packages/cli/dist/bin.js inspect datasets/synthetic-patients.csv

# transform to FHIR R4 Patient resources
node packages/cli/dist/bin.js transform datasets/synthetic-patients.csv \
  --mapping examples/patient-mapping.json --out patients.fhir.json

# validate a resource (exits 3 when invalid)
node packages/cli/dist/bin.js validate patients.fhir.json --json

# deterministic broken-data generator for debugging practice
node packages/cli/dist/bin.js demo generate --profile broken-dates --seed 42 --records 10

# SDK example: transform, inspect coverage, replay the same run
npx tsx examples/run-sdk-example.ts
```

The CLI is **not published to npm yet**. Until the first release, install it from a local
checkout with `npm link --workspace @healthbridge/cli` (the command is then `healthbridge`),
or run `node packages/cli/dist/bin.js` directly after `npm run build`.

### SDK

```typescript
import { HealthBridge } from "@healthbridge/sdk";

const bridge = new HealthBridge({ debug: { payloadMode: "redacted" } });

const result = await bridge.transform({
  input: "./patients.csv",                 // path or inline payload
  mapping: "./mapping.yaml",               // JSON and YAML are both accepted (CLI)
});

console.log(result.status);                 // completed | completed_with_warnings | failed
console.log(result.coverage.coveragePercentage);
console.log(result.rejectedRecords);        // never silently dropped
console.log(result.dataLoss);               // unmapped fields, rejected values, dropped records
console.log(result.traces[0].stage);        // redacted trace events
```

Exit codes / result statuses are documented in `docs/cli.md`.

### REST API

```bash
npm run build
node apps/api/dist/main.js          # demo mode: in-memory, prints a bootstrap token

TOKEN=<token printed at startup>
curl -s localhost:3000/api/v1/healthz

# create the first workspace; the owner key is returned once
curl -s localhost:3000/api/v1/workspaces \
  -H "x-bootstrap-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Demo Clinic","slug":"demo-clinic"}'
```

Then upload an asset (`POST /assets`), create a mapping (`POST /mappings`) and submit a run
(`POST /runs`). Full reference, error codes and lifecycle: [docs/api.md](docs/api.md).
With `DATABASE_URL` set the API uses MySQL 8.0+ (migrations run at boot) and refuses to start if
the database is unreachable, older than 8.0, MariaDB, missing `HEALTHBRIDGE_KEY_PEPPER`, or
started in production without a database. Each refusal names the reason; `/healthz` reports the
active `mode`, `persistence` and `queue.mode`. In database mode the run queue is the `run_jobs`
table, so queued work survives a restart and several replicas can share one database (ADR-0004).

### Operator Console

```bash
npm run build          # API + packages
npm run build:web      # Angular bundle
npm run start:api      # terminal 1: demo mode, prints a bootstrap token
npm run start:web      # terminal 2: static bundle + /api proxy on :4200
```

Open `http://localhost:4200`, paste the bootstrap token under **First run? Create a workspace**,
and the console signs in with the returned key. The key lives in memory: reloading the tab signs
you out by design. Docker users get the same thing from the compose stack:

```bash
docker compose -f docker/compose.demo.yaml up -d --wait   # mysql + api + web (UI on :4200)
bash scripts/smoke-compose.sh                             # full flow against the stack
```

The console is a **single-operator administrative tool**, not multi-user auth: serve it over
HTTPS behind your own access control and never expose it publicly. Security model, proxy
contract, architecture and test strategy: [docs/console.md](docs/console.md). End-to-end tests:

```bash
npm run test:e2e               # Playwright against a real API + the real proxy
npm run test:web               # SSE parser, error mapping, proxy contract
```

See `.env.example` for every variable (`HEALTHBRIDGE_QUEUE_POLL_MS`,
`HEALTHBRIDGE_QUEUE_VISIBILITY_MS` and friends) and [docs/troubleshooting.md](docs/troubleshooting.md)
when a refusal message looks unexpected.

---

## Verified scenarios

Four end-to-end scenarios run in CI, each with data, mapping, expected output, expected
issues, README and a test that also guards against PHI in traces:

| Scenario | Pipeline | Expected outcome |
|---|---|---|
| `scenarios/01-hospital-patient-migration` | CSV → `Patient` | 3/3 resources, valid, 63 % field coverage |
| `scenarios/02-laboratory-interop` | CSV → `Observation`, `DiagnosticReport` | LOINC + UCUM, 3/3 valid |
| `scenarios/03-broken-hospital-data` | CSV → `Patient` | 2/4 exported, 2 rejected with reasons, duplicate reported |
| `scenarios/04-international-formats` | `;`-CSV, `DD.MM.YYYY`, decimal comma → `Patient` | Unicode preserved, aliases honoured |

```bash
node packages/cli/dist/bin.js transform scenarios/02-laboratory-interop/data/lab-results.csv \
  --mapping scenarios/02-laboratory-interop/mapping/observation.json
```

Every run is reproducible: `--run-bundle` exports a data-free descriptor and
`healthbridge reproduce bundle.json --input data.csv` must return the same output checksum.

## Design principles

1. **Universal input, explicit capabilities.** Every adapter publishes a capability manifest with an honest status: `supported`, `partial`, `metadata-only`, `adapter-required`, `planned`, `unsupported`.
2. **No silent data loss.** Unmapped source fields, rejected values and failed records are reported (`coverage`, `dataLoss`, `rejectedRecords`).
3. **No raw PHI in traces.** Redaction is structural by default (protocol v1.2): structure and terminology codes stay, scalars are masked, including values quoted in issue messages. See `docs/adr/ADR-0003-trace-redaction-policy.md`.
4. **Deterministic transforms.** Dates are parsed against an explicit or unambiguous format — `03/04/2024` is rejected rather than guessed. Transform failures reject the value instead of writing something wrong.
5. **FHIR is an output format, not the internal model.**
6. **Plugins are privileged code.** Installing a third-party adapter means running its code; there is no sandbox yet. See [SECURITY.md](SECURITY.md).

---

## Repository layout

```text
apps/api          @healthbridge/api — NestJS REST API (runs, assets, mappings, keys, audit)
apps/web          Angular 19 Operator Console + server.mjs (static SPA + /api proxy server)
packages/shared-types        Public contracts, envelope, trace, data-loss types
packages/core                Adapter registry, checksum, classification, path utilities
packages/adapters            CSV, JSON, FHIR R4 JSON/NDJSON adapters
packages/mapping-engine      Declarative rules, deterministic transforms, coverage
packages/transformation-engine  Pipeline: detect → parse → map → report
packages/trace-protocol      Trace collector, redaction policy, report export
packages/fhir-r4             FHIR R4 resource interfaces
packages/validation          Structural FHIR validation + OperationOutcome
packages/lineage-engine      Lineage graph builder
packages/sdk                 @healthbridge/sdk (offline, no NestJS required)
packages/auth                API keys, scopes, roles, rate limiting
packages/storage             Content-addressed object storage (local fs, memory)
packages/persistence         Workspace-scoped repositories (memory + MySQL, migrations)
packages/cli                 @healthbridge/cli
datasets                     Deterministic synthetic fixtures
examples                     Runnable mapping + SDK examples
docs                         Capability matrix, ADRs, CLI reference
```

---

## Safety and scope

- Synthetic data only in this repository. Never commit real patient data.
- HealthBridge OS does **not** provide autonomous diagnosis, treatment recommendations or regulatory compliance. Pseudonymisation is not anonymisation.
- No telemetry. No data is sent anywhere by default.
- Apache-2.0. See [LICENSE](LICENSE), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [ROADMAP.md](ROADMAP.md).
