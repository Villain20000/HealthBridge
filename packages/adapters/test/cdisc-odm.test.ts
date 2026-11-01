import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAdapterConformance, assertSafeXml, UnsafeXmlError } from "@healthbridge/adapters";
import { CdiscOdmFormatAdapter } from "../src/cdisc-odm.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

const LONG_VALUE = `Sitting blood pressure recheck after five minutes of rest in a quiet room, repeated twice ${"x".repeat(300)}`;

const ODM_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" FileType="Snapshot" FileOID="FILE-001" CreationDateTime="2024-01-05T10:00:00" ODMVersion="1.3.1">',
  '  <Study OID="STU-001">',
  "    <GlobalVariables>",
  "      <StudyName>Vitals Registry</StudyName>",
  "      <StudyDescription>Observational vitals collection</StudyDescription>",
  "      <ProtocolName>VIT-2024</ProtocolName>",
  "    </GlobalVariables>",
  '    <MetaDataVersion OID="MDV-001" Name="Baseline">',
  '      <StudyEventDef OID="SE-BASE" Name="Baseline Visit" Type="Scheduled">',
  '        <FormRef FormOID="F-VITALS" Mandatory="Yes"/>',
  "      </StudyEventDef>",
  '      <FormDef OID="F-VITALS" Name="Vitals">',
  '        <ItemGroupRef ItemGroupOID="IG-VITALS" Mandatory="Yes"/>',
  "      </FormDef>",
  '      <ItemGroupDef OID="IG-VITALS" Name="Vitals" Domain="VS">',
  '        <ItemRef ItemOID="IT-SYSBP" Mandatory="Yes"/>',
  '        <ItemRef ItemOID="IT-SEX" Mandatory="No"/>',
  "      </ItemGroupDef>",
  '      <ItemDef OID="IT-SYSBP" Name="Systolic BP" DataType="integer">',
  "        <Question><TranslatedText>Systolic blood pressure</TranslatedText></Question>",
  "      </ItemDef>",
  '      <ItemDef OID="IT-SEX" Name="Sex" DataType="text">',
  "        <Question><TranslatedText>Recorded sex</TranslatedText></Question>",
  '        <CodeListRef CodeListOID="CL-SEX"/>',
  "      </ItemDef>",
  '      <CodeList OID="CL-SEX" Name="Sex" DataType="text">',
  '        <CodeListItem CodedValue="F"><Decode><TranslatedText>Female</TranslatedText></Decode></CodeListItem>',
  '        <CodeListItem CodedValue="M"><Decode><TranslatedText>Male</TranslatedText></Decode></CodeListItem>',
  "      </CodeList>",
  "    </MetaDataVersion>",
  "  </Study>",
  '  <ClinicalData StudyOID="STU-001" MetaDataVersionOID="MDV-001">',
  '    <SubjectData SubjectKey="SUBJ-001">',
  '      <StudyEventData StudyEventOID="SE-BASE">',
  '        <FormData FormOID="F-VITALS">',
  '          <ItemGroupData ItemGroupOID="IG-VITALS">',
  '            <ItemData ItemOID="IT-SYSBP" Value="118"/>',
  `            <ItemData ItemOID="IT-SEX" Value="${LONG_VALUE}"/>`,
  "          </ItemGroupData>",
  "        </FormData>",
  "      </StudyEventData>",
  "    </SubjectData>",
  '    <SubjectData SubjectKey="SUBJ-002">',
  '      <StudyEventData StudyEventOID="SE-BASE">',
  '        <FormData FormOID="F-VITALS">',
  '          <ItemGroupData ItemGroupOID="IG-VITALS">',
  '            <ItemData ItemOID="IT-SYSBP" Value="121"/>',
  '            <ItemData ItemOID="IT-SEX" Value="F"/>',
  "          </ItemGroupData>",
  "        </FormData>",
  "      </StudyEventData>",
  "    </SubjectData>",
  "  </ClinicalData>",
  "</ODM>",
].join("\n");

const ODM_METADATA_ONLY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" FileType="Snapshot" FileOID="FILE-002" ODMVersion="1.3.1">',
  '  <Study OID="STU-009">',
  "    <GlobalVariables>",
  "      <StudyName>Empty Registry</StudyName>",
  "    </GlobalVariables>",
  '    <MetaDataVersion OID="MDV-009" Name="Screening">',
  '      <FormDef OID="F-SCR" Name="Screening">',
  '        <ItemGroupRef ItemGroupOID="IG-SCR" Mandatory="Yes"/>',
  "      </FormDef>",
  '      <ItemGroupDef OID="IG-SCR" Name="Screening">',
  '        <ItemRef ItemOID="IT-AGE" Mandatory="Yes"/>',
  "      </ItemGroupDef>",
  '      <ItemDef OID="IT-AGE" Name="Age" DataType="integer"/>',
  "    </MetaDataVersion>",
  "  </Study>",
  "</ODM>",
].join("\n");

