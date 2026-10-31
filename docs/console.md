# Operator Console (apps/web)

The Angular application in `apps/web` is the **HealthBridge Operator Console v1**: a real,
key-authenticated administrative UI over the platform API. It is the foundation the
Studio (Visual Transformation Debugger, Mapping Studio, Schema Explorer, Lineage, FHIR
Validation Center, Asset Explorer) will be built on — not a separate application.

It is explicitly **a single-operator administrative console**, not a multi-user
authentication system. Read the security model before exposing it anywhere.

---

## 1. What exists today

| Area | Implemented | Notes |
|---|---|---|
| Connect / session | Yes | API base URL + API key, memory only, explicit Disconnect |
| Health & limits | Yes | `/healthz` read live: mode, persistence, storage, queue, uptime, limits, versions |
| Dashboard | Yes | Health cards, execution/rate limits, per-status counts, recent runs |
| Runs list | Yes | Cursor pagination, status filters, submit a new run |
| Run detail | Yes | Lifecycle, counts, issues, generated resources, traces, run bundle, cancel, replay |
| Live progress | Yes | `fetch` + `ReadableStream` SSE, reconnect with `Last-Event-ID`, connection chip |
| Studio | Yes | Landing screen with the latest five runs, assets and mappings, per-run stored-trace debugger links, and the mapping editor (draft autosave, conflict handling, publish, version diff, preview) |
| Mapping editor | Yes | `/studio/mappings/:name`: draft autosave and undo/redo, conflict resolution, publish with a server-validation gate, draft discard, read-only published versions, server version diff, JSON import/export, conditions and every transform parameter, coverage heat map, bounded preview |
| Stored-trace debugger | Yes | Filters, stage summary, virtualised timeline, payloads, declared rule provenance, resource/snippet diffs, filtered JSON export; reads stored rows only — no live attach, SSE, polling or breakpoints |
| Assets | Yes | Upload (size limit read from the API), list, download link, checksum display |
| Mappings | Yes | Import spec, versions, inspect the stored spec |
| Pipelines | Yes | Create (mapping + engine config), list, run against an asset → the run it produced |
| API keys | Yes | List, create (secret shown once), rotate, revoke |
| Audit | Yes | Paginated audit log with outcomes and request ids |
| Themes | Yes | Dark and light, follows the OS by default, manual toggle |
| Accessibility | Yes | Skip link, focus-visible rings, labelled controls, axe-checked in CI |

Anything not in this table is **not** simulated. The console never fakes a successful
operation: a button either calls the API and renders the response, or is not rendered.

---

## 2. Security model (API key in memory)

