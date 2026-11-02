# Fix API Connection and UX/UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix API connection handling so the web console connects reliably to any configured base URL and local demo backend, and resolve all navigation, discoverability, and UX/UI gaps across shipped routes (`STU-001`).

**Architecture:** 
1. Make `ApiClient` dynamically resolve its base URL from `AuthStore` (or method parameter for pre-auth calls), removing hardcoded `/api/v1` dependencies.
2. Enhance `ConnectPage` with live backend detection, pre-auth health verification against the user's specific `baseUrl`, and a one-click local demo connection.
3. Bridge all disconnected UX routes: link Lineage, Validation Centre, and Debugger from Run Detail and Runs; link Mapping Editor from Mappings and Studio; replace Studio Home's `hb-planned` cards with active tool cards; and add a Formats viewer dialog to expose `ApiClient.formats()`.
4. Fix `PlannedCard` input attribute bindings to eliminate Angular `NG0303` runtime warnings.

**Tech Stack:** Angular 19 (standalone components, signals), RxJS, TypeScript, Vitest, Node.js test runner.

**Spec:** Referenced from `docs/console.md`, `docs/plan-web-studio.md`, and `MISSING.md` (`STU-001`).

## Global Constraints
- Preserve zero-storage API key model (API key held in memory only).
- Keep all unit tests passing (`npm run test:web` and `npm run test:unit`).
- Retain existing security headers and CSP compatibility.

## Review Focus
1. Custom base URL with or without trailing slash (e.g., `http://127.0.0.1:3000/api/v1/` vs `/api/v1`).
2. Pre-connection health verification when user changes base URL in the input before logging in.
3. Accessible navigation labels and keyboard focus on new action links.
4. Handling when runs have no validation or trace data yet.
5. Formats modal accessibility (`role="dialog"`, `aria-modal="true"`, escape to close).

---

### Task 1: Fix Dynamic Base URL & API Connection in `ApiClient`, `AuthStore`, and `ConnectPage`

**Files:**
- Modify: `apps/web/src/app/core/api-client.ts`
- Modify: `apps/web/src/app/core/auth.store.ts`
- Modify: `apps/web/src/app/features/connect/connect.page.ts`
- Test: `apps/web/src/app/core/auth.store.spec.ts`

**Interfaces:**
- `ApiClient.health(baseUrl?: string): Observable<Health>`
- `ApiClient.createWorkspace(input, bootstrapToken, baseUrl?: string): Observable<CreatedWorkspace>`
- `ApiClient.url(path: string): string` -> resolves path against active `AuthStore.baseUrl()` or `/api/v1`

- [ ] **Step 1: Update `AuthStore` to expose `baseUrl` signal directly**
- [ ] **Step 2: Update `ApiClient` to resolve paths via dynamic `baseUrl` instead of static `API_BASE`**
- [ ] **Step 3: Update `ConnectPage.connect()` and `bootstrap()` to pass `this.baseUrl` to pre-auth calls**
- [ ] **Step 4: Verify with `npm run test:unit`**

---

### Task 2: Fix `PlannedCard` Component Inputs and Tests

**Files:**
- Modify: `apps/web/src/app/ui/primitives.ts:77-80`
- Test: `apps/web/src/app/ui/primitives.spec.ts:110-120`

**Interfaces:**
- `PlannedCard`: accepts both `message` and `detail` inputs seamlessly

- [ ] **Step 1: Add `detail` input to `PlannedCard` and compute combined message text**
- [ ] **Step 2: Run `npm run test:unit` and verify zero `NG0303` console warnings**

---

### Task 3: Link Validation Centre, Lineage, and Debugger from Run Detail and Runs Pages

**Files:**
- Modify: `apps/web/src/app/features/runs/run-detail.page.ts`
- Modify: `apps/web/src/app/features/runs/runs.page.ts`

**Interfaces:**
- Navigation buttons to `/validation-centre/:id`, `/lineage/:id`, and `/studio/debugger/:id`

- [ ] **Step 1: In `run-detail.page.ts`, add an actions toolbar / card links for Validation Centre, Data Lineage, and Debugger**
- [ ] **Step 2: In `runs.page.ts`, add quick action buttons in the runs table to open Validation Centre and Lineage**
- [ ] **Step 3: Test navigation logic with `npm run test:web`**

---

### Task 4: Link Mapping Editor from Mappings Page

**Files:**
- Modify: `apps/web/src/app/features/mappings/mappings.page.ts`

- [ ] **Step 1: In `mappings.page.ts`, add action to open `/mapping-editor/:id` in addition to `/studio/mappings/:name`**
- [ ] **Step 2: Verify with `npm run test:web`**

---

### Task 5: Replace `hb-planned` Cards on Studio Home with Active Tool Cards

**Files:**
- Modify: `apps/web/src/app/features/studio/studio-home.page.ts`

- [ ] **Step 1: Replace the 3 static `hb-planned` cards with interactive Studio Tool cards with real links**
- [ ] **Step 2: Add quick jump to the most recent run's Validation Centre and Lineage graph**
- [ ] **Step 3: Verify with `npm run test:web`**

---

### Task 6: Add Formats Viewer Modal / Action

**Files:**
- Modify: `apps/web/src/app/layout/shell.ts`
- Modify: `apps/web/src/app/features/studio/studio-home.page.ts`

- [ ] **Step 1: Add formats discovery card or trigger using `ApiClient.formats()`**
- [ ] **Step 2: Render supported source/target formats from the server**

---

### Task 7: Add Local Demo Quick-Connect on Connect Page

**Files:**
- Modify: `apps/web/src/app/features/connect/connect.page.ts`

- [ ] **Step 1: Add API status check on `/connect` page initialization**
- [ ] **Step 2: Add a "Quick Connect (Local Demo)" one-click action using default demo credentials**
- [ ] **Step 3: Test connecting to the running API instance**

---

### Task 8: Verification

- [ ] **Step 1: Run vitest unit tests (`npm run test:unit`)**
- [ ] **Step 2: Run web logic test suite (`npm run test:web`)**
- [ ] **Step 3: Run full monorepo build (`npm run build`)**
- [ ] **Step 4: Re-build web console production bundle (`npm run build:web`)**
- [ ] **Step 5: Verify live connectivity to `http://127.0.0.1:4200`**
