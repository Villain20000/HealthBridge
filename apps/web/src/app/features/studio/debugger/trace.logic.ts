import type { MappingRule, ValidationIssue } from "@healthbridge/shared-types";
import type { StoredTrace } from "../../../core/api-types";
import { isTerminalStatus } from "../../../core/format";

/**
 * Pure logic for the stored-trace debugger.
 *
 * The debugger reads stored rows; it never watches a live run. The source of truth per event is
 * the redacted `TraceEvent` in `StoredTrace.payload`; stored columns are only a fallback for the
 * handful of fields they actually carry. Anything the payload did not record stays `null` —
 * observed values, adapter ids, record indexes and rule ids are never inferred.
 */

export const STORED_REPLAY = { source: "stored-trace", live: false } as const;

export const TRACE_STAGES = [
  "detect",
  "adapter-selection",
  "parse",
  "envelope",
  "mapping",
  "build",
  "validate",
  "export",
] as const;

export interface DebuggerEvent {
  /** The stored row exactly as returned, including its redacted payload. */
  raw: StoredTrace;
  seq: number;
  stage: string; // payload.stage ?? row.stage ?? "unknown"
  stepName: string; // payload.stepName ?? row.stepName ?? ""
  status: string; // payload.status ?? row.status ?? "unknown"
  timestamp: string | null; // payload.timestamp ?? row.createdAt ?? null
  recordIndex: number | null; // payload.recordIndex when a non-negative integer, else null
  ruleId: string | null;
  sourcePath: string | null;
  targetPath: string | null;
  inputSnippet: unknown; // the recorded value, even when it is null
  hasInputSnippet: boolean; // true when the payload recorded the key at all
  outputSnippet: unknown;
  hasOutputSnippet: boolean;
  durationMs: number | null; // finite non-negative number, else null
  issues: ValidationIssue[]; // payload.issues when an array, else []
  redacted: boolean | null; // payload.redacted when boolean, else null ("not recorded")
  redactionState: string | null;
  validationState: string | null;
  hasPayload: boolean;
}

export interface DebuggerFilter {
  stage: string | null;
  status: string | null;
  record: number | null;
  rule: string | null;
  q: string;
  onlyIssues: boolean;
}

