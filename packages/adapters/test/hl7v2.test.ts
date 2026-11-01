import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DELIMITERS,
  Hl7v2FormatAdapter,
  decodeEscapes,
  normaliseHl7DateTime,
  parseHl7Messages,
  parseMshHeader,
} from "../src/hl7v2.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const ADT_SAMPLE = [
  "MSH|^~\\&|SENDING|SEND_FAC|RECEIVING|REC_FAC|202401151030||ADT^A01^ADT_A01|MSG00001|P|2.5",
  "EVN||202401151030",
  "PID|1||PAT123^^^HOSP^MR~PAT999^^^CLINIC^PI||DOE^JOHN^A^JR^DR||19800115|M|||123 MAIN ST^^SPRINGFIELD^IL^62701^USA||(217)555-0100",
  "PV1|1|I|WARD1^101^A||||DOCTOR^JANE||||||||||||VISIT001",
  "NK1|1|DOE^JANE|SPO",
  "ZPD|custom|site|data",
].join("\r");

const ORU_SAMPLE = [
  "MSH|^~\\&|LAB|LABFAC|EHR|EHRFAC|202401151100||ORU^R01^ORU_R01|MSG00002|P|2.5",
  "PID|1||PAT123^^^HOSP^MR||DOE^JOHN^A^JR^DR||19800115|M",
  "OBR|1|ORD001|FILL001|GLU^Glucose^LN|||202401151030|||||||||DOCTOR^JANE|||||||||F",
  "OBX|1|NM|GLU^Glucose^LN||95|mg/dL|70-100|N|||F|||202401151045",
  "OBX|2|ST|NOTE^Note^LN||Fasting sample||||||F|||202401151045",
  "NTE|1||Sample comment",
].join("\r");

const ESCAPED_ADT = [
  "MSH|^~\\&|S|F|R|RF|202401151030||ADT^A01|MSG00003|P|2.5",
  "PID|1||A\\S\\X^^^HOSP^MR||O\\F\\NEIL^JANE&JANET||19800115|M",
].join("\r");

const CUSTOM_SEPARATORS = [
  "MSH#%!&*#S#F#R#RF#202401151030##ADT%A01#MSG00004#P#2.5",
  "PID#1##PAT1##DOE%JOHN##19800115#M",
].join("\r");

