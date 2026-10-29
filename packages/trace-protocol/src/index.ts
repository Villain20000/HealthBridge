import {
  TraceEvent,
  TRACE_PROTOCOL_VERSION,
  RedactionState,
  TraceStage,
  ValidationIssue,
} from "@healthbridge/shared-types";

/**
 * Trace snippets are the most likely place for PHI to leak: they are written to
 * disk, exported and attached to bug reports. Redaction is therefore on by
 * default and must never be bypassed implicitly.
 *
 * Policy (v1.2, see docs/adr/ADR-0003-trace-redaction-policy.md):
 *  - structure (keys, array shapes, nesting) is always preserved, because that is
 *    what transformation debugging needs;
 *  - scalar values are masked unless the key is a structural/terminology field
 *    (`resourceType`, `code`, `system`, `unit`, `status`, `url`, ...);
 *  - issue messages have quoted values masked, since engines embed the offending
 *    value in messages.
 *
 * `payloadMode: "full"` (CLI/SDK) keeps raw values and is documented as
 * local-only: those traces must never be persisted or shared.
 */
export interface RedactionPolicy {
  /** Mask scalar values that are not structural/terminology fields. */
  maskScalarValues: boolean;
  /** Truncate long strings to this many characters (full mode). */
  maxStringLength: number;
  /** Keep at most this many array items in a snippet. */
  maxArrayItems: number;
  /** Maximum object nesting depth captured in a snippet. */
  maxDepth: number;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  maskScalarValues: true,
  maxStringLength: 120,
  maxArrayItems: 25,
  maxDepth: 8,
};

/** Keys whose values are structural or terminology identifiers, not PHI. */
const SAFE_VALUE_KEYS = new Set([
  "resourcetype",
  "system",
  "code",
  "unit",
  "url",
  "status",
  "gender",
  "use",
  "profile",
  "contenttype",
  "language",
  "method",
  "severity",
  "stage",
  "stepid",
  "stepname",
]);

const QUOTED_VALUE = /'[^']{1,200}'|"[^"]{1,200}"/g;

export interface TracerOptions {
  runId: string;
  correlationId?: string;
  /** `false` keeps raw values. Only allowed for local, non-persisted debugging. */
  redactSensitiveData?: boolean;
  policy?: Partial<RedactionPolicy>;
  /** Optional hard cap on retained events to bound memory on large runs. */
  maxEvents?: number;
}

export interface TraceSummary {
  runId: string;
  protocolVersion: string;
  totalEvents: number;
  byStatus: Record<string, number>;
  byStage: Record<string, number>;
  totalIssues: number;
  totalDurationMs: number;
  redactionStates: Record<RedactionState, number>;
}

interface RedactionCounter {
  applied: number;
}

export class TraceRedactor {
  private readonly policy: RedactionPolicy;

  constructor(policy: Partial<RedactionPolicy> = {}) {
    this.policy = { ...DEFAULT_REDACTION_POLICY, ...policy };
  }

  public redact(value: unknown): { value: unknown; applied: number } {
    const counter: RedactionCounter = { applied: 0 };
    const result = this.walk(value, 0, counter, undefined);
    return { value: result, applied: counter.applied };
  }

  /** Mask values embedded in human-readable issue messages. */
  public redactMessage(message: string): string {
    return message.replace(QUOTED_VALUE, "'[REDACTED]'");
  }

  private walk(value: unknown, depth: number, counter: RedactionCounter, key: string | undefined): unknown {
    if (value === null || value === undefined) return value;

    if (depth > this.policy.maxDepth) {
      counter.applied++;
      return "[TRUNCATED]";
    }

    const safeKey = key !== undefined && SAFE_VALUE_KEYS.has(key.toLowerCase());

    if (typeof value === "string") {
      if (!this.policy.maskScalarValues || safeKey) {
        if (value.length > this.policy.maxStringLength) {
          return `${value.slice(0, this.policy.maxStringLength)}\u2026[truncated ${value.length} chars]`;
        }
        return value;
      }
      counter.applied++;
      return "[REDACTED]";
    }

    if (typeof value === "number") {
      if (!this.policy.maskScalarValues) return value;
      counter.applied++;
      return "[REDACTED]";
    }

    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return "[REDACTED]";

    if (Array.isArray(value)) {
      const items = value.slice(0, this.policy.maxArrayItems).map((item) => this.walk(item, depth + 1, counter, key));
      if (value.length > this.policy.maxArrayItems) {
        items.push(`\u2026[${value.length - this.policy.maxArrayItems} more items]`);
      }
      return items;
    }

    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.walk(v, depth + 1, counter, k);
      }
      return out;
    }

    counter.applied++;
    return "[UNSUPPORTED]";
  }
}

export type TraceEventInput = Omit<
  TraceEvent,
  "protocolVersion" | "runId" | "timestamp" | "redacted" | "redactionState"