const ODM_WITH_AUDIT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" FileType="Snapshot" FileOID="FILE-003" ODMVersion="1.3.1">',
  '  <Study OID="STU-007">',
  '    <MetaDataVersion OID="MDV-007" Name="V1">',
  '      <FormDef OID="F-A" Name="A"/>',
  "    </MetaDataVersion>",
  "  </Study>",
  "  <AuditRecords>",
  '    <AuditRecord ID="A1"><UserRef UserOID="U1"/></AuditRecord>',
  "  </AuditRecords>",
  "  <Annotations>",
  '    <Annotation ID="N1"><Comment>reviewed</Comment></Annotation>',
  "  </Annotations>",
  "</ODM>",
].join("\n");

const GENERIC_XML_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<labReport lab="central">',
  '  <patient id="P-1">',
  "    <name>Doe</name>",
  "  </patient>",
  "</labReport>",
].join("\n");

const CDA_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<ClinicalDocument xmlns="urn:hl7-org:v3">',
  "  <title>Note</title>",
  "</ClinicalDocument>",
].join("\n");

const XXE_DOCTYPE = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ODM xmlns="http://www.cdisc.org/ns/odm/v1.3"><Study OID="S"/></ODM>`;
const ENTITY_PAYLOAD = `<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3"><!ENTITY lol "x"><Study OID="S"/></ODM>`;

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

