# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/Villain20000/HealthBridge/security/advisories/new) on GitHub (the primary channel). Do not file a public issue for a vulnerability that could expose patient data. Include: affected version, adapter/format, reproduction steps, and whether real data was involved.

Target response: acknowledgement within 3 working days, triage within 10.

## Supported versions

Security fixes land on the latest minor release only (`3.2.x` at time of writing). Pre-release versions receive no backports.

## Security-relevant behaviour of the current release

**Redaction.** Traces are redacted structurally by default: object keys, array shapes and terminology fields (codes, units, status, …) stay readable, patient-data scalars are masked, and values quoted inside issue messages are masked too (protocol v1.2; see `docs/adr/ADR-0003-trace-redaction-policy.md`, which supersedes ADR-0002). Raw payload mode (`debug.payloadMode: "full"`) writes unredacted data to traces and must only be used locally.

**No telemetry.** The engine makes no outbound network calls. The CLI is fully offline. Remote adapter support (FHIR REST, DICOMweb) does not exist yet.

**Plugins are privileged code.** A registered adapter runs in-process with full filesystem and network access. There is no sandbox, no signature check and no capability restriction today. Install third-party adapters only from sources you trust. `healthbridge plugins list` shows only adapters actually registered.

**Demo mode is not a deployment.** Without `DATABASE_URL` the API uses in-memory repositories, prints the bootstrap token at startup and reports `mode: demo` from `/healthz`. In production (`NODE_ENV=production`) it refuses to start without a database, a key pepper and a bootstrap token rather than degrading silently.

**Parsing untrusted files.**
- CSV/JSON/FHIR adapters are dependency-free; no XML parsing exists yet, so XXE is not currently reachable. A safe XML parser (entity expansion disabled) is a hard requirement for the CDA/XML adapters in Phase E.
- Inputs are held in memory; a large file can exhaust memory. Bound uploads and row counts (`--max-records`) until streaming lands.

**API authentication and authorisation (`@healthbridge/api`).** Every endpoint except `/healthz`, `/version`, `/formats` and `POST /workspaces` requires an API key in `x-api-key`.

- Keys are random 32-byte secrets, stored only as `HMAC-SHA256(pepper, secret)`. The plaintext is shown once, at issue or rotation.
- `HEALTHBRIDGE_KEY_PEPPER` is a server-side secret: anyone with it and the database can verify guesses offline. Rotating it invalidates every key at once.
- The bootstrap token is platform-level and cannot read tenant data; it can only create a workspace. It must be at least 16 characters (the API refuses to start otherwise), and every attempt is rate limited per client IP in a fixed 15-minute window (`HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT`, default 10). Rotate it after setup. In demo mode it is printed to the log, which is why demo mode must not be exposed.
- Authorisation is scope-based (`runs:write`, `mappings:read`, …) with four least-privilege roles. A missing scope returns `403` with `details.requiredScope`; a foreign record returns `404` so identifiers cannot be probed.
- Tenant isolation is enforced in repository signatures (every query takes `workspaceId`) and asserted by `packages/persistence/test/sql-scoping.test.ts` (ADR-0005).
- Rate limiting is a per-key token bucket for authenticated routes, plus a per-IP fixed-window limiter for workspace bootstrap. Both are in-process and stop a runaway client, not a distributed attacker.
- Every privileged action is written to an append-only audit trail (`GET /audit`, owner scope). Audit write failures are logged, never allowed to fail the request.

**Uploads.** `POST /assets` accepts raw bytes only (no multipart), enforces `HEALTHBRIDGE_MAX_UPLOAD_BYTES`, and stores objects content-addressed and verified on read. Bytes are buffered before hashing — a 64 MB limit exists because there is no streaming upload yet.

**Data at rest and in transit.** The SDK/CLI write nothing except the files you ask them to write. The API stores metadata in MySQL and objects on disk, **unencrypted**. TLS termination and encryption at rest are deployment responsibilities and are not implemented here. Do not deploy with real patient data without adding both.

**PHI in logs.** CLI summaries contain counts and percentages, never field values. Errors may include offending values in `issues[].offendingValue` only where adapters set it deliberately; review before sharing.

## Non-goals

HealthBridge OS does not certify HIPAA, GDPR, MDR or any other regulatory regime, does not anonymise data, and must not be used for autonomous diagnosis or clinical decision-making.

## Dependency and container hygiene

`npm audit` and dependency review belong in CI (see `.github/workflows/ci.yml`). Report known-vulnerable transitive dependencies as issues rather than silently upgrading major versions.
