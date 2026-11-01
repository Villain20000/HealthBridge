import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { runAdapterConformance } from "@healthbridge/adapters";
import {
  XlsxFormatAdapter,
  columnIndexToLetters,
  columnLettersToIndex,
  decodeXmlEntities,
  excelSerialToIso,
  isDateFormatCode,
  listZipEntries,
  parseMergedRanges,
  parseSharedStrings,
  parseStyles,
  parseWorkbookXml,
  splitCellRef,
  streamSheetRecords,
  streamSheetRows,
} from "../src/xlsx.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// Minimal OOXML builders (in-test fixtures; no new dependencies)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Array<{ name: string; text: string; method?: "store" | "deflate" }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.text, "utf-8");
    const method = file.method === "store" ? 0 : 8;
    const compressed = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(file.name, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" ` +
  `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
  `<sheet name="Labs" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/>` +
  `</sheets></workbook>`;

const WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${NS_PKG}">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
  `</Relationships>`;

const SHARED = [
  "patient_id",
  "result_value",
  "collected_on",
  "flag",
  "cached_formula",
  "note",
  "custom_date",
  "P007",
  "comment",
  "text",
];

const SHARED_STRINGS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<sst xmlns="${NS_MAIN}" count="${SHARED.length}" uniqueCount="${SHARED.length}">` +
  SHARED.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("") +
  `</sst>`;

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="${NS_MAIN}">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
  `<fonts count="1"><font><sz val="11"/></font></fonts>` +
  `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs></styleSheet>`;

const LABS_SHEET =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="${NS_MAIN}"><dimension ref="A1:G4"/><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>` +
  `<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c>` +
  `<c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c></row>` +
  `<row r="2"><c r="A2" t="s"><v>7</v></c><c r="B2"><v>7.2</v></c>` +
  `<c r="C2" s="1"><v>44927</v></c><c r="D2" t="b"><v>1</v></c>` +
  `<c r="E2" t="str"><f>1+1</f><v>999</v></c>` +
  `<c r="F2" t="inlineStr"><is><t>ok</t></is></c><c r="G2" s="2"><v>44927</v></c></row>` +
  `<row r="3"><c r="B3" t="e"><v>#DIV/0!</v></c></row>` +
  `<row r="4"></row>` +
  `</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;

const NOTES_SHEET =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="${NS_MAIN}"><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>8</v></c><c r="B1" t="s"><v>9</v></c></row>` +
  `<row r="2"><c r="A2" t="inlineStr"><is><t>n/a</t></is></c><c r="B2"><v>3</v></c></row>` +
  `</sheetData></worksheet>`;

function labsWorkbook(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", text: CONTENT_TYPES },
    { name: "_rels/.rels", text: ROOT_RELS },
    { name: "xl/workbook.xml", text: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", text: WORKBOOK_RELS },
    { name: "xl/sharedStrings.xml", text: SHARED_STRINGS },
    { name: "xl/styles.xml", text: STYLES, method: "store" },
    { name: "xl/worksheets/sheet1.xml", text: LABS_SHEET },
    { name: "xl/worksheets/sheet2.xml", text: NOTES_SHEET },
  ]);
}

