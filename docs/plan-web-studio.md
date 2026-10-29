# Plan: Angular Web Studio (frontend)

Status: **implemented (v1, phases 0–6).** `apps/web` is now the Angular Operator Console
described here; the operational reference is [docs/console.md](console.md). What remains from
this document is the Studio itself (visual debugger, mapping editor, schema/lineage
explorers), which the console's architecture is built to accept as added feature routes.
The "planned" cards inside the console mark exactly those unimplemented capabilities.

Related: `PLAN.md` §9 (Mapping Studio), §10 (Web Studio), §11 (debugger); `docs/api.md`
(endpoint contract); ADR-0004 (queue, SSE semantics); ADR-0005 (tenant isolation).

---

## 1. What the first release is (and is not)

**v1 — Operator console.** One person with an API key can answer: *is the platform healthy,
what did I run, what did it produce, what is wrong with it, and can I stop or repeat it?*

In scope:

| Screen | Job to be done |
| --- | --- |
| **Connect** | Enter API base URL + API key, verify against `GET /healthz`, remember only for the session |
| **Dashboard** | Health (`mode`, `persistence`, `queue.mode`), counts per run status, latest runs, recent audit |
| **Assets** | Upload a file (raw body), list, inspect checksum/size/format, download for comparison |
| **Mappings** | List, view a version's spec, import a JSON spec, show the version history |
| **Runs** | List with status filter + cursor paging, submit a run, watch it live, cancel, replay |
| **Run detail** | Status, counts, issues with `path`/`recordIndex`, resources, traces, bundle checksum, download |
| **API keys** | List, create (show the secret exactly once), rotate, revoke |

Explicitly **out of v1** (shown as `Planned`, never as a dead button):

- Mapping Studio: drag-and-drop editor, coverage heat map, undo/redo, version diff (§9)
- Debugger: step forward/back, breakpoints, field provenance, nested JSON diff (§11)
- Admin: workspace settings, retention, user accounts (no such endpoints exist)
- Any chart that is not computed from a real response

## 2. Decisions I need from you before scaffolding

1. **Where does the API key live?** The API only supports `x-api-key`; there is no session,
   login or OAuth. Options:
   - **(A) In-memory only** (recommended): survives navigation, lost on refresh, never in
     `localStorage`. Slightly annoying, no XSS exfiltration of a durable key.
   - **(B)** `sessionStorage`: survives refresh, readable by injected script.
   - **(C) BFF**: add a cookie-session proxy in front of the API and never send a key to the
     browser. Correct for multi-user production, but it is new backend work (≈2 days) and out
     of scope for v1 unless you want it.
2. **Deployment target**: served by the existing `web` container (Angular build output copied
   into the image, `/api` proxy kept) — my assumption — or a separate static host?
3. **Test depth**: Playwright end-to-end against the composed stack (recommended, adds a CI
   job and ≈1 day) or unit tests only for v1?

## 3. Backend deltas (small, and worth doing first)

The API is already sufficient for v1 except for these gaps:

| # | Gap | Change | Effort |
| --- | --- | --- | --- |
| B1 | Browser cannot read response headers (`x-checksum`, `x-request-id`) | add `access-control-expose-headers: x-checksum, x-request-id` and `access-control-max-age` to the CORS middleware | 15 min |
| B2 | `EventSource` cannot send `x-api-key` | no backend change: the client uses `fetch()` + `ReadableStream` to consume `/runs/:id/events` (Nest `@Sse` output is plain `text/event-stream`) | — |
| B3 | No machine-readable API description (my earlier landing page linked `/openapi.json`, which 404s) | optional: emit an OpenAPI 3.1 document from the controllers, served at `/api/v1/openapi.json`, checked in CI | 1 day, not required for v1 |
| B4 | No aggregate counts endpoint | v1 computes counts client-side from `GET /runs?limit=…` per status (5 requests, bounded); add `/runs/summary` only if it becomes slow | 0–0.5 day |
| B6 | Upload/body limits and rate-limit numbers are not exposed by any endpoint (`/healthz` reports health only) | add `limits: { maxUploadBytes, maxRequestBodyBytes, rateLimit: { burst, rps } }` to `GET /healthz` so the upload screen can state the real limit instead of hard-coding one | 20 min |
| B5 | `apps/web` depends on `@healthbridge/sdk`, which imports `node:fs` and cannot run in a browser | drop it. Response DTOs (`RunRecord`, `AssetRecord`, `MappingRecord`, `AuditEvent`, `Page<T>`) live in `@healthbridge/persistence` and are imported **type-only** (`import type`, erased at build, no runtime dependency); engine DTOs (`ValidationIssue`, `TraceEvent`, `CoverageReport`) come from `@healthbridge/shared-types`, which is already browser-safe | 15 min |

