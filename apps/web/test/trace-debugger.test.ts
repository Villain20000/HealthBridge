import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NO_FILTER,
  STORED_REPLAY,
  TRACE_STAGES,
  buildExport,
  buildTimeline,
  describeTraceAvailability,
  filterEvents,
  firstMatchingIndex,
  joinRule,
  mergeIssues,
  stageSummary,
} from "../src/app/features/studio/debugger/trace.logic";

/**
 * Stored-trace replay is a reading tool, not an observer. Every row below is synthetic, and
 * the assertions pin the rule that matters most: the payload is the only source of recorded
 * values, and anything the payload did not record stays unrecorded.
 */

type StoredRow = Parameters<typeof buildTimeline>[0][number];
type LogicEvent = ReturnType<typeof buildTimeline>[number];
type LogicFilter = typeof NO_FILTER;
type LogicIssue = Parameters<typeof mergeIssues>[0][number];
type DeclaredRule = NonNullable<ReturnType<typeof joinRule>["rule"]>;

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const PAYLOAD_TIME = "2026-01-01T00:00:05.000Z";

function traceRow(seq: number, overrides: Partial<StoredRow> = {}): StoredRow {
  return { seq, stage: "parse", ...overrides };
}

function payloadRow(seq: number, payload: Record<string, unknown>, overrides: Partial<StoredRow> = {}): StoredRow {
  return traceRow(seq, { payload, ...overrides });
}

function issue(overrides: Partial<LogicIssue> = {}): LogicIssue {
  return { code: "SYNTHETIC_ISSUE", severity: "error", message: "Synthetic issue", ...overrides };
}

function eventFrom(payload: Record<string, unknown>): LogicEvent {
  return buildTimeline([payloadRow(1, payload)])[0];
}

function filter(patch: Partial<LogicFilter>): LogicFilter {
  return { ...NO_FILTER, ...patch };
}

function rule(id: string, targetPath: string, sourcePath = `${id}.source`): DeclaredRule {
  return { id, sourcePath, targetPath, transform: "identity" };
}

