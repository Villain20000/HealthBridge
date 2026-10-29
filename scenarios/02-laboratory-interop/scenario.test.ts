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

describe("Scenario 2 — laboratory interoperability (CSV → Observation / DiagnosticReport)", () => {
  test("maps laboratory rows to FHIR Observations with UCUM units and reference ranges", async () => {
    const { result } = await runScenario("02-laboratory-interop", "lab-results.csv", "observation.json");
    const expected = readJson<unknown[]>(scenarioPath("02-laboratory-interop", "expected", "observations.json"));

    assert.equal(result.status, "completed");
    assert.equal(result.targetResourceType, "Observation");
    assert.deepEqual(projection(result.output), expected);

    const first = result.output[0] as Record<string, any>;
    assert.equal(first.code.coding[0].system, "http://loinc.org");
    assert.equal(first.valueQuantity.system, "http://unitsofmeasure.org");
    assert.equal(first.subject.reference, "Patient/P100");
    assert.equal(result.validation.isValid, true);
    assertPipelineStages(result);
  });

  test("maps the same rows to DiagnosticReports and reports its narrower coverage", async () => {
    const { result } = await runScenario("02-laboratory-interop", "lab-results.csv", "diagnostic-report.json");
    const expected = readJson<unknown[]>(scenarioPath("02-laboratory-interop", "expected", "diagnostic-reports.json"));

    assert.equal(result.targetResourceType, "DiagnosticReport");
    assert.deepEqual(projection(result.output), expected);
    assert.equal(result.validation.isValid, true);

    // The report mapping covers a subset of the columns: it must say so.
    const expectedIssues = readJson<{ diagnosticReport: { codes: string[] } }>(
      scenarioPath("02-laboratory-interop", "expected", "issues.json"),
    );
    for (const code of expectedIssues.diagnosticReport.codes) {
      assert.ok(issueCodes(result).includes(code), `expected issue '${code}' (got ${issueCodes(result).join(", ")})`);
    }
    assert.ok(result.coverage.coveragePercentage < 100);
  });

  test("does not leak analyte values or accession numbers into traces", async () => {
    const { result } = await runScenario("02-laboratory-interop", "lab-results.csv", "observation.json");
    assertNoPhiInTraces(result, ["A-9001", "Glucose", "11.2"]);
  });
});
