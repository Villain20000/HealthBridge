# HealthBridge OS — Implementation Progress

Single-page status for the platform API, the Operator Console and the Studio. It records what is
**verified**, what is partial, and what is deliberately not built. Claims here are backed by a
command in §7; anything without evidence is marked ⬜ or "not verified".

**Snapshot:** branch `main` · HEAD `44a40a4` · remote `origin/main` (in sync after this commit) · 6 untracked paths (generated, git-ignored: `docs/site/`, `benchmark-results/`, compiled `packages/fhir-ndjson/src/*.{js,d.ts*}`)
**Legend:** ✅ done and verified · 🟨 partial or needs owner review · ⬜ planned, not started

---

## 1. Status by area

| Area | Status | Evidence / notes |
|---|---|---|
| Core packages (envelope, mapping engine, trace protocol, adapters, validator, SDK) | ✅ | `npm test` — 313 tests, includes scenario lab and reproducibility |
| CLI (`@healthbridge/cli`) | ✅ | doctor / formats / transform / validate / demo / reproduce in CI |
| REST API (`@healthbridge/api`) | ✅ | MySQL 8.0+ or in-memory demo, scoped API keys, tenant isolation, idempotent runs, SSE, traces/bundles/replay, audit, durable `run_jobs` queue. `docs/api.md` |
| Limits discovery (B6) | ✅ | `/healthz` exposes upload/body/stored-result/trace/rate/queue limits; console reads it, nothing hardcoded |
| Cross-origin response headers (B1) | ✅ | `x-checksum`, `x-request-id` exposed via `access-control-expose-headers`; asserted through the proxy |
| Browser-safe dependencies (B5) | ✅ | type-only imports from `@healthbridge/shared-types`; CI greps the bundle for `node:` modules |
| **Operator Console v1** (`apps/web`) | ✅ | 8 lazy routes + 1 feature route, 34 E2E journeys, 32 unit tests, axe checks, compose E2E |
| Console serving/proxy (`apps/web/server.mjs`) | ✅ | same-origin `/api`, SSE passthrough, piped uploads, `no-store`, CSP + security headers, request-id propagation, traversal guards |
| **Studio M0/M1** (contracts + stored-trace debugger) | ✅ | Landed in `5ebc7fa`; 33 E2E pass; superseded by the M2 work below |
| **Studio M2** (mapping editor, draft API, live preview) | ✅ | Committed in `8203902` + `e644291` + merge `30dd443`: rule-table editor, mapping drafts/preview/publish/diff API, coverage; E2E `mapping-editor.spec.ts` |
| Studio schema explorers, lineage view, validation centre | ✅ | Committed in `44a40a4`: `GET /assets/:id/schema`, `lineage/`, `validation-centre/` pages + E2E (`lineage.spec.ts`, `validation-centre.spec.ts`); per-run scope, no aggregate endpoints |
| Broker-backed queue (Redis/BullMQ) | ✅ opt-in | `apps/api/src/jobs/bullmq-queue.ts` + `bullmq-queue.test.ts`; opt-in via `HEALTHBRIDGE_REDIS_URL`, MySQL queue remains the default (ADR-0004) |
| S3-compatible storage driver | ✅ opt-in | `S3StorageDriver` + auto-selection in `app.context` when `HEALTHBRIDGE_S3_ENDPOINT`/`BUCKET` are set; local/memory remain the default |
| Retention and deletion | ✅ | `RetentionService` + `DELETE /assets/:id`, `DELETE /runs/:id`, `DELETE /workspaces/current` + scheduled sweeper (`HEALTHBRIDGE_RETENTION_SWEEP_MS`, `HEALTHBRIDGE_WORKSPACE_GRACE_DAYS`); e2e + service tests |
| OpenAPI document + typed client | ✅ | `apps/api/src/openapi.ts` + `generate-openapi.ts`, committed `docs/openapi.json`, drift-checked in CI (`--check`); `@healthbridge/client` typed REST client (mapping-studio/pause-resume methods still missing) |
| Adapter wave (HL7 v2, CDA, DICOMweb, XLSX, OMOP, MySQL connector, …) | ✅ | 13 opt-in adapters + FHIR NDJSON split into `@healthbridge/fhir-ndjson` (4th built-in); conformance kit, security suite, benchmarks, docs site, release automation — see `44a40a4` |
| Live pausable execution | ✅ | Chunked checkpoints with pause/resume (`POST /runs/:id/pause|resume`); v1 process-local, replay untouched |
| Docker Compose demo | ✅ | mysql + api + web build, start healthy, smoke script + 64 E2E tests against containers |
| Component-DOM (Karma/Vitest) tests | ⬜ | Logic unit-tested, UI covered by E2E; no TestBed layer. Toolchain decision, see §8.1 |

