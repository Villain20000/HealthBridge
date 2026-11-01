import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FhirValidator } from "@healthbridge/validation";
import {
  LOCAL_TERMINOLOGY_PROVIDER_NAME,
  LocalCodeTableProvider,
  LocalTerminologyError,
  parseLocalCodeTableCsv,
  parseLocalCodeTableJson,
} from "../src/local-terminology.js";

/**
 * SYNTHETIC TEST TABLE ONLY. This is not a clinical code system, makes no
 * validity claim about any real edition, and must never be mistaken for a
 * bundled codeset: production tables are supplied by the operator with a
 * declared licence (see `parseLocalCodeTableJson` / `parseLocalCodeTableCsv`).
 */
const SYNTHETIC_TEST_SYSTEM = "http://example.org/synthetic-test-only";
const SYNTHETIC_TEST_VERSION = "2026-10-31-test";
const SYNTHETIC_TEST_LICENCE = "synthetic-test-only — not a clinical code system, never bundled";

const SYNTHETIC_TEST_JSON = JSON.stringify({
  system: SYNTHETIC_TEST_SYSTEM,
  version: SYNTHETIC_TEST_VERSION,
  licence: SYNTHETIC_TEST_LICENCE,
  codes: [
    { code: "TEST-001", display: "Synthetic alpha" },
    { code: "TEST-002", display: "Synthetic beta" },
  ],
});

const SYNTHETIC_TEST_CSV = [
  `# system: ${SYNTHETIC_TEST_SYSTEM}`,
  `# version: ${SYNTHETIC_TEST_VERSION}`,
  `# licence: ${SYNTHETIC_TEST_LICENCE}`,
  "code,display",
  "TEST-001,Synthetic alpha",
  "TEST-002,Synthetic beta",
].join("\n");

function providerFromJson() {
  return new LocalCodeTableProvider([parseLocalCodeTableJson(SYNTHETIC_TEST_JSON)]);
}

