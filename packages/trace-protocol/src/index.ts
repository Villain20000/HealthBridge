import { TraceEvent, ValidationIssue } from "@healthbridge/shared-types";

export interface TracerOptions {
  runId: string;
  correlationId?: string;
  redactSensitiveData?: boolean;
}

export class TraceCollector {
  private events: TraceEvent[] = [];
  private runId: string;
  private correlationId?: string;
  private redactSensitiveData: boolean;

  constructor(options: TracerOptions) {
    this.runId = options.runId;
    this.correlationId = options.correlationId;
    this.redactSensitiveData = options.redactSensitiveData ?? true;
  }

  public emit(event: Omit<TraceEvent, "protocolVersion" | "runId" | "timestamp" | "redacted">): TraceEvent {
    const fullEvent: TraceEvent = {
      protocolVersion: "1.0",
      runId: this.runId,
      correlationId: this.correlationId,
      timestamp: new Date().toISOString(),
      redacted: this.redactSensitiveData,
      inputSnippet: this.redactSensitiveData ? this.redact(event.inputSnippet) : event.inputSnippet,
      outputSnippet: this.redactSensitiveData ? this.redact(event.outputSnippet) : event.outputSnippet,
      ...event,
    };
    this.events.push(fullEvent);
    return fullEvent;
  }

  public getEvents(): TraceEvent[] {
    return [...this.events];
  }

  public clear(): void {
    this.events = [];
  }

  private redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      if (/^\d{3}-\d{2}-\d{4}$/.test(value)) return "***-**-****";
      if (/^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(value)) return "redacted@email.com";
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const redactedObj: Record<string, unknown> = {};
      const sensitiveKeys = ["ssn", "password", "secret", "nationalid", "phone", "email"];
      for (const [k, v] of Object.entries(obj)) {
        if (sensitiveKeys.some((sk) => k.toLowerCase().includes(sk))) {
          redactedObj[k] = "[REDACTED]";
        } else {
          redactedObj[k] = this.redact(v);
        }
      }
      return redactedObj;
    }
    return value;
  }
}

export function exportTraceReport(traces: TraceEvent[]): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    protocolVersion: "1.0",
    totalEvents: traces.length,
    events: traces,
  }, null, 2);
}