---

## 2. Phase tracker

| Phase | Scope | Status |
|---|---|---|
| 0 — Bootstrap | Angular workspace, B1/B5/B6, compose wiring, typed client | ✅ |
| 1 — Connection & health | connect (memory-only key), health/limits, shell with mode/queue badges | ✅ |
| 2 — Dashboard & runs | real statistics, runs list + cursor paging + filters, submit run | ✅ |
| 3 — Run detail | lifecycle, issues, resources, traces, bundle, cancel, replay | ✅ |
| 4 — Live progress | `fetch` + `ReadableStream` SSE, reconnect, dedupe, abort, status chip | ✅ |
| 5 — Data & administration | assets (upload/download/checksum), mappings (+versions), **pipelines (create + run)**, API keys, audit | ✅ |
| 6 — Quality | dark/light themes, responsive, keyboard/axe, CI e2e (built + compose), docs | ✅ |
| D2 — Studio M0/M1 | contracts + stored-trace debugger (`/studio`, `/studio/debugger/:runId`) | ✅ |
| D3 — Studio M2 | mapping editor, draft API, live preview, schema explorers, lineage view, validation centre | ✅ |
| E+ — Adapter wave | HL7 v2, CDA, DICOMweb, XLSX, OMOP, MySQL connector, VCF/FASTA/PDF/EDF/CDISC-ODM, FHIR REST/validator, NDJSON split | ✅ |

---

## 3. What this cycle delivered (Operator Console v1)

**Backend corrections**

- **B1** — download responses expose `x-checksum`/`x-request-id` to cross-origin callers.
- **B6** — `/healthz` is the limits contract: `maxUploadBytes`, `maxRequestBodyBytes`,
  `maxStoredResultBytes`, `maxTracesPerRun`, `rateLimit{burst,refillPerSecond}`,
  `queue{concurrency,maxAttempts}`. Documented in `docs/api.md`, consumed by the UI.
- **B5** — the browser bundle contains no `node:*` imports (CI guard + unit assertion).

**Console** — `apps/web/src/app/`

| Path | Contents |
|---|---|
| `core/` | `api-types` (DTOs mirroring `docs/api.md`), `api-client` (typed, one `Page<T>` for every list envelope, `ApiProblem` for failures), `api.interceptor` (`x-api-key`, `x-request-id`, 401-only invalidation), `auth.store` (memory-only key, explicit disconnect), `sse.ts`, `api-errors.ts`, `format.ts`, `json.ts`, `navigation.ts`, `virtual-window.ts` |
| `ui/` | status chip, empty state, error panel (code + request id + retry), loading state, planned-feature card |
| `layout/` | authenticated shell: primary nav, API/queue mode badges, key prefix, theme toggle, disconnect, skip link, auto-redirect on lost session |
| `features/connect` | API base URL + key, first-run workspace bootstrap, trusted-operator warning |
| `features/dashboard` | persistence/queue/storage/uptime, execution + rate limits, versions, per-status counts (labelled with the page size they were counted from), recent runs |
| `features/runs` | filters, cursor pagination, submit form (asset + mapping + options + idempotency key), run detail with issues/resources/traces/bundle tabs, cancel, replay |
| `features/assets` | upload (limit from `/healthz`), list, download, checksum |
| `features/mappings` | import spec, list, inspect, version history |
| `features/pipelines` | catalogue, create (mapping + JSON config, client-side validation), run → submits a real run and navigates to it |
| `features/keys` | list prefixes, create/rotate (secret shown once), revoke |
| `features/audit` | paginated audit log with outcomes |
| `features/not-found` | 404 screen |

**Serving** — `apps/web/server.mjs`: static bundle + `/api` proxy (`API_ORIGIN`, `API_PREFIX`,
`PROXY_TIMEOUT_MS=0` for SSE, `TRUST_PROXY` → HSTS), streamed SSE (`no-transform`, `X-Accel-Buffering: no`),
piped uploads, `no-store` on API, CSP/nosniff/referrer/frame-options/permissions-policy/COOP,
request-id propagation, SPA fallback that never swallows `/api`, traversal refusal, `/healthz`
for the container check. `ng serve` uses `proxy.conf.json` on port 4300.