/** Workbook exercising blank + duplicate header fallback (no shared strings, no styles). */
function headerFallbackWorkbook(): Buffer {
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    `<sheet name="H" sheetId="1" r:id="rId9"/></sheets></workbook>`;
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${NS_MAIN}"><sheetData>` +
    `<row r="1"><c r="B1" t="inlineStr"><is><t>x</t></is></c>` +
    `<c r="C1" t="inlineStr"><is><t>x</t></is></c></row>` +
    `<row r="2"><c r="B2" t="inlineStr"><is><t>v</t></is></c></row>` +
    `</sheetData></worksheet>`;
  return buildZip([
    { name: "xl/workbook.xml", text: workbook, method: "store" },
    { name: "xl/worksheets/sheet1.xml", text: sheet, method: "store" },
  ]);
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

describe("XLSX structural helpers", () => {
  test("column letters round-trip", () => {
    assert.equal(columnLettersToIndex("A"), 0);
    assert.equal(columnLettersToIndex("Z"), 25);
    assert.equal(columnLettersToIndex("AA"), 26);
    assert.equal(columnLettersToIndex("BC"), 54);
    assert.equal(columnIndexToLetters(0), "A");
    assert.equal(columnIndexToLetters(25), "Z");
    assert.equal(columnIndexToLetters(26), "AA");
    assert.equal(columnIndexToLetters(54), "BC");
    assert.deepEqual(splitCellRef("BC12"), { columnIndex: 54, rowNumber: 12 });
    assert.equal(splitCellRef("nope"), null);
  });

  test("date serials convert against both epochs and reject garbage", () => {
    assert.equal(excelSerialToIso(25569), "1970-01-01T00:00:00.000Z");
    assert.equal(excelSerialToIso(44927), "2023-01-01T00:00:00.000Z");
    assert.equal(excelSerialToIso(0, true), "1904-01-01T00:00:00.000Z");
    assert.equal(excelSerialToIso(-1), null);
    assert.equal(excelSerialToIso(9999999), null);
    assert.equal(excelSerialToIso(Number.NaN), null);
  });

  test("format-code date heuristic separates dates from plain numbers", () => {
    assert.equal(isDateFormatCode("yyyy-mm-dd"), true);
    assert.equal(isDateFormatCode("h:mm"), true);
    assert.equal(isDateFormatCode("mm:ss"), true);
    assert.equal(isDateFormatCode("General"), false);
    assert.equal(isDateFormatCode("#,##0.00"), false);
    assert.equal(isDateFormatCode('"$"#,##0'), false);
  });

  test("xml entities decode structurally", () => {
    assert.equal(decodeXmlEntities("&lt;A&gt; &amp; &#65;&#x42;"), "<A> & AB");
  });

  test("workbook, strings, styles and merges parse structurally", () => {
    const workbook = parseWorkbookXml(WORKBOOK);
    assert.deepEqual(
      workbook.sheets.map((s) => s.name),
      ["Labs", "Notes"],
    );
    assert.equal(workbook.date1904, false);
    const strings = parseSharedStrings(SHARED_STRINGS);
    assert.equal(strings.length, SHARED.length);
    assert.equal(strings[0], "patient_id");
    const styles = parseStyles(STYLES);
    assert.deepEqual(styles.isDateStyle, [false, true, true]);
    assert.deepEqual(parseMergedRanges(LABS_SHEET), ["A1:B1"]);
    assert.deepEqual(parseMergedRanges(NOTES_SHEET), []);
  });

  test("row streaming yields rows lazily in document order", () => {
    const generator = streamSheetRows(LABS_SHEET);
    const first = generator.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.rowNumber, 1);
    assert.equal(first.value?.cells.length, 7);
    const second = generator.next();
    assert.equal(second.value?.rowNumber, 2);
    // The record stream leads with headers, then one event per data row, then a summary.
    const events = [...streamSheetRecords(LABS_SHEET, SHARED, parseStyles(STYLES), false)];
    assert.equal(events[0]?.kind, "headers");
    assert.equal(events[events.length - 1]?.kind, "end");
    const records = events.filter((e) => e.kind === "record");
    assert.equal(records.length, 2);
  });

  test("zip directory lists entries without inflating them", () => {
    const names = listZipEntries(labsWorkbook()).map((e) => e.name);
    assert.ok(names.includes("xl/workbook.xml"));
    assert.ok(names.includes("xl/worksheets/sheet1.xml"));
  });
});

