import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeXml, UnsafeXmlError } from "@healthbridge/adapters";
import { XmlCdaFormatAdapter } from "../src/xml-cda.js";
import { CsvFormatAdapter, FhirNdjsonFormatAdapter, JsonFormatAdapter } from "../src/index.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

/**
 * Phase F security-suite foundations.
 *
 * Every assertion below targets behaviour the CURRENT code already exhibits:
 * fixtures the guards already refuse, and malformed inputs the adapters
 * already report as issues instead of throwing. If a guard below ever stops
 * refusing, this suite goes red — that is the point. Nothing here weakens a
 * guard; missing guards are reported in docs/security.md, not added here.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/security-fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

function contextFor(
  adapter: MedicalFormatAdapter,
  options?: Record<string, unknown>,
  maxRecords?: number,
): ParseContext {
  // NOTE: `maxRecords` is a top-level ParseContext field (not inside
  // `options`): every built-in adapter reads `context.maxRecords`.
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

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("security suite foundations (Phase F)", () => {
  const xml = new XmlCdaFormatAdapter();

  describe("XXE / entity expansion is refused before parsing", () => {
    for (const fixture of ["xxe-cda-bomb.xml", "entity-expansion-bomb.xml"]) {
      test(`${fixture}: kit guard throws UnsafeXmlError`, () => {
        const text = readFixture(fixture);
        assert.throws(() => assertSafeXml(text), UnsafeXmlError);
        assert.throws(() => assertSafeXml(text), /DOCTYPE|ENTITY/);
      });

      test(`${fixture}: xml-cda inspect/parse reject, detect refuses without throwing`, async () => {
        const text = readFixture(fixture);
        const input: InputDescriptor = { id: `sec-${fixture}`, filename: fixture, contentString: text };

        await assert.rejects(xml.inspect(input), UnsafeXmlError);
        await assert.rejects(collect(xml, input, contextFor(xml)), UnsafeXmlError);
        assert.equal(await xml.detect(input), false);
      });
    }

    test("the kit guard also refuses inline DOCTYPE/ENTITY payloads (defence in depth)", () => {
      assert.throws(
        () => assertSafeXml(`<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`),
        UnsafeXmlError,
      );
      assert.throws(() => assertSafeXml(`<root><!ENTITY lol "x"></root>`), UnsafeXmlError);
      assert.doesNotThrow(() => assertSafeXml(`<ClinicalDocument><title>summary</title></ClinicalDocument>`));
    });
  });

  describe("oversized inputs are refused or bounded under documented limits", () => {
    test("oversized CDATA (> 1 MiB with CDATA) is refused with the documented limit", async () => {
      const file = path.join(FIXTURES, "oversized-cdata.xml");
      assert.equal(fs.statSync(file).size > 1024 * 1024, true, "fixture must pin the > 1 MiB limit");
      const text = fs.readFileSync(file, "utf-8");
      assert.ok(text.includes("<![CDATA["), "fixture must carry a CDATA section");

      assert.throws(() => assertSafeXml(text), /Oversized CDATA/);
      const input: InputDescriptor = {
        id: "sec-oversized-cdata",
        filename: "oversized-cdata.xml",
        contentString: text,
      };
      await assert.rejects(xml.inspect(input), UnsafeXmlError);
      await assert.rejects(collect(xml, input, contextFor(xml)), UnsafeXmlError);
      assert.equal(await xml.detect(input), false);
    });

    test("small CDATA stays accepted (no false positive from the oversize guard)", async () => {
      const text = `<root><![CDATA[${"A".repeat(100)}]]></root>`;
      assert.doesNotThrow(() => assertSafeXml(text));
      assert.equal(await xml.detect({ id: "sec-small-cdata", filename: "note.xml", contentString: text }), true);
    });

    test("oversized CSV is bounded by maxRecords (documented bound, no byte cap at adapter level)", async () => {
      const csv = new CsvFormatAdapter();
      const text = readFixture("oversized-records.csv");
      const input: InputDescriptor = {
        id: "sec-oversized-csv",
        filename: "oversized-records.csv",
        contentString: text,
      };

      const full = await collect(csv, input, contextFor(csv));
      assert.equal(full.envelopes.length, 5000);

      const bounded = await collect(csv, input, contextFor(csv, undefined, 100));
      assert.equal(bounded.envelopes.length, 100);
      assert.deepEqual(
        bounded.envelopes.map((envelope) => envelope.provenance.recordIndex),
        Array.from({ length: 100 }, (_, index) => index),
      );
    });
  });

  describe("zip-bomb-shaped nested structure scans without expansion", () => {
    test("nested-structure-bomb.xml completes: one envelope, reported depth/counts, no fatal issue", async () => {
      const text = readFixture("nested-structure-bomb.xml");
      assert.doesNotThrow(() => assertSafeXml(text));
      const input: InputDescriptor = {
        id: "sec-nested-bomb",
        filename: "nested-structure-bomb.xml",
        contentString: text,
      };

      assert.equal(await xml.detect(input), true);
      const inspection = await xml.inspect(input);
      assert.ok(
        inspection.warnings?.some((warning) => warning.includes("Elements: 22003")),
        `expected 22003 scanned elements (got ${inspection.warnings?.join(" | ")})`,
      );

      const { envelopes, issues } = await collect(xml, input, contextFor(xml));
      assert.equal(envelopes.length, 1);
      assert.equal(envelopes[0].metadata.maxDepth, 2002);
      assert.equal(envelopes[0].metadata.elementCount, 22003);
      assert.deepEqual(
        issues.filter((issue) => issue.severity === "fatal"),
        [],
      );
    });
  });

  describe("malformed inputs report issues instead of throwing", () => {
    test("malformed JSON reports MALFORMED_JSON and yields no envelopes", async () => {
      const json = new JsonFormatAdapter();
      const input: InputDescriptor = { id: "sec-malformed-json", filename: "broken.json", contentString: "{not valid" };
      const { envelopes, issues } = await collect(json, input, contextFor(json));
      assert.equal(envelopes.length, 0);
      assert.ok(codes(issues).includes("MALFORMED_JSON"));
      assert.equal(issues.find((issue) => issue.code === "MALFORMED_JSON")?.severity, "fatal");

      const inspection = await json.inspect(input);
      assert.equal(inspection.recordCount, 0);
      assert.ok(inspection.warnings?.some((warning) => warning.includes("Malformed JSON")));
    });

    test("malformed FHIR NDJSON line is skipped with a warning, valid lines survive", async () => {
      const fhir = new FhirNdjsonFormatAdapter();
      // NOTE: every line must stay brace-shaped: a non-JSON-looking line makes
      // the whole payload fall back to single-document parsing (MALFORMED_JSON),
      // which is itself still an issue-not-throw outcome. A brace-shaped but
      // unparseable line is skipped with MALFORMED_NDJSON_LINE.
      const input: InputDescriptor = {
        id: "sec-malformed-ndjson",
        filename: "bundle.ndjson",
        contentString: [
          '{"resourceType":"Patient","id":"p-a"}',
          '{"resourceType": broken,}',
          '{"resourceType":"Patient","id":"p-b"}',
        ].join("\n"),
      };
      const { envelopes, issues } = await collect(fhir, input, contextFor(fhir));
      assert.equal(envelopes.length, 2);
      assert.ok(codes(issues).includes("MALFORMED_NDJSON_LINE"));
    });

    test("ragged CSV rows report RAGGED_ROW and keep their data (plus __extra)", async () => {
      const csv = new CsvFormatAdapter();
      const input: InputDescriptor = {
        id: "sec-ragged-csv",
        filename: "ragged.csv",
        contentString: "a,b,c\n1,2\n1,2,3,4\n",
      };
      // NOTE: ragged-row problems ride on `envelope.parseIssues` (per record),
      // not on the shared onIssue channel — both are issues, neither throws.
      const { envelopes } = await collect(csv, input, contextFor(csv));
      assert.equal(envelopes.length, 2);
      const recordIssues = envelopes.flatMap((envelope) => envelope.parseIssues ?? []);
      assert.ok(codes(recordIssues).includes("RAGGED_ROW"));
      assert.ok(recordIssues.every((issue) => issue.severity === "warning"));
      assert.deepEqual((envelopes[1].content.data as Record<string, unknown>).__extra, ["4"]);
    });

    test("unbalanced XML reports XML_UNBALANCED_TAGS and still yields its envelope", async () => {
      const input: InputDescriptor = {
        id: "sec-unbalanced-xml",
        filename: "unbalanced.xml",
        contentString: "<root><a><b></a></root>",
      };
      const { envelopes, issues } = await collect(xml, input, contextFor(xml));
      assert.equal(envelopes.length, 1);
      assert.ok(codes(issues).includes("XML_UNBALANCED_TAGS"));
    });

    test("empty XML reports XML_EMPTY_INPUT and yields nothing (no throw)", async () => {
      const input: InputDescriptor = { id: "sec-empty-xml", filename: "empty.xml", contentString: "   " };
      const { envelopes, issues } = await collect(xml, input, contextFor(xml));
      assert.equal(envelopes.length, 0);
      assert.ok(codes(issues).includes("XML_EMPTY_INPUT"));
    });

    test("unterminated CSV quote is a warning on inspect, never a throw", async () => {
      const csv = new CsvFormatAdapter();
      const inspection = await csv.inspect({
        id: "sec-unterminated-csv",
        filename: "unterminated.csv",
        contentString: 'a,b\n"unterminated,cell\nx,y\n',
      });
      assert.ok(inspection.warnings?.some((warning) => warning.includes("unterminated quote")));
    });
  });
});