B1 and B5 are prerequisites; everything else can follow.

## 4. Architecture

```
apps/web/
  src/                         Angular application (standalone, no NgModules)
    app/
      core/                    auth (key store), api client, sse client, error mapping
      features/
        connect/  dashboard/  assets/  mappings/  runs/  run-detail/  keys/  audit/
      ui/                      table, pagination, status chip, issue list, empty/planned card
    index.html                 replaced by the Angular shell
  proxy.conf.json              dev-only /api → localhost:3000
```

- **Angular 19, standalone components, Signals**, zoneless change detection,
  `provideHttpClient(withFetch())`, `provideRouter` with lazy `loadComponent` per feature.
- **Typed API client**, hand-written over the documented routes, importing DTOs from
  `@healthbridge/shared-types` (RunRecord, MappingDefinition, ValidationIssue…). One
  `HttpInterceptorFn` adds `x-api-key`, `x-request-id` (crypto.randomUUID) and
  `Idempotency-Key` where the endpoint accepts it; one `ErrorInterceptor` maps the documented
  codes (`VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `RUN_NOT_CANCELLABLE`, `QUEUE_UNAVAILABLE`,
  `RATE_LIMITED`, `UNAUTHORIZED`) to human sentences with the `requestId` for support.
- **SSE via `fetch`** (`core/sse-client.ts`): parse `event:`/`data:` frames, resume from the
  server's snapshot on reconnect, stop on terminal events. `EventSource` is not usable because
  it cannot set headers.
- **Routing**: `/connect`, `/dashboard`, `/assets`, `/mappings`, `/runs`, `/runs/:id`,
  `/keys`, `/audit`; a `canActivate` guard redirects to `/connect` when no key is held.
- **State**: signals + a tiny store per feature; no NgRx for a console this size.
- **Build**: `ng build` → served by the existing `apps/web` node server (keeps `/api` proxy and
  one origin) — no SSR in v1.

## 5. Phases

Estimates are working days for one developer, and are estimates, not promises.

### Phase 0 — prerequisites (0.5 day)
- B1 CORS expose headers, B5 dependency swap.
- Angular workspace scaffolded inside `apps/web` (`ng new --standalone --routing --style=css`),
  root `package.json` scripts (`build:web`, `dev:web`), Dockerfile.web updated to build the
  Angular output, `proxy.conf.json` for `ng serve`.
- Gate: `npm run build` still succeeds; the container serves the Angular shell; existing
  `scripts/smoke-compose.sh` passes unchanged.

### Phase 1 — Connect + shell (1 day)
- Connect screen (base URL + key, `GET /healthz` verification, error states for 401/network).
- App shell: header with workspace slug (`GET /workspaces/current`), nav, sign-out, 404 route.
- Gate: key held in memory per decision §2.1; unit tests for the guard and the interceptor.

### Phase 2 — Dashboard + runs list (1.5 days)
- Health panel (`mode`, `persistence`, `queue.mode`, `uptimeSeconds`, version).
- Runs table: status filter, cursor paging, `recordsSucceeded/Failed`, age, link to detail.
- Counts per status computed from bounded list calls (B4), clearly labelled as "last N".
- Gate: pagination never repeats or skips a row (assert against the API's keyset contract).

### Phase 3 — Run detail, live + actions (2 days)
- Status lifecycle, issues grouped by code with `recordIndex`/`path`, resources table,
  traces list, bundle checksum + download, `omitted: true` handled honestly.
- Live updates: SSE stream, `aria-live` status, reconnect, fallback to polling.
- Cancel (409 handled: "already finished"), replay (new run id), copy `requestId`.
- Gate: a cancelled run shows `cancelled` without a stale success flash; SSE reconnect does not
  duplicate issues.

### Phase 4 — Assets + submit a run (1.5 days)
- Upload (file input + drag target), progress, checksum display, limit shown from `/healthz` (B6).
- Submit run: pick asset + mapping (+ options `maxRecords`, `importedAt`), `Idempotency-Key`
  generated per attempt and reused on retry; `409` duplicate returns the existing run.
- Gate: uploading a 64 MB file works; a rejected file shows the API's message, not "error".

### Phase 5 — Mappings + keys + audit (2 days)
- Mappings: list, spec viewer (read-only JSON tree), import, version history.
- Keys: list/create/rotate/revoke; the secret is shown exactly once, with a copy affordance.
- Audit: filterable table with actor, action, outcome, target.
- Gate: a rotated key stops working in the UI immediately (401 → back to Connect).

### Phase 6 — Hardening (1.5 days)
- WCAG 2.1 AA pass: focus order, labels, `aria-live` region for run status, colour-independent
  status chips, reduced-motion, 200 % zoom.
- Empty/error/loading states per screen; `Planned` cards for Studio/debugger sections.
- Playwright smoke (if §2.3 says yes): connect → upload → run → detail → cancel, against the
  composed stack; CI job `web-smoke`.

**v1 total: ≈ 10 working days.** Phases 1–3 alone (≈4.5 days) already give a usable console.

### Phase 7+ — Studio and debugger (separate project, ≈8–12 days)
Drag-and-drop mapping editor with a keyboard-complete alternative, coverage heat map, autosave,
version diff, then the debugger (step, jump-to-error, provenance, nested diff). Both need
backend support for draft mappings and diffing; they are planned in `PLAN.md` §9/§11 and are
out of scope here.

## 6. Honesty rules for the UI (non-negotiable)

1. No mock data in a shipped build. If an endpoint is missing, the screen shows a `Planned`
   card that names the missing capability and links to this plan.
2. Every number on screen comes from a response; "last N" is always qualified.
3. Errors show the API's `code` and `requestId`, never a generic toast that hides the cause.
4. `mode: demo` / `queue.mode: process` are surfaced in the header — a console that silently
   runs on volatile storage would be a trap.
5. Status is never conveyed by colour alone.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| API key in a browser is a long-lived secret | Decision §2.1; HTTPS only; no `localStorage` by default; document the BFF path |
| SSE through proxies buffers | server sends heartbeats (`HEALTHBRIDGE_SSE_HEARTBEAT_MS`); client falls back to polling; verify through the compose stack |
| Angular in a TS-project-references monorepo is fussy | scaffold with its own `tsconfig` (`tsc -b` must keep passing); keep Angular out of the root `references` graph until Phase 0 gate proves it |
| Scope creep toward the Studio | v1 gate is the operator loop; Studio is Phase 7+ with its own plan |
| Bundle size / slow first paint | lazy `loadComponent` per feature, budget warnings in `angular.json`, no chart library in v1 |

## 8. Definition of done for v1

- `npm run build` builds API and web; `npm test` stays green; web unit tests run in CI.
- `docker compose up` serves the console at `:4200` with `/api` proxied — no separate origin.
- `scripts/smoke-compose.sh` extended to assert the console loads and reaches `/api/v1/healthz`.
- The five flows (connect, upload, run + watch, cancel, replay) pass in Playwright or, if §2.3
  says no, are covered by a manual checklist stored with the plan.
- `README.md`, `docs/capability-matrix.md` and `PLAN.md` §10 updated from `Planned` to
  `Supported` **only for what actually runs**.
