import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoPhiInTraces,
  assertPipelineStages,
  issueCodes,
  projection,
  readJson,
  runScenario,
  scenarioPath,
} from "../harness";

const SCENARIO = "03-broken-hospital-data";

describe("Scenario 3 — broken hospital data (invalid dates, duplicates, unmapped codes)", () => {
  test("rejects unparseable records instead of exporting them", async () => {
    const { result } = await runScenario(SCENARIO, "broken-patients.csv", "patient.json");
    const expected = readJson<{
      recordsProcessed: number;
      recordsSucceeded: number;
      recordsFailed: number;
      codes: string[];
    }>(scenarioPath(SCENARIO, "expected", "issues.json"));

    assert.equal(result.status, "completed_with_warnings");
    assert.equal(result.recordsProcessed, expected.recordsProcessed);
    assert.equal(result.recordsSucceeded, expected.recordsSucceeded);
    assert.equal(result.recordsFailed, expected.recordsFailed);
    assert.equal(result.output.length, expected.recordsSucceeded);

    for (const code of expected.codes) {
      assert.ok(issueCodes(result).includes(code), `expected issue '${code}' (got ${issueCodes(result).join(", ")})`);
    }
  });

  test("every rejected record carries a reason and the surviving rows are the valid ones", async () => {
    const { result } = await runScenario(SCENARIO, "broken-patients.csv", "patient.json");
    const expected = readJson<unknown[]>(scenarioPath(SCENARIO, "expected", "resources.json"));

    assert.deepEqual(projection(result.output), expected);
    assert.deepEqual(
      result.rejectedRecords.map((r) => r.recordIndex),
      [1, 3],
    );
    for (const rejected of result.rejectedRecords) {
      assert.ok(rejected.issues.length > 0, "a rejected record without a reason is a silent data loss bug");
      assert.ok(rejected.issues.some((i) => i.severity === "error" || i.severity === "fatal"));
    }
  });

  test("the duplicate identifier is reported, not deduplicated silently", async () => {
    const { result } = await runScenario(SCENARIO, "broken-patients.csv", "patient.json");
    const duplicate = result.coverage.issues.find((i) => i.code === "DUPLICATE_RESOURCE_ID");
    assert.ok(duplicate, "duplicate Patient/B001 must be reported");
    assert.equal(duplicate?.severity, "warning");
  });

  test("broken input never becomes invalid FHIR and never leaks names into traces", async () => {
    const { result } = await runScenario(SCENARIO, "broken-patients.csv", "patient.json");
    assert.equal(result.validation.isValid, true, "surviving records must still validate");
    assertPipelineStages(result);
    assertNoPhiInTraces(result, ["Duval", "Nakamura", "not a date"]);
  });
});
