import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OmopFormatAdapter, identifyOmopTable, isConceptColumn } from "../src/omop.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const PERSON_CSV = [
  "person_id,gender_concept_id,year_of_birth,race_concept_id,ethnicity_concept_id",
  "1,8532,1975,8527,38003564",
  "2,8507,1980,0,0",
  ",8507,1990,8527,38003564",
].join("\n");

const MEASUREMENT_CSV = [
  "measurement_id,person_id,measurement_concept_id,measurement_date,value_as_number,unit_concept_id",
  "100,1,3025315,2024-01-15,5.6,8753",
  "101,1,0,2024-02-01,,0",
].join("\n");

const SPECIMEN_CSV = ["specimen_id,person_id,specimen_concept_id,specimen_date", "500,2,1000001,2024-03-01"].join("\n");

const OBSERVATION_CSV = [
  "observation_id,person_id,observation_concept_id,observation_date",
  "700,1,1000002,2024-04-01",
].join("\n");

const CONDITION_CSV = [
  "condition_occurrence_id,person_id,condition_concept_id,condition_start_date",
  "900,2,1000003,2024-05-01",
].join("\n");

function contextFor(adapter: MedicalFormatAdapter, options?: Record<string, unknown>): ParseContext {
  return { adapterId: adapter.id, adapterVersion: adapter.version, importedAt: "2024-01-01T00:00:00.000Z", options };
}

async function collect(
  adapter: MedicalFormatAdapter,
  input: InputDescriptor,
  context: ParseContext,
): Promise<{ envelopes: MedicalDataEnvelope[]; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const envelopes: MedicalDataEnvelope[] = [];
  for await (const envelope of adapter.parse(input, { ...context, onIssue: (issue) => issues.push(issue) })) {
    envelopes.push(envelope);
  }
  return { envelopes, issues };
}

function structuredData(envelope: MedicalDataEnvelope): Record<string, unknown> {
  assert.equal(envelope.content.kind, "structured");
  if (envelope.content.kind !== "structured") throw new Error("unreachable");
  return envelope.content.data as Record<string, unknown>;
}

