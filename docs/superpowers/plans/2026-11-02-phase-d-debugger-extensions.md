# Phase D Debugger Extensions (`STU-002`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the HealthBridge stored-trace debugger at `/studio/debugger/:runId` into a VS Code-style three-pane workbench with breakpoint management, multi-mode stepping (Continue, Step Over, Step Back, Jump to Error, Jump to Record), timeline gutter toggles, and per-rule condition evaluation labeled with `[observed]` vs `[inferred]`.

**Architecture:** Pure breakpoint and condition evaluation logic in `breakpoints.logic.ts` and `trace.logic.ts` consumed by an extended `DebuggerStore` with `sessionStorage` breakpoint caching. The UI is reorganized into an accessible three-pane responsive layout (`DebuggerPage`) featuring a clickable breakpoint gutter on `TraceTimeline`, an execution control `DebuggerToolbar`, a `BreakpointsPanel`, and an enhanced `Provenance` / rule evaluator component.

**Tech Stack:** Angular 19 (Signals, Standalone Components, zoneless change detection), TypeScript 5.4, Vitest, Node.js test runner (`node:test`), Playwright.

**Spec:** [docs/superpowers/specs/2026-11-02-phase-d-debugger-extensions-design.md](file:///c:/Users/igian/Downloads/Projects/HealthBridge/docs/superpowers/specs/2026-11-02-phase-d-debugger-extensions-design.md) (implements `STU-002` in `MISSING.md` and Phase D in `ROADMAP.md`).

## Global Constraints

- **Stored-trace replay only:** The debugger reads stored traces (`GET /runs/:id/traces`) and must never claim live execution, server-side pausing, or live attach.
- **Browser-safe dependencies:** Zero `node:*` runtime imports in `apps/web`.
- **Zero API deltas:** Operates entirely against existing endpoints (`/runs/:id`, `/runs/:id/traces`, `/runs/:id/issues`, `/mappings/:id`).
- **WCAG 2.1 AA:** Accessible keyboard navigation (`F5`, `F9`, `F10`, `Shift+F10`), ARIA live regions, semantic roles (`toolbar`, `listbox`, `option`), and color-independent status chips.
- **Strict truthfulness:** Payload values present in trace events are marked `[observed]`; spec metadata (defaults, fallback targets, condition rules) are marked `[inferred]`.

## Review Focus

1. **Gutter breakpoint toggle on virtualized timeline:** When the timeline is scrolled or virtualized (over 200 events), clicking the gutter of any visible row must correctly toggle the breakpoint for that event's exact sequence number.
2. **Stepping off-filter awareness:** When `continueToBreakpoint()` or `jumpToNextError()` finds a match in the full event list that is hidden by active filters, the store must surface an off-filter notification and offer a single-click "Clear filter and jump" action without crashing or getting stuck.
3. **Condition evaluation on missing or null snippets:** When an event lacks `inputSnippet` or has a null snippet, rule condition evaluation must return `Snippet Unavailable` or `Unmatched` safely without throwing null-pointer exceptions.
4. **Keyboard shortcut handling outside input fields:** Global hotkeys (`F5`, `F9`, `F10`, `Shift+F10`) must trigger stepping actions reliably without interfering when the user is typing in a search or filter input field.
5. **Breakpoint persistence in `sessionStorage`:** Breakpoints must survive page refresh for the specific `runId` without leaking across different runs.

---

### Task 1: Pure Breakpoint Evaluation and Stepping Logic

**Files:**
- Create: `apps/web/src/app/features/studio/debugger/breakpoints.logic.ts`
- Modify: `apps/web/src/app/features/studio/debugger/trace.logic.ts`
- Test: `apps/web/test/trace-debugger.test.ts`

**Interfaces:**
- Produces in `breakpoints.logic.ts`:
  ```typescript
  export type BreakpointKind = "seq" | "status" | "stage" | "record" | "rule" | "condition";
  export interface Breakpoint {
    id: string;
    kind: BreakpointKind;
    enabled: boolean;
    value: string | number;
    conditionTarget?: "input" | "output";
    conditionPath?: string;
    conditionOp?: "equals" | "not_equals" | "exists" | "not_exists" | "contains" | "in";
    conditionValue?: unknown;
  }
  export function matchesBreakpoint(event: DebuggerEvent, bp: Breakpoint): boolean;
  export function findNextBreakpoint(events: DebuggerEvent[], currentIndex: number, breakpoints: Breakpoint[], direction: "forward" | "backward"): number;
  export function findNextErrorIndex(events: DebuggerEvent[], currentIndex: number, direction: "forward" | "backward"): number;
  export function findNextRecordIndex(events: DebuggerEvent[], currentIndex: number, direction: "forward" | "backward"): number;
  export interface ConditionEvaluationResult {
    path: string;
    op: string;
    expectedValue?: unknown;
    evaluated: boolean;
    matched: boolean;
    observedValue: unknown;
    hasObservedValue: boolean;
    reason: string;
  }
  export function evaluateRuleConditions(rule: MappingRule, inputSnippet: unknown, hasInputSnippet: boolean): ConditionEvaluationResult[];
  ```

- [ ] **Step 1: Write failing tests in `apps/web/test/trace-debugger.test.ts`**
  - Test `matchesBreakpoint` for `seq`, `status`, `stage`, `record`, `rule`, and `condition`.
  - Test `findNextBreakpoint` forward and backward with wrapping or clamping at boundaries.
  - Test `findNextErrorIndex` jumping to events with `status === "error"` or `issues.length > 0`.
  - Test `findNextRecordIndex` jumping to next distinct `recordIndex`.
  - Test `evaluateRuleConditions` handling operators `equals`, `not_equals`, `exists`, `not_exists`, `contains`, `in`, and null/missing snippets safely.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npm run test:web`
  Expected: FAIL (cannot find module `breakpoints.logic.ts`).

- [ ] **Step 3: Implement `apps/web/src/app/features/studio/debugger/breakpoints.logic.ts`**
  - Implement pure utility functions for path extraction (`getByPath`), condition operators, breakpoint matching, and index searches.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm run test:web`
  Expected: PASS (all unit tests passing).

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/app/features/studio/debugger/breakpoints.logic.ts apps/web/src/app/features/studio/debugger/trace.logic.ts apps/web/test/trace-debugger.test.ts
  git commit -m "feat(studio): add pure breakpoint evaluation and stepping logic"
  ```

---

### Task 2: Breakpoint State & Stepping Actions in `DebuggerStore`

**Files:**
- Modify: `apps/web/src/app/features/studio/debugger/debugger.store.ts`
- Test: `apps/web/test/trace-debugger.test.ts`

**Interfaces:**
- Consumes: `Breakpoint`, `matchesBreakpoint`, `findNextBreakpoint`, `findNextErrorIndex`, `findNextRecordIndex` from `breakpoints.logic.ts`.
- Produces on `DebuggerStore`:
  ```typescript
  public readonly breakpoints: Signal<Breakpoint[]>;
  public readonly breakpointSeqs: Signal<Set<number>>;
  public readonly offFilterNotice: Signal<{ seq: number; label: string } | null>;
  public toggleSeqBreakpoint(seq: number): void;
  public addBreakpoint(bp: Omit<Breakpoint, "id">): void;
  public removeBreakpoint(id: string): void;
  public toggleBreakpoint(id: string): void;
  public continueToBreakpoint(): boolean;
  public stepOver(): void;
  public stepBack(): void;
  public jumpToNextError(): boolean;
  public jumpToPrevError(): boolean;
  public jumpToNextRecord(): boolean;
  public jumpToPrevRecord(): boolean;
  public jumpToOffFilterMatch(): void;
  public clearOffFilterNotice(): void;
  ```

- [ ] **Step 1: Write unit tests in `apps/web/test/trace-debugger.test.ts` for store logic**
  - Test breakpoint addition, removal, and sequence toggling.
  - Test `continueToBreakpoint` advancing selection to the next matching breakpoint event.
  - Test off-filter detection: when an error exists in `events()` but not in `filtered()`, `offFilterNotice` is set.
  - Test `jumpToOffFilterMatch` clearing filters and selecting the target sequence.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npm run test:web`
  Expected: FAIL (`toggleSeqBreakpoint` not defined on store).

- [ ] **Step 3: Update `DebuggerStore` in `apps/web/src/app/features/studio/debugger/debugger.store.ts`**
  - Add `breakpointsSignal` with `sessionStorage` initialization and persistence (`healthbridge:debugger:bp:${runId}`).
  - Add `offFilterNoticeSignal`.
  - Implement stepping and navigation methods with active filter awareness.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm run test:web`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/app/features/studio/debugger/debugger.store.ts apps/web/test/trace-debugger.test.ts
  git commit -m "feat(studio): add breakpoints and stepping state to DebuggerStore"
  ```

---

### Task 3: Interactive Timeline Gutter and Debugger Toolbar Components

**Files:**
- Modify: `apps/web/src/app/features/studio/debugger/trace-timeline.ts`
- Create: `apps/web/src/app/features/studio/debugger/debugger-toolbar.ts`
- Test: `apps/web/src/app/ui/primitives.spec.ts`

**Interfaces:**
- `TraceTimeline`:
  - Input: `breakpointSeqs = input<Set<number>>(new Set())`
  - Output: `toggleBreakpoint = output<number>()`
- `DebuggerToolbar`:
  - Inputs: `canPrevious: boolean`, `canNext: boolean`, `hasBreakpoints: boolean`, `currentIndex: number`, `totalCount: number`, `offFilterNotice: { seq: number; label: string } | null`
  - Outputs: `continue`, `stepOver`, `stepBack`, `jumpNextError`, `jumpPrevError`, `jumpNextRecord`, `jumpPrevRecord`, `jumpOffFilter`

- [ ] **Step 1: Write component DOM test in `apps/web/src/app/ui/primitives.spec.ts`**
  - Verify `DebuggerToolbar` renders stepping buttons with accessibility labels and emits on click.
  - Verify `TraceTimeline` renders breakpoint indicators in the gutter column and emits `toggleBreakpoint` when clicked.

- [ ] **Step 2: Run test to verify failure**
  Run: `npm run test:unit`
  Expected: FAIL (`DebuggerToolbar` does not exist).

- [ ] **Step 3: Implement `debugger-toolbar.ts` and update `trace-timeline.ts`**
  - In `trace-timeline.ts`, add a clickable gutter area with a dot `●` for active breakpoints.
  - In `debugger-toolbar.ts`, implement the accessible toolbar with Continue (F5), Step Over (F10), Step Back (Shift+F10), Jump Error, and Jump Record buttons.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npm run test:unit`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/app/features/studio/debugger/trace-timeline.ts apps/web/src/app/features/studio/debugger/debugger-toolbar.ts apps/web/src/app/ui/primitives.spec.ts
  git commit -m "feat(studio): add debugger toolbar and timeline breakpoint gutter"
  ```

---

### Task 4: Breakpoints Panel and Rule Condition Evaluator

**Files:**
- Create: `apps/web/src/app/features/studio/debugger/breakpoints-panel.ts`
- Modify: `apps/web/src/app/features/studio/debugger/provenance.ts`
- Test: `apps/web/src/app/ui/primitives.spec.ts`

**Interfaces:**
- `BreakpointsPanel`:
  - Inputs: `breakpoints = input<Breakpoint[]>([])`
  - Outputs: `add = output<Omit<Breakpoint, "id">>()`, `remove = output<string>()`, `toggle = output<string>()`
- `Provenance`:
  - Displays `[observed]` for payload-extracted values and `[inferred]` for spec-derived metadata.
  - Evaluates rule `when` conditions against the current event's `inputSnippet` and renders an evaluation table.

- [ ] **Step 1: Write component tests for `BreakpointsPanel` and `Provenance`**
  - Test `BreakpointsPanel` rendering breakpoint list and emitting `add`, `toggle`, `remove`.
  - Test `Provenance` condition table showing `Matched` / `Unmatched` with `[observed]` vs `[inferred]` badges.

- [ ] **Step 2: Run test to verify failure**
  Run: `npm run test:unit`
  Expected: FAIL (`BreakpointsPanel` does not exist).

- [ ] **Step 3: Implement `breakpoints-panel.ts` and update `provenance.ts`**
  - In `breakpoints-panel.ts`, build an accessible list with checkboxes to toggle active breakpoints and a collapsible form to add breakpoints.
  - In `provenance.ts`, invoke `evaluateRuleConditions` from `breakpoints.logic.ts` and render the evaluation summary and badges.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm run test:unit`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/app/features/studio/debugger/breakpoints-panel.ts apps/web/src/app/features/studio/debugger/provenance.ts apps/web/src/app/ui/primitives.spec.ts
  git commit -m "feat(studio): add breakpoints management panel and rule condition evaluator"
  ```

---

### Task 5: Three-Pane Responsive Workbench & Keyboard Navigation in `DebuggerPage`

**Files:**
- Modify: `apps/web/src/app/features/studio/debugger/debugger.page.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/app/ui/primitives.spec.ts`

**Interfaces:**
- `DebuggerPage`: Integrates Left Pane (Timeline + Breakpoints), Center Pane (Toolbar + Detail + Diff), Right Pane (Provenance + Condition Evaluation + Issues).
- Keyboard handler for `F5` (continue), `F9` (toggle breakpoint on current event), `F10` (step over), `Shift+F10` (step back), `Alt+E` (jump next error).

- [ ] **Step 1: Write test for keyboard navigation and three-pane structure**
  - Verify keyboard event dispatching triggers store stepping actions when active element is not an input or textarea.

- [ ] **Step 2: Run test to verify failure**
  Run: `npm run test:unit`
  Expected: FAIL.

- [ ] **Step 3: Refactor `debugger.page.ts` into a Three-Pane Grid**
  - Update template: Left Pane (`hb-trace-timeline`, `hb-breakpoints-panel`, stage summary), Center Pane (`hb-debugger-toolbar`, `hb-event-detail`, `hb-record-panel`), Right Pane (`hb-provenance`, issues list, `hb-debugger-export`).
  - Add `@HostListener("window:keydown", ["$event"])` to handle debugger shortcuts (`F5`, `F9`, `F10`, `Shift+F10`).
  - Update CSS grid styling in `debugger.page.ts` and `styles.css` with responsive collapse for screens <1200px.

- [ ] **Step 4: Run unit tests to verify they pass**
  Run: `npm run test:unit` && `npm run test:web`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/app/features/studio/debugger/debugger.page.ts apps/web/src/styles.css apps/web/src/app/ui/primitives.spec.ts
  git commit -m "feat(studio): implement three-pane workbench layout and keyboard navigation"
  ```

---

### Task 6: Playwright E2E Tests for Debugger Extensions

**Files:**
- Modify: `apps/web/e2e/studio-debugger.spec.ts`

**Interfaces:**
- Automated browser journeys covering:
  1. Gutter breakpoint toggle and Continue (F5) navigation.
  2. Adding condition/status breakpoints in Breakpoints Panel.
  3. Step Over, Step Back, Jump to Next Error.
  4. Off-filter notice and "Clear filter and jump" behavior.
  5. Rule condition evaluation badges (`[observed]` vs `[inferred]`).

- [ ] **Step 1: Add E2E tests in `apps/web/e2e/studio-debugger.spec.ts`**
  - Add test: `gutter click toggles breakpoint and Continue (F5) jumps to it`.
  - Add test: `jump to next error advances timeline to failing event`.
  - Add test: `rule condition evaluation shows observed vs inferred badges`.

- [ ] **Step 2: Run Playwright tests**
  Run: `npm run test:e2e -- apps/web/e2e/studio-debugger.spec.ts`
  Expected: PASS (all browser tests and accessibility assertions pass).

- [ ] **Step 3: Update documentation (`README.md`, `ROADMAP.md`, `MISSING.md`)**
  - Update `MISSING.md` marking `STU-002` as `DELIVERED`.
  - Update `ROADMAP.md` Phase D status noting debugger extensions shipped.
  - Update `README.md` Phase D row.

- [ ] **Step 4: Commit**
  ```bash
  git add apps/web/e2e/studio-debugger.spec.ts README.md ROADMAP.md MISSING.md
  git commit -m "test(studio): add e2e tests for debugger extensions and update roadmap"
  ```
