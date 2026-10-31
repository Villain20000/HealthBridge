# Angular component-DOM tests — planned

**Status:** ⬜ not implemented · **Phase:** D · **UI today:** logic is unit-tested (32 tests),
UI behaviour is covered by 64 Playwright journeys; there is no TestBed layer.

## Why it matters

E2E proves the app works end-to-end but is slow and cannot pin down a component's state machine
(pagination, filters, error branches) cheaply. Component tests close that gap.

## What exists today (verified)

- `apps/web/test/*.test.ts` runs under the repo's `node:test` runner (pure logic only).
- `apps/web/e2e/*.spec.ts` runs under Playwright against a real API and the real proxy.
- CI has `console-e2e` and `console-e2e-compose` jobs; no `ng test` job exists.

## What is missing

- A DOM test environment and a decision between Vitest and Karma.
- Specs for the components with the most state: table filters, cursor pagination, error panels,
  auth store transitions, SSE chip state.

## Proposed design

**Preferred: Vitest + `@analogjs/vitest-angular`** — no browser binary, fast, same TS pipeline.
Fallback: Karma + Chromium with `CHROME_BIN` pointing at Playwright's browser (already installed
in CI). Layout: `*.spec.ts` beside each component; TestDoubles for `ApiClient` only (never for
HTTP itself). Keep the existing `node:test` suite untouched.

## Acceptance criteria

- `ng test` runs headless in CI in under two minutes and is a required check.
- At least: `StatusChip`, `ErrorPanel`, `EmptyState`, `ConnectPage` (client-side validation),
  `RunsPage` (filter + pagination state), `AuthStore` (401 clears, 403 does not).
- No spec asserts on CSS classes alone; assertions target roles, labels and text.
- A failing component test fails the build before E2E starts.

## Risks / non-goals

- A second runner adds surface; do not duplicate what Playwright already proves.
- No visual regression snapshots (screenshots of a design system are noisy and slow).
- No coverage percentage target; coverage is a diagnostic, not a gate.
