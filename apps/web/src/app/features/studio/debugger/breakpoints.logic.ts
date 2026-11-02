import type { MappingRule } from "@healthbridge/shared-types";
import type { DebuggerEvent } from "./trace.logic";

export type BreakpointKind = "seq" | "status" | "stage" | "record" | "rule" | "condition";

export type ConditionOp = "equals" | "not_equals" | "exists" | "not_exists" | "contains" | "in";

export interface Breakpoint {
  id: string;
  kind: BreakpointKind;
  enabled: boolean;
  value: string | number;
  conditionTarget?: "input" | "output";
  conditionPath?: string;
  conditionOp?: ConditionOp;
  conditionValue?: unknown;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getByPath(target: unknown, path: string): { found: boolean; value: unknown } {
  if (!path || path.trim().length === 0) {
    return { found: true, value: target };
  }
  const parts = path.split(".").filter((p) => p.length > 0);
  let current: unknown = target;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return { found: false, value: undefined };
    }
    if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        return { found: false, value: undefined };
      }
      current = current[part];
    } else if (Array.isArray(current)) {
      const idx = Number(part);
      if (Number.isInteger(idx) && idx >= 0 && idx < current.length) {
        current = current[idx];
      } else {
        return { found: false, value: undefined };
      }
    } else {
      return { found: false, value: undefined };
    }
  }

  return { found: true, value: current };
}

function evaluateOp(op: string, observed: unknown, hasObserved: boolean, expected?: unknown): boolean {
  switch (op) {
    case "exists":
      return hasObserved && observed !== null && observed !== undefined;
    case "not_exists":
      return !hasObserved || observed === null || observed === undefined;
    case "equals":
      if (!hasObserved) return false;
      return JSON.stringify(observed) === JSON.stringify(expected);
    case "not_equals":
      if (!hasObserved) return true;
      return JSON.stringify(observed) !== JSON.stringify(expected);
    case "contains":
      if (!hasObserved || observed === null || observed === undefined) return false;
      if (typeof observed === "string") {
        return observed.includes(String(expected));
      }
      if (Array.isArray(observed)) {
        return observed.some((item) => JSON.stringify(item) === JSON.stringify(expected));
      }
      return false;
    case "in":
      if (!hasObserved || !Array.isArray(expected)) return false;
      return expected.some((item) => JSON.stringify(item) === JSON.stringify(observed));
    default:
      return false;
  }
}

export function matchesBreakpoint(event: DebuggerEvent, bp: Breakpoint): boolean {
  if (!bp.enabled) return false;

  switch (bp.kind) {
    case "seq":
      return event.seq === Number(bp.value);
    case "status":
      return event.status.toLowerCase() === String(bp.value).toLowerCase();
    case "stage":
      return event.stage.toLowerCase() === String(bp.value).toLowerCase();
    case "record":
      return event.recordIndex !== null && event.recordIndex === Number(bp.value);
    case "rule":
      return event.ruleId !== null && event.ruleId.toLowerCase() === String(bp.value).toLowerCase();
    case "condition": {
      const target = bp.conditionTarget === "output" ? event.outputSnippet : event.inputSnippet;
      const hasTarget = bp.conditionTarget === "output" ? event.hasOutputSnippet : event.hasInputSnippet;
      if (!hasTarget || target === null || target === undefined) return false;

      const path = bp.conditionPath ?? "";
      const { found, value } = getByPath(target, path);
      return evaluateOp(bp.conditionOp ?? "exists", value, found, bp.conditionValue);
    }
    default:
      return false;
  }
}

export function findNextBreakpoint(
  events: DebuggerEvent[],
  currentIndex: number,
  breakpoints: Breakpoint[],
  direction: "forward" | "backward",
): number {
  const activeBps = breakpoints.filter((bp) => bp.enabled);
  if (activeBps.length === 0 || events.length === 0) return -1;

  const step = direction === "forward" ? 1 : -1;
  let idx = currentIndex + step;

  while (idx >= 0 && idx < events.length) {
    const event = events[idx];
    if (activeBps.some((bp) => matchesBreakpoint(event, bp))) {
      return idx;
    }
    idx += step;
  }

  return -1;
}

export function findNextErrorIndex(
  events: DebuggerEvent[],
  currentIndex: number,
  direction: "forward" | "backward",
): number {
  if (events.length === 0) return -1;

  const step = direction === "forward" ? 1 : -1;
  let idx = currentIndex + step;

  while (idx >= 0 && idx < events.length) {
    const event = events[idx];
    if (event.status === "error" || event.issues.length > 0) {
      return idx;
    }
    idx += step;
  }

  return -1;
}

export function findNextRecordIndex(
  events: DebuggerEvent[],
  currentIndex: number,
  direction: "forward" | "backward",
): number {
  if (events.length === 0 || currentIndex < 0 || currentIndex >= events.length) return -1;

  const currentRecord = events[currentIndex].recordIndex;
  if (direction === "forward") {
    let idx = currentIndex + 1;
    while (idx < events.length) {
      const event = events[idx];
      if (event.recordIndex !== null && event.recordIndex !== currentRecord) {
        return idx;
      }
      idx += 1;
    }
    return -1;
  } else {
    // Backward: find the distinct previous record, then find the first event of that record
    let idx = currentIndex - 1;
    let targetRecord: number | null = null;
    while (idx >= 0) {
      const event = events[idx];
      if (event.recordIndex !== null && event.recordIndex !== currentRecord) {
        targetRecord = event.recordIndex;
        break;
      }
      idx -= 1;
    }
    if (targetRecord === null) return -1;

    while (idx > 0 && events[idx - 1].recordIndex === targetRecord) {
      idx -= 1;
    }
    return idx;
  }
}

export function evaluateRuleConditions(
  rule: MappingRule | { when?: Array<{ path: string; op: string; value?: unknown }> },
  inputSnippet: unknown,
  hasInputSnippet: boolean,
): ConditionEvaluationResult[] {
  const conditions = rule.when;
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    return [];
  }

  return conditions.map((cond) => {
    if (!hasInputSnippet || inputSnippet === null || inputSnippet === undefined) {
      return {
        path: cond.path,
        op: cond.op,
        expectedValue: cond.value,
        evaluated: false,
        matched: false,
        observedValue: null,
        hasObservedValue: false,
        reason: "Snippet not recorded in trace event",
      };
    }

    const { found, value } = getByPath(inputSnippet, cond.path);
    const matched = evaluateOp(cond.op, value, found, cond.value);

    return {
      path: cond.path,
      op: cond.op,
      expectedValue: cond.value,
      evaluated: true,
      matched,
      observedValue: found ? value : null,
      hasObservedValue: found,
      reason: matched ? "Condition matched" : "Condition not matched",
    };
  });
}