describe("buildTimeline", () => {
  it("reads recorded payload fields first, keeps the raw row and reports recorded null snippets", () => {
    const recordedIssue = issue({ code: "PAYLOAD_ISSUE", path: "Patient.name" });
    const row = payloadRow(
      7,
      {
        stage: "mapping",
        stepName: "payload step",
        status: "warning",
        timestamp: PAYLOAD_TIME,
        recordIndex: 0,
        ruleId: "rule-a",
        sourcePath: "Patient.name",
        targetPath: "Patient.name.family",
        inputSnippet: { family: "Doe" },
        outputSnippet: null,
        durationMs: 12.5,
        issues: [recordedIssue],
        redacted: true,
        redactionState: "partial",
        validationState: "valid",
      },
      { stage: "parse", stepName: "column step", status: "success", createdAt: CREATED_AT },
    );

    const [event] = buildTimeline([row]);

    assert.equal(event.raw, row);
    assert.equal(event.seq, 7);
    assert.equal(event.stage, "mapping");
    assert.equal(event.stepName, "payload step");
    assert.equal(event.status, "warning");
    assert.equal(event.timestamp, PAYLOAD_TIME);
    assert.equal(event.recordIndex, 0);
    assert.equal(event.ruleId, "rule-a");
    assert.equal(event.sourcePath, "Patient.name");
    assert.equal(event.targetPath, "Patient.name.family");
    assert.equal(event.hasInputSnippet, true);
    assert.deepEqual(event.inputSnippet, { family: "Doe" });
    assert.equal(event.hasOutputSnippet, true);
    assert.equal(event.outputSnippet, null);
    assert.equal(event.durationMs, 12.5);
    assert.deepEqual(event.issues, [recordedIssue]);
    assert.equal(event.redacted, true);
    assert.equal(event.redactionState, "partial");
    assert.equal(event.validationState, "valid");
    assert.equal(event.hasPayload, true);
  });

  it("treats a recorded null input snippet as recorded", () => {
    const [event] = buildTimeline([payloadRow(1, { inputSnippet: null })]);

    assert.equal(event.hasInputSnippet, true);
    assert.equal(event.inputSnippet, null);
    assert.equal(event.hasOutputSnippet, false);
    assert.equal(event.outputSnippet, null);
  });

  it("falls back to stored columns and leaves unrecorded fields empty when the payload is absent", () => {
    const row = traceRow(3, { stage: "detect", stepName: "scan", status: "success", createdAt: CREATED_AT });

    const [event] = buildTimeline([row]);

    assert.equal(event.raw, row);
    assert.equal(event.stage, "detect");
    assert.equal(event.stepName, "scan");
    assert.equal(event.status, "success");
    assert.equal(event.timestamp, CREATED_AT);
    assert.equal(event.recordIndex, null);
    assert.equal(event.ruleId, null);
    assert.equal(event.sourcePath, null);
    assert.equal(event.targetPath, null);
    assert.equal(event.inputSnippet, null);
    assert.equal(event.hasInputSnippet, false);
    assert.equal(event.outputSnippet, null);
    assert.equal(event.hasOutputSnippet, false);
    assert.equal(event.durationMs, null);
    assert.deepEqual(event.issues, []);
    assert.equal(event.redacted, null);
    assert.equal(event.redactionState, null);
    assert.equal(event.validationState, null);
    assert.equal(event.hasPayload, false);
  });

  it("only accepts payload fields with the right type and keeps non-empty fallbacks", () => {
    const [event] = buildTimeline([
      payloadRow(
        1,
        {
          stage: "",
          stepName: 42,
          status: "",
          timestamp: 123,
          recordIndex: -1,
          ruleId: 9,
          sourcePath: {},
          targetPath: "",
          durationMs: Number.POSITIVE_INFINITY,
          issues: "not-an-array",
          redacted: "yes",
          redactionState: 1,
          validationState: false,
        },
        { stage: "build", stepName: "column step", status: "skipped", createdAt: CREATED_AT },
      ),
    ]);

    assert.equal(event.stage, "build");
    assert.equal(event.stepName, "column step");
    assert.equal(event.status, "skipped");
    assert.equal(event.timestamp, CREATED_AT);
    assert.equal(event.recordIndex, null);
    assert.equal(event.ruleId, null);
    assert.equal(event.sourcePath, null);
    assert.equal(event.targetPath, null);
    assert.equal(event.durationMs, null);
    assert.deepEqual(event.issues, []);
    assert.equal(event.redacted, null);
    assert.equal(event.redactionState, null);
    assert.equal(event.validationState, null);
  });

  it("rejects fractional and negative record indexes and durations", () => {
    const [fractional, valid] = buildTimeline([
      payloadRow(1, { recordIndex: 2.5, durationMs: -1 }),
      payloadRow(2, { recordIndex: 0, durationMs: 0 }),
    ]);

    assert.equal(fractional.recordIndex, null);
    assert.equal(fractional.durationMs, null);
    assert.equal(valid.recordIndex, 0);
    assert.equal(valid.durationMs, 0);
  });

  it("keeps only object entries from an issues array", () => {
    const recordedIssue = issue();
    const bareObject = { note: "object-ness is the only check" };
    const [event] = buildTimeline([payloadRow(1, { issues: [recordedIssue, null, "x", 7, bareObject] })]);

    assert.deepEqual(event.issues, [recordedIssue, bareObject]);
  });

  it("sorts by seq ascending without mutating the input rows", () => {
    const rows = [
      payloadRow(5, { stepName: "five" }),
      payloadRow(1, { stepName: "one" }),
      payloadRow(3, { stepName: "three" }),
    ];
    const originalOrder = rows.map((row) => row.seq);
    const payloadSnapshot = rows.map((row) => JSON.stringify(row.payload));

    const events = buildTimeline(rows);

    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 3, 5],
    );
    assert.deepEqual(
      rows.map((row) => row.seq),
      originalOrder,
    );
    assert.deepEqual(
      rows.map((row) => JSON.stringify(row.payload)),
      payloadSnapshot,
    );
    assert.equal(events[0].raw, rows[1]);
  });
});