describe("OMOP CDM staging-subset adapter", () => {
  const adapter = new OmopFormatAdapter();

  test("manifest is honestly metadata-only with staging-subset limitations", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.format, "omop");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    const limitations = (manifest.limitations ?? []).join(" ");
    assert.ok(limitations.includes("staging subset") || limitations.includes("Staging subset"));
    assert.ok(limitations.includes("No OHDSI validation") || limitations.includes("no OHDSI validation"));
    assert.ok(limitations.includes("verbatim"));
    assert.ok(limitations.includes("no clinical interpretation") || limitations.includes("No clinical interpretation"));
  });

  test("identifies OMOP tables by headers, never by generic person_id alone", () => {
    assert.equal(identifyOmopTable(["person_id", "gender_concept_id", "year_of_birth"]), "person");
    assert.equal(identifyOmopTable(["measurement_id", "person_id", "measurement_concept_id"]), "measurement");
    assert.equal(identifyOmopTable(["specimen_id", "person_id", "specimen_concept_id"]), "specimen");
    assert.equal(identifyOmopTable(["observation_id", "person_id", "observation_concept_id"]), "observation");
    assert.equal(
      identifyOmopTable(["condition_occurrence_id", "person_id", "condition_concept_id"]),
      "condition_occurrence",
    );
    assert.equal(identifyOmopTable(["patient_id", "first_name"]), undefined);
    assert.equal(identifyOmopTable(["person_id", "full_name"]), undefined);
    assert.equal(isConceptColumn("measurement_concept_id"), true);
    assert.equal(isConceptColumn("measurement_id"), false);
  });

  test("detects OMOP extracts by filename and headers, rejects other content", async () => {
    assert.equal(await adapter.detect({ id: "o-1", filename: "person.csv", contentString: PERSON_CSV }), true);
    assert.equal(
      await adapter.detect({ id: "o-2", filename: "measurement.csv", contentString: MEASUREMENT_CSV }),
      true,
    );
    assert.equal(await adapter.detect({ id: "o-3", filename: "specimen.csv", contentString: SPECIMEN_CSV }), true);
    assert.equal(await adapter.detect({ id: "o-4", filename: "extract.csv", contentString: MEASUREMENT_CSV }), true);
    assert.equal(
      await adapter.detect({ id: "o-5", filename: "observation.csv", contentString: OBSERVATION_CSV }),
      true,
    );
    assert.equal(
      await adapter.detect({ id: "o-6", filename: "condition_occurrence.csv", contentString: CONDITION_CSV }),
      true,
    );
    assert.equal(
      await adapter.detect({ id: "o-7", filename: "kit.csv", contentString: "patient_id,first_name\nP1,Jane\n" }),
      false,
    );
    assert.equal(await adapter.detect({ id: "o-8", filename: "note.txt", contentString: "plain prose" }), false);
    assert.equal(
      await adapter.detect({ id: "o-9", filename: "people.csv", contentString: "person_id,full_name\n1,Jane\n" }),
      false,
    );
  });

  test("detect never throws on empty or binary-adjacent input", async () => {
    assert.equal(await adapter.detect({ id: "o-10", filename: "person.csv" }), true);
    assert.equal(await adapter.detect({ id: "o-11", filename: "mystery.csv" }), false);
    assert.equal(await adapter.detect({ id: "o-12", filename: "person.csv", contentString: "" }), true);
  });

  test("parses one envelope per person row with checksum and provenance", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "o-20", filename: "person.csv", contentString: PERSON_CSV },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0].domain, "research");
    assert.equal(envelopes[0].id, "omop-person-1");
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.sourceLocation, "line 2");
    assert.equal(envelopes[1].provenance.sourceLocation, "line 3");
    assert.equal(envelopes[0].metadata.omopTable, "person");
    assert.equal(envelopes[0].metadata.personId, "1");
    assert.deepEqual(structuredData(envelopes[0]).person_id, "1");
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("OMOP_MISSING_REQUIRED_FIELD"));
  });

  test("carries concept_ids verbatim with an UNMAPPED_CONCEPT warning channel", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "o-21", filename: "measurement.csv", contentString: MEASUREMENT_CSV },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 2);
    assert.equal(structuredData(envelopes[0]).measurement_concept_id, "3025315");
    assert.equal(typeof structuredData(envelopes[0]).measurement_concept_id, "string");
    assert.deepEqual(envelopes[0].metadata.conceptIds, { measurement_concept_id: "3025315", unit_concept_id: "8753" });
    const unmapped = issues.filter((i) => i.code === "OMOP_UNMAPPED_CONCEPT");
    assert.ok(unmapped.length >= 2);
    assert.ok(unmapped.every((i) => i.severity === "warning"));
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("diagnos"));
    assert.ok(!serialised.includes("patholog"));
    assert.ok(!serialised.includes("treatment"));
    assert.ok(!serialised.includes("benign"));
  });

  test("maps specimen rows to the biobanking domain", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "o-22", filename: "specimen.csv", contentString: SPECIMEN_CSV },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].domain, "biobanking");
    assert.equal(envelopes[0].id, "omop-specimen-500");
    assert.ok(issues.some((i) => i.code === "OMOP_UNMAPPED_CONCEPT"));
  });

  test("tolerates observation and condition_occurrence structurally", async () => {
    const obs = await collect(
      adapter,
      { id: "o-23", filename: "observation.csv", contentString: OBSERVATION_CSV },
      contextFor(adapter),
    );
    assert.equal(obs.envelopes.length, 1);
    assert.equal(obs.envelopes[0].domain, "research");
    assert.equal(obs.envelopes[0].metadata.omopTable, "observation");

    const cond = await collect(
      adapter,
      { id: "o-24", filename: "condition_occurrence.csv", contentString: CONDITION_CSV },
      contextFor(adapter),
    );
    assert.equal(cond.envelopes.length, 1);
    assert.equal(cond.envelopes[0].metadata.omopTable, "condition_occurrence");
  });

  test("reports malformed rows via onIssue and never swallows them", async () => {
    const ragged = await collect(
      adapter,
      {
        id: "o-25",
        filename: "measurement.csv",
        contentString: ["measurement_id,person_id,measurement_concept_id", "100,1,3025315,EXTRA", ",,"].join("\n"),
      },
      contextFor(adapter),
    );
    assert.equal(ragged.envelopes.length, 1);
    const codes = ragged.issues.map((i) => i.code);
    assert.ok(codes.includes("OMOP_RAGGED_ROW"));
    assert.ok(codes.includes("OMOP_MISSING_REQUIRED_FIELD"));
    assert.deepEqual(ragged.envelopes[0].unmappedFields, { __extra: ["EXTRA"] });

    const empty = await collect(
      adapter,
      { id: "o-26", filename: "measurement.csv", contentString: "   \n" },
      contextFor(adapter),
    );
    assert.equal(empty.envelopes.length, 0);
    assert.ok(empty.issues.some((i) => i.code === "OMOP_EMPTY_INPUT"));

    const foreign = await collect(
      adapter,
      { id: "o-27", filename: "labs.csv", contentString: "patient_id,result\nP1,5.6\n" },
      contextFor(adapter),
    );
    assert.equal(foreign.envelopes.length, 0);
    assert.ok(foreign.issues.some((i) => i.code === "OMOP_UNRECOGNIZED_TABLE"));
  });

  test("inspection reports table, row counts and schema", async () => {
    const inspection = await adapter.inspect({
      id: "o-30",
      filename: "measurement.csv",
      contentString: MEASUREMENT_CSV,
    });
    assert.equal(inspection.format, "omop");
    assert.equal(inspection.formatVersion, "measurement");
    assert.equal(inspection.domain, "research");
    assert.equal(inspection.recordCount, 2);
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.detectedSchema?.fields.some((f) => f.name === "measurement_concept_id"));
    assert.ok(inspection.warnings?.some((w) => w.includes("rows: 2")));
    assert.ok(inspection.warnings?.some((w) => w.includes("unmapped concepts")));

    const specimen = await adapter.inspect({
      id: "o-31",
      filename: "specimen.csv",
      contentString: SPECIMEN_CSV,
    });
    assert.equal(specimen.domain, "biobanking");
    assert.equal(specimen.recordCount, 1);
  });

  test("honours maxRecords", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "o-32", filename: "person.csv", contentString: PERSON_CSV },
      { ...contextFor(adapter), maxRecords: 1 },
    );
    assert.equal(envelopes.length, 1);
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.ok(health?.details.includes("omop-adapter"));
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
