# Design Document: Phase D — Studio Debugger Extensions (`STU-002`)

**Date:** 2026-11-02  
**Status:** Approved for Implementation Planning  
**Milestone:** Phase D — Studio and debugger (closes `STU-002` in `MISSING.md`)  
**Target:** `apps/web` (Angular 19, standalone components, signals)  

---

## 1. Intent and Why

### Context
HealthBridge OS is an open-source medical data transformation platform. Phase D shipped the Angular 19 Operator Console v1 (`apps/web`), the visual rule-table mapping editor, schema explorers, lineage graph view, and validation centre. However, the stored-trace debugger at `/studio/debugger/:runId` remains in an M1 state: it only provides simple sequential navigation ("Previous event" and "Next event") over stored traces.

### The Problem
Engineers and clinical data operators troubleshooting complex transformations (e.g. FHIR Patient/Observation conversions with tens of thousands of trace events) cannot efficiently find failures:
- There are no breakpoints to pause at critical points (by stage, rule ID, record index, error status, or custom payload conditions).
- There is no jump-to-error or record-level stepping.
- There is no evaluation of mapping rule conditions against stored record inputs, making it difficult to understand why a rule executed or was skipped.
- The two-column stacked UI requires excessive scrolling to correlate timeline position, raw payload diffs, and declared rule provenance.

### The Objective
Deliver **Debugger 2.0 (`STU-002`)**: a three-pane VS Code-style visual debugger over stored traces with breakpoint management, multi-mode stepping (Continue, Step Over, Step Back, Jump to Next/Prev Error, Jump to Next/Prev Record), interactive timeline gutter toggles, and per-rule condition evaluation with explicit `[observed]` vs `[inferred]` badges.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
1. **Three-Pane Workbench Layout**:
   - **Left Pane (Traps & Navigation)**: Timeline with virtual windowing, breakpoint gutter indicator (`●`), active Breakpoints List, and Stage Summary.
   - **Center Pane (Payload & Envelopes)**: Sticky Stepping Toolbar (Continue, Step Over, Step Back, Jump Error, Record Step), Input/Output JSON trees, and Snippet/Resource diff views.
   - **Right Pane (Rule Evaluation & Provenance)**: Declared rule details, rule condition evaluator against stored input, clear `[observed]` vs `[inferred]` badges, and event issues list.
2. **Comprehensive Breakpoints System**:
   - Gutter toggle: click sequence number in timeline to set/unset breakpoint on that event sequence.
   - Configurable breakpoints:
     - By `status` (e.g. `error`, `warning`).
     - By `stage` (e.g. `mapping`, `validate`, `build`).
     - By `recordIndex` (e.g. record `5`).
     - By `ruleId` (e.g. `rule-gender`).
     - By `condition` expression (e.g. path match or field check).
   - Breakpoint enable/disable and deletion controls.
3. **Advanced Stepping Controls**:
   - **Continue (F5)**: Advance to the next event matching an active breakpoint.
   - **Step Over (F10)**: Advance to next event in current filtered timeline.
   - **Step Back (Shift+F10)**: Return to previous event in filtered timeline.
   - **Jump to Error (Next / Prev)**: Jump to the next or previous event with status `error` or non-empty `issues`.
   - **Jump to Record (Next / Prev)**: Jump to the first event of the next or previous record index.
4. **Rule Condition Evaluation**:
   - Evaluate declared rule conditions (`when: [{ path, op, value }]`) against stored input snippets.
   - Display evaluation outcome: `Matched`, `Unmatched`, `Snippet Unavailable`, or `No Conditions`.
   - Distinctly label payload values: `[observed]` (present in raw trace payload) vs `[inferred]` (derived from mapping spec).
5. **Accessibility & Keyboard Navigation**:
   - Full keyboard shortcuts (`F5`, `F10`, `Shift+F10`, `F9` for toggle breakpoint).
   - High contrast status chips, ARIA `listbox` / `toolbar` attributes, screen-reader polite announcements.

### Non-Goals
1. **Live Stream / Live Attach**: The debugger strictly reads stored traces. It will NEVER claim live execution or live attachment until real engine streaming trace feeds exist.
2. **Server-side Breakpoint Execution**: Breakpoints are evaluated client-side over the fetched stored trace dataset (`GET /runs/:id/traces`). No backend execution engine changes are required.
3. **Arbitrary JS Script Evaluation**: Breakpoint conditions and rule conditions will not execute un-sandboxed `eval()`; condition evaluation strictly follows HealthBridge's declared condition schema (`path`, `op`, `value`).