describe("local code-table terminology (licence-safe depth)", () => {
  test("a known code validates and executes level 5 with the provider name", () => {
    const provider = providerFromJson();
    assert.equal(provider.name, LOCAL_TERMINOLOGY_PROVIDER_NAME);
    assert.ok(provider.licence.includes(SYNTHETIC_TEST_LICENCE));
    const outcome = provider.validateCode({ system: SYNTHETIC_TEST_SYSTEM, code: "TEST-001", path: "code.coding[0]" });
    assert.equal(outcome.valid, true);
    assert.deepEqual(outcome.issues, []);

    const validator = new FhirValidator();
    const result = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: SYNTHETIC_TEST_SYSTEM, code: "TEST-001" }] },
      },
      { terminology: provider },
    );
    assert.equal(result.isValid, true);
    assert.deepEqual(result.issues, []);
    const level5 = result.levels.find((l) => l.level === 5);
    assert.equal(level5?.status, "executed");
    assert.equal(level5?.validator, LOCAL_TERMINOLOGY_PROVIDER_NAME);
  });

  test("CSV tables load with metadata and validate the same codes", () => {
    const provider = new LocalCodeTableProvider([parseLocalCodeTableCsv(SYNTHETIC_TEST_CSV)]);
    assert.equal(provider.validateCode({ system: SYNTHETIC_TEST_SYSTEM, code: "TEST-002" }).valid, true);
    const tables = provider.describeTables();
    assert.equal(tables.length, 1);
    assert.equal(tables[0].system, SYNTHETIC_TEST_SYSTEM);
    assert.equal(tables[0].version, SYNTHETIC_TEST_VERSION);
    assert.equal(tables[0].licence, SYNTHETIC_TEST_LICENCE);
    assert.equal(tables[0].codeCount, 2);
  });

  test("every validation reason records the table version", () => {
    const provider = providerFromJson();
    const unknownCode = provider.validateCode({ system: SYNTHETIC_TEST_SYSTEM, code: "NOPE-9", path: "code" });
    assert.equal(unknownCode.valid, false);
    assert.equal(unknownCode.issues[0].code, "UNKNOWN_CODE");
    assert.ok(unknownCode.issues[0].message.includes(SYNTHETIC_TEST_VERSION), "UNKNOWN_CODE must cite the table version");

    const unknownSystem = provider.validateCode({ system: "http://loinc.org", code: "2339-0" });
    assert.equal(unknownSystem.issues[0].code, "UNKNOWN_CODE_SYSTEM");
    assert.ok(
      unknownSystem.issues[0].message.includes(SYNTHETIC_TEST_VERSION),
      "UNKNOWN_CODE_SYSTEM must list loaded table versions",
    );

    const incomplete = provider.validateCode({ code: "TEST-001" });
    assert.equal(incomplete.issues[0].code, "INCOMPLETE_CODING");
    assert.ok(
      incomplete.issues[0].message.includes(SYNTHETIC_TEST_VERSION),
      "INCOMPLETE_CODING must name the loaded table versions",
    );
  });

  test("unknown codes warn without failing the resource", () => {
    const provider = providerFromJson();
    const validator = new FhirValidator();
    const result = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: SYNTHETIC_TEST_SYSTEM, code: "NOPE-9" }] },
      },
      { terminology: provider },
    );
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_CODE"));
    assert.equal(result.levels.find((l) => l.level === 5)?.status, "executed");
    // Warnings, not errors: terminology lookup never invents a structural failure.
    assert.equal(result.isValid, true);
  });

  test("tables without a declared licence are refused explicitly", () => {
    const unlicensedJson = JSON.stringify({
      system: SYNTHETIC_TEST_SYSTEM,
      version: SYNTHETIC_TEST_VERSION,
      codes: [{ code: "TEST-001" }],
    });
    assert.throws(
      () => parseLocalCodeTableJson(unlicensedJson),
      (error: unknown) =>
        error instanceof LocalTerminologyError &&
        error.code === "LOCAL_TERMINOLOGY_LICENCE_MISSING" &&
        /licence/.test(error.message),
    );

    const unlicensedCsv = ["# system: http://example.org/x", "# version: 1", "code", "A"].join("\n");
    assert.throws(
      () => parseLocalCodeTableCsv(unlicensedCsv),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_LICENCE_MISSING",
    );

    assert.throws(
      () =>
        new LocalCodeTableProvider([
          { metadata: { system: SYNTHETIC_TEST_SYSTEM, version: SYNTHETIC_TEST_VERSION, licence: "  " }, entries: [] },
        ]),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_LICENCE_MISSING",
    );
  });

  test("missing system/version metadata is refused with its own code", () => {
    assert.throws(
      () => parseLocalCodeTableJson(JSON.stringify({ version: "1", licence: "x", codes: [] })),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_SYSTEM_MISSING",
    );
    assert.throws(
      () => parseLocalCodeTableJson(JSON.stringify({ system: "s", licence: "x", codes: [] })),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_VERSION_MISSING",
    );
    assert.throws(
      () => parseLocalCodeTableJson("not json"),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_MALFORMED",
    );
    assert.throws(
      () => parseLocalCodeTableCsv("display\nonly-display"),
      (error: unknown) => error instanceof LocalTerminologyError && error.code === "LOCAL_TERMINOLOGY_MALFORMED",
    );
  });

  test("no real codesets ship: licensed systems are unknown to the test tables", () => {
    const provider = providerFromJson();
    for (const system of ["http://loinc.org", "http://snomed.info/sct", "http://hl7.org/fhir/sid/icd-10"]) {
      const outcome = provider.validateCode({ system, code: "whatever" });
      assert.equal(outcome.valid, false);
      assert.equal(outcome.issues[0].code, "UNKNOWN_CODE_SYSTEM");
    }
  });

  test("describeTables exposes metadata only, never code values", () => {
    const provider = providerFromJson();
    const text = JSON.stringify(provider.describeTables());
    assert.ok(!text.includes("TEST-001"), "table summaries must not leak code values");
    assert.ok(!text.includes("Synthetic alpha"), "table summaries must not leak displays");
  });

  test("display values are informational: a wrong display still validates", () => {
    const provider = providerFromJson();
    const outcome = provider.validateCode({ system: SYNTHETIC_TEST_SYSTEM, code: "TEST-001", display: "Wrong label" });
    assert.equal(outcome.valid, true);
  });
});
