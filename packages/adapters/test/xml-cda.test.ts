import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAdapterConformance, assertSafeXml, UnsafeXmlError } from "@healthbridge/adapters";
import { XmlCdaFormatAdapter } from "../src/xml-cda.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const CDA_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  '  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>',
  '  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>',
  '  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>',
  '  <id root="2.16.840.1.113883.19.5.99999.1" extension="12345"/>',
  '  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>',
  "  <title>Good Health Clinic Consultation Note</title>",
  '  <effectiveTime value="20240105120000-0500"/>',
  "  <recordTarget>",
  "    <patientRole>",
  '      <id root="2.16.840.1.113883.19.5" extension="MRN-001"/>',
  "    </patientRole>",
  "  </recordTarget>",
  "  <author>",
  "    <assignedAuthor>",
  '      <id root="2.16.840.1.113883.19.5" extension="AUTH-7"/>',
  "      <representedOrganization>",
  "        <name>Good Health Clinic</name>",
  "      </representedOrganization>",
  "    </assignedAuthor>",
  "  </author>",
  "  <component>",
  "    <structuredBody>",
  "      <component>",
  "        <section>",
  '          <code code="48765-2" codeSystem="2.16.840.1.113883.6.1" displayName="Allergies"/>',
  "          <title>Allergies</title>",
  "          <text>No known allergies.</text>",
  "        </section>",
  "      </component>",
  "      <component>",
  "        <section>",
  '          <code code="10160-0" codeSystem="2.16.840.1.113883.6.1" displayName="Medications"/>',
  "          <title>Medications</title>",
  "          <text>Aspirin 81mg daily.</text>",
  "        </section>",
  "      </component>",
  "    </structuredBody>",
  "  </component>",
  "</ClinicalDocument>",
].join("\n");

const GENERIC_XML_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<labReport lab="central">',
  "  <patient id=\"P-1\">",
  "    <name>Doe</name>",
  "  </patient>",
  '  <result code="GLU" value="5.4"/>',
  '  <result code="HB" value="13.2"/>',
  "</labReport>",
].join("\n");