- The key lives in an Angular signal (`AuthStore`). It is **never** written to
  `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL, or a log line.
- Reloading the tab destroys it; the operator signs in again. That is deliberate.
- The key is sent as `x-api-key` on API requests, including the SSE request. `EventSource`
  cannot send headers, so the console uses `fetch` with a `ReadableStream` instead.
- A `401` clears the session and returns to `/connect` with an explanation. A `403` keeps
  the session: the key is valid, the action is not allowed, and the page says so with the
  error `code` and `requestId`.
- Error messages show the API's problem code (`UNAUTHORIZED`, `FORBIDDEN`,
  `PAYLOAD_TOO_LARGE`, …), the HTTP status and the request id. The API never echoes key
  material and the console never prints the key.

**Threat model.** Anyone with the key has the workspace's scopes. The console therefore
assumes the operator and the browser are trusted, and that the deployment is reachable
only over HTTPS behind an access control layer (VPN, SSO proxy, private network). It is not
hardened against a hostile page in the same browser profile, browser extensions, or an
attacker with local machine access. Do not expose it to the public internet.

**TLS.** Same-origin serving keeps the key off the wire only over TLS. Set
`TRUST_PROXY=1` when TLS terminates in front of the web container so HSTS is emitted.

### Replacing API keys with a cookie-based BFF/OIDC later

`AuthStore` is the only place that knows what a credential is. It exposes
`isConnected()`, `key()` (used by one interceptor and the SSE client) and
`invalidate(reason)`. To move to a BFF:

1. Add a `SessionAuthStore` with the same public surface and a `/api/session` probe.
2. Point the interceptor at it; drop the `x-api-key` header (the cookie travels on its own).
3. Delete the connect form. No page, guard or client changes.

`ApiClient` already owns every URL, header and DTO, so no component contains transport
logic.

---

## 3. Serving model

`apps/web/server.mjs` is a dependency-free Node process that serves the built bundle and
proxies `/api/*` to the API container:

```
browser ──HTTPS──▶ web container (static SPA + /api proxy) ──▶ api container
```

Configuration (environment, no hardcoded URLs):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4200` | Listen port |
| `API_ORIGIN` | `http://127.0.0.1:3000` | Upstream API origin |
| `API_PREFIX` | `/api` | Only this prefix is proxied; nothing else reaches internals |
| `STATIC_DIR` | `dist/web/browser` | Built bundle directory |
| `PROXY_TIMEOUT_MS` | `0` | Upstream socket timeout; `0` keeps SSE open |
| `TRUST_PROXY` | unset | `1` emits HSTS (TLS terminated upstream) |

Proxy behaviour:

- **SSE**: the response is streamed chunk by chunk (`flushHeaders`, no buffering,
  `X-Accel-Buffering: no`, `Cache-Control: no-store, no-transform`), socket timeouts are
  disabled for the stream, and the client disconnect cancels the upstream request.
- **Uploads**: the request body is piped, never buffered in the proxy.
- **No caching** of `/api/*`: `Cache-Control: no-store`.
- **Security headers** on every response: CSP (`default-src 'self'`; `connect-src 'self'`;
  `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- **SPA fallback** only for `GET`/`HEAD` without a file extension; `/api/*` never falls back
  to HTML. Dotfiles and traversal escapes are refused.
- **Request ids**: an incoming `x-request-id` is forwarded, otherwise one is generated, so
  a failed request can be traced from the browser to the API log.
- Hashed assets are cached for a year; `index.html` is `no-store`.

`ng serve` uses `proxy.conf.json` with the same `/api` contract for local development.

---

## 4. Architecture

```
src/app/
  core/        transport and state: api-types, api-client, api.interceptor,
               api-errors, auth.store, sse, format        (framework-light, unit tested)
  ui/          presentation primitives: status chip, empty state, error panel,
               loading state, planned-feature card
  layout/      authenticated shell: header, nav, mode/queue badges, theme, disconnect
  features/    one folder per route, lazy loaded:
               connect, dashboard, runs, run-detail, assets, mappings, keys, audit, studio
```

The Studio (`features/studio/`) contains the landing screen, the stored-trace debugger and the
mapping editor (`features/studio/editor/`) at `/studio/mappings/:name`. The debugger reads through
a page-scoped store and never opens a stream. The editor's `MappingEditorStore` is also
page-scoped: it owns the draft, debounced autosave (800 ms), undo/redo, 409 `DRAFT_CONFLICT`
handling, previews and publishing, and is discarded when the operator leaves the page.

The editor covers the whole draft lifecycle: autosave, undo/redo, conflict resolution (reload the
server draft or overwrite it), publishing (pending edits are flushed first and the server validates
the saved draft again before a version is created), and draft discard. It can open a published
version read-only with `?version=N`, compare versions through the server-computed diff, import and
export the JSON definition, edit rule conditions and every transform parameter (complex parameters
use a bounded JSON editor), and show the coverage heat map of a preview. Previews use a record
limit and are explicitly **preview only**: they run against a stored asset and never create a run.

Keyboard model: `Ctrl/Cmd+S` flushes the draft, `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` undo and redo (the
shortcuts intentionally leave text fields to native undo), and rule order changes through native
drag and drop or the labelled Move up / Move down buttons. Unsaved work is protected by an inline
dirty guard instead of a browser dialog: leaving flushes the draft, and when the save fails the
page offers **Retry save** or **Discard and leave**. `beforeunload` is registered only while the
draft is dirty.

Conventions that keep the Studio additive:

- **Standalone components only**; no `NgModule`.
- **Signals** for all UI state (`signal`, `computed`, `effect`), `ChangeDetectionStrategy.OnPush`.
- **Typed API clients** — `ApiClient` returns typed DTOs, maps the API's resource-named
  envelopes (`{ runs, nextCursor }`) to one `Page<T>`, and turns every failure into
  `ApiProblem { code, status, requestId }`.
- **Feature folders + lazy routes** (`loadComponent`) so new Studio screens never enlarge
  the initial bundle.
- **Shared primitives** (`ui/`) and **design tokens** (`styles.css` custom properties) so a
  new screen looks native without copying markup.
- **API access never lives in a component template**; components call `ApiClient` and hold
  state, which is what a future visual debugger needs.

Adding the Studio means adding `features/studio/` routes and reusing `ui/` and `core/`.
Nothing about the current routes has to be rewritten.

---

## 5. Testing

| Layer | Command | Scope |
|---|---|---|
| Logic unit tests | `npm run test:web` | SSE frame parser (chunk boundaries, CRLF, comments, duplicate ids), error mapping, formatters, key masking, and the proxy contract (headers, no-store, traversal, SSE passthrough) |
| API integration | `npm test` | Includes the 413/`PAYLOAD_TOO_LARGE` and `INVALID_JSON` envelope regressions found by the console work |
| End-to-end | `npm run test:e2e` | Playwright, Chromium, real API + real proxy; console, Studio, stored-trace debugger and mapping editor coverage |
| End-to-end (containers) | `E2E_BASE_URL=http://127.0.0.1:4200 npx playwright test` (in `apps/web`) | The same suite against the composed stack |
| Accessibility | part of E2E | axe (WCAG 2.0 A/AA and 2.2 AA tags) on connect, dashboard (both themes), debugger, mapping editor (both themes) and run detail, keyboard navigation including run-detail tabs and the mapping editor (add, reorder), 390 px overflow on console, debugger, editor and Studio screens |

`studio-editor.spec.ts` covers the editor end to end: a keyboard-only new mapping (add, move,
undo/redo, `Ctrl+S` flush, preview that creates no run, publish verified through the API),
autosave against the seeded mapping, the seeded v1→v2 diff, conflict resolution after a revision
bump through the API, blocked navigation with a forced 503 and a successful retry, a viewer-key
403 that shows the code and request id, a read-only `?version=1` view, and JSON import/export
(the invalid-import path leaves the draft unchanged).

E2E data is **seeded through the API** (`apps/web/e2e/support/seed.mjs`): a unique
workspace per run, two synthetic CSV assets (24 rows and a header-only file), two mappings (one
reserved for the editor specs, which save drafts and publish versions), a second version of the
run mapping with one extra rule for the version-diff spec, two completed runs and a viewer key.
There are no hardcoded UI fixtures and no mocked API responses, except one
test that intercepts the SSE route to prove the client sends `x-api-key`, never puts the
key in the URL, and stops on the terminal frame, and the debugger's deterministic 5,000-row
trace fixture served through `page.route` — the only new API interception besides SSE.

The mapping editor is also checked at 390 px with the version-diff and coverage tables visible:
both tables stay inside their own scroll containers and the page never grows horizontally. The
keyboard check adds a rule and reorders rules with focus plus Enter and no mouse clicks.

CI runs the suite twice: against a freshly built API + proxy, and against the Docker
Compose stack.

---

## 6. Known limitations (v1)

- **No component-level DOM tests.** Component behaviour is covered end-to-end; the logic
  layer is unit tested. Karma/Jasmine are intentionally not wired (they need a browser
  binary in every job and duplicate what Playwright already proves).
- **Single workspace per session.** The API's `/workspaces/current` returns the workspace
  bound to the key; switching workspaces means switching keys.
- **No OpenAPI-generated client.** DTOs are hand-written against `docs/api.md` and checked
  by E2E; an OpenAPI document is still on the roadmap.
- **No offline mode, no optimistic writes, no client-side cache.** Every view reads the API.
- **Rate limiting is per key**; the console shows the limits but does not retry with
  backoff on `429` beyond surfacing the error.
- **The stored-trace debugger is stored replay only.** It never attaches to a running run;
  per-rule observed lineage is never recorded and rule conditions are printed, not evaluated.
