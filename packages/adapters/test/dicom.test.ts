import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DICOM_PHI_TAGS,
  DICOM_MAX_SEQUENCE_DEPTH,
  DICOM_PHI_PLACEHOLDER,
  DicomFormatAdapter,
  formatTag,
  hasDicomMagic,
  isPixelDataTag,
  isPrivateTag,
  parseDicomBytes,
  parseTagKey,
  resolveTransferSyntax,
} from "../src/dicom.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// Minimal in-test Part-10 builders (explicit/implicit LE, explicit BE)
// ---------------------------------------------------------------------------

const SOP_CLASS_CT = "1.2.840.10008.5.1.4.1.1.2";
const SOP_INSTANCE = "1.2.3.4.5.6.7.8.9";
const TS_EXPLICIT_LE = "1.2.840.10008.1.2.1";
const TS_IMPLICIT_LE = "1.2.840.10008.1.2";
const TS_EXPLICIT_BE = "1.2.840.10008.1.2.2";
const TS_DEFLATED = "1.2.840.10008.1.2.1.99";

function u16le(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u16be(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

/** ASCII with trailing space padding to even length (DICOM text padding). */
function textBuf(s: string): Buffer {
  const raw = Buffer.from(s, "ascii");
  return raw.length % 2 === 0 ? raw : Buffer.concat([raw, Buffer.from(" ")]);
}

/** UID with trailing NUL padding to even length. */
function uiBuf(s: string): Buffer {
  const raw = Buffer.from(s, "ascii");
  return raw.length % 2 === 0 ? raw : Buffer.concat([raw, Buffer.from([0])]);
}

function tagBuf(group: number, elem: number, le = true): Buffer {
  return le ? Buffer.concat([u16le(group), u16le(elem)]) : Buffer.concat([u16be(group), u16be(elem)]);
}

function elExplicit(group: number, elem: number, vr: string, value: Buffer, le = true): Buffer {
  const head = Buffer.alloc(8);
  tagBuf(group, elem, le).copy(head, 0);
  head.write(vr, 4, 2, "ascii");
  if (le) head.writeUInt16LE(value.length, 6);
  else head.writeUInt16BE(value.length, 6);
  return Buffer.concat([head, value]);
}

function elExplicitLong(group: number, elem: number, vr: string, value: Buffer, le = true): Buffer {
  const head = Buffer.alloc(12);
  tagBuf(group, elem, le).copy(head, 0);
  head.write(vr, 4, 2, "ascii");
  if (le) head.writeUInt32LE(value.length, 8);
  else head.writeUInt32BE(value.length, 8);
  return Buffer.concat([head, value]);
}

function elExplicitUndefined(group: number, elem: number, vr: string, le = true): Buffer {
  const head = Buffer.alloc(12);
  tagBuf(group, elem, le).copy(head, 0);
  head.write(vr, 4, 2, "ascii");
  if (le) head.writeUInt32LE(0xffffffff, 8);
  else head.writeUInt32BE(0xffffffff, 8);
  return head;
}

function elImplicit(group: number, elem: number, value: Buffer, le = true): Buffer {
  const head = Buffer.alloc(8);
  tagBuf(group, elem, le).copy(head, 0);
  if (le) head.writeUInt32LE(value.length, 4);
  else head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
}

function elImplicitUndefined(group: number, elem: number, le = true): Buffer {
  const head = Buffer.alloc(8);
  tagBuf(group, elem, le).copy(head, 0);
  if (le) head.writeUInt32LE(0xffffffff, 4);
  else head.writeUInt32BE(0xffffffff, 4);
  return head;
}

function itemDelim(elem: 0xe000 | 0xe00d | 0xe0dd, length: number, le = true): Buffer {
  const head = Buffer.alloc(8);
  tagBuf(0xfffe, elem, le).copy(head, 0);
  if (le) head.writeUInt32LE(length, 4);
  else head.writeUInt32BE(length, 4);
  return head;
}

const PREAMBLE = Buffer.concat([Buffer.alloc(128, 0), Buffer.from("DICM", "ascii")]);

function fileMetaBlock(transferSyntaxUid: string): Buffer {
  return Buffer.concat([
    elExplicit(0x0002, 0x0000, "UL", u32le(0)),
    elExplicit(0x0002, 0x0002, "UI", uiBuf(SOP_CLASS_CT)),
    elExplicit(0x0002, 0x0003, "UI", uiBuf(SOP_INSTANCE)),
    elExplicit(0x0002, 0x0010, "UI", uiBuf(transferSyntaxUid)),
    elExplicit(0x0002, 0x0012, "UI", uiBuf("1.2.3.4")),
    elExplicit(0x0002, 0x0013, "SH", textBuf("TEST")),
  ]);
}

const PIXEL_MARKER = "PIXELBYTES-NEVER-INLINE";
const PIXEL_BYTES = Buffer.concat([Buffer.from(PIXEL_MARKER, "ascii"), Buffer.from([0])]);

function validExplicitFile(): Buffer {
  const refContent = Buffer.concat([
    elExplicit(0x0008, 0x1150, "UI", uiBuf(SOP_CLASS_CT)),
    elExplicit(0x0008, 0x1155, "UI", uiBuf("9.9.9")),
  ]);
  const item = Buffer.concat([itemDelim(0xe000, refContent.length), refContent]);
  return Buffer.concat([
    PREAMBLE,
    fileMetaBlock(TS_EXPLICIT_LE),
    elExplicit(0x0008, 0x0016, "UI", uiBuf(SOP_CLASS_CT)),
    elExplicit(0x0008, 0x0018, "UI", uiBuf(SOP_INSTANCE)),
    elExplicit(0x0008, 0x0060, "CS", textBuf("CT")),
    elExplicit(0x0008, 0x0008, "CS", textBuf("ORIGINAL\\PRIMARY")),
    elExplicit(0x0010, 0x0010, "PN", textBuf("Doe^John")),
    elExplicit(0x0010, 0x0020, "LO", textBuf("PAT123")),
    elExplicit(0x0010, 0x0030, "DA", textBuf("19800115")),
    elExplicit(0x0020, 0x000d, "UI", uiBuf("1.2.3.4.5")),
    elExplicit(0x0020, 0x000e, "UI", uiBuf("1.2.3.4.5.6")),
    elExplicit(0x0028, 0x0010, "US", u16le(512)),
    elExplicit(0x0028, 0x0011, "US", u16le(512)),
    elExplicit(0x0020, 0x0032, "DS", textBuf("1\\2\\3")),
    elExplicit(0x0008, 0x1030, "LO", Buffer.alloc(0)),
    elExplicit(0x0011, 0x0010, "LO", textBuf("CREATOR")),
    elExplicitLong(0x0011, 0x1001, "UN", Buffer.from([1, 2, 3, 4])),
    elExplicit(0x0018, 0x7777, "ZZ", textBuf("ABC")),
    elExplicitLong(0x0008, 0x1140, "SQ", item),
    elExplicitLong(0x7fe0, 0x0010, "OW", PIXEL_BYTES),
  ]);
}

function validImplicitFile(): Buffer {
  const refContent = elImplicit(0x0008, 0x1150, uiBuf(SOP_CLASS_CT));
  return Buffer.concat([
    PREAMBLE,
    fileMetaBlock(TS_IMPLICIT_LE),
    elImplicit(0x0008, 0x0060, textBuf("MR")),
    elImplicit(0x0010, 0x0010, textBuf("Doe^Jane")),
    elImplicit(0x0028, 0x0010, u16le(256)),
    elImplicit(0x0019, 0x1001, Buffer.from("SECRET", "ascii")),
    elImplicit(0x0018, 0x9999, textBuf("HELLO")),
    elImplicit(0x0018, 0x9998, Buffer.from([0, 1, 2, 255])),
    elImplicitUndefined(0x0008, 0x1140),
    itemDelim(0xe000, 0xffffffff),
    refContent,
    itemDelim(0xe00d, 0),
    itemDelim(0xe0dd, 0),
  ]);
}

function validBigEndianFile(): Buffer {
  return Buffer.concat([
    PREAMBLE,
    fileMetaBlock(TS_EXPLICIT_BE),
    elExplicit(0x0008, 0x0060, "CS", textBuf("MR"), false),
    elExplicit(0x0028, 0x0010, "US", u16be(256), false),
    elExplicit(0x0010, 0x0010, "PN", textBuf("Doe^John"), false),
  ]);
}

function encapsulatedFile(): Buffer {
  return Buffer.concat([
    PREAMBLE,
    fileMetaBlock(TS_EXPLICIT_LE),
    elExplicit(0x0008, 0x0060, "CS", textBuf("CT")),
    elExplicitUndefined(0x7fe0, 0x0010, "OW"),
    itemDelim(0xe000, 0),
    itemDelim(0xe000, 10),
    Buffer.from("FRAGBYTES1", "ascii"),
    itemDelim(0xe000, 10),
    Buffer.from("FRAGBYTES2", "ascii"),
    itemDelim(0xe0dd, 0),
  ]);
}

function nestedSequence(levels: number): Buffer {
  let inner = elExplicit(0x0010, 0x0010, "PN", textBuf("Deep"));
  for (let i = levels; i >= 1; i--) {
    const item = Buffer.concat([itemDelim(0xe000, inner.length), inner]);
    inner = elExplicitLong(0x0008, 0x1140, "SQ", item);
  }
  return inner;
}

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

interface ElementView {
  tag: string;
  vr: string;
  value?: unknown;
  [key: string]: unknown;
}

function elementsOf(envelope: MedicalDataEnvelope): ElementView[] {
  return structuredData(envelope)["elements"] as ElementView[];
}

function elementByTag(envelope: MedicalDataEnvelope, tag: string): ElementView {
  const found = elementsOf(envelope).find((e) => e.tag === tag);
  assert.ok(found, `expected element ${tag}`);
  return found!;
}

describe("DICOM tag helpers", () => {
  test("tag formatting, parsing, privacy and pixel classification", () => {
    assert.equal(formatTag(0x0010, 0x0010), "0010,0010");
    assert.equal(formatTag(0x7fe0, 0x0010), "7FE0,0010");
    assert.deepEqual(parseTagKey("0010,0010"), { group: 0x10, element: 0x10 });
    assert.equal(parseTagKey("nope"), null);
    assert.equal(isPrivateTag(0x0011), true);
    assert.equal(isPrivateTag(0x0010), false);
    assert.equal(isPixelDataTag(0x7fe0, 0x0010), true);
    assert.equal(isPixelDataTag(0x7fe0, 0x0008), true);
    assert.equal(isPixelDataTag(0x6000, 0x3000), true);
    assert.equal(isPixelDataTag(0x0028, 0x0010), false);
    assert.equal(hasDicomMagic(validExplicitFile()), true);
    assert.equal(hasDicomMagic(Buffer.alloc(200)), false);
  });

  test("transfer syntax resolution is explicit about every case", () => {
    assert.deepEqual(resolveTransferSyntax(TS_EXPLICIT_LE), {
      uid: TS_EXPLICIT_LE,
      explicit: true,
      littleEndian: true,
      deflated: false,
      assumed: false,
    });
    assert.equal(resolveTransferSyntax(TS_IMPLICIT_LE).explicit, false);
    assert.equal(resolveTransferSyntax(TS_EXPLICIT_BE).littleEndian, false);
    assert.equal(resolveTransferSyntax(TS_DEFLATED).deflated, true);
    assert.equal(resolveTransferSyntax(undefined).assumed, true);
    assert.equal(resolveTransferSyntax("1.2.9999.unknown").assumed, true);
    // Encapsulated image syntaxes stay explicit VR little-endian.
    assert.equal(resolveTransferSyntax("1.2.840.10008.1.2.4.50").explicit, true);
  });

  test("default PHI policy covers names, ids and dates", () => {
    assert.equal(DEFAULT_DICOM_PHI_TAGS["0010,0010"], "PatientName");
    assert.equal(DEFAULT_DICOM_PHI_TAGS["0010,0020"], "PatientID");
    assert.equal(DEFAULT_DICOM_PHI_TAGS["0010,0030"], "PatientBirthDate");
    assert.equal(DEFAULT_DICOM_PHI_TAGS["0008,0020"], "StudyDate");
  });
});

describe("DICOM adapter", () => {
  const adapter = new DicomFormatAdapter();

  test("manifest is honestly metadata-only with pixel/DICOMweb boundaries", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.format, "dicom");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.deepEqual(manifest.extensions, [".dcm", ".dicom"]);
    assert.ok(manifest.limitations?.some((l) => l.includes("never inlined")));
    assert.ok(manifest.limitations?.some((l) => l.includes("DICOMweb")));
    assert.ok(manifest.limitations?.some((l) => l.toLowerCase().includes("no clinical interpretation")));
    assert.ok(manifest.limitations?.some((l) => l.toLowerCase().includes("deflated")));
    assert.ok(manifest.limitations?.some((l) => l.includes("Private tags")));
  });

  test("detects by extension and DICM sniffing, never claims non-DICOM", async () => {
    const bytes = validExplicitFile();
    assert.equal(await adapter.detect({ id: "d-1", filename: "scan.dcm", buffer: bytes }), true);
    assert.equal(await adapter.detect({ id: "d-2", filename: "mystery.bin", buffer: bytes }), true);
    assert.equal(await adapter.detect({ id: "d-3", filename: "scan.dicom", buffer: bytes }), true);
    assert.equal(await adapter.score({ id: "d-4", filename: "scan.dcm", buffer: bytes }), 0.95);
    // Content contradiction wins over the extension: 200 non-DICOM bytes are not claimed.
    assert.equal(await adapter.detect({ id: "d-5", filename: "scan.dcm", buffer: Buffer.alloc(200) }), false);
    assert.equal(await adapter.score({ id: "d-6", filename: "scan.dcm", buffer: Buffer.alloc(200) }), 0);
    assert.equal(await adapter.detect({ id: "d-7", filename: "note.csv", contentString: "a,b\n1,2\n" }), false);
    assert.equal(await adapter.detect({ id: "d-8", filename: "note.json", contentString: '{"a": 1}' }), false);
    assert.equal(
      await adapter.detect({
        id: "d-9",
        filename: "note.fhir.json",
        contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
      }),
      false,
    );
    // Short buffers cannot contradict yet: the extension claim stands (parse reports it).
    assert.equal(await adapter.detect({ id: "d-10", filename: "cut.dcm", buffer: Buffer.alloc(10) }), true);
    assert.equal(await adapter.detect({ id: "d-11", filename: "plain.txt", contentString: "hello" }), false);
  });

  test("parses explicit VR with redaction, sequences, private tags and pixel presence", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-20", filename: "scan.dcm", buffer: validExplicitFile() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const envelope = envelopes[0]!;
    assert.equal(envelope.domain, "imaging");
    assert.equal(envelope.source.format, "dicom");
    assert.equal(envelope.source.formatVersion, TS_EXPLICIT_LE);
    assert.equal(envelope.id, SOP_INSTANCE);
    assert.match(String(envelope.source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelope.provenance.sourceLocation, "dataset");
    assert.equal(envelope.provenance.recordIndex, 0);
    assert.equal(envelope.metadata["modality"], "CT");
    assert.equal(envelope.metadata["transferSyntaxUid"], TS_EXPLICIT_LE);

    // PHI values are replaced; tag numbers stay for provenance.
    assert.equal(elementByTag(envelope, "0010,0010").value, DICOM_PHI_PLACEHOLDER);
    assert.equal(elementByTag(envelope, "0010,0010").redacted, true);
    assert.equal(elementByTag(envelope, "0010,0020").value, DICOM_PHI_PLACEHOLDER);
    assert.equal(elementByTag(envelope, "0010,0030").value, DICOM_PHI_PLACEHOLDER);
    assert.deepEqual(envelope.metadata["phiRedactedTags"], ["0010,0010", "0010,0020", "0010,0030"]);

    // Non-PHI metadata is carried verbatim, structurally.
    assert.equal(elementByTag(envelope, "0008,0060").value, "CT");
    assert.equal(elementByTag(envelope, "0028,0010").value, 512);
    assert.deepEqual(elementByTag(envelope, "0008,0008").value, ["ORIGINAL", "PRIMARY"]);
    assert.deepEqual(elementByTag(envelope, "0020,0032").value, ["1", "2", "3"]);
    assert.equal(elementByTag(envelope, "0008,1030").empty, true);

    // Unknown explicit VR falls back to plain-ASCII text.
    assert.equal(elementByTag(envelope, "0018,7777").value, "ABC");

    // Sequences nest; pixel bytes are never inlined.
    const seq = elementByTag(envelope, "0008,1140");
    assert.equal(seq.vr, "SQ");
    const items = seq.value as Array<Array<ElementView>>;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.find((e) => e.tag === "0008,1150")?.value, SOP_CLASS_CT);
    const pixel = elementByTag(envelope, "7FE0,0010");
    assert.equal(pixel.pixelData, true);
    assert.equal(pixel.value, undefined);
    assert.deepEqual(pixel.pixel, { encapsulated: false, byteLength: PIXEL_BYTES.length });
    const serialised = JSON.stringify(envelopes);
    assert.ok(!serialised.includes("Doe^John"));
    assert.ok(!serialised.includes("PAT123"));
    assert.ok(!serialised.includes(PIXEL_MARKER));
    // Issues never carry PHI either.
    assert.ok(!JSON.stringify(issues).includes("Doe^John"));
    assert.ok(!JSON.stringify(issues).includes("PAT123"));
    assert.equal(issues.length, 0);
  });

  test("private tags are preserved by number, never interpreted", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-21", filename: "scan.dcm", buffer: validExplicitFile() },
      contextFor(adapter),
    );
    const creator = elementByTag(envelopes[0]!, "0011,0010");
    assert.equal(creator.private, true);
    assert.equal(creator.binary, true);
    assert.equal(creator.value, undefined);
    const raw = elementByTag(envelopes[0]!, "0011,1001");
    assert.equal(raw.private, true);
    assert.equal(raw.vr, "UN");
    assert.equal(raw.value, undefined);
    assert.ok(!JSON.stringify(envelopes).includes("CREATOR"));
    assert.ok((envelopes[0]!.metadata["privateTagCount"] as number) >= 2);
    assert.equal(issues.length, 0);
  });

  test("parses implicit VR little-endian with dictionary VRs", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-22", filename: "scan.dcm", buffer: validImplicitFile() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const envelope = envelopes[0]!;
    assert.equal(envelope.source.formatVersion, TS_IMPLICIT_LE);
    assert.equal(elementByTag(envelope, "0008,0060").value, "MR");
    assert.equal(elementByTag(envelope, "0028,0010").value, 256);
    assert.equal(elementByTag(envelope, "0010,0010").value, DICOM_PHI_PLACEHOLDER);
    // Undefined-length sequence with item/sequence delimitation.
    const seq = elementByTag(envelope, "0008,1140");
    assert.equal((seq.value as Array<Array<ElementView>>).length, 1);
    // Private values never inlined even when printable.
    const priv = elementByTag(envelope, "0019,1001");
    assert.equal(priv.private, true);
    assert.equal(priv.value, undefined);
    assert.ok(!JSON.stringify(envelopes).includes("SECRET"));
    // Unknown implicit tags: ASCII inlined, binary kept as length.
    assert.equal(elementByTag(envelope, "0018,9999").value, "HELLO");
    assert.equal(elementByTag(envelope, "0018,9998").binary, true);
    assert.equal(issues.length, 0);
  });

  test("parses retired explicit VR big-endian read-only", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-23", filename: "legacy.dcm", buffer: validBigEndianFile() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(elementByTag(envelopes[0]!, "0008,0060").value, "MR");
    assert.equal(elementByTag(envelopes[0]!, "0028,0010").value, 256);
    assert.equal(envelopes[0]!.source.formatVersion, TS_EXPLICIT_BE);
    assert.equal(issues.length, 0);
  });

  test("records encapsulated pixel fragments without bytes", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "d-24", filename: "encap.dcm", buffer: encapsulatedFile() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    const pixel = elementByTag(envelopes[0]!, "7FE0,0010");
    assert.equal(pixel.pixelData, true);
    assert.deepEqual(pixel.pixel, { encapsulated: true, byteLength: 20, fragmentCount: 2 });
    const serialised = JSON.stringify(envelopes);
    assert.ok(!serialised.includes("FRAGBYTES1"));
    assert.ok(!serialised.includes("FRAGBYTES2"));
    assert.equal(envelopes[0]!.metadata["hasPixelData"], true);
    assert.equal(envelopes[0]!.metadata["pixelFragmentCount"], 2);
  });

  test("PHI policy is configurable and has an explicit local-debug opt-out", async () => {
    const extra = await collect(
      adapter,
      { id: "d-25", filename: "scan.dcm", buffer: validExplicitFile() },
      contextFor(adapter, { dicomExtraPhiTags: ["0008,0060"] }),
    );
    assert.equal(elementByTag(extra.envelopes[0]!, "0008,0060").value, DICOM_PHI_PLACEHOLDER);
    assert.equal(elementByTag(extra.envelopes[0]!, "0010,0010").value, DICOM_PHI_PLACEHOLDER);

    const overridden = await collect(
      adapter,
      { id: "d-26", filename: "scan.dcm", buffer: validExplicitFile() },
      contextFor(adapter, { dicomPhiTags: [] }),
    );
    assert.equal(elementByTag(overridden.envelopes[0]!, "0010,0010").value, "Doe^John");

    const debug = await collect(
      adapter,
      { id: "d-27", filename: "scan.dcm", buffer: validExplicitFile() },
      contextFor(adapter, { dicomIncludePhiForLocalDebug: true }),
    );
    assert.equal(elementByTag(debug.envelopes[0]!, "0010,0010").value, "Doe^John");
    const redaction = structuredData(debug.envelopes[0]!)["phiRedaction"] as Record<string, unknown>;
    assert.equal(redaction["mode"], "included-local-debug");
    assert.equal(redaction["applied"], false);
  });

  test("refuses missing magic, deflated syntax and empty input without throwing", async () => {
    const noMagic = await collect(
      adapter,
      { id: "d-30", filename: "scan.dcm", buffer: Buffer.alloc(200) },
      contextFor(adapter),
    );
    assert.equal(noMagic.envelopes.length, 0);
    assert.ok(noMagic.issues.some((i) => i.code === "DICOM_MISSING_MAGIC" && i.severity === "error"));

    const short = await collect(
      adapter,
      { id: "d-31", filename: "cut.dcm", buffer: Buffer.alloc(10) },
      contextFor(adapter),
    );
    assert.equal(short.envelopes.length, 0);
    assert.ok(short.issues.some((i) => i.code === "DICOM_MISSING_MAGIC"));

    const deflated = await collect(
      adapter,
      {
        id: "d-32",
        filename: "deflated.dcm",
        buffer: Buffer.concat([PREAMBLE, fileMetaBlock(TS_DEFLATED)]),
      },
      contextFor(adapter),
    );
    assert.equal(deflated.envelopes.length, 0);
    assert.ok(
      deflated.issues.some((i) => i.code === "DICOM_DEFLATED_TRANSFER_SYNTAX_REFUSED" && i.severity === "error"),
    );

    const empty = await collect(adapter, { id: "d-33", filename: "empty.dcm" }, contextFor(adapter));
    assert.equal(empty.envelopes.length, 0);
    assert.ok(empty.issues.some((i) => i.code === "DICOM_EMPTY_INPUT"));

    const garbage = await collect(
      adapter,
      { id: "d-34", filename: "fake.dcm", buffer: Buffer.from("hello", "utf-8") },
      contextFor(adapter),
    );
    assert.equal(garbage.envelopes.length, 0);
    assert.ok(garbage.issues.some((i) => i.code === "DICOM_MISSING_MAGIC"));
  });

  test("truncated elements yield a partial envelope with an explicit issue", async () => {
    const full = validExplicitFile();
    const cut = full.subarray(0, full.length - 4);
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-35", filename: "cut.dcm", buffer: Buffer.from(cut) },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.ok(issues.some((i) => i.code === "DICOM_TRUNCATED_ELEMENT" && i.severity === "error"));
    assert.equal(envelopes[0]!.metadata["truncated"], true);
    // Elements before the truncation are still auditable; the cut pixel element is gone.
    assert.equal(elementByTag(envelopes[0]!, "0008,0060").value, "CT");
    assert.equal(
      elementsOf(envelopes[0]!).some((e) => e.tag === "7FE0,0010"),
      false,
    );
  });

  test("sequence depth is bounded and reported, never hung or crashed on", async () => {
    const bytes = Buffer.concat([PREAMBLE, fileMetaBlock(TS_EXPLICIT_LE), nestedSequence(10)]);
    const { envelopes, issues } = await collect(
      adapter,
      { id: "d-36", filename: "deep.dcm", buffer: bytes },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.ok(issues.some((i) => i.code === "DICOM_SEQUENCE_DEPTH_EXCEEDED"));
    assert.equal(envelopes[0]!.metadata["maxSequenceDepth"], DICOM_MAX_SEQUENCE_DEPTH + 1);
  });

  test("parseDicomBytes exposes the file-meta walk directly", () => {
    const parsed = parseDicomBytes(validExplicitFile(), undefined);
    assert.equal(parsed.refused, false);
    if (parsed.refused) throw new Error("unreachable");
    assert.ok(parsed.fileMeta.some((e) => e.tag === "0002,0010" && e.value === TS_EXPLICIT_LE));
    assert.equal(parsed.summary.modality, "CT");
    assert.equal(parsed.summary.pixel.present, true);
    assert.deepEqual(parsed.summary.pixel.tag, "7FE0,0010");
    assert.equal(parsed.truncated, false);

    const refused = parseDicomBytes(Buffer.concat([PREAMBLE, fileMetaBlock(TS_DEFLATED)]), undefined);
    assert.equal(refused.refused, true);
  });

  test("inspection reports file-meta, counts and transfer syntax", async () => {
    const inspection = await adapter.inspect({ id: "d-40", filename: "scan.dcm", buffer: validExplicitFile() });
    assert.equal(inspection.format, "dicom");
    assert.equal(inspection.formatVersion, TS_EXPLICIT_LE);
    assert.equal(inspection.domain, "imaging");
    assert.equal(inspection.recordCount, 1);
    assert.equal(inspection.status, "metadata-only");
    assert.ok(inspection.detectedSchema?.fields.some((f) => f.name === "0008,0060 Modality"));
    assert.ok(inspection.warnings?.some((w) => w.includes(TS_EXPLICIT_LE)));
    assert.ok(inspection.warnings?.some((w) => w.includes("Modality: CT")));
    assert.ok(inspection.warnings?.some((w) => w.includes("Pixel data: present")));
    assert.ok(inspection.warnings?.some((w) => w.includes("PHI redaction")));
    assert.ok(!JSON.stringify(inspection).includes("Doe^John"));

    const bad = await adapter.inspect({ id: "d-41", filename: "scan.dcm", buffer: Buffer.alloc(200) });
    assert.equal(bad.recordCount, 0);
    assert.ok(bad.warnings?.some((w) => w.includes("DICM")));

    const deflated = await adapter.inspect({
      id: "d-42",
      filename: "deflated.dcm",
      buffer: Buffer.concat([PREAMBLE, fileMetaBlock(TS_DEFLATED)]),
    });
    assert.equal(deflated.recordCount, 0);
    assert.ok(deflated.warnings?.some((w) => w.includes("DICOM_DEFLATED_TRANSFER_SYNTAX_REFUSED")));
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.ok(health?.details.includes("metadata only"));
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
