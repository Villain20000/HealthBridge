import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCanonicalEnvelope } from "@healthbridge/core";
import type { MedicalDataEnvelope, ValidationIssue } from "@healthbridge/shared-types";
import type { MappingDefinition } from "@healthbridge/mapping-engine";
import type { TerminologyProvider } from "@healthbridge/validation";
import { TransformationPipeline } from "@healthbridge/transformation-engine";

const IMPORTED_AT = "2024-01-01T00:00:00.000Z";

const patientMapping: MappingDefinition = {
  id: "patient-csv-to-fhir",
  name: "CSV Patient to FHIR R4 Patient",
  version: "1.1.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  rules: [
    { id: "r0", sourcePath: "__constant", targetPath: "resourceType", transform: "default_value", defaultValue: "Patient" },
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
    { id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" },
    { id: "r3", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" },
  ],
};

const patientRows: Array<Record<string, unknown>> = [
  { patient_id: "P101", first_name: "Jane", gender: "F", ssn: "999-12-3456" },
  { patient_id: "P102", first_name: "John", gender: "M", ssn: "999-65-4321" },
  { patient_id: "", first_name: "Nope", gender: "X", ssn: "999-88-7766" },
];

function envelopeFor(index: number, data: Record<string, unknown>): MedicalDataEnvelope {
  return createCanonicalEnvelope({
    id: `csv-rec-${index}`,
    domain: "clinical",
    sourceFormat: "csv",
    formatVersion: "RFC4180",
    content: { kind: "structured", data },
    importedAt: IMPORTED_AT,
    adapterId: "csv-adapter",
    adapterVersion: "1.1.0",
    recordIndex: index,
    sourceLocation: `line ${index + 2}`,
    filename: "patients.csv",
    checksum: "sha256:fixture",
    encoding: "utf-8",
    metadata: { delimiter: ",", columns: 4, lineNumber: index + 2 },
  });
}

async function* envelopesOf(rows: Array<Record<string, unknown>>): AsyncGenerator<MedicalDataEnvelope> {
  for (let index = 0; index < rows.length; index++) {
    yield envelopeFor(index, rows[index]);
  }
}

/** Synthetic test-only terminology: no clinical claim, never bundled. */
const demoTerminology: TerminologyProvider = {
  name: "synthetic-demo-terminology",
  licence: "synthetic-test-only — never bundled",
  validateCode: ({ code, path }) => {
    if (code === "2339-0") return { valid: true, issues: [] };
    const issue: ValidationIssue = {
      code: "UNKNOWN_CODE",
      severity: "warning",
      message: `Code '${code}' is unknown to the synthetic demo table`,
      path,
    };
    return { valid: false, issues: [issue] };
  },
};

const labMapping: MappingDefinition = {
  id: "lab-to-observation",
  name: "Lab CSV to FHIR R4 Observation",
  version: "1.0.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Observation",
  rules: [
    { id: "r0", sourcePath: "__constant", targetPath: "resourceType", transform: "default_value", defaultValue: "Observation" },
    { id: "r1", sourcePath: "lab_id", targetPath: "id", transform: "identity", required: true },
    { id: "r2", sourcePath: "status", targetPath: "status", transform: "default_value", defaultValue: "final" },
    {
      id: "r3",
      sourcePath: "loinc",
      targetPath: "code",
      transform: "codeable_concept",
      params: { system: "http://loinc.org" },
    },
  ],
};

describe("executeEnvelopes streaming", () => {
  test("matches execute() on output, coverage, data-loss and checksums", async () => {
    const pipeline = new TransformationPipeline();
    const csv = [
      "patient_id,first_name,gender,ssn",
      "P101,Jane,F,999-12-3456",
      "P102,John,M,999-65-4321",
      ",Nope,X,999-88-7766",
    ].join("\n");

    const buffered = await pipeline.execute({
      input: { id: "in", filename: "patients.csv", contentString: csv },
      mapping: patientMapping,
      adapterId: "csv-adapter",
      runId: "run-parity",
      importedAt: IMPORTED_AT,
    });
    assert.equal(buffered.recordsProcessed, 3);

    const streamed = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(patientRows),
      mapping: patientMapping,
      adapterId: "csv-adapter",
      adapterVersion: "1.1.0",
      sourceFormat: "csv",
      inputChecksum: buffered.inputChecksum,
      runId: "run-parity",
      importedAt: IMPORTED_AT,
    });

    assert.deepEqual(streamed.output, buffered.output);
    assert.deepEqual(streamed.coverage, buffered.coverage);
    assert.deepEqual(streamed.rejectedRecords, buffered.rejectedRecords);
    assert.deepEqual(streamed.dataLoss, buffered.dataLoss);
    assert.deepEqual(streamed.validation, buffered.validation);
    assert.equal(streamed.status, buffered.status);
    assert.equal(streamed.inputChecksum, buffered.inputChecksum);
  });

  test("emits batches that reassemble the full output in order", async () => {
    const pipeline = new TransformationPipeline();
    const seen: Array<{ batchIndex: number; recordIndexes: number[]; resources: unknown[] }> = [];
    const result = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(patientRows),
      mapping: patientMapping,
      adapterId: "csv-adapter",
      adapterVersion: "1.1.0",
      sourceFormat: "csv",
      importedAt: IMPORTED_AT,
      batchSize: 1,
      onBatch: (batch) => {
        seen.push(batch);
      },
    });
    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((b) => b.batchIndex),
      [0, 1, 2],
    );
    assert.deepEqual(
      seen.flatMap((b) => b.resources),
      result.output,
    );
    assert.deepEqual(
      seen.flatMap((b) => b.recordIndexes),
      [0, 1, 2],
    );
  });

  test("honours maxRecords by stopping consumption early", async () => {
    const pipeline = new TransformationPipeline();
    let consumed = 0;
    async function* counting(): AsyncGenerator<MedicalDataEnvelope> {
      for (let index = 0; index < patientRows.length; index++) {
        consumed++;
        yield envelopeFor(index, patientRows[index]);
      }
    }
    const result = await pipeline.executeEnvelopes({
      envelopes: counting(),
      mapping: patientMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
      maxRecords: 2,
    });
    assert.equal(result.recordsProcessed, 2);
    assert.equal(consumed, 2);
  });

  test("an invalid mapping aborts before consuming envelopes", async () => {
    const pipeline = new TransformationPipeline();
    let consumed = 0;
    async function* counting(): AsyncGenerator<MedicalDataEnvelope> {
      consumed++;
      yield envelopeFor(0, patientRows[0]);
    }
    const result = await pipeline.executeEnvelopes({
      envelopes: counting(),
      mapping: { ...patientMapping, rules: [{ ...patientMapping.rules[0], transform: "nope" as never }] },
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
    });
    assert.equal(result.status, "failed");
    assert.equal(consumed, 0);
    assert.ok(result.coverage.issues.some((i) => i.code === "MAPPING_UNKNOWN_TRANSFORM"));
  });

  test("is deterministic for a fixed import timestamp", async () => {
    const pipeline = new TransformationPipeline();
    const run = () =>
      pipeline.executeEnvelopes({
        envelopes: envelopesOf(patientRows),
        mapping: patientMapping,
        adapterId: "csv-adapter",
        importedAt: IMPORTED_AT,
      });
    const a = await run();
    const b = await run();
    assert.deepEqual(a.output, b.output);
    assert.equal(a.outputChecksum, b.outputChecksum);
  });
});

