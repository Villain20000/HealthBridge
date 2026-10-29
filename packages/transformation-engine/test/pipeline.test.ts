import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TransformationPipeline } from "@healthbridge/transformation-engine";
import { TRACE_PROTOCOL_VERSION } from "@healthbridge/shared-types";
import type { MappingDefinition } from "@healthbridge/mapping-engine";

const patientMapping: MappingDefinition = {
  id: "patient-csv-to-fhir",
  name: "CSV Patient to FHIR R4 Patient",
  version: "1.1.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  rules: [
    {
      id: "r0",
      sourcePath: "__constant_resourceType",
      targetPath: "resourceType",
      transform: "default_value",
      defaultValue: "Patient",
    },
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
    { id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" },
    { id: "r3", sourcePath: "last_name", targetPath: "name.0.family", transform: "uppercase" },
    { id: "r4", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" },
    { id: "r5", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" },
  ],
};

const csv = [
  "patient_id,first_name,last_name,gender,birth_date,ssn",
  "P101,Jane,Doe,F,1990-11-23,123-45-6789",
  "P102,John,Smith,M,1985-04-12,987-65-4321",
  ",Anon,Missing,,not-a-date,",
].join("\n");

describe("transformation pipeline", () => {
  const pipeline = new TransformationPipeline();

  test("produces FHIR-shaped output and aggregates coverage across records", async () => {
    const result = await pipeline.execute({
      input: { id: "in-1", filename: "patients.csv", contentString: csv },
      mapping: patientMapping,
      runId: "run-test-1",
    });

    assert.equal(result.recordsProcessed, 3);
    assert.equal(result.recordsSucceeded, 2);
    assert.equal(result.recordsFailed, 1);
    assert.equal(result.output.length, 2);

    const first = result.output[0] as Record<string, unknown>;
    assert.deepEqual(first.name, [{ given: ["Jane"], family: "DOE" }]);
    assert.equal(first.gender, "female");

    // Coverage must consider all records, not only the last one.
    assert.equal(result.coverage.recordsConsidered, 3);
    assert.ok(result.coverage.totalSourceFields > 0);
    assert.ok(result.coverage.coveragePercentage > 0);
    assert.ok(result.coverage.unmappedSourceFields.includes("ssn"));
  });

  test("never drops a failed record silently", async () => {
    const result = await pipeline.execute({
      input: { id: "in-2", filename: "patients.csv", contentString: csv },
      mapping: patientMapping,
    });

    assert.equal(result.rejectedRecords.length, 1);
    const rejected = result.rejectedRecords[0];
    assert.equal(rejected.recordIndex, 2);
    assert.equal(rejected.envelopeId, "csv-rec-2");
    assert.equal(rejected.sourceLocation, "line 4");
    assert.ok(rejected.issues.some((i) => i.code === "MISSING_REQUIRED_FIELD"));
    assert.deepEqual(result.dataLoss.droppedRecordIndexes, [2]);
    assert.equal(result.dataLoss.isLossless, false);
  });

  test("traces are redacted and carry checksums, adapter versions and stages", async () => {
    const result = await pipeline.execute({
      input: { id: "in-3", filename: "patients.csv", contentString: csv },
      mapping: patientMapping,
    });

    assert.match(String(result.inputChecksum), /^sha256:/);
    assert.equal(result.adapterId, "csv-adapter");
    assert.ok(result.adapterVersion);
    assert.ok(result.engineVersion);
    assert.ok(result.traces.length >= 4);
    assert.ok(result.traces.every((trace) => trace.protocolVersion === TRACE_PROTOCOL_VERSION));

    const serialised = JSON.stringify(result.traces);
    assert.ok(!serialised.includes("123-45-6789"), "SSN must not leak into traces");
    assert.ok(!serialised.includes("Jane"), "given name must not leak into traces");

    const stages = new Set(result.traces.map((t) => t.stage));
    assert.ok(stages.has("detect"));
    assert.ok(stages.has("adapter-selection"));
    assert.ok(stages.has("parse"));
    assert.ok(stages.has("mapping"));
    assert.ok(stages.has("export"));
  });

  test("invalid mapping aborts before parsing with a structured error", async () => {
    const result = await pipeline.execute({
      input: { id: "in-4", filename: "patients.csv", contentString: csv },
      mapping: { ...patientMapping, rules: [{ ...patientMapping.rules[0], transform: "nope" as never }] },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.recordsProcessed, 0);
    assert.ok(result.coverage.issues.some((i) => i.code === "MAPPING_UNKNOWN_TRANSFORM"));
    assert.ok(result.dataLoss.adapterNotes.some((note) => note.includes("mapping definition is invalid")));
  });

  test("malformed JSON fails with a fatal adapter issue", async () => {
    const result = await pipeline.execute({
      input: { id: "in-5", filename: "broken.json", contentString: '{ "resourceType": ' },
      mapping: patientMapping,
    });
    assert.equal(result.status, "failed");
    assert.ok(result.coverage.issues.some((i) => i.code === "MALFORMED_JSON"));
  });

  test("is deterministic for identical input and a fixed import timestamp", async () => {
    const importedAt = "2024-01-01T00:00:00.000Z";
    const runA = await pipeline.execute({
      input: { id: "a", filename: "p.csv", contentString: csv },
      mapping: patientMapping,
      importedAt,
    });
    const runB = await pipeline.execute({
      input: { id: "b", filename: "p.csv", contentString: csv },
      mapping: patientMapping,
      importedAt,
    });
    assert.deepEqual(runA.output, runB.output);
    assert.deepEqual(runA.coverage, runB.coverage);
    assert.equal(runA.inputChecksum, runB.inputChecksum);
    assert.equal(runA.outputChecksum, runB.outputChecksum);
  });

  test("respects maxRecords and reports it honestly", async () => {
    const result = await pipeline.execute({
      input: { id: "in-6", filename: "patients.csv", contentString: csv },
      mapping: patientMapping,
      maxRecords: 1,
    });
    assert.equal(result.recordsProcessed, 1);
  });

  test("warns when the source domain does not match the mapping's declared domains", async () => {
    const labs = ["lab_id,patient_id,loinc_code,result_value,result_unit", "L1,P101,2339-0,95,mg/dL"].join("\n");
    const result = await pipeline.execute({
      input: { id: "in-7", filename: "labs.csv", contentString: labs },
      mapping: { ...patientMapping, sourceDomains: ["clinical"] },
    });

    assert.ok(result.coverage.issues.some((i) => i.code === "DOMAIN_MISMATCH"));
    assert.ok(result.coverage.issues.some((i) => i.code === "LOW_MAPPING_COVERAGE"));
    assert.equal(result.status, "completed_with_warnings");
  });

  test("reports duplicate target resource ids", async () => {
    const duplicated = ["patient_id,first_name,last_name", "P1,A,One", "P1,B,Two"].join("\n");
    const result = await pipeline.execute({
      input: { id: "in-8", filename: "dup.csv", contentString: duplicated },
      mapping: patientMapping,
    });

    const issue = result.coverage.issues.find((i) => i.code === "DUPLICATE_RESOURCE_ID");
    assert.ok(issue);
    assert.match(issue!.message, /Patient\/P1/);
  });
});