export const NO_FILTER: DebuggerFilter = {
  stage: null,
  status: null,
  record: null,
  rule: null,
  q: "",
  onlyIssues: false,
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Payload strings must carry information; an empty string is "not recorded". */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasOwn(payload: JsonObject | undefined, key: string): boolean {
  return payload !== undefined && Object.prototype.hasOwnProperty.call(payload, key);
}

function toRecordIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function toDurationMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toIssues(value: unknown): ValidationIssue[] {
  // Object-ness is the only shape check: a stored issue is displayed as recorded, never
  // "repaired". Elements that are not objects cannot be rendered as issues at all.
  return Array.isArray(value) ? (value.filter(isRecord) as unknown as ValidationIssue[]) : [];
}

function toDebuggerEvent(row: StoredTrace): DebuggerEvent {
  const payload = isRecord(row.payload) ? row.payload : undefined;
  const hasInputSnippet = hasOwn(payload, "inputSnippet");
  const hasOutputSnippet = hasOwn(payload, "outputSnippet");
  const redacted = payload?.["redacted"];

  return {
    raw: row,
    seq: row.seq,
    stage: nonEmptyString(payload?.["stage"]) ?? nonEmptyString(row.stage) ?? "unknown",
    stepName: nonEmptyString(payload?.["stepName"]) ?? (typeof row.stepName === "string" ? row.stepName : ""),
    status: nonEmptyString(payload?.["status"]) ?? nonEmptyString(row.status) ?? "unknown",
    timestamp: nonEmptyString(payload?.["timestamp"]) ?? nonEmptyString(row.createdAt) ?? null,
    recordIndex: toRecordIndex(payload?.["recordIndex"]),
    ruleId: nonEmptyString(payload?.["ruleId"]),
    sourcePath: nonEmptyString(payload?.["sourcePath"]),
    targetPath: nonEmptyString(payload?.["targetPath"]),
    inputSnippet: hasInputSnippet ? payload?.["inputSnippet"] : null,
    hasInputSnippet,
    outputSnippet: hasOutputSnippet ? payload?.["outputSnippet"] : null,
    hasOutputSnippet,
    durationMs: toDurationMs(payload?.["durationMs"]),
    issues: toIssues(payload?.["issues"]),
    redacted: typeof redacted === "boolean" ? redacted : null,
    redactionState: nonEmptyString(payload?.["redactionState"]),
    validationState: nonEmptyString(payload?.["validationState"]),
    hasPayload: payload !== undefined,
  };
}

/** Every stored row becomes one event; timeline order is `seq` ascending, not arrival order. */
export function buildTimeline(traces: StoredTrace[]): DebuggerEvent[] {
  return traces.map(toDebuggerEvent).sort((left, right) => left.seq - right.seq);
}

export interface StageSummary {
  total: number;
  stages: Array<{ stage: string; count: number }>;
  withIssues: number; // events with at least one issue
  warnings: number; // events whose status is "warning"
  errors: number; // events whose status is "error"
}

/**
 * Counts **all** stored events. The debugger calls this with the unfiltered timeline; feeding
 * it filtered events would make the summary lie about what the run stored.
 */
export function stageSummary(events: DebuggerEvent[]): StageSummary {
  const counts = new Map<string, number>();
  let withIssues = 0;
  let warnings = 0;
  let errors = 0;

  for (const event of events) {
    counts.set(event.stage, (counts.get(event.stage) ?? 0) + 1);
    if (event.issues.length > 0) withIssues += 1;
    if (event.status === "warning") warnings += 1;
    if (event.status === "error") errors += 1;
  }

  const stages: Array<{ stage: string; count: number }> = [];
  for (const stage of TRACE_STAGES) {
    const count = counts.get(stage);
    if (count !== undefined) {
      stages.push({ stage, count });
      counts.delete(stage);
    }
  }
  const extraStages = [...counts.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const stage of extraStages) {
    stages.push({ stage, count: counts.get(stage) ?? 0 });
  }

  return { total: events.length, stages, withIssues, warnings, errors };
}

/**
 * Lowercased search haystack per event. The store re-runs its computed filter on every
 * keystroke and filter change, so the text is built once per event identity.
 */
const haystacks = new WeakMap<DebuggerEvent, string>();

function haystack(event: DebuggerEvent): string {
  const cached = haystacks.get(event);
  if (cached !== undefined) return cached;

  const parts: string[] = [event.stepName, event.sourcePath ?? "", event.targetPath ?? ""];
  for (const issue of event.issues) {
    if (typeof issue.code === "string") parts.push(issue.code);
    if (typeof issue.message === "string") parts.push(issue.message);
  }

  const value = parts.join("\n").toLowerCase();
  haystacks.set(event, value);
  return value;
}

function matches(event: DebuggerEvent, filter: DebuggerFilter, query: string): boolean {
  if (filter.stage !== null && event.stage !== filter.stage) return false;
  if (filter.status !== null && event.status !== filter.status) return false;
  if (filter.record !== null && event.recordIndex !== filter.record) return false;
  if (filter.rule !== null && event.ruleId !== filter.rule) return false;
  if (filter.onlyIssues && event.issues.length === 0) return false;
  if (query.length > 0 && !haystack(event).includes(query)) return false;
  return true;
}

export function filterEvents(events: DebuggerEvent[], filter: DebuggerFilter): DebuggerEvent[] {
  const query = filter.q.trim().toLowerCase();
  return events.filter((event) => matches(event, filter, query));
}

/** Index into the original array of the first match, or `-1`; uses the same predicate. */
export function firstMatchingIndex(events: DebuggerEvent[], filter: DebuggerFilter): number {
  const query = filter.q.trim().toLowerCase();
  return events.findIndex((event) => matches(event, filter, query));
}

export type RuleJoinStatus = "exact" | "by-target" | "unrecorded" | "ambiguous" | "missing" | "no-mapping";

export interface RuleJoin {
  status: RuleJoinStatus;
  rule: MappingRule | null;
  note: string;
}

function isMappingRuleLike(value: unknown): value is MappingRule {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["targetPath"] === "string";
}

/**
 * `Mapping.spec` is `unknown`; a spec that is not `{ rules: MappingRule[] }` declares no rules.
 * Junk entries inside `rules` are ignored rather than trusted.
 */
function declaredRules(mappingSpec: unknown): MappingRule[] {
  if (!isRecord(mappingSpec)) return [];
  const rules = mappingSpec["rules"];
  return Array.isArray(rules) ? (rules.filter(isMappingRuleLike) as MappingRule[]) : [];
}

/**
 * Joins an event to a rule *declared by the run's mapping version*. A join never claims that
 * the event's input/output is that rule's observed value — the trace does not record that.
 */
export function joinRule(event: DebuggerEvent, mappingSpec: unknown): RuleJoin {
  const rules = declaredRules(mappingSpec);
  if (rules.length === 0) {
    return { status: "no-mapping", rule: null, note: "The run's mapping version has no declared rules." };
  }

  if (event.ruleId !== null) {
    const exact = rules.find((candidate) => candidate.id === event.ruleId);
    if (exact) return { status: "exact", rule: exact, note: "" };
    return {
      status: "missing",
      rule: null,
      note: `Rule ${event.ruleId} is not in the run's mapping version.`,
    };
  }

  if (event.targetPath !== null) {
    const candidates = rules.filter((candidate) => candidate.targetPath === event.targetPath);
    if (candidates.length === 1) {
      return {
        status: "by-target",
        rule: candidates[0],
        note: "Joined by declared target path; this trace event does not record a rule id.",
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        rule: null,
        note: `${candidates.length} declared rules target this path; not guessing.`,
      };
    }
  }

  return { status: "unrecorded", rule: null, note: "Rule not recorded in this trace event." };
}

export interface MergedIssue {
  issue: ValidationIssue;
  inRun: boolean;
  seqs: number[]; // trace events carrying the same issue, ascending, unique
}

function keyPart(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `${typeof value}:${String(value)}`;
}

/** The dedupe tuple is exact: differing in any field keeps two separate issues. */
function issueKey(issue: ValidationIssue): string {
  return [issue.code, issue.severity, issue.path, issue.recordIndex, issue.ruleId, issue.message]
    .map(keyPart)
    .join("\u0000");
}

export function mergeIssues(runIssues: ValidationIssue[], events: DebuggerEvent[]): MergedIssue[] {
  const merged: MergedIssue[] = [];
  const byKey = new Map<string, MergedIssue>();

  const record = (issue: ValidationIssue, inRun: boolean, seq: number | null): void => {
    const key = issueKey(issue);
    const existing = byKey.get(key);
    if (!existing) {
      const entry: MergedIssue = { issue, inRun, seqs: seq === null ? [] : [seq] };
      byKey.set(key, entry);
      merged.push(entry);
      return;
    }
    if (inRun) existing.inRun = true;
    if (seq !== null) existing.seqs.push(seq);
  };

  for (const issue of runIssues) record(issue, true, null);
  for (const event of events) {
    for (const issue of event.issues) record(issue, false, event.seq);
  }

  for (const entry of merged) {
    entry.seqs = [...new Set(entry.seqs)].sort((left, right) => left - right);
  }
  return merged;
}

export type TraceAvailabilityKind = "settled" | "pending" | "partial" | "empty";

export interface TraceAvailability {
  kind: TraceAvailabilityKind;
  message: string;
  /** True exactly when the UI must offer a manual refresh. */
  canRefresh: boolean;
}

/**
 * Says what a reader may expect from the stored trace. Stored rows appear when the run settles;
 * a non-terminal run is never presented as if its trace were complete.
 */
export function describeTraceAvailability(runStatus: string, eventCount: number): TraceAvailability {
  if (!isTerminalStatus(runStatus)) {
    if (eventCount === 0) {
      return {
        kind: "pending",
        message: `Trace rows are written when the run settles; this run is ${runStatus}. Open run detail for live progress.`,
        canRefresh: false,
      };
    }
    return {
      kind: "partial",
      message: `This run is still ${runStatus}; the stored trace is partial. Refresh to load rows written since this page opened.`,
      canRefresh: true,
    };
  }

  if (eventCount > 0) return { kind: "settled", message: "", canRefresh: false };
  return { kind: "empty", message: "This run settled without storing any trace rows.", canRefresh: false };
}

export interface TraceExport {
  source: "stored-trace";
  live: false;
  runId: string;
  generatedAt: string;
  filter: DebuggerFilter;
  count: number;
  redaction: "server-redacted";
  traces: StoredTrace[];
}

/**
 * The export is a filtered view of stored rows. It carries no observed/expected payloads and
 * no live marker beyond the constant `live: false`.
 */
export function buildExport(
  runId: string,
  filteredEvents: DebuggerEvent[],
  filter: DebuggerFilter,
  generatedAt: string,
): TraceExport {
  return {
    source: "stored-trace",
    live: false,
    runId,
    generatedAt,
    filter: { ...filter },
    count: filteredEvents.length,
    redaction: "server-redacted",
    traces: filteredEvents.map((event) => event.raw),
  };
}