describe("terminology threading end-to-end", () => {
  test("level 5 reports executed with the provider name when supplied", async () => {
    const pipeline = new TransformationPipeline();
    const rows = [{ lab_id: "L1", loinc: "2339-0" }];
    const result = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(rows),
      mapping: labMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
      terminology: demoTerminology,
    });
    const level5 = result.validation.levels.find((l) => l.level === 5);
    assert.equal(level5?.status, "executed");
    assert.equal(level5?.validator, "synthetic-demo-terminology");
    assert.equal(result.validation.isValid, true);
  });

  test("terminology issues surface on the run when codes are unknown", async () => {
    const pipeline = new TransformationPipeline();
    const rows = [{ lab_id: "L1", loinc: "99999-9" }];
    const result = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(rows),
      mapping: labMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
      terminology: demoTerminology,
    });
    assert.ok(result.validation.issues.some((i) => i.code === "UNKNOWN_CODE"));
    assert.equal(result.validation.levels.find((l) => l.level === 5)?.status, "executed");
  });

  test("without a provider level 5 stays skipped on the buffered path too", async () => {
    const pipeline = new TransformationPipeline();
    const result = await pipeline.execute({
      input: { id: "in", filename: "p.csv", contentString: "patient_id\nP1" },
      mapping: patientMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
    });
    assert.equal(result.validation.levels.find((l) => l.level === 5)?.status, "skipped");
  });
});