### Anti-Goals
1. Never label static trace replay as "live execution" or "pausing server execution" (standing rule).
2. Never infer or guess values that were not recorded in the trace payload without explicitly marking them as `[inferred]`.
3. Never introduce heavy third-party dock/window managers that degrade bundle size and accessibility.

---

## 3. Constraints

1. **Angular 19 Architecture**: Standalone components, signals, `ChangeDetectionStrategy.OnPush`, zoneless change detection.
2. **Browser Safety**: Zero runtime imports from `node:` packages.
3. **WCAG 2.1 AA Compliance**: Keyboard focus traps avoided, semantic ARIA roles, legible contrast, reduced-motion support.
4. **Zero Backend API Changes**: Operates completely against existing stable API endpoints (`GET /runs/:id`, `GET /runs/:id/traces`, `GET /runs/:id/issues`, `GET /mappings/:id`).

---

## 4. Architectural Approaches

### Approaches Considered

#### Approach 1: Reactive Three-Pane Workbench via Extended Store (Selected)
- Pure logic module (`trace.logic.ts` & `breakpoints.logic.ts`) handling breakpoint matching, stepping calculations, and rule condition evaluation.
- `DebuggerStore` extended with `breakpoints` signal, active breakpoint state, and stepping actions (`continueToBreakpoint`, `jumpToError`, `stepRecord`).
- Responsive 3-pane CSS grid in `DebuggerPage`:
  - Left: Breakpoints & Timeline
  - Center: Payload & Diff Inspection
  - Right: Rule Evaluation & Provenance
- State synchronized with URL parameters (`event`, `stage`, `status`, `record`, etc.).
- **Decision:** Selected because it aligns with HealthBridge's clean Signals architecture, maintains fast rendering via virtual scrolling, requires no external dependencies, and is fully accessible.

#### Approach 2: Split Route Architecture
- Break debugger into `/studio/debugger/:runId/timeline`, `/studio/debugger/:runId/diff`, `/studio/debugger/:runId/provenance`.
- **Rejected:** Destroying the unified debugging context causes disorientation and breaks stepping workflows.

#### Approach 3: Third-Party Docking Framework
- Integrate floating window manager (e.g. golden-layout / dockview).
- **Rejected:** Adds bundle bloat, CSS conflicts, and severe accessibility issues.

---

## 5. Architectural & Implementation Decisions (Builder Review Resolutions)

### Decision 1: Semantics of `[observed]` vs. `[inferred]`
- **Resolution:** Strict replay semantics are preserved. The client does *not* re-run transform engines or execute arbitrary mapping scripts in the browser.
- **`[observed]`**: Represents data physically recorded in the trace payload (`event.inputSnippet`, `event.outputSnippet`, `event.issues`, `event.durationMs`, `event.ruleId`).
- **`[inferred]`**: Represents metadata derived by joining the trace event with the declared mapping spec (e.g., rule identity joined via fallback `targetPath` when `ruleId` was null, rule `defaultValue`, declared transform parameters, and condition criteria).

### Decision 2: Stepping Scope (Filtered vs. Unfiltered)
- **Resolution:**
  - `stepOver()` and `stepBack()` step through the active `store.filtered()` timeline.
  - `continueToBreakpoint()`, `jumpToNextError()`, and `jumpToNextRecord()` evaluate across the active `filtered()` list first.
  - If a matching breakpoint or error exists in the full trace (`store.events()`) but is hidden by active filters, the store emits an off-filter notice with a one-click affordance: `"Next error is at event #42 (hidden by current filters). Clear filters and jump"`.

### Decision 3: Breakpoint Condition Scope & Schema
- **Resolution:** Condition breakpoints leverage the existing canonical `MappingCondition` operator set (`equals`, `not_equals`, `exists`, `not_exists`, `contains`, `in`).
- Targets resolve against `inputSnippet` by default (with an optional target toggle for `outputSnippet` or `issues`). No unsandboxed code execution is used.

### Decision 4: Breakpoint Lifecycle & Persistence
- **Resolution:** Breakpoints are maintained in the reactive `DebuggerStore` and persisted to `sessionStorage` scoped by `runId` (`healthbridge:debugger:bp:${runId}`). This ensures user-configured breakpoints survive page refresh without durable cross-run contamination or sensitive data leakage.

