import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TransformationPipeline } from "@healthbridge/transformation-engine";
import type { RunCheckpoint } from "@healthbridge/shared-types";
import type { MappingDefinition } from "@healthbridge/mapping-engine";

const IMPORTED_AT = "2024-01-01T00:00:00.000Z";

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

// Four valid rows; the fifth is rejected (missing required patient_id), so the
// full run exercises both the output prefix and the rejected-records tail.
const csv = [
  "patient_id,first_name,last_name,gender,birth_date",
  "P101,Jane,Doe,F,1990-11-23",
  "P102,John,Smith,M,1985-04-12",
  "P103,Ana,Lee,F,2000-01-30",
  "P104,Bob,Brown,M,1975-07-04",
  ",Anon,Missing,,not-a-date",
].join("\n");

function input() {
  return { id: "in-live", filename: "patients.csv", contentString: csv };
}

describe("executeChunked live checkpoints", () => {
  test("matches execute() byte-identically when never paused", async () => {
    const pipeline = new TransformationPipeline();
    const full = await pipeline.execute({ input: input(), mapping: patientMapping, importedAt: IMPORTED_AT });

    const checkpoints: RunCheckpoint[] = [];
    const chunked = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    assert.equal(chunked.status, full.status);
    assert.ok(chunked.result, "an uninterrupted chunked run finishes with a result");
    assert.deepEqual(chunked.result.output, full.output);
    assert.deepEqual(chunked.result.coverage, full.coverage);
    assert.deepEqual(chunked.result.rejectedRecords, full.rejectedRecords);
    assert.deepEqual(chunked.result.dataLoss, full.dataLoss);
    assert.deepEqual(chunked.result.validation, full.validation);
    assert.equal(chunked.result.inputChecksum, full.inputChecksum);
    assert.equal(chunked.result.outputChecksum, full.outputChecksum);
    assert.deepEqual(checkpoints.map((c) => c.recordIndex), [2, 4, 5, 5]);
    assert.deepEqual(
      checkpoints.map((c) => c.stage),
      ["mapping", "mapping", "mapping", "done"],
    );
  });

  test("checkpoints carry stage, record index and binding checksums", async () => {
    const pipeline = new TransformationPipeline();
    const full = await pipeline.execute({ input: input(), mapping: patientMapping, importedAt: IMPORTED_AT });

    const checkpoints: RunCheckpoint[] = [];
    await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      runId: "run-checkpoint-shape",
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    assert.equal(checkpoints.length, 4);
    for (const checkpoint of checkpoints) {
      assert.equal(checkpoint.runId, "run-checkpoint-shape");
      assert.equal(checkpoint.inputChecksum, full.inputChecksum, "checkpoint binds the exact input");
      assert.match(String(checkpoint.outputChecksumSoFar), /^sha256:[0-9a-f]{64}$/);
      assert.equal(checkpoint.adapterId, "csv-adapter");
      assert.equal(checkpoint.importedAt, IMPORTED_AT, "checkpoint binds the reproducibility anchor");
      assert.ok(checkpoint.updatedAt);
    }
    assert.deepEqual(
      checkpoints.map((c) => c.stage),
      ["mapping", "mapping", "mapping", "done"],
    );
    assert.ok(Number.isInteger(checkpoints[0].recordIndex) && checkpoints[0].recordIndex === 2);
  });

  test("pause stops after the current chunk and resume is byte-identical", async () => {
    const pipeline = new TransformationPipeline();
    const full = await pipeline.execute({ input: input(), mapping: patientMapping, importedAt: IMPORTED_AT });

    const paused = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      runId: "run-pause-resume",
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      shouldPause: () => true,
    });

    assert.equal(paused.status, "paused", "pause is not cancel and not completion");
    assert.equal(paused.result, undefined, "a paused run has no final result yet");
    assert.equal(paused.checkpoint.recordIndex, 2, "the in-flight chunk finishes before stopping");
    assert.equal(paused.checkpoint.stage, "mapping");
    assert.equal(paused.checkpoint.inputChecksum, full.inputChecksum);
    assert.deepEqual(paused.outputSoFar, full.output.slice(0, 2), "the kept prefix matches the full run");

    const resumed = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      runId: "run-pause-resume",
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      resumeFrom: paused.checkpoint,
    });

    assert.ok(resumed.result);
    assert.deepEqual(resumed.result.output, full.output);
    assert.deepEqual(resumed.result.rejectedRecords, full.rejectedRecords);
    assert.deepEqual(resumed.result.coverage, full.coverage);
    assert.equal(resumed.result.outputChecksum, full.outputChecksum);
    assert.equal(resumed.checkpoint.stage, "done");
    assert.equal(resumed.checkpoint.recordIndex, 5);
  });

  test("resume refuses a checkpoint bound to different input or timestamp", async () => {
    const pipeline = new TransformationPipeline();
    const paused = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      shouldPause: () => true,
    });

    await assert.rejects(
      () =>
        pipeline.executeChunked({
          input: input(),
          mapping: patientMapping,
          importedAt: IMPORTED_AT,
          resumeFrom: { ...paused.checkpoint, inputChecksum: "sha256:other" },
        }),
      /inputChecksum/,
      "resuming different bytes must fail loudly, not diverge silently",
    );

    await assert.rejects(
      () =>
        pipeline.executeChunked({
          input: input(),
          mapping: patientMapping,
          importedAt: "2025-06-01T00:00:00.000Z",
          resumeFrom: paused.checkpoint,
        }),
      /importedAt/,
      "resuming with a fresh timestamp would rewrite provenance",
    );
  });

  test("cancellation stops at the next chunk boundary and keeps its cursor", async () => {
    const pipeline = new TransformationPipeline();
    const controller = new AbortController();
    const outcome = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      importedAt: IMPORTED_AT,
      chunkSize: 2,
      signal: controller.signal,
      onCheckpoint: (checkpoint) => {
        if (checkpoint.recordIndex >= 2) controller.abort();
      },
    });

    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.checkpoint.recordIndex, 2, "the in-flight chunk finished before stopping");
    assert.deepEqual(outcome.outputSoFar.length, 2);
  });

  test("an already-aborted signal cancels before any work", async () => {
    const pipeline = new TransformationPipeline();
    const controller = new AbortController();
    controller.abort();
    const outcome = await pipeline.executeChunked({
      input: input(),
      mapping: patientMapping,
      importedAt: IMPORTED_AT,
      signal: controller.signal,
    });

    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.checkpoint.recordIndex, 0);
    assert.deepEqual(outcome.outputSoFar, []);
  });

  test("invalid mappings abort identically on both paths", async () => {
    const pipeline = new TransformationPipeline();
    const bad = { ...patientMapping, rules: [{ ...patientMapping.rules[0], transform: "nope" as never }] };
    const full = await pipeline.execute({ input: input(), mapping: bad, importedAt: IMPORTED_AT });
    const chunked = await pipeline.executeChunked({ input: input(), mapping: bad, importedAt: IMPORTED_AT });

    assert.equal(full.status, "failed");
    assert.equal(chunked.status, "failed");
    assert.ok(chunked.result);
    assert.ok(chunked.result.coverage.issues.some((i) => i.code === "MAPPING_UNKNOWN_TRANSFORM"));
    assert.deepEqual(
      chunked.result.coverage.issues.map((i) => i.code),
      full.coverage.issues.map((i) => i.code),
    );
  });

  test("the default execute() path stays deterministic (untouched by the chunked path)", async () => {
    const pipeline = new TransformationPipeline();
    const first = await pipeline.execute({ input: input(), mapping: patientMapping, importedAt: IMPORTED_AT });
    const second = await pipeline.execute({ input: input(), mapping: patientMapping, importedAt: IMPORTED_AT });

    assert.deepEqual(first.output, second.output);
    assert.deepEqual(first.coverage, second.coverage);
    assert.equal(first.inputChecksum, second.inputChecksum);
    assert.equal(first.outputChecksum, second.outputChecksum);
  });

  test("cross-record mappings stay identical on the chunked path", async () => {
    const pipeline = new TransformationPipeline();
    const linked: MappingDefinition = {
      id: "lab-report-link",
      name: "Observations plus linking DiagnosticReport",
      version: "1.0.0",
      sourceFormat: "csv",
      targetFormat: "fhir-r4",
      targetResourceType: "Observation",
      allowCrossRecordContext: true,
      rules: [
        {
          id: "r0",
          sourcePath: "__constant",
          targetPath: "resourceType",
          transform: "default_value",
          defaultValue: "Observation",
        },
        { id: "r1", sourcePath: "lab_id", targetPath: "id", transform: "identity" },
        {
          id: "r3",
          sourcePath: "loinc",
          targetPath: "code",
          transform: "codeable_concept",
          params: { system: "http://loinc.org" },
        },
      ],
    };
    const labs = ["lab_id,loinc", "O1,2339-0", "O2,1234-5", "O3,2339-0"].join("\n");
    const labInput = () => ({ id: "labs", filename: "labs.csv", contentString: labs });

    const full = await pipeline.execute({ input: labInput(), mapping: linked, importedAt: IMPORTED_AT });
    const chunked = await pipeline.executeChunked({
      input: labInput(),
      mapping: linked,
      importedAt: IMPORTED_AT,
      chunkSize: 2,
    });

    assert.ok(chunked.result);
    assert.deepEqual(chunked.result.output, full.output);
    assert.equal(chunked.result.outputChecksum, full.outputChecksum);
  });
});
