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

describe("Scenario 1 — hospital patient migration (CSV → FHIR Patient)", () => {
  test("produces the expected FHIR R4 Patients", async () => {
    const { result } = await runScenario("01-hospital-patient-migration", "patients.csv", "patient.json");
    const expected = readJson<unknown[]>(scenarioPath("01-hospital-patient-migration", "expected", "resources.json"));

    assert.equal(result.status, "completed");
    assert.equal(result.recordsProcessed, 3);
    assert.equal(result.recordsSucceeded, 3);
    assert.equal(result.recordsFailed, 0);
    assert.equal(result.adapterId, "csv-adapter");
    assert.deepEqual(projection(result.output), expected);
  });

  test("validates the output and reports which levels ran", async () => {
    const { result } = await runScenario("01-hospital-patient-migration", "patients.csv", "patient.json");
    assert.equal(result.validation.isValid, true);
    assert.equal(result.validation.standard, "fhir-r4");
    assertPipelineStages(result);
  });

  test("records provenance and stays reproducible", async () => {
    const first = await runScenario("01-hospital-patient-migration", "patients.csv", "patient.json");
    const second = await runScenario("01-hospital-patient-migration", "patients.csv", "patient.json");

    assert.equal(first.result.outputChecksum, second.result.outputChecksum);
    assert.match(first.result.inputChecksum ?? "", /^sha256:[0-9a-f]{64}$/);

    const extensions = (first.result.output[0] as Record<string, unknown>).extension as Array<Record<string, unknown>>;
    const provenance = extensions.find(
      (e) => e.url === "https://healthbridge.dev/fhir/StructureDefinition/source-provenance",
    );
    assert.ok(provenance, "provenance extension must be present");
    const children = new Map((provenance.extension as Array<Record<string, unknown>>).map((c) => [c.url as string, c]));
    assert.equal(children.get("mappingId")?.valueString, "hospital-patient-to-fhir");
    assert.equal(children.get("adapterId")?.valueString, "csv-adapter");
  });

  test("keeps patient identifiers out of traces", async () => {
    const { result } = await runScenario("01-hospital-patient-migration", "patients.csv", "patient.json");
    assertNoPhiInTraces(result, ["Okonkwo", "Chidi", "MRN-1001", "1990-02-17"]);
    assert.deepEqual(issueCodes(result), []);
  });
});
