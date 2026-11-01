import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CsvFormatAdapter,
  JsonFormatAdapter,
  FhirJsonFormatAdapter,
  FhirNdjsonFormatAdapter,
  readCsvTable,
  buildCsvRecords,
  decodeBuffer,
  sniffDelimiter,
} from "@healthbridge/adapters";
import { AdapterRegistry } from "@healthbridge/core";

const encoder = new TextEncoder();

describe("CSV tokenizer", () => {
  test("handles quoted fields containing the delimiter", () => {
    const table = readCsvTable({ contentString: 'id,name\n1,"Doe, John"\n2,Alice\n' });
    const { records } = buildCsvRecords(table);
    assert.equal(records[0].data.name, "Doe, John");
    assert.equal(table.headers.length, 2);
  });

  test("handles embedded newlines and CRLF line endings", () => {
    const csv = 'id,note\r\n1,"line one\r\nline two"\r\n';
    const table = readCsvTable({ contentString: csv });
    const { records } = buildCsvRecords(table);
    assert.equal(records.length, 1);
    assert.equal(records[0].data.note, "line one\r\nline two");
  });

  test("preserves doubled quotes", () => {
    const table = readCsvTable({ contentString: 'id,quote\n1,"He said ""hi"""\n' });
    const { records } = buildCsvRecords(table);
    assert.equal(records[0].data.quote, 'He said "hi"');
  });

  test("sniffs semicolon and tab delimiters", () => {
    assert.equal(sniffDelimiter("a;b;c\n1;2;3\n").delimiter, ";");
    assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3\n").delimiter, "\t");
    const table = readCsvTable({ contentString: "id;name;city\n1;Jane;Berlin\n2;John;Paris\n" });
    assert.equal(table.delimiter, ";");
    assert.deepEqual(table.headers, ["id", "name", "city"]);
  });

  test("strips UTF-8 BOM", () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encoder.encode("id,name\n1,Jane\n"))]);
    const decoded = decodeBuffer(buffer);
    assert.equal(decoded.encoding, "utf-8-bom");
    assert.equal(decoded.text, "id,name\n1,Jane\n");
    const table = readCsvTable({ buffer });
    assert.deepEqual(table.headers, ["id", "name"]);
  });

  test("decodes UTF-16LE and windows-1252 fallbacks", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("id,name\n1,Jürgen\n", "utf16le")]);
    const decodedUtf16 = decodeBuffer(utf16);
    assert.equal(decodedUtf16.encoding, "utf-16le");
    assert.ok(decodedUtf16.text.includes("Jürgen"));

    const cp1252 = Buffer.concat([
      Buffer.from(encoder.encode("id,name\n1,J")),
      Buffer.from([0xfc]), // ü in windows-1252, invalid as UTF-8
      Buffer.from(encoder.encode("rgen\n")),
    ]);
    const decodedCp = decodeBuffer(cp1252);
    assert.equal(decodedCp.encoding, "windows-1252");
    assert.ok(decodedCp.text.includes("Jürgen"));
  });

  test("reports ragged rows instead of padding silently", () => {
    const table = readCsvTable({ contentString: "a,b\n1,2,3\n4\n" });
    const { records } = buildCsvRecords(table);
    assert.equal(records[0].issues[0].code, "RAGGED_ROW");
    assert.deepEqual(records[0].data.__extra, ["3"]);
    assert.equal(records[1].data.b, "");
    assert.equal(records[1].issues[0].code, "RAGGED_ROW");
  });

  test("renames duplicate and empty headers", () => {
    const table = readCsvTable({ contentString: "id,id,,name\n1,2,3,4\n" });
    assert.deepEqual(table.headers, ["id", "id_2", "column_3", "name"]);
    assert.equal(table.duplicateHeaders.length, 1);
  });

  test("tracks physical line numbers across multiline rows", () => {
    const table = readCsvTable({ contentString: 'id,note\n1,"a\nb"\n2,plain\n' });
    const { records } = buildCsvRecords(table);
    assert.equal(records[0].lineNumber, 2);
    assert.equal(records[1].lineNumber, 4);
  });

  test("flags unterminated quotes", () => {
    const table = readCsvTable({ contentString: 'id,note\n1,"unterminated\n' });
    assert.equal(table.unterminatedQuote, true);
    assert.ok(table.warnings.some((w) => w.includes("unterminated")));
  });
});