---

## 6. Detailed Component & Logic Design

### 6.1 Pure Logic (`trace.logic.ts` & `breakpoints.logic.ts`)

#### Breakpoint Types:
```typescript
export type BreakpointKind = "seq" | "status" | "stage" | "record" | "rule" | "condition";

export interface Breakpoint {
  id: string;
  kind: BreakpointKind;
  enabled: boolean;
  value: string | number;
  conditionTarget?: "input" | "output";
  conditionPath?: string;
  conditionOp?: string;
  conditionValue?: unknown;
}
```

#### Breakpoint Evaluation:
```typescript
export function matchesBreakpoint(event: DebuggerEvent, bp: Breakpoint): boolean;
export function findNextBreakpoint(
  events: DebuggerEvent[],
  startIndex: number,
  breakpoints: Breakpoint[],
  direction: "forward" | "backward"
): number;
```

#### Stepping Helpers:
```typescript
export function findNextErrorIndex(events: DebuggerEvent[], startIndex: number, direction: "forward" | "backward"): number;
export function findNextRecordIndex(events: DebuggerEvent[], startIndex: number, direction: "forward" | "backward"): number;
```

#### Rule Condition Evaluator:
```typescript
export interface ConditionEvaluationResult {
  condition: MappingCondition;
  evaluated: boolean;
  matched: boolean;
  observedValue: unknown;
  hasObservedValue: boolean;
  reason: string;
}

export function evaluateRuleConditions(
  rule: MappingRule,
  inputSnippet: unknown,
  hasInputSnippet: boolean
): ConditionEvaluationResult[];
```

### 6.2 Store Extensions (`DebuggerStore`)
- Signals:
  - `breakpoints: Signal<Breakpoint[]>`
  - `activeBreakpointSeq: Signal<number | null>`
  - `offFilterNotice: Signal<{ seq: number; label: string } | null>`
- Actions:
  - `toggleSeqBreakpoint(seq: number): void`
  - `addBreakpoint(bp: Omit<Breakpoint, "id">): void`
  - `removeBreakpoint(id: string): void`
  - `toggleBreakpoint(id: string): void`
  - `continueToBreakpoint(): void`
  - `stepOver(): void`
  - `stepBack(): void`
  - `jumpToNextError(): void`
  - `jumpToPrevError(): void`
  - `jumpToNextRecord(): void`
  - `jumpToPrevRecord(): void`
  - `clearOffFilterNotice(): void`

### 6.3 UI Components in `apps/web/src/app/features/studio/debugger`
1. **`DebuggerPage` (`debugger.page.ts`)**:
   - Reorganized into CSS Grid: `.debugger-three-pane { display: grid; grid-template-columns: 320px minmax(0, 1fr) 360px; gap: var(--space-3); }`.
   - Responsive adjustments for medium (<1200px) and small (<900px) screens.
   - Global keyboard shortcuts: `F5` (continue), `F9` (toggle breakpoint), `F10` (step over), `Shift+F10` (step back), `Alt+E` (jump error).
2. **`BreakpointsPanel` (`breakpoints-panel.ts`)**:
   - List of breakpoints with enable/disable checkbox, delete button, and a compact "Add Breakpoint" form.
3. **`TraceTimeline` (`trace-timeline.ts`)**:
   - Clickable gutter column displaying red dot (`●`) when a breakpoint is active on that event sequence number.
4. **`DebuggerToolbar` (`debugger-toolbar.ts`)**:
   - Controls: Continue, Step Back, Step Over, Jump to Prev/Next Error, Jump to Prev/Next Record.
5. **`RuleEvaluator` (`rule-evaluator.ts`) / `Provenance` (`provenance.ts`)**:
   - Displays declared rules, evaluated `when` conditions against the stored `inputSnippet`, and explicit `[observed]` vs `[inferred]` badges.

---

## 7. What's Left to the Builder

1. Precise CSS styling and responsive layout rules adhering to HealthBridge's design tokens.
2. Accessibility strings and ARIA announcements (`aria-live="polite"`, `role="toolbar"`, `role="listbox"`).
3. Pure unit tests in `trace-debugger.test.ts` for breakpoint matching, stepping, and condition evaluation.
4. Component tests with Vitest in `apps/web/src/**/*.spec.ts`.
5. Playwright E2E tests in `apps/web/e2e/studio-debugger.spec.ts` covering breakpoint setting, gutter clicks, and stepping controls.