const XXE_DOCTYPE = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>`;
const ENTITY_PAYLOAD = `<root><!ENTITY lol "x"></root>`;

const KIT_CSV = "patient_id,first_name\nP1,Jane\n";
const KIT_JSON = JSON.stringify([{ patient_id: "P1", first_name: "Jane" }]);
const KIT_FHIR = JSON.stringify({ resourceType: "Patient", id: "kit-p1" });

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

describe("XML/CDA adapter", () => {
  const adapter = new XmlCdaFormatAdapter();

  test("manifest is honestly metadata-only with explicit limitations", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.ok(manifest.extensions.includes(".xml"));
    assert.ok(manifest.extensions.includes(".cda"));
    const limitations = (manifest.limitations ?? []).join(" ").toLowerCase();
    assert.ok(limitations.includes("no clinical interpretation"));
    assert.ok(limitations.includes("nlp") || limitations.includes("no clinical nlp"));
    assert.ok(limitations.includes("schema"));
  });

  test("XXE guard runs before any parsing (DOCTYPE/ENTITY refused)", async () => {
    assert.throws(() => assertSafeXml(XXE_DOCTYPE), UnsafeXmlError);
    assert.throws(() => assertSafeXml(ENTITY_PAYLOAD), UnsafeXmlError);
    await assert.rejects(adapter.inspect({ id: "x-1", filename: "evil.xml", contentString: XXE_DOCTYPE }), UnsafeXmlError);
    await assert.rejects(
      adapter.inspect({ id: "x-2", filename: "evil.xml", contentString: ENTITY_PAYLOAD }),
      UnsafeXmlError,
    );
    await assert.rejects(
      (async () => {
        for await (const _ of adapter.parse(
          { id: "x-3", filename: "evil.xml", contentString: XXE_DOCTYPE },
          contextFor(adapter),
        )) {
          // refused before any envelope is produced
        }
      })(),
      UnsafeXmlError,
    );
    await assert.rejects(
      (async () => {
        for await (const _ of adapter.parse(
          { id: "x-4", filename: "evil.cda", contentString: ENTITY_PAYLOAD },
          contextFor(adapter),
        )) {
          // refused before any envelope is produced
        }
      })(),
      UnsafeXmlError,
    );
  });

  test("detect refuses unsafe payloads instead of throwing", async () => {
    assert.equal(await adapter.detect({ id: "x-5", filename: "evil.xml", contentString: XXE_DOCTYPE }), false);
    assert.equal(await adapter.detect({ id: "x-6", filename: "evil.cda", contentString: ENTITY_PAYLOAD }), false);
  });

  test("detects XML/CDA by extension and content sniffing", async () => {
    assert.equal(await adapter.detect({ id: "x-7", filename: "note.xml", contentString: GENERIC_XML_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "x-8", filename: "summary.cda", contentString: CDA_SAMPLE }), true);
    assert.equal(
      await adapter.detect({ id: "x-9", filename: "unknown.bin", contentString: GENERIC_XML_SAMPLE }),
      true,
    );
  });

  test("does not claim CSV, JSON or FHIR payloads", async () => {
    assert.equal(await adapter.detect({ id: "x-10", filename: "data.csv", contentString: KIT_CSV }), false);
    assert.equal(await adapter.detect({ id: "x-11", filename: "data.json", contentString: KIT_JSON }), false);
    assert.equal(await adapter.detect({ id: "x-12", filename: "patient.fhir.json", contentString: KIT_FHIR }), false);
    assert.equal(await adapter.detect({ id: "x-13", filename: "note.txt", contentString: "plain prose" }), false);
  });

  test("inspects CDA header metadata structurally", async () => {
    const inspection = await adapter.inspect({ id: "x-14", filename: "summary.cda", contentString: CDA_SAMPLE });
    assert.equal(inspection.format, "xml-cda");
    assert.equal(inspection.formatVersion, "cda");
    assert.equal(inspection.domain, "clinical");
    assert.equal(inspection.recordCount, 2);
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.detectedSchema?.fields.some((f) => f.name === "section"));
    assert.ok(inspection.warnings?.some((w) => w.includes("Document type: cda")));
    assert.ok(inspection.warnings?.some((w) => w.includes("templateIds")));
    assert.ok(inspection.warnings?.some((w) => w.includes("Sections: 2")));
  });

  test("inspects generic XML with element/attribute counts and depth", async () => {
    const inspection = await adapter.inspect({
      id: "x-15",
      filename: "lab.xml",
      contentString: GENERIC_XML_SAMPLE,
    });
    assert.equal(inspection.formatVersion, "xml-1.0");
    assert.equal(inspection.recordCount, 1);
    assert.ok(inspection.warnings?.some((w) => w.includes("Elements: 5")));
    assert.ok(inspection.warnings?.some((w) => w.includes("attributes: 6")));
    assert.ok(inspection.warnings?.some((w) => w.includes("max depth: 3")));
    assert.ok(inspection.warnings?.some((w) => w.includes("Encoding: UTF-8")));
  });

  test("parses one envelope per CDA section with checksum and provenance", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "x-16", filename: "summary.cda", contentString: CDA_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(issues.length, 0);
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0].domain, "clinical");
    assert.equal(envelopes[0].source.formatVersion, "cda");
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.sourceLocation, "section 1");
    assert.equal(envelopes[1].provenance.sourceLocation, "section 2");
    assert.equal(envelopes[0].provenance.recordIndex, 0);

    const first = structuredData(envelopes[0]);
    assert.equal(first.title, "Allergies");
    assert.equal(first.code, "48765-2");
    assert.equal(first.textPreview, "Allergies No known allergies.");
    assert.equal(envelopes[1].metadata.sectionCount, 2);
    assert.deepEqual(envelopes[0].metadata.templateIds, [
      "2.16.840.1.113883.10.20.22.1.1",
      "2.16.840.1.113883.10.20.22.1.2",
    ]);
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("pathogenic"));
    assert.ok(!serialised.includes("triage"));
  });

  test("parses generic XML as a single document envelope", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "x-17", filename: "lab.xml", contentString: GENERIC_XML_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].provenance.sourceLocation, "root");
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    const data = structuredData(envelopes[0]);
    assert.equal(data.documentType, "generic-xml");
    assert.equal(data.rootElement, "labReport");
    assert.equal(data.elementCount, 5);
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