describe("CSV adapter", () => {
  const adapter = new CsvFormatAdapter();

  test("parses records into envelopes with provenance and checksum", async () => {
    const input = { id: "in-1", filename: "patients.csv", contentString: "patient_id,first_name\nP1,Jane\nP2,John\n" };
    const envelopes = [];
    for await (const envelope of adapter.parse(input, { adapterId: adapter.id, adapterVersion: adapter.version })) {
      envelopes.push(envelope);
    }
    assert.equal(envelopes.length, 2);
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.sourceLocation, "line 2");
    assert.equal(envelopes[0].classification.sensitivity, "sensitive");
    assert.equal(envelopes[0].metadata.delimiter, ",");
  });

  test("inspection reports schema, domain and warnings", async () => {
    const inspection = await adapter.inspect({
      id: "in-2",
      filename: "labs.csv",
      contentString: "lab_id,loinc_code,result_value,reference_range\nL1,2339-0,95,70-99\n",
    });
    assert.equal(inspection.domain, "laboratory");
    assert.equal(inspection.recordCount, 1);
    assert.ok(inspection.warnings?.some((w) => w.includes("Delimiter")));
    assert.equal(inspection.detectedSchema?.fields[2].type, "integer");
  });

  test("does not detect plain prose as CSV", async () => {
    const score = await adapter.score({
      id: "in-3",
      filename: "note.txt",
      contentString: "This is a clinical note without delimiters.",
    });
    assert.ok(score < 0.5);
  });
});

describe("adapter registry detection", () => {
  const registry = new AdapterRegistry();
  registry.register(new CsvFormatAdapter());
  registry.register(new JsonFormatAdapter());
  registry.register(new FhirJsonFormatAdapter());

  test("prefers the FHIR adapter over generic JSON for FHIR payloads", async () => {
    const input = {
      id: "in-4",
      filename: "patient.json",
      contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
    };
    const best = await registry.detectAdapter(input);
    assert.equal(best?.id, "fhir-r4-json-adapter");
  });

  test("ranks candidates by descending confidence", async () => {
    const candidates = await registry.detect({ id: "in-5", filename: "x.csv", contentString: "a,b\n1,2\n" });
    assert.equal(candidates[0].adapterId, "csv-adapter");
    assert.ok(candidates[0].confidence > 0.5);
  });

  test("returns no candidates for unsupported input", async () => {
    const candidates = await registry.detect({ id: "in-6", filename: "x.bin", contentString: "\u0000\u0001binary" });
    assert.equal(candidates.length, 0);
  });

  test("rejects duplicate adapter registration", () => {
    assert.throws(() => registry.register(new CsvFormatAdapter()), /already registered/);
  });
});

describe("FHIR NDJSON adapter", () => {
  const adapter = new FhirNdjsonFormatAdapter();

  test("reports malformed lines instead of silently dropping them", async () => {
    const input = {
      id: "in-7",
      filename: "resources.ndjson",
      contentString: '{"resourceType":"Patient","id":"p1"}\n{broken json}\n{"resourceType":"Observation","id":"o1"}\n',
    };
    const issues: string[] = [];
    const envelopes = [];
    for await (const envelope of adapter.parse(input, {
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      onIssue: (issue) => issues.push(issue.code),
    })) {
      envelopes.push(envelope);
    }
    assert.equal(envelopes.length, 2);
    assert.deepEqual(issues, ["MALFORMED_NDJSON_LINE"]);
  });

  test("unwraps Bundle entries and keeps sample records", async () => {
    const bundle = {
      resourceType: "Bundle",
      type: "collection",
      entry: [{ resource: { resourceType: "Patient", id: "p1" } }, { resource: { resourceType: "Patient", id: "p2" } }],
    };
    // Bundles stay with the single-resource/Bundle JSON adapter.
    const jsonAdapter = new FhirJsonFormatAdapter();
    const inspection = await jsonAdapter.inspect({
      id: "in-8",
      filename: "bundle.json",
      contentString: JSON.stringify(bundle),
    });
    assert.equal(inspection.recordCount, 2);
  });
});