describe("stageSummary", () => {
  const events = buildTimeline([
    payloadRow(1, { stage: "mapping", status: "success" }),
    payloadRow(2, { stage: "mapping", status: "warning", issues: [issue()] }),
    payloadRow(3, { stage: "parse", status: "error" }),
    payloadRow(4, { stage: "zeta", status: "success" }),
    payloadRow(5, { stage: "alpha", status: "warning" }),
    payloadRow(6, { stage: "beta", status: "skipped", issues: [issue(), issue()] }),
  ]);

  it("counts every stored event and orders known stages by TRACE_STAGES, extras alphabetically", () => {
    const summary = stageSummary(events);

    assert.equal(summary.total, 6);
    assert.deepEqual(summary.stages, [
      { stage: "parse", count: 1 },
      { stage: "mapping", count: 2 },
      { stage: "alpha", count: 1 },
      { stage: "beta", count: 1 },
      { stage: "zeta", count: 1 },
    ]);
    assert.equal(summary.withIssues, 2);
    assert.equal(summary.warnings, 2);
    assert.equal(summary.errors, 1);
  });

  it("keeps counting all events when a filter would exclude some", () => {
    const filtered = filterEvents(events, filter({ stage: "parse" }));

    assert.equal(filtered.length, 1);
    assert.equal(stageSummary(events).total, 6);
  });

  it("pins the declared stage order", () => {
    assert.deepEqual(
      [...TRACE_STAGES],
      ["detect", "adapter-selection", "parse", "envelope", "mapping", "build", "validate", "export"],
    );
  });
});

describe("filterEvents", () => {
  const events = buildTimeline([
    payloadRow(1, {
      stage: "mapping",
      stepName: "Map Patient",
      status: "success",
      recordIndex: 0,
      sourcePath: "Patient.name",
      targetPath: "Patient.name.family",
    }),
    payloadRow(2, {
      stage: "validate",
      stepName: "Check Name",
      status: "warning",
      recordIndex: 1,
      sourcePath: "Patient.name.given",
      targetPath: "Patient.name.given",
      issues: [issue({ code: "INVALID_NAME", severity: "warning", message: "Name is invalid", path: "Patient.name" })],
    }),
    payloadRow(3, {
      stage: "mapping",
      stepName: "Map Birth Date",
      status: "success",
    }),
  ]);

  it("ANDs two conditions at once", () => {
    assert.deepEqual(
      filterEvents(events, filter({ stage: "validate", q: "name is invalid" })).map((event) => event.seq),
      [2],
    );
    assert.deepEqual(filterEvents(events, filter({ stage: "mapping", q: "name is invalid" })), []);
  });

  it("matches q case-insensitively over step names, paths and issue text", () => {
    assert.deepEqual(
      filterEvents(events, filter({ q: "MAP PATIENT" })).map((event) => event.seq),
      [1],
    );
    assert.deepEqual(
      filterEvents(events, filter({ q: "patient.name.family" })).map((event) => event.seq),
      [1],
    );
    assert.deepEqual(
      filterEvents(events, filter({ q: "PATIENT.NAME.GIVEN" })).map((event) => event.seq),
      [2],
    );
    assert.deepEqual(
      filterEvents(events, filter({ q: "invalid_name" })).map((event) => event.seq),
      [2],
    );
    assert.deepEqual(
      filterEvents(events, filter({ q: "IS INVALID" })).map((event) => event.seq),
      [2],
    );
  });

  it("treats record 0 as a value, not as empty", () => {
    const matched = filterEvents(events, filter({ record: 0 }));

    assert.deepEqual(
      matched.map((event) => event.seq),
      [1],
    );
    assert.ok(matched.every((event) => event.recordIndex === 0));
  });

  it("keeps only events with issues when onlyIssues is set", () => {
    assert.deepEqual(
      filterEvents(events, filter({ onlyIssues: true })).map((event) => event.seq),
      [2],
    );
    assert.deepEqual(filterEvents(events, filter({ onlyIssues: true, record: 0 })), []);
  });

  it("ignores a whitespace-only q and trims a real one", () => {
    assert.equal(filterEvents(events, filter({ q: "   " })).length, 3);
    assert.deepEqual(
      filterEvents(events, filter({ q: "  invalid_name  " })).map((event) => event.seq),
      [2],
    );
  });

  it("matches nothing when q has no substring anywhere", () => {
    assert.deepEqual(filterEvents(events, filter({ q: "synthetic-miss" })), []);
  });
});