describe("cross-record DiagnosticReport linking", () => {
  const labCsv = ["lab_id,report_id,loinc,kind", "O1,,2339-0,obs", "O2,,1234-5,obs", ",DR1,1234-5,report"].join("\n");
  const reportRows: Array<Record<string, unknown>> = [
    { lab_id: "O1", report_id: "", loinc: "2339-0", kind: "obs" },
    { lab_id: "O2", report_id: "", loinc: "1234-5", kind: "obs" },
    { lab_id: "", report_id: "DR1", loinc: "1234-5", kind: "report" },
  ];

  const linkedMapping: MappingDefinition = {
    id: "lab-report-link",
    name: "Observations plus linking DiagnosticReport",
    version: "1.0.0",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    targetResourceType: "Observation",
    allowCrossRecordContext: true,
    rules: [
      { id: "r0", sourcePath: "__constant", targetPath: "resourceType", transform: "default_value", defaultValue: "Observation" },
      { id: "r1", sourcePath: "lab_id", targetPath: "id", transform: "identity" },
      {
        id: "r2",
        sourcePath: "__output.1.id",
        targetPath: "result.0",
        transform: "to_reference",
        params: { type: "Observation" },
        when: [{ path: "kind", op: "equals", value: "report" }],
      },
      {
        id: "r3",
        sourcePath: "loinc",
        targetPath: "code",
        transform: "codeable_concept",
        params: { system: "http://loinc.org" },
      },
    ],
  };

  test("a report links the produced Observation id when the flag is set", async () => {
    const pipeline = new TransformationPipeline();
    const streamed = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(reportRows),
      mapping: linkedMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
    });
    assert.equal(streamed.recordsFailed, 0);
    assert.equal(streamed.output.length, 3);
    const report = streamed.output[2] as Record<string, unknown>;
    assert.deepEqual(report["result"], [{ reference: "Observation/O2" }]);

    const buffered = await pipeline.execute({
      input: { id: "in", filename: "labs.csv", contentString: labCsv },
      mapping: linkedMapping,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
    });
    assert.deepEqual(buffered.output, streamed.output);
  });

  test("the same rows stay unlinked without cross-record context", async () => {
    const pipeline = new TransformationPipeline();
    const plain: MappingDefinition = {
      ...linkedMapping,
      allowCrossRecordContext: undefined,
      rules: linkedMapping.rules.filter((r) => r.id !== "r2"),
    };
    const result = await pipeline.executeEnvelopes({
      envelopes: envelopesOf(reportRows),
      mapping: plain,
      adapterId: "csv-adapter",
      importedAt: IMPORTED_AT,
    });
    assert.equal(result.recordsFailed, 0);
    assert.equal(result.output.length, 3);
    const report = result.output[2] as Record<string, unknown>;
    assert.equal(report["result"], undefined);
  });
});