describe("XLSX adapter", () => {
  const adapter = new XlsxFormatAdapter();

  test("manifest is honestly metadata-only with no FHIR transform", () => {
    const manifest = adapter.getManifest();
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.ok(manifest.extensions?.includes(".xlsx"));
    assert.ok(manifest.extensions?.includes(".xlsm"));
    assert.ok(manifest.limitations?.some((l) => l.includes("never evaluated")));
    assert.ok(manifest.limitations?.some((l) => l.includes("Merged ranges")));
    assert.ok(manifest.limitations?.some((l) => l.includes("Legacy binary .xls")));
    assert.ok(manifest.limitations?.some((l) => l.includes("no clinical interpretation")));
  });

  test("detects by extension and ZIP+content sniffing, never legacy .xls", async () => {
    const bytes = labsWorkbook();
    assert.equal(await adapter.detect({ id: "x-1", filename: "labs.xlsx", buffer: bytes }), true);
    assert.equal(await adapter.detect({ id: "x-2", filename: "macros.xlsm", buffer: bytes }), true);
    assert.equal(await adapter.detect({ id: "x-3", filename: "legacy.xls", buffer: bytes }), false);
    assert.equal(await adapter.detect({ id: "x-4", filename: "mystery.bin", buffer: bytes }), true);
    const plainZip = buildZip([{ name: "hello.txt", text: "hi" }]);
    assert.equal(await adapter.detect({ id: "x-5", filename: "mystery.bin", buffer: plainZip }), false);
    assert.equal(await adapter.detect({ id: "x-6", filename: "note.csv", contentString: "a,b\n1,2\n" }), false);
    assert.equal(await adapter.detect({ id: "x-7", filename: "note.json", contentString: '[{"a": 1}]' }), false);
    assert.equal(
      await adapter.detect({
        id: "x-8",
        filename: "note.fhir.json",
        contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
      }),
      false,
    );
  });

  test("parses typed cells structurally with cached formulas", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "x-10", filename: "labs.xlsx", buffer: labsWorkbook() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 3);
    const first = structuredData(envelopes[0]);
    const values = first["values"] as Record<string, unknown>;
    assert.deepEqual(values, {
      patient_id: "P007",
      result_value: 7.2,
      collected_on: "2023-01-01T00:00:00.000Z",
      flag: true,
      cached_formula: "999",
      note: "ok",
      custom_date: "2023-01-01T00:00:00.000Z",
    });
    assert.deepEqual(first["cellTypes"], {
      patient_id: "text",
      result_value: "number",
      collected_on: "date",
      flag: "boolean",
      cached_formula: "text",
      note: "text",
      custom_date: "date",
    });
    // The cached value is carried verbatim — 1+1 was never evaluated to 2.
    assert.deepEqual(first["formulas"], { cached_formula: "1+1" });
    assert.equal(first["formulasEvaluated"], false);
    assert.deepEqual(first["dateSerials"], { collected_on: 44927, custom_date: 44927 });

    const recordIssues = envelopes[0].parseIssues ?? [];
    assert.ok(recordIssues.some((i) => i.code === "XLS_FORMULA_CACHED"));

    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("XLS_MERGED_CELLS"));
    assert.ok(codes.includes("XLS_FORMULA_CACHED"));

    // Error tokens are carried verbatim with an explicit per-record warning.
    const errorRow = structuredData(envelopes[1]);
    const errorValues = errorRow["values"] as Record<string, unknown>;
    assert.equal(errorValues["result_value"], "#DIV/0!");
    assert.deepEqual((errorRow["cellTypes"] as Record<string, unknown>)["result_value"], "error");
    assert.ok((envelopes[1].parseIssues ?? []).some((i) => i.code === "XLS_ERROR_CELL"));
  });

  test("provenance spans sheets with checksum, locations and global indexes", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "x-11", filename: "labs.xlsx", buffer: labsWorkbook() },
      { ...contextFor(adapter), importedAt: "2026-01-01T00:00:00.000Z" },
    );
    assert.equal(envelopes.length, 3);
    assert.deepEqual(
      envelopes.map((e) => e.provenance.sourceLocation),
      ["sheet 'Labs' row 2", "sheet 'Labs' row 3", "sheet 'Notes' row 2"],
    );
    assert.deepEqual(
      envelopes.map((e) => e.provenance.recordIndex),
      [0, 1, 2],
    );
    for (const envelope of envelopes) {
      assert.match(String(envelope.source.checksum), /^sha256:[a-f0-9]{64}$/);
      assert.equal(envelope.source.format, "xlsx");
      assert.equal(envelope.provenance.adapterId, adapter.id);
      assert.equal(envelope.provenance.adapterVersion, adapter.version);
      assert.equal(envelope.provenance.importedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(envelope.metadata["formulasNeverEvaluated"], true);
    }
    // result_value is a laboratory keyword, so the sheet reads as laboratory.
    assert.equal(envelopes[0].domain, "laboratory");
    assert.deepEqual(envelopes[0].metadata["workbookSheets"], ["Labs", "Notes"]);
    assert.equal(envelopes[0].metadata["mergedRangeCount"], 1);
  });

  test("blank and duplicate headers fall back with explicit warnings", async () => {
    const { envelopes, issues } = await collect(
      adapter,
      { id: "x-12", filename: "headers.xlsx", buffer: headerFallbackWorkbook() },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 1);
    assert.deepEqual(structuredData(envelopes[0])["values"] as Record<string, unknown>, {
      ColumnA: null,
      x: "v",
      "x (2)": null,
    });
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("XLS_BLANK_HEADER"));
    assert.ok(codes.includes("XLS_DUPLICATE_HEADER"));
  });

  test("legacy .xls is refused with an explicit issue, never sniffed", async () => {
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    assert.equal(await adapter.detect({ id: "x-13", filename: "legacy.xls", buffer: ole2 }), false);
    const { envelopes, issues } = await collect(
      adapter,
      { id: "x-14", filename: "legacy.xls", buffer: ole2 },
      contextFor(adapter),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(issues.some((i) => i.code === "XLS_LEGACY_XLS_REFUSED" && i.severity === "error"));
    const inspection = await adapter.inspect({ id: "x-15", filename: "legacy.xls", buffer: ole2 });
    assert.equal(inspection.recordCount, 0);
    assert.ok(inspection.warnings?.some((w) => w.includes("Legacy binary .xls")));
  });

  test("non-workbook inputs are reported, never thrown", async () => {
    const notZip = await collect(
      adapter,
      { id: "x-16", filename: "fake.xlsx", buffer: Buffer.from("hello", "utf-8") },
      contextFor(adapter),
    );
    assert.equal(notZip.envelopes.length, 0);
    assert.ok(notZip.issues.some((i) => i.code === "XLS_NOT_A_ZIP"));

    const notWorkbook = await collect(
      adapter,
      {
        id: "x-17",
        filename: "weird.xlsx",
        buffer: buildZip([{ name: "hello.txt", text: "hi" }]),
      },
      contextFor(adapter),
    );
    assert.equal(notWorkbook.envelopes.length, 0);
    assert.ok(notWorkbook.issues.some((i) => i.code === "XLS_NOT_SPREADSHEET"));

    const empty = await collect(
      adapter,
      { id: "x-18", filename: "empty.xlsx", buffer: Buffer.alloc(0) },
      contextFor(adapter),
    );
    assert.equal(empty.envelopes.length, 0);
    assert.ok(empty.issues.some((i) => i.code === "XLS_EMPTY_INPUT"));
  });

  test("inspection reports sheets, columns and counts", async () => {
    const inspection = await adapter.inspect({
      id: "x-19",
      filename: "labs.xlsx",
      buffer: labsWorkbook(),
    });
    assert.equal(inspection.format, "xlsx");
    assert.equal(inspection.domain, "laboratory");
    assert.equal(inspection.recordCount, 3);
    assert.equal(inspection.status, "metadata-only");
    const names = (inspection.detectedSchema?.fields ?? []).map((f) => f.name);
    assert.ok(names.includes("Labs.patient_id"));
    assert.ok(names.includes("Labs.result_value"));
    assert.ok(names.includes("Labs.collected_on"));
    assert.ok(names.includes("Notes.comment"));
    const collected = inspection.detectedSchema?.fields.find((f) => f.name === "Labs.collected_on");
    assert.equal(collected?.type, "date");
    // result_value mixes a number with an error token, so the honest label is string.
    const result = inspection.detectedSchema?.fields.find((f) => f.name === "Labs.result_value");
    assert.equal(result?.type, "string");
    const text = inspection.detectedSchema?.fields.find((f) => f.name === "Notes.text");
    assert.equal(text?.type, "integer");
    assert.ok(inspection.warnings?.some((w) => w.includes("workbook: 2 sheet(s): Labs, Notes")));
    assert.ok(inspection.warnings?.some((w) => w.includes("sheet 'Labs': 2 data row(s) x 7 column(s)")));
    assert.ok(inspection.warnings?.some((w) => w.includes("sheet 'Notes': 1 data row(s) x 2 column(s)")));
    assert.ok(inspection.warnings?.some((w) => w.includes("merged range(s) noted but not expanded")));
    assert.ok(inspection.warnings?.some((w) => w.includes("formulas are never evaluated")));
    assert.equal(inspection.sampleRecords?.length, 3);
  });

  test("maxRecords bounds the streamed rows", async () => {
    const { envelopes } = await collect(
      adapter,
      { id: "x-20", filename: "labs.xlsx", buffer: labsWorkbook() },
      { ...contextFor(adapter), maxRecords: 2 },
    );
    assert.equal(envelopes.length, 2);
    assert.deepEqual(
      envelopes.map((e) => e.provenance.sourceLocation),
      ["sheet 'Labs' row 2", "sheet 'Labs' row 3"],
    );
  });

  test("reports health and satisfies the shared conformance contract", async () => {
    const health = await adapter.health?.();
    assert.equal(health?.ok, true);
    assert.ok(health?.details.includes("xlsx-adapter"));
    assert.deepEqual(await runAdapterConformance(adapter), []);
  });
});