**Tests and CI** — 32 unit tests (`apps/web/test`), 34 Playwright journeys (`apps/web/e2e`),
axe WCAG 2.2 AA checks, compose smoke extended with shell headers, proxy caching, SSE and
queue-row assertions. CI: console build + unit + bundle-leak guard in the matrix; `console-e2e`
and `console-e2e-compose` jobs.

**Docs** — `docs/console.md` (security model, proxy contract, architecture, testing, limitations),
README capability/quickstart, `ARCHITECTURE.md` §9, `docs/api.md` limits contract,
`docs/plan-web-studio.md` marked implemented, ROADMAP Phase D, CHANGELOG, `.env.example`.

---

## 4. Studio M0/M1 (landed in `5ebc7fa`) and M2 (landed in `8203902` → `30dd443`)

Present in the tree and passing E2E; listed here so the tracker reflects reality:

- M0 contracts in `packages/` (6 files touched) plus console-side types.
- `/studio` home (`studio-home.page.ts`): recent runs/assets/mappings from the API, honest
  "no aggregate endpoint" wording, planned cards for unbuilt tools, links into the debugger.
- `/studio/debugger/:runId` (`debugger/`): page-scoped store with monotonic request token,
  exact mapping version fetch, stored-trace timeline with virtual window, filters, event detail,
  provenance panel, record panel, export, explicit "stored traces, not live execution" wording.
- 33 E2E tests: `studio-debugger.spec.ts`, `studio-navigation.spec.ts`, `studio-shell.spec.ts`.
- M2 mapping editor (`8203902`, finished in `e644291`, merged in `30dd443`): rule-table editor
  UI at `/mapping-editor/:mappingId`, mapping-studio draft/preview/publish/diff API
  (`mapping-studio.controller.ts`), live preview service, coverage; E2E
  `mapping-editor.spec.ts`.
- `44a40a4` (this HEAD): 13 opt-in adapters, FHIR NDJSON split into `@healthbridge/fhir-ndjson`
  (4th built-in), opt-in BullMQ driver, auto-selected S3 driver, retention service + DELETE
  endpoints + sweeper, OpenAPI generator + committed `docs/openapi.json` (CI `--check`) +
  `@healthbridge/client`, `GET /assets/:id/schema`, lineage/mapping-editor/validation-centre
  pages with E2E, pause/resume checkpoints, benchmarks, docs site, security fixtures.

**Verification:** all 64 E2E tests pass against the composed stack (§7). **Not re-verified by me:**
the design intent behind the M0/M1 files — review with the author before closing D2.

---

## 5. Defects found and fixed this cycle

| Symptom | Root cause | Fix |
|---|---|---|
| Oversized upload returned **500** | body-parser's 413 is a plain error, fell through to the generic handler | mapped to `413 PAYLOAD_TOO_LARGE` (+ request id), regression test |
| Malformed JSON returned **500** | same, for `entity.parse.failed` | `400 INVALID_JSON`, regression test |
| A **403 signed the operator out** | interceptor treated every 4xx as a dead session | only 401 invalidates; 403 renders the error and keeps the session |
| Run-detail tabs showed a **permanent spinner** | resources/traces/bundle were only fetched when the tab was already active at load | tabs load on first view (`selectTab`) |
| Console **blocked by its own CSP** | Angular's critical-CSS inliner emits `onload=` | inlining disabled instead of weakening `script-src` |
| **API exposed on every interface** | compose mapped `3000:3000` | bound to `127.0.0.1` |
| Pipelines list would have crashed | DTO drift: API returns `{mappingId, config}`, client expected `{steps}` | corrected type + `createPipeline` contract, `getPipeline` added |
| Lists/keys/traces rendered wrong shapes | resource-named envelopes (`{runs}`, `{assets}`, `{events}`) and `{key, apiKey}` for created keys | mapped explicitly in `ApiClient` |

---

## 6. Environment caveats (local machine, not CI)

- **Port 4200** is held by `ng serve --host 127.0.0.1` from a different project (`...\Projects\MyCV`).
  Compose keeps 4200 (what CI uses); local verification ran on `WEB_PORT=4310`; the console dev
  server defaults to **4300**.
- **Docker Desktop** must be running for compose work; it had stopped between sessions and was
  restarted for the verification below.
- **Demo mode is in-memory**: restarting the API discards workspaces, keys, runs. Database mode
  (compose) persists to the MySQL volume.
- The stack is currently **up on `http://127.0.0.1:4310`**. Tear down with
  `docker compose -f docker/compose.demo.yaml down`.