describe("firstMatchingIndex", () => {
  const events = buildTimeline([
    payloadRow(10, { stage: "mapping", stepName: "Map Patient" }),
    payloadRow(11, { stage: "validate", stepName: "Check Name" }),
    payloadRow(12, { stage: "mapping", stepName: "Map Birth Date" }),
  ]);

  it("returns the index in the original array or -1", () => {
    assert.equal(firstMatchingIndex(events, NO_FILTER), 0);
    assert.equal(firstMatchingIndex(events, filter({ stage: "validate" })), 1);
    assert.equal(firstMatchingIndex(events, filter({ q: "birth date" })), 2);
    assert.equal(firstMatchingIndex(events, filter({ stage: "export" })), -1);
  });

  it("agrees with filterEvents", () => {
    const active = filter({ q: "map" });
    const first = filterEvents(events, active)[0];

    assert.equal(firstMatchingIndex(events, active), events.indexOf(first));
  });
});

describe("joinRule", () => {
  const spec = {
    rules: [rule("rule-a", "target/a"), rule("rule-b", "target/shared"), rule("rule-c", "target/shared")],
  };

  it("joins an exact recorded rule id", () => {
    const join = joinRule(eventFrom({ ruleId: "rule-a", targetPath: "target/shared" }), spec);

    assert.equal(join.status, "exact");
    assert.equal(join.rule?.id, "rule-a");
    assert.equal(join.note, "");
  });

  it("reports a recorded rule id that the mapping version does not declare", () => {
    const join = joinRule(eventFrom({ ruleId: "rule-z" }), spec);

    assert.equal(join.status, "missing");
    assert.equal(join.rule, null);
    assert.equal(join.note, "Rule rule-z is not in the run's mapping version.");
  });

  it("joins by a uniquely declared target path when no rule id is recorded", () => {
    const join = joinRule(eventFrom({ targetPath: "target/a" }), spec);

    assert.equal(join.status, "by-target");
    assert.equal(join.rule?.id, "rule-a");
    assert.equal(join.note, "Joined by declared target path; this trace event does not record a rule id.");
  });

  it("refuses to guess when several declared rules target the same path", () => {
    const join = joinRule(eventFrom({ targetPath: "target/shared" }), spec);

    assert.equal(join.status, "ambiguous");
    assert.equal(join.rule, null);
    assert.equal(join.note, "2 declared rules target this path; not guessing.");
  });

  it("reports an unrecorded rule when neither an id nor a matching target exists", () => {
    const unmatched = joinRule(eventFrom({ targetPath: "target/none" }), spec);
    const missingPath = joinRule(eventFrom({}), spec);

    assert.equal(unmatched.status, "unrecorded");
    assert.equal(unmatched.rule, null);
    assert.equal(unmatched.note, "Rule not recorded in this trace event.");
    assert.equal(missingPath.status, "unrecorded");
    assert.equal(missingPath.note, "Rule not recorded in this trace event.");
  });

  it("treats an invalid or empty mapping spec as no declared rules", () => {
    const invalidSpecs: unknown[] = [null, undefined, {}, { rules: "x" }, { rules: [] }, { rules: [null] }];

    for (const invalid of invalidSpecs) {
      const join = joinRule(eventFrom({ ruleId: "rule-a" }), invalid);

      assert.equal(join.status, "no-mapping");
      assert.equal(join.rule, null);
      assert.equal(join.note, "The run's mapping version has no declared rules.");
    }
  });
});