> & {
  stage?: TraceStage;
};

export class TraceCollector {
  private events: TraceEvent[] = [];
  private readonly runId: string;
  private readonly correlationId?: string;
  private readonly redactSensitiveData: boolean;
  private readonly redactor: TraceRedactor;
  private readonly maxEvents: number;
  private sequence = 0;
  private droppedEvents = 0;

  constructor(options: TracerOptions) {
    this.runId = options.runId;
    this.correlationId = options.correlationId;
    this.redactSensitiveData = options.redactSensitiveData ?? true;
    this.redactor = new TraceRedactor(options.policy);
    this.maxEvents = options.maxEvents ?? 50_000;
  }

  /**
   * Emit a normalised trace event.
   *
   * Order matters: the caller-supplied fields are spread **first** so that the
   * redacted snippets computed below always win. Reversing this order silently
   * disables redaction (regression fixed in v3.1.0).
   */
  public emit(event: TraceEventInput): TraceEvent {
    let applied = 0;
    let inputSnippet: unknown = event.inputSnippet;
    let outputSnippet: unknown = event.outputSnippet;
    let issues = event.issues;

    if (this.redactSensitiveData) {
      if (issues) {
        issues = issues.map((issue) => ({
          ...issue,
          message: this.redactor.redactMessage(issue.message),
          advice: issue.advice ? this.redactor.redactMessage(issue.advice) : undefined,
        }));
      }
      const redactedInput = this.redactor.redact(event.inputSnippet);
      const redactedOutput = this.redactor.redact(event.outputSnippet);
      inputSnippet = redactedInput.value;
      outputSnippet = redactedOutput.value;
      applied = redactedInput.applied + redactedOutput.applied;
    }

    const redactionState: RedactionState = !this.redactSensitiveData ? "none" : applied > 0 ? "partial" : "none";

    const fullEvent: TraceEvent = {
      ...event,
      protocolVersion: TRACE_PROTOCOL_VERSION,
      runId: this.runId,
      correlationId: event.correlationId ?? this.correlationId,
      timestamp: new Date().toISOString(),
      redacted: this.redactSensitiveData,
      redactionState,
      inputSnippet,
      outputSnippet,
      issues,
      spanId: event.spanId ?? `span-${++this.sequence}`,
    };

    if (this.events.length >= this.maxEvents) {
      this.droppedEvents++;
      return fullEvent;
    }

    this.events.push(fullEvent);
    return fullEvent;
  }

  public getEvents(): TraceEvent[] {
    return [...this.events];
  }

  public getDroppedEventCount(): number {
    return this.droppedEvents;
  }

  public clear(): void {
    this.events = [];
    this.droppedEvents = 0;
  }

  public summarize(): TraceSummary {
    const byStatus: Record<string, number> = {};
    const byStage: Record<string, number> = {};
    const redactionStates: Record<RedactionState, number> = { none: 0, partial: 0, full: 0 };
    let totalIssues = 0;
    let totalDurationMs = 0;

    for (const event of this.events) {
      byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
      const stage = event.stage ?? "parse";
      byStage[stage] = (byStage[stage] ?? 0) + 1;
      redactionStates[event.redactionState ?? "none"]++;
      totalIssues += event.issues?.length ?? 0;
      totalDurationMs += event.durationMs ?? 0;
    }

    return {
      runId: this.runId,
      protocolVersion: TRACE_PROTOCOL_VERSION,
      totalEvents: this.events.length,
      byStatus,
      byStage,
      totalIssues,
      totalDurationMs,
      redactionStates,
    };
  }
}

export interface ExportedTraceReport {
  exportedAt: string;
  protocolVersion: string;
  runId: string;
  summary: TraceSummary;
  events: TraceEvent[];
}

export function exportTraceReport(traces: TraceEvent[], summary?: TraceSummary): string {
  const report: ExportedTraceReport = {
    exportedAt: new Date().toISOString(),
    protocolVersion: TRACE_PROTOCOL_VERSION,
    runId: traces[0]?.runId ?? "unknown",
    summary: summary ?? {
      runId: traces[0]?.runId ?? "unknown",
      protocolVersion: TRACE_PROTOCOL_VERSION,
      totalEvents: traces.length,
      byStatus: countBy(traces, (t) => t.status),
      byStage: countBy(traces, (t) => t.stage ?? "parse"),
      totalIssues: traces.reduce((acc, t) => acc + (t.issues?.length ?? 0), 0),
      totalDurationMs: traces.reduce((acc, t) => acc + (t.durationMs ?? 0), 0),
      redactionStates: { none: 0, partial: 0, full: 0 },
    },
    events: traces,
  };
  return JSON.stringify(report, null, 2);
}

function countBy(events: TraceEvent[], key: (event: TraceEvent) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    const k = key(event);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function issue(
  code: string,
  severity: ValidationIssue["severity"],
  message: string,
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, severity, message, ...extra };
}