---

## 7. Verification log

| Command | Result |
|---|---|
| `npm run build` | ✅ packages + API compile |
| `npm run build:web` | ✅ production bundle, ~299 kB initial, no `node:` imports |
| `npm test` | ✅ **313 / 313** |
| `npm run test:web` | ✅ **32 / 32** (SSE parser, error mapping, formatters, key masking, proxy contract) |
| `cd apps/web && npx playwright test` | ✅ **34 / 34** against built API + console proxy (pre-Studio tree) |
| `E2E_BASE_URL=http://127.0.0.1:4310 … npx playwright test` | ✅ **64 / 64** against Docker Compose (mysql + api + web), 1.4 min |
| `bash scripts/smoke-compose.sh` | ✅ health (database/mysql/durable), shell + CSP, `no-store`, proxy health, run, idempotency, `run_jobs` row, SSE frames through the proxy |
| API regressions | ✅ 413 / 400 envelopes covered in `apps/api/test/api.e2e.test.ts` |
| Accessibility | ✅ axe WCAG 2.2 AA on connect + dashboard (dark and light), keyboard skip link, 390 px overflow |
| **Not run** | component-DOM tests (none exist), cross-browser (Chromium only), load/soak tests |

---

## 8. Open work, in suggested order

Every item below has a full specification in **[docs/planned/](docs/planned/README.md)**: current
behaviour, missing API, proposed design, acceptance criteria and explicit non-goals. Nothing in
that folder is implemented; the console renders these as `planned` cards.

**8.1 Component-DOM tests** — the only gap against the approved test plan.
A Vitest harness and two specs exist (`vitest.config.mts`, `auth.store.spec.ts`,
`ui/primitives.spec.ts`) but there is no CI gate yet.
Options: wire `npm run test:unit` into CI, or add Karma + Chromium
(`CHROME_BIN` from Playwright). Acceptance: `test:unit` green in CI, specs for `StatusChip`,
`ErrorPanel`, `ConnectPage` validation, `RunsPage` filter/pagination state, `AuthStore`.
Risk: new toolchain; keep it isolated to `apps/web` so the node:test suite stays untouched.

**8.2 Studio follow-ups** — the M2 editor, schema explorers, lineage view and validation
centre are shipped per-run slices. Remaining: server-side spec validation before save,
optimistic-concurrency token on mapping updates, aggregate lineage/validation endpoints
(so the UI stops deriving graphs from one page of traces), and a navigation pass so every
shipped route is reachable from the shell or a run/asset page (see `STU-001`, `STU-004`,
`VAL-002` in `MISSING.md`).

**8.3 Schema explorer + lineage** — read-only first. Lineage can be derived today from stored
traces (source field → target path) but needs an aggregate endpoint; do not fake it client-side
with one page of rows.

**8.4 FHIR validation centre** — the API only runs structural checks; the UI must keep saying
"partial" until profile/terminology validation exists.

**8.5 Cookie-based BFF/OIDC** — `AuthStore` is the seam (§2 of `docs/console.md`). Acceptance:
no key in the browser at all, session probe, CSRF protection, SSO logout.

**8.6 OpenAPI generated client adoption** — the document (`docs/openapi.json`, CI
`--check`) and `@healthbridge/client` exist, but the console still hand-writes DTOs and the
generator omits `MappingStudioController` (see `API-003` in `MISSING.md`). Acceptance: the
console consumes the generated client and the drift test covers every controller.

**8.7 Repo hygiene** — ✅ remote `origin` (`github.com/Villain20000/HealthBridge`) configured;
`main` tracks `origin/main`. Generated output (`docs/site/`, `benchmark-results/`, compiled
`packages/fhir-ndjson/src/*.{js,d.ts*}`) stays untracked via `.gitignore`; do not commit it.

---

## 9. Changelog of this file

- **2026-11-01 — HEAD `44a40a4` truth pass.** Status table, phase tracker, §4 and §8 updated
  for the M2 editor, adapter wave, BullMQ/S3 opt-ins, retention + DELETE endpoints, OpenAPI +
  `@healthbridge/client`, schema/lineage/validation-centre pages, pause/resume, benchmarks,
  docs site and release automation. Remote `origin` now configured; generated output
  (`docs/site/`, `benchmark-results/`, compiled fhir-ndjson `src/`) stays untracked.
- **Initial tracker** — records Phases 0–6 (console v1), pipelines, defects fixed, verification
  evidence, Studio M0/M1 review status and the ordered backlog above.