describe("CDISC ODM adapter", () => {
  const adapter = new CdiscOdmFormatAdapter();

  test("manifest is honestly metadata-only with explicit limitations", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.ok(manifest.extensions.includes(".odm"));
    assert.ok(manifest.extensions.includes(".xml"));
    const limitations = (manifest.limitations ?? []).join(" ").toLowerCase();
    assert.ok(limitations.includes("no sdtm"));
    assert.ok(limitations.includes("no clinical meaning") || limitations.includes("clinical meaning"));
    assert.ok(limitations.includes("nlp") || limitations.includes("no clinical nlp"));
    assert.ok(limitations.includes("schema"));
    assert.ok(limitations.includes("audit"));
  });

  test("XXE guard runs before any parsing (DOCTYPE/ENTITY refused)", async () => {
    assert.throws(() => assertSafeXml(XXE_DOCTYPE), UnsafeXmlError);
    assert.throws(() => assertSafeXml(ENTITY_PAYLOAD), UnsafeXmlError);
    await assert.rejects(adapter.inspect({ id: "o-1", filename: "study.odm", contentString: XXE_DOCTYPE }), UnsafeXmlError);
    await assert.rejects(
      adapter.inspect({ id: "o-2", filename: "study.odm", contentString: ENTITY_PAYLOAD }),
      UnsafeXmlError,
    );
    await assert.rejects(
      (async () => {
        for await (const _ of adapter.parse(
          { id: "o-3", filename: "study.odm", contentString: XXE_DOCTYPE },
          contextFor(adapter),
        )) {
          // refused before any envelope is produced
        }
      })(),
      UnsafeXmlError,
    );
  });

  test("detect refuses unsafe payloads instead of throwing", async () => {
    assert.equal(await adapter.detect({ id: "o-4", filename: "evil.odm", contentString: XXE_DOCTYPE }), false);
    assert.equal(await adapter.detect({ id: "o-5", filename: "evil.odm", contentString: ENTITY_PAYLOAD }), false);
  });

  test("detects ODM by extension and namespace/root sniffing", async () => {
    assert.equal(await adapter.detect({ id: "o-6", filename: "study.odm", contentString: ODM_SAMPLE }), true);
    assert.equal(await adapter.detect({ id: "o-7", filename: "study.xml", contentString: ODM_SAMPLE }), true);
    assert.equal(
      await adapter.detect({ id: "o-8", filename: "study export.bin", contentString: ODM_SAMPLE }),
      true,
    );
  });

  test("never claims non-ODM XML, CSV, JSON or FHIR payloads", async () => {
    assert.equal(await adapter.detect({ id: "o-9", filename: "lab.xml", contentString: GENERIC_XML_SAMPLE }), false);
    assert.equal(await adapter.detect({ id: "o-10", filename: "odd.odm", contentString: GENERIC_XML_SAMPLE }), false);
    assert.equal(await adapter.detect({ id: "o-11", filename: "note.cda", contentString: CDA_SAMPLE }), false);
    assert.equal(await adapter.detect({ id: "o-12", filename: "data.csv", contentString: KIT_CSV }), false);
    assert.equal(await adapter.detect({ id: "o-13", filename: "data.json", contentString: KIT_JSON }), false);
    assert.equal(await adapter.detect({ id: "o-14", filename: "patient.fhir.json", contentString: KIT_FHIR }), false);
    assert.equal(await adapter.detect({ id: "o-15", filename: "note.txt", contentString: "plain prose" }), false);
  });

  test("inspects ODM defs and clinical counts structurally", async () => {
    const inspection = await adapter.inspect({ id: "o-16", filename: "study.odm", contentString: ODM_SAMPLE });
    assert.equal(inspection.format, "cdisc-odm");
    assert.equal(inspection.formatVersion, "1.3.1");
    assert.equal(inspection.domain, "research");
    assert.equal(inspection.recordCount, 2);
    assert.equal(inspection.status, "metadata-only");
    const fields = Object.fromEntries((inspection.detectedSchema?.fields ?? []).map((f) => [f.name, f.sampleValues?.[0]]));
    assert.equal(fields["ItemDef"], 2);
    assert.equal(fields["FormDef"], 1);
    assert.equal(fields["ItemGroupDef"], 1);
    assert.equal(fields["CodeList"], 1);
    assert.equal(fields["SubjectData"], 2);
    assert.equal(fields["FormData"], 2);
    assert.equal(fields["ItemData"], 4);
    assert.ok(inspection.warnings?.some((w) => w.includes("STU-001")));
    assert.ok(inspection.warnings?.some((w) => w.includes("MDV-001")));
    assert.ok(inspection.sampleRecords?.length === 2);
  });

  test("reports skipped audit/annotation blocks without parsing them", async () => {
    const inspection = await adapter.inspect({
      id: "o-17",
      filename: "audit.odm",
      contentString: ODM_WITH_AUDIT,
    });
    assert.ok(inspection.warnings?.some((w) => w.includes("Skipped 2 block(s)")));
    assert.ok(inspection.warnings?.some((w) => w.includes("AuditRecords")));
    const { envelopes, issues } = await collect(
      adapter,
      { id: "o-18", filename: "audit.odm", contentString: ODM_WITH_AUDIT },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.ok(issues.some((issue) => issue.code === "ODM_SKIPPED_BLOCKS"));
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("reviewed"));
  });

  test("parses one envelope per FormData with verbatim subject keys and bounded previews", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "o-19", filename: "study.odm", contentString: ODM_SAMPLE },
      contextFor(adapter),
    );
    assert.equal(issues.length, 0);
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0].domain, "research");
    assert.equal(envelopes[0].source.format, "cdisc-odm");
    assert.equal(envelopes[0].source.formatVersion, "1.3.1");
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.recordIndex, 0);
    assert.ok(String(envelopes[0].provenance.sourceLocation).includes("SUBJ-001"));

    const first = structuredData(envelopes[0]);
    assert.equal(first.subjectKey, "SUBJ-001");
    assert.equal(first.studyEventOid, "SE-BASE");
    assert.equal(first.formOid, "F-VITALS");
    assert.equal(first.itemCount, 2);
    const items = first.items as Array<{ itemOid: string; valuePreview: string; truncated: boolean }>;
    assert.equal(items[0].itemOid, "IT-SYSBP");
    assert.equal(items[0].valuePreview, "118");
    assert.equal(items[0].truncated, false);
    assert.equal(items[1].valuePreview.length, 200);
    assert.equal(items[1].truncated, true);

    const second = structuredData(envelopes[1]);
    assert.equal(second.subjectKey, "SUBJ-002");
    const serialised = JSON.stringify(envelopes).toLowerCase();
    assert.ok(!serialised.includes("triage"));
    assert.ok(!serialised.includes("sdtm"));
  });

  test("parses metadata-only files as one envelope per FormDef", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "o-20", filename: "meta.odm", contentString: ODM_METADATA_ONLY },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].provenance.sourceLocation, "FormDef F-SCR");
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    const data = structuredData(envelopes[0]);
    assert.equal(data.recordKind, "odm-form-def");
    assert.equal(data.studyOid, "STU-009");
    assert.equal(data.metaDataVersionOid, "MDV-009");
  });

  test("respects maxRecords", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "o-21", filename: "study.odm", contentString: ODM_SAMPLE },
      { ...contextFor(adapter), maxRecords: 1 },
    );
    assert.equal(envelopes.length, 1);
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
