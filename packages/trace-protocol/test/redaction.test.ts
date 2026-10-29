import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TraceCollector, DEFAULT_REDACTION_POLICY, TraceRedactor } from "@healthbridge/trace-protocol";

describe("trace redaction", () => {
  test("redacts direct identifiers in emitted events (regression: spread order disabled redaction)", () => {
    const tracer = new TraceCollector({ runId: "run-1" });
    const event = tracer.emit({
      stepId: "semantic-mapping",
      stepName: "Semantic Mapping",
      status: "success",
      inputSnippet: {
        ssn: "123-45-6789",
        email: "jane.doe@example.org",
        phone: "+1 555 010 9999",
        patient_id: "P101",
        first_name: "Jane",
        birth_date: "1990-11-23",
        loinc_code: "2339-0",
        result_value: 95,
      },
    });

    const serialised = JSON.stringify(event);
    assert.ok(!serialised.includes("123-45-6789"), "SSN must not appear in traces");
    assert.ok(!serialised.includes("jane.doe@example.org"), "e-mail must not appear");
    assert.ok(!serialised.includes("555 010 9999"), "phone must not appear");
    assert.ok(!serialised.includes("Jane"), "given name must not appear");
    assert.ok(!serialised.includes("1990-11-23"), "birth date must not appear");
    assert.equal(event.redacted, true);
    assert.equal(event.redactionState, "partial");
  });

  test("keeps structure and terminology fields, masks clinical values by default", () => {
    const tracer = new TraceCollector({ runId: "run-2" });
    const event = tracer.emit({
      stepId: "semantic-mapping",
      stepName: "Semantic Mapping",
      status: "success",
      outputSnippet: {
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "2339-0" }] },
        valueQuantity: { value: 95, unit: "mg/dL" },
        subject: { reference: "Patient/P101" },
      },
    });
    const snippet = event.outputSnippet as Record<string, any>;
    // structural + terminology values stay
    assert.equal(snippet.resourceType, "Observation");
    assert.equal(snippet.status, "final");
    assert.equal(snippet.code.coding[0].system, "http://loinc.org");
    assert.equal(snippet.code.coding[0].code, "2339-0");
    assert.equal(snippet.valueQuantity.unit, "mg/dL");
    // patient-linked values do not
    assert.equal(snippet.valueQuantity.value, "[REDACTED]");
    assert.equal(snippet.subject.reference, "[REDACTED]");
    assert.equal(event.redactionState, "partial");
  });

  test("masks values quoted inside issue messages", () => {
    const tracer = new TraceCollector({ runId: "run-2b" });
    const event = tracer.emit({
      stepId: "semantic-mapping",
      stepName: "Semantic Mapping",
      status: "error",
      issues: [
        { code: "INVALID_DATE_FORMAT", severity: "warning", message: "Could not parse 'not a date' as a valid date" },
      ],
    });
    const message = (event.issues ?? [])[0].message;
    assert.ok(!message.includes("not a date"), "quoted values must be masked");
    assert.ok(message.includes("Could not parse"));
    assert.equal(event.issues?.[0].code, "INVALID_DATE_FORMAT");
  });

  test("payloadMode full keeps raw values but marks the event as not redacted", () => {
    const tracer = new TraceCollector({ runId: "run-3", redactSensitiveData: false });
    const event = tracer.emit({
      stepId: "semantic-mapping",
      stepName: "Semantic Mapping",
      status: "success",
      inputSnippet: { ssn: "123-45-6789" },
    });
    assert.equal(event.redacted, false);
    assert.equal(event.redactionState, "none");
    assert.equal((event.inputSnippet as Record<string, string>).ssn, "123-45-6789");
  });

  test("bounds snippet size for long arrays, long strings and deep objects", () => {
    const redactor = new TraceRedactor({ maskScalarValues: false });
    const result = redactor.redact({
      rows: Array.from({ length: 500 }, (_, i) => i),
      note: "x".repeat(5000),
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } },
    }) as { value: Record<string, unknown> };

    const rows = result.value.rows as unknown[];
    assert.ok(rows.length <= DEFAULT_REDACTION_POLICY.maxArrayItems + 1);
    assert.ok(String(result.value.note).includes("truncated"));
  });

  test("emits the current protocol version with span ids", () => {
    const tracer = new TraceCollector({ runId: "run-4" });
    const first = tracer.emit({ stepId: "a", stepName: "A", status: "success" });
    const second = tracer.emit({ stepId: "b", stepName: "B", status: "success" });
    assert.equal(first.protocolVersion, "1.2");
    assert.notEqual(first.spanId, second.spanId);
  });

  test("summarises events by status and stage", () => {
    const tracer = new TraceCollector({ runId: "run-5" });
    tracer.emit({ stepId: "a", stepName: "A", status: "success", stage: "parse" });
    tracer.emit({
      stepId: "b",
      stepName: "B",
      status: "error",
      stage: "mapping",
      issues: [{ code: "X", severity: "error", message: "x" }],
    });
    const summary = tracer.summarize();
    assert.equal(summary.totalEvents, 2);
    assert.equal(summary.byStatus.success, 1);
    assert.equal(summary.byStage.mapping, 1);
    assert.equal(summary.totalIssues, 1);
  });
});