function contextFor(adapter: MedicalFormatAdapter, options?: Record<string, unknown>): ParseContext {
  return { adapterId: adapter.id, adapterVersion: adapter.version, options };
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

describe("HL7 v2 adapter", () => {
  const adapter = new Hl7v2FormatAdapter();

  test("manifest is honestly metadata-only with explicit limitations", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.format, "hl7v2");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.deepEqual(manifest.extensions, [".hl7", ".er7"]);
    assert.ok(manifest.limitations?.some((l) => l.includes("no clinical interpretation")));
    assert.ok(manifest.limitations?.some((l) => l.includes("Z-segments")));
    assert.ok(manifest.limitations?.some((l) => l.includes("2.3")));
  });

  test("detects HL7 v2 by extension and MSH header, rejects other content", async () => {
    assert.equal(await adapter.detect({ id: "h-1", filename: "msg.hl7", contentString: ADT_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "h-2", filename: "msg.er7", contentString: ADT_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "h-3", filename: "msg.txt", contentString: ADT_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "h-4", filename: "note.txt", contentString: "plain prose" }), false);
    assert.equal(await adapter.detect({ id: "h-5", filename: "data.csv", contentString: "a,b\n1,2\n" }), false);
    assert.equal(await adapter.detect({ id: "h-6", filename: "data.json", contentString: '{"a":1}' }), false);
    assert.equal(await adapter.detect({ id: "h-7", filename: "msg.hl7", contentString: "" }), true);
  });

  test("parses the MSH segment: separators, message type and version", () => {
    const { header, issues } = parseMshHeader("MSH|^~\\&|S|F|R|RF|202401151030||ADT^A01^ADT_A01|MSG1|P|2.5", 1);
    assert.deepEqual(issues, []);
    assert.ok(header);
    assert.equal(header.fieldSeparator, "|");
    assert.deepEqual(header.delimiters, DEFAULT_DELIMITERS);
    assert.equal(header.messageCode, "ADT");
    assert.equal(header.triggerEvent, "A01");
    assert.equal(header.messageStructure, "ADT_A01");
    assert.equal(header.messageControlId, "MSG1");
    assert.equal(header.version, "2.5");
    assert.equal(header.sendingApplication, "S");
  });

  test("decodes escape sequences per the HL7 table without touching structure", () => {
    assert.equal(decodeEscapes("O\\F\\NEIL"), "O|NEIL");
    assert.equal(decodeEscapes("A\\S\\X"), "A^X");
    assert.equal(decodeEscapes("a\\R\\b"), "a~b");
    assert.equal(decodeEscapes("a\\T\\b"), "a&b");
    assert.equal(decodeEscapes("a\\E\\b"), "a\\b");
    assert.equal(decodeEscapes("a\\.br\\b"), "a\nb");
    assert.equal(decodeEscapes("\\X48\\\\X49\\"), "HI");
    assert.equal(decodeEscapes("keep\\Q\\verbatim"), "keep\\Q\\verbatim");
    assert.equal(decodeEscapes("trailing\\"), "trailing\\");
  });

  test("normalises HL7 datetimes structurally and refuses garbage", () => {
    assert.equal(normaliseHl7DateTime("19800115"), "1980-01-15");
    assert.equal(normaliseHl7DateTime("202401151030"), "2024-01-15T10:30");
    assert.equal(normaliseHl7DateTime("20240115103045"), "2024-01-15T10:30:45");
    assert.equal(normaliseHl7DateTime("202401151030+0500"), "2024-01-15T10:30+05:00");
    assert.equal(normaliseHl7DateTime("not-a-date"), null);
    assert.equal(normaliseHl7DateTime("20241301"), null);
  });

  test("maps ADT^A01 structurally to a Patient-shaped envelope", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-10", filename: "adt.hl7", contentString: ADT_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const envelope = envelopes[0];
    assert.equal(envelope.domain, "administrative");
    assert.equal(envelope.source.format, "hl7v2");
    assert.equal(envelope.source.formatVersion, "2.5");
    assert.match(String(envelope.source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelope.provenance.sourceLocation, "message 1 line 3");
    assert.equal(envelope.metadata.messageControlId, "MSG00001");

    const data = structuredData(envelope);
    assert.equal(data.resourceType, "Patient");
    assert.equal(data.id, "PAT123");
    assert.deepEqual(data.identifier, [
      { value: "PAT123", system: "HOSP", type: "MR" },
      { value: "PAT999", system: "CLINIC", type: "PI" },
    ]);
    assert.deepEqual(data.name, [{ family: "DOE", given: ["JOHN"], middle: "A", suffix: ["JR"], prefix: ["DR"] }]);
    assert.equal(data.birthDate, "1980-01-15");
    assert.equal(data.gender, "male");
    assert.deepEqual(data.address, [
      { line: ["123 MAIN ST"], city: "SPRINGFIELD", state: "IL", postalCode: "62701", country: "USA" },
    ]);
    assert.deepEqual(data.telecom, [{ value: "(217)555-0100" }]);
    assert.deepEqual(envelope.metadata.visit, {
      patientClass: "I",
      location: "WARD1",
      attending: "DOCTOR JANE",
      visitNumber: "VISIT001",
    });

    // No clinical interpretation anywhere in the envelope payload.
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("diagnos"));
    assert.ok(!serialised.includes("patholog"));

    // Unhandled segments (EVN, NK1) and the Z-segment are reported, never swallowed.
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("HL7_UNHANDLED_SEGMENT"));
    assert.ok(codes.includes("HL7_Z_SEGMENT"));
    assert.ok(issues.some((i) => i.code === "HL7_Z_SEGMENT" && i.message.includes("ZPD")));
    assert.deepEqual(envelope.metadata.unhandledSegments, ["EVN", "NK1", "ZPD"]);
    assert.equal(envelope.metadata.hasZSegments, true);
    const preserved = envelope.unmappedFields.unhandledSegments as Array<{ name: string; raw: string }>;
    assert.ok(preserved.some((s) => s.name === "ZPD" && s.raw === "ZPD|custom|site|data"));
    assert.equal(envelope.unmappedFields.pv1, "PV1|1|I|WARD1^101^A||||DOCTOR^JANE||||||||||||VISIT001");
  });

  test("keeps escaped separators as literal data, not structure", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "h-11", filename: "esc.hl7", contentString: ESCAPED_ADT },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const data = structuredData(envelopes[0]);
    // A^X stays ONE identifier: the escaped ^ decoded to a literal, not a field split.
    assert.deepEqual(data.identifier, [{ value: "A^X", system: "HOSP", type: "MR" }]);
    assert.deepEqual(data.name, [{ family: "O|NEIL", given: ["JANE", "JANET"] }]);
  });

  test("honours custom MSH separators and subcomponent splitting", async () => {
    const { header } = parseMshHeader("MSH#%!&*#S#F#202401151030##ADT%A01#MSG00004#P#2.5", 1);
    assert.deepEqual(header?.delimiters, { field: "#", component: "%", repetition: "!", escape: "&", subcomponent: "*" });
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-12", filename: "custom.hl7", contentString: CUSTOM_SEPARATORS },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const data = structuredData(envelopes[0]);
    assert.equal(data.resourceType, "Patient");
    assert.deepEqual(data.name, [{ family: "DOE", given: ["JOHN"] }]);
    assert.ok(!issues.some((i) => i.code === "HL7_INVALID_ENCODING_CHARACTERS"));
  });

  test("maps ORU^R01 structurally to Observation plus DiagnosticReport envelopes", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-13", filename: "oru.hl7", contentString: ORU_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 3);
    assert.ok(envelopes.every((e) => e.domain === "laboratory"));
    assert.ok(envelopes.every((e) => String(e.source.checksum).startsWith("sha256:")));

    const report = envelopes.find((e) => structuredData(e).resourceType === "DiagnosticReport");
    assert.ok(report);
    const reportData = structuredData(report);
    assert.equal(reportData.status, "final");
    assert.equal(reportData.statusRaw, "F");
    assert.deepEqual(reportData.code, { coding: [{ code: "GLU", display: "Glucose", system: "LN" }], text: "Glucose" });
    assert.equal(reportData.effectiveDateTime, "2024-01-15T10:30");
    assert.equal(reportData.placerOrderNumber, "ORD001");
    assert.equal(reportData.fillerOrderNumber, "FILL001");
    assert.deepEqual(reportData.result, [
      { reference: "Observation/hl7-MSG00002-obs-0" },
      { reference: "Observation/hl7-MSG00002-obs-1" },
    ]);

    const observations = envelopes.filter((e) => structuredData(e).resourceType === "Observation");
    assert.equal(observations.length, 2);
    const glucose = structuredData(observations[0]);
    assert.equal(glucose.status, "final");
    assert.deepEqual(glucose.valueQuantity, { value: 95, unit: "mg/dL" });
    assert.deepEqual(glucose.abnormalFlagsRaw, ["N"]);
    assert.equal(glucose.effectiveDateTime, "2024-01-15T10:45");
    const note = structuredData(observations[1]);
    assert.equal(note.valueString, "Fasting sample");

    // Flags are preserved verbatim, never interpreted.
    assert.ok(!JSON.stringify(envelopes).toLowerCase().includes("abnormality"));

    assert.ok(issues.some((i) => i.code === "HL7_UNHANDLED_SEGMENT" && i.message.includes("NTE")));
  });

  test("carries unknown message types as generic envelopes with an explicit issue", async () => {
    const siu = ["MSH|^~\\&|S|F|R|RF|202401151030||SIU^S12|MSG9|P|2.5", "SCH|1|APT1"].join("\r");
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-14", filename: "siu.hl7", contentString: siu },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const data = structuredData(envelopes[0]);
    assert.equal(data.kind, "hl7-message");
    assert.equal(data.messageType, "SIU^S12");
    assert.ok(issues.some((i) => i.code === "HL7_UNSUPPORTED_MESSAGE_TYPE"));
    assert.ok(issues.some((i) => i.code === "HL7_UNHANDLED_SEGMENT" && i.message.includes("SCH")));
  });

  test("warns on versions outside 2.3-2.9 but still parses structurally", async () => {
    const old = ["MSH|^~\\&|S|F|R|RF|202401151030||ADT^A01|MSGV|P|2.2", "PID|1||P1"].join("\r");
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-15", filename: "old.hl7", contentString: old },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(structuredData(envelopes[0]).resourceType, "Patient");
    assert.ok(issues.some((i) => i.code === "HL7_UNSUPPORTED_VERSION"));
  });

  test("reports an unknown administrative sex instead of guessing", async () => {
    const other = ["MSH|^~\\&|S|F|R|RF|202401151030||ADT^A01|MSGX|P|2.5", "PID|1||P1||DOE^JOHN||19800115|X"].join("\r");
    const { envelopes, issues } = await collect(
      adapter,
      { id: "h-16", filename: "sex.hl7", contentString: other },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const data = structuredData(envelopes[0]);
    assert.ok(!("gender" in data));
    assert.equal(envelopes[0].metadata.adminSexRaw, "X");
    assert.ok(issues.some((i) => i.code === "HL7_UNKNOWN_ADMIN_SEX"));
  });

  test("handles empty input and missing MSH without throwing", async () => {
    const empty = await collect(adapter, { id: "h-17", filename: "empty.hl7", contentString: "" }, contextFor(adapter));
    assert.equal(empty.envelopes.length, 0);
    assert.ok(empty.issues.some((i) => i.code === "HL7_EMPTY_INPUT"));

    const noMsh = await collect(
      adapter,
      { id: "h-18", filename: "nomsh.hl7", contentString: "PID|1||P1" },
      contextFor(adapter),
    );
    assert.equal(noMsh.envelopes.length, 0);
    assert.ok(noMsh.issues.some((i) => i.code === "HL7_MISSING_MSH"));

    // Multiple messages in one file each yield envelopes.
    const batch = await collect(
      adapter,
      { id: "h-19", filename: "batch.hl7", contentString: `${ADT_SAMPLE}\r\n${ORU_SAMPLE}` },
      contextFor(adapter),
    );
    assert.equal(batch.envelopes.length, 4);
  });

  test("parseHl7Messages splits repetitions, components and subcomponents", () => {
    const { messages } = parseHl7Messages(ADT_SAMPLE);
    assert.equal(messages.length, 1);
    const pid = messages[0].segments.find((s) => s.name === "PID");
    assert.ok(pid);
    assert.equal(pid.fields[2]?.length, 2);
    assert.deepEqual(messages[0].segmentCounts, { MSH: 1, EVN: 1, PID: 1, PV1: 1, NK1: 1, ZPD: 1 });
  });

  test("inspection reports schema, counts and unmapped segments", async () => {
    const inspection = await adapter.inspect({ id: "h-20", filename: "adt.hl7", contentString: ADT_SAMPLE });
    assert.equal(inspection.format, "hl7v2");
    assert.equal(inspection.formatVersion, "2.5");
    assert.equal(inspection.domain, "administrative");
    assert.equal(inspection.recordCount, 1);
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.detectedSchema?.fields.some((f) => f.name === "resourceType"));
    assert.ok(inspection.warnings?.some((w) => w.includes("ADT^A01: 1")));
    assert.ok(inspection.warnings?.some((w) => w.includes("ZPD")));

    const oruInspection = await adapter.inspect({ id: "h-21", filename: "oru.hl7", contentString: ORU_SAMPLE });
    assert.equal(oruInspection.domain, "laboratory");
    assert.equal(oruInspection.recordCount, 3);
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
