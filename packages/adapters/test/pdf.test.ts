import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  PDF_ADAPTER_ID,
  PDF_ADAPTER_VERSION,
  PDF_MAX_TEXT_CHARS,
  PdfFormatAdapter,
  decodeContentStream,
  decodePdfString,
  extractPdfPageTexts,
  hasPdfMagic,
  parseInfoDict,
  parsePdfStructure,
  splitPdfObjects,
} from "../src/pdf.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// Minimal in-test PDF builders (real offsets, real xref, no PDF library)
// ---------------------------------------------------------------------------

interface ObjDef {
  num: number;
  body: string;
}

interface PdfBuildOptions {
  objects: ObjDef[];
  header?: string;
  prefix?: string;
  infoNum?: number;
  rootNum?: number;
  encryptNum?: number;
  omitXref?: boolean;
  omitEof?: boolean;
  badStartxref?: boolean;
}

function assemblePdf(options: PdfBuildOptions): Buffer {
  const chunks: Array<{ text: string }> = [];
  let length = 0;
  const push = (text: string): void => {
    chunks.push({ text });
    length += Buffer.byteLength(text, "latin1");
  };
  if (options.prefix) push(options.prefix);
  push(options.header ?? "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const offsets: number[] = [];
  for (const object of options.objects) {
    offsets.push(length);
    push(`${object.num} 0 obj\n${object.body}\nendobj\n`);
  }
  const xrefAt = length;
  const maxNum = Math.max(...options.objects.map((o) => o.num));
  if (!options.omitXref) {
    push(`xref\n0 ${maxNum + 1}\n`);
    push("0000000000 65535 f \n");
    for (let n = 1; n <= maxNum; n++) {
      const at = offsets[options.objects.findIndex((o) => o.num === n)] ?? 0;
      push(`${String(at).padStart(10, "0")} 00000 n \n`);
    }
  }
  const rootNum = options.rootNum ?? 1;
  const infoPart = options.infoNum !== undefined ? ` /Info ${options.infoNum} 0 R` : "";
  const encryptPart = options.encryptNum !== undefined ? ` /Encrypt ${options.encryptNum} 0 R` : "";
  push(`trailer\n<< /Size ${maxNum + 1} /Root ${rootNum} 0 R${infoPart}${encryptPart} >>\n`);
  if (!options.omitXref) {
    push(options.badStartxref ? "startxref\nnot-a-number\n" : `startxref\n${xrefAt}\n`);
  }
  if (!options.omitEof) push("%%EOF\n");
  return Buffer.from(chunks.map((c) => c.text).join(""), "latin1");
}

function textStreamObject(num: number, ops: string, filter?: string): ObjDef {
  const raw = Buffer.from(ops, "latin1");
  if (!filter) {
    return { num, body: `<< /Length ${raw.length} >>\nstream\n${ops}\nendstream` };
  }
  const compressed = deflateSync(raw);
  return {
    num,
    body: `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString("latin1")}\nendstream`,
  };
}

function twoPagePdf(): Buffer {
  return assemblePdf({
    objects: [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>" },
      textStreamObject(4, "BT /F1 12 Tf 72 712 Td (Hello page one) Tj ET"),
      { num: 5, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>" },
      textStreamObject(6, "BT [(Secon) 120 (d page)] TJ ET", "flate"),
      {
        num: 7,
        body: "<< /Title (Discharge Summary) /Author (Jane Doe) /Subject (Cardiology) /Producer (HealthBridge) >>",
      },
    ],
    infoNum: 7,
  });
}

function contextFor(
  adapter: MedicalFormatAdapter,
  options?: Record<string, unknown>,
  maxRecords?: number,
): ParseContext {
  return { adapterId: adapter.id, adapterVersion: adapter.version, options, maxRecords };
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

const KIT_SAMPLES: InputDescriptor[] = [
  { id: "kit-sample-csv", filename: "kit.csv", contentString: "patient_id,first_name\nP1,Jane\n" },
  {
    id: "kit-sample-json",
    filename: "kit.json",
    contentString: JSON.stringify([{ patient_id: "P1", first_name: "Jane" }]),
  },
  {
    id: "kit-sample-fhir",
    filename: "kit.fhir.json",
    contentString: JSON.stringify({ resourceType: "Patient", id: "kit-p1" }),
  },
];

describe("PDF adapter", () => {
  const adapter = new PdfFormatAdapter();

  test("manifest is honestly metadata-only with an explicit boundary", () => {
    assert.equal(adapter.id, PDF_ADAPTER_ID);
    assert.equal(adapter.version, PDF_ADAPTER_VERSION);
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.ok(manifest.limitations?.some((l) => l.includes("never decrypted") || l.includes("never interpreted")));
    assert.ok(manifest.limitations?.some((l) => l.includes("textUnverified")));
    assert.ok(manifest.limitations?.some((l) => l.includes("OCR") || l.includes("NLP")));
  });

  test("detects by .pdf extension and %PDF magic, never claims non-PDF", async () => {
    assert.equal(await adapter.detect({ id: "p-1", filename: "report.pdf", buffer: twoPagePdf() }), true);
    assert.equal(
      await adapter.detect({ id: "p-2", filename: "report.txt", buffer: twoPagePdf() }),
      true,
      "magic sniffing claims %PDF bytes under any name",
    );
    for (const sample of KIT_SAMPLES) {
      assert.equal(await adapter.detect(sample), false, `must not claim ${sample.filename}`);
    }
    assert.equal(
      await adapter.detect({ id: "p-3", filename: "note.txt", contentString: "plain prose, no magic" }),
      false,
    );
    assert.equal(await adapter.detect({ id: "p-4", filename: "no-name" }), false);
  });

  test("inspect reports page count, Info dict and census for the two-page fixture", async () => {
    const inspection = await adapter.inspect({ id: "p-5", filename: "report.pdf", buffer: twoPagePdf() });
    assert.equal(inspection.format, "pdf");
    assert.equal(inspection.formatVersion, "1.4");
    assert.equal(inspection.domain, "document");
    assert.equal(inspection.recordCount, 2);
    assert.equal(inspection.status, "metadata-only");
    const sample = inspection.sampleRecords?.[0] as unknown as Record<string, unknown>;
    assert.equal(sample.pageCount, 2);
    assert.equal(sample.pageCountSource, "count");
    assert.equal(sample.encrypted, false);
    assert.equal(sample.linearized, false);
    assert.ok((sample.objectCount as number) >= 7);
    assert.ok((sample.streamCount as number) >= 2);
    const info = sample.info as Record<string, string>;
    assert.equal(info.title, "Discharge Summary");
    assert.equal(info.author, "Jane Doe");
    assert.equal(info.subject, "Cardiology");
    assert.equal(info.producer, "HealthBridge");
  });

  test("parse yields one metadata-only document envelope by default", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "p-6", filename: "report.pdf", buffer: twoPagePdf() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1, `expected only the document envelope, got issues: ${JSON.stringify(issues)}`);
    const envelope = envelopes[0];
    assert.equal(envelope.domain, "document");
    assert.equal(envelope.source.format, "pdf");
    assert.ok(envelope.source.checksum?.startsWith("sha256:"), "envelope carries its SHA-256 checksum");
    assert.equal(envelope.provenance.adapterId, PDF_ADAPTER_ID);
    const data = structuredData(envelope);
    assert.equal(data.pageCount, 2);
    assert.equal((data.info as Record<string, string>).title, "Discharge Summary");
    assert.equal(envelope.metadata.textExtraction, "off");
  });

  test("opt-in extraction yields unverified per-page envelopes for Tj, TJ and FlateDecode", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "p-7", filename: "report.pdf", buffer: twoPagePdf() },
      contextFor(adapter, { extractText: true }),
    );
    assert.equal(envelopes.length, 3, `doc + 2 pages, got issues: ${JSON.stringify(issues)}`);
    assert.equal(envelopes[0].metadata.textExtraction, "per-page (opt-in, unverified)");
    const pageOne = structuredData(envelopes[1]);
    const pageTwo = structuredData(envelopes[2]);
    assert.equal(pageOne.pageNumber, 1);
    assert.ok((pageOne.text as string).includes("Hello page one"));
    assert.equal(pageOne.textUnverified, true);
    assert.ok(String(pageOne.extractionMethod).includes("unverified"));
    assert.equal(pageTwo.pageNumber, 2);
    assert.ok((pageTwo.text as string).includes("Second page"), `TJ fragments must join, got: ${pageTwo.text}`);
    assert.equal(pageTwo.textUnverified, true);
    for (const envelope of envelopes.slice(1)) {
      assert.equal(envelope.metadata.textUnverified, true);
      assert.ok(envelope.source.checksum?.startsWith("sha256:"));
    }
  });

  test("WinAnsi and UTF-16BE show strings decode structurally", async () => {
    const pdf = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        // 0xE9 is é in WinAnsi; the hex string carries a UTF-16BE BOM.
        textStreamObject(4, "BT (caf\xe9) Tj <FEFF00480069> Tj ET"),
      ],
    });
    const { envelopes } = await collect(
      adapter,
      { id: "p-8", filename: "enc.pdf", buffer: pdf },
      contextFor(adapter, { extractText: true }),
    );
    assert.equal(envelopes.length, 2);
    const page = structuredData(envelopes[1]);
    assert.ok((page.text as string).includes("caf\xe9"), `WinAnsi byte must survive, got: ${page.text}`);
    assert.ok((page.text as string).includes("Hi"), `UTF-16BE hex must decode, got: ${page.text}`);
  });

  test("encrypted files are never decrypted: metadata flows, extraction is refused", async () => {
    const pdf = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        textStreamObject(4, "BT (secret, but stored in clear for the test) Tj ET"),
        { num: 9, body: "<< /Filter /Standard /V 2 /Length 128 >>" },
      ],
      encryptNum: 9,
    });
    const inspection = await adapter.inspect({ id: "p-9", filename: "locked.pdf", buffer: pdf });
    const sample = inspection.sampleRecords?.[0] as unknown as Record<string, unknown>;
    assert.equal(sample.encrypted, true);

    const metaOnly = await collect(
      adapter,
      { id: "p-10", filename: "locked.pdf", buffer: pdf },
      contextFor(adapter),
    );
    assert.equal(metaOnly.envelopes.length, 1, "metadata-only parse still yields the document envelope");
    assert.ok(metaOnly.issues.some((i) => i.code === "PDF_ENCRYPTED_LIMITED"));

    const refused = await collect(
      adapter,
      { id: "p-11", filename: "locked.pdf", buffer: pdf },
      contextFor(adapter, { extractText: true }),
    );
    assert.equal(refused.envelopes.length, 1, "refused extraction yields no page envelopes");
    assert.ok(
      refused.issues.some((i) => i.code === "PDF_ENCRYPTED_REFUSED" && i.severity === "error"),
      `expected an explicit refusal, got: ${JSON.stringify(refused.issues)}`,
    );
  });

  test("garbage-tolerant sniffing: prefix, linearization and truncation are explicit", async () => {
    const prefixed = Buffer.concat([Buffer.from("junk-bytes\n", "latin1"), twoPagePdf()]);
    const structure = parsePdfStructure(prefixed);
    assert.ok(structure.headerOffset > 0);
    assert.ok(structure.issues.some((i) => i.code === "PDF_GARBAGE_PREFIX"));
    assert.equal(structure.pageCount, 2, "leading garbage must not break the walk");

    const linearized = assemblePdf({
      objects: [
        { num: 10, body: "<< /Linearized 1 /L 9999 >>" },
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      ],
    });
    assert.equal(parsePdfStructure(linearized).linearized, true);

    const truncated = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      ],
      omitXref: true,
      omitEof: true,
    });
    const broken = parsePdfStructure(truncated);
    assert.ok(broken.issues.some((i) => i.code === "PDF_MISSING_STARTXREF"));
    assert.ok(broken.issues.some((i) => i.code === "PDF_MISSING_EOF"));
    assert.equal(broken.pageCount, 1, "counts are best-effort even without a trailer");
  });

  test("files without a header get an explicit issue, never a crash", async () => {
    const input: InputDescriptor = { id: "p-12", filename: "mystery.pdf", contentString: "definitely not a pdf" };
    const inspection = await adapter.inspect(input);
    assert.equal(inspection.recordCount, 0);
    assert.ok(inspection.warnings.some((w) => w.includes("ERROR")));
    const { envelopes, issues } = await collect(adapter, input, contextFor(adapter));
    assert.equal(envelopes.length, 1, "best-effort document envelope is still yielded");
    assert.ok(issues.some((i) => i.code === "PDF_MISSING_HEADER" && i.severity === "error"));
    const empty = await collect(adapter, { id: "p-13", filename: "empty.pdf" }, contextFor(adapter));
    assert.equal(empty.envelopes.length, 0);
    assert.ok(empty.issues.some((i) => i.code === "PDF_EMPTY_INPUT"));
  });

  test("page-count fallback uses the /Page census when /Count is absent", () => {
    const pdf = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      ],
    });
    const structure = parsePdfStructure(pdf);
    assert.equal(structure.pageCount, 1);
    assert.equal(structure.pageCountSource, "objects");
    assert.ok(structure.xrefEntryCount !== null && structure.xrefEntryCount > 0, "the xref table is really walked");
  });
});