describe("mergeIssues", () => {
  const sharedRunIssue = issue({
    code: "SHARED",
    severity: "warning",
    message: "Shared problem",
    path: "Patient.name",
    recordIndex: 0,
    ruleId: "rule-a",
  });
  const runOnly = issue({
    code: "RUN_ONLY",
    severity: "error",
    message: "Run only",
    path: "Patient.birthDate",
    recordIndex: 2,
    ruleId: "rule-b",
  });
  const traceOnly = issue({
    code: "TRACE_ONLY",
    severity: "information",
    message: "Trace only",
    path: "Patient.telecom",
    recordIndex: 1,
    ruleId: "rule-c",
  });
  const sameCodeDifferentPath = issue({ ...sharedRunIssue, path: "Patient.other" });
  const events = buildTimeline([
    payloadRow(1, { issues: [traceOnly, sharedRunIssue] }),
    payloadRow(2, { issues: [sharedRunIssue, sharedRunIssue, traceOnly, sameCodeDifferentPath] }),
  ]);

  it("lists run issues first, then trace-only issues, deduplicated with ascending unique seqs", () => {
    const merged = mergeIssues([sharedRunIssue, runOnly], events);

    assert.deepEqual(
      merged.map((entry) => [entry.issue.code, entry.inRun, entry.seqs]),
      [
        ["SHARED", true, [1, 2]],
        ["RUN_ONLY", true, []],
        ["TRACE_ONLY", false, [1, 2]],
        ["SHARED", false, [2]],
      ],
    );
  });

  it("keeps issues separate when any tuple field differs", () => {
    const merged = mergeIssues([sharedRunIssue], buildTimeline([payloadRow(1, { issues: [sameCodeDifferentPath] })]));

    assert.equal(merged.length, 2);
    assert.equal(merged[1].inRun, false);
    assert.equal(merged[1].issue.path, "Patient.other");
  });
});

describe("buildExport", () => {
  const rows = [
    payloadRow(1, { stage: "mapping", stepName: "one" }),
    payloadRow(2, { stage: "build", stepName: "two" }),
    payloadRow(3, { stage: "validate", stepName: "three" }),
  ];
  const events = buildTimeline(rows);

  it("exports the raw rows of the filtered events with the filter echoed", () => {
    const active = filter({ stage: "build", record: 0 });
    const exported = buildExport("run-synthetic", [events[1], events[2]], active, "2026-02-03T04:05:06.000Z");

    assert.deepEqual(exported, {
      source: "stored-trace",
      live: false,
      runId: "run-synthetic",
      generatedAt: "2026-02-03T04:05:06.000Z",
      filter: active,
      count: 2,
      redaction: "server-redacted",
      traces: [rows[1], rows[2]],
    });
    assert.deepEqual(Object.keys(exported).sort(), [
      "count",
      "filter",
      "generatedAt",
      "live",
      "redaction",
      "runId",
      "source",
      "traces",
    ]);
  });

  it("exports an empty trace list before anything matches", () => {
    const exported = buildExport("run-synthetic", [], NO_FILTER, "2026-02-03T04:05:06.000Z");

    assert.equal(exported.count, 0);
    assert.deepEqual(exported.traces, []);
  });

  it("pins the stored replay marker", () => {
    assert.deepEqual(STORED_REPLAY, { source: "stored-trace", live: false });
  });
});

describe("describeTraceAvailability", () => {
  it("describes pending, partial, settled and empty runs with exact messages", () => {
    const cases = [
      [
        "running",
        0,
        "pending",
        "Trace rows are written when the run settles; this run is running. Open run detail for live progress.",
        false,
      ],
      [
        "queued",
        2,
        "partial",
        "This run is still queued; the stored trace is partial. Refresh to load rows written since this page opened.",
        true,
      ],
      ["completed", 3, "settled", "", false],
      ["completed_with_warnings", 1, "settled", "", false],
      ["cancelled", 1, "settled", "", false],
      ["failed", 0, "empty", "This run settled without storing any trace rows.", false],
    ] as const;

    for (const [status, count, kind, message, canRefresh] of cases) {
      assert.deepEqual(describeTraceAvailability(status, count), { kind, message, canRefresh });
    }
  });

  it("treats an unknown status as non-terminal", () => {
    assert.deepEqual(describeTraceAvailability("synthetic-status", 0), {
      kind: "pending",
      message:
        "Trace rows are written when the run settles; this run is synthetic-status. Open run detail for live progress.",
      canRefresh: false,
    });
    assert.deepEqual(describeTraceAvailability("synthetic-status", 4), {
      kind: "partial",
      message:
        "This run is still synthetic-status; the stored trace is partial. Refresh to load rows written since this page opened.",
      canRefresh: true,
    });
  });
});