describe("PDF structural units", () => {
  test("decodePdfString handles escapes, octal, nesting and hex", () => {
    assert.equal(decodePdfString("(a\\nB)").text, "a\nB");
    assert.equal(decodePdfString("(\\101)").text, "A", "octal escapes decode");
    assert.equal(decodePdfString("(a(b)c)").text, "a(b)c", "balanced parens survive");
    assert.equal(decodePdfString("<4869>").text, "Hi");
    assert.equal(decodePdfString("<FEFF0041>").text, "A", "UTF-16BE BOM decodes");
  });

  test("parseInfoDict carries document metadata structurally", () => {
    const info = parseInfoDict("<< /Title (T) /Author (A) /Subject (S) /Producer (P) >>");
    assert.deepEqual(info, { title: "T", author: "A", subject: "S", producer: "P" });
  });

  test("decodeContentStream only honours Tj/TJ", () => {
    const { fragments } = decodeContentStream("BT /F1 12 Tf 72 712 Td (Hi) Tj 10 0 Td [(By) -40 (e)] TJ ET");
    assert.equal(fragments.map((f) => f.text).join(""), "HiBye");
  });

  test("hasPdfMagic tolerates leading garbage but rejects prose", () => {
    assert.equal(hasPdfMagic(Buffer.from("%PDF-1.7\n", "latin1")), true);
    assert.equal(hasPdfMagic(Buffer.from("xx%PDF-1.4\n", "latin1")), true);
    assert.equal(hasPdfMagic(Buffer.from("just text", "latin1")), false);
  });

  test("extractPdfPageTexts truncates beyond the envelope budget explicitly", () => {
    const big = `(x) Tj ${`(y) Tj `.repeat(40000)}`;
    const pdf = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        textStreamObject(4, `BT ${big} ET`),
      ],
    });
    const [page] = extractPdfPageTexts(pdf);
    assert.equal(page.truncated, true);
    assert.ok(page.text.length <= PDF_MAX_TEXT_CHARS);
    assert.ok(page.issues.some((i) => i.code === "PDF_TEXT_TRUNCATED"));
  });

  test("splitPdfObjects does not truncate on binary that spells endobj", () => {
    const binary = Buffer.from([0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x00, 0xff]); // 'endobj' + bytes
    const pdf = assemblePdf({
      objects: [
        { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
        { num: 3, body: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
        {
          num: 4,
          body: `<< /Length ${binary.length} >>\nstream\n${binary.toString("latin1")}\nendstream`,
        },
      ],
    });
    const objects = splitPdfObjects(pdf.toString("latin1"));
    assert.equal(objects.length, 4);
    assert.ok(objects[3].body.includes("endstream"));
  });
});

describe("PDF adapter contract", () => {
  test("satisfies the shared conformance kit with zero failures", async () => {
    const failures = await runAdapterConformance(new PdfFormatAdapter());
    assert.deepEqual(failures, []);
  });

  test("health reports a metadata-only self-check", async () => {
    const result = await new PdfFormatAdapter().health?.();
    assert.equal(result?.ok, true);
    assert.ok(result?.details.includes(PDF_ADAPTER_ID));
  });
});
