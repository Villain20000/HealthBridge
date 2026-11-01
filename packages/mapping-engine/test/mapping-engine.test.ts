import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MappingEngine,
  TRANSFORM_FUNCTIONS,
  applyTransform,
  getPath,
  setPath,
  parseDateValue,
  type MappingDefinition,
  type MappingRule,
} from "@healthbridge/mapping-engine";

const engine = new MappingEngine();

function rule(
  partial: Partial<MappingRule> & Pick<MappingRule, "id" | "sourcePath" | "targetPath" | "transform">,
): MappingRule {
  return { ...partial };
}

function mapping(rules: MappingRule[]): MappingDefinition {
  return {
    id: "test-mapping",
    name: "Test mapping",
    version: "1.0.0",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    rules,
  };
}

describe("path handling", () => {
  test("writes FHIR-valid arrays for 0-based path segments", () => {
    const target: Record<string, unknown> = { resourceType: "Patient" };
    setPath(target, "name.0.given.0", "Jane");
    setPath(target, "name.0.family", "Doe");
    setPath(target, "identifier.0.system", "urn:oid:1.2.3");
    setPath(target, "identifier.0.value", "P101");

    assert.deepEqual(target, {
      resourceType: "Patient",
      name: [{ given: ["Jane"], family: "Doe" }],
      identifier: [{ system: "urn:oid:1.2.3", value: "P101" }],
    });
  });

  test("supports sparse indexes and reading back", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "address.2.city", "Boston");
    assert.deepEqual(getPath(target, "address.2.city"), "Boston");
    assert.equal(getPath(target, "address.0.city"), undefined);
  });

  test("overwrites leaf values idempotently", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "name.0.family", "A");
    setPath(target, "name.0.family", "B");
    assert.deepEqual(target, { name: [{ family: "B" }] });
  });
});

describe("date parsing is deterministic", () => {
  test("accepts ISO dates and datetimes", () => {
    assert.deepEqual(parseDateValue("1985-04-12"), { ok: true, value: "1985-04-12" });
    assert.deepEqual(parseDateValue("1985-04-12T10:00:00Z"), { ok: true, value: "1985-04-12" });
  });

  test("rejects impossible calendar dates", () => {
    assert.equal(parseDateValue("2024-02-30").ok, false);
    assert.equal(parseDateValue("2023-02-29").ok, false);
    assert.deepEqual(parseDateValue("2024-02-29"), { ok: true, value: "2024-02-29" });
  });

  test("rejects ambiguous slash dates instead of guessing", () => {
    assert.deepEqual(parseDateValue("03/04/2024"), { ok: false, reason: "ambiguous" });
    assert.deepEqual(parseDateValue("13/04/2024"), { ok: true, value: "2024-04-13" });
  });

  test("honours an explicit input format", () => {
    assert.deepEqual(parseDateValue("03/04/2024", "DD/MM/YYYY"), { ok: true, value: "2024-04-03" });
    assert.deepEqual(parseDateValue("03/04/2024", "MM/DD/YYYY"), { ok: true, value: "2024-03-04" });
  });
});

describe("transforms", () => {
  test("every declared transform is implemented and never silently passes through", () => {
    const samples: Record<string, string> = {
      identity: "42",
      uppercase: "42",
      lowercase: "42",
      trim: "42",
      concat: "42",
      split: "42",
      number_to_string: "42",
      string_to_number: "42",
      default_value: "42",
      parse_date_iso: "2024-01-02",
      format_gender_fhir: "F",
      to_reference: "P100",
      codeable_concept: "2345-7",
    };
    const extraParams: Record<string, Record<string, unknown>> = {
      codeable_concept: { system: "http://loinc.org" },
      convert_units: { from: "mg/dL", to: "g/L" },
    };
    for (const kind of TRANSFORM_FUNCTIONS) {
      const outcome = applyTransform(
        samples[kind] ?? "42",
        rule({
          id: "r",
          sourcePath: "a",
          targetPath: "b",
          transform: kind,
          defaultValue: "default",
          params: extraParams[kind],
        }),
        { a: samples[kind] ?? "42" },
      );
      assert.equal(outcome.ok, true, `transform '${kind}' should succeed for a representative value`);
      assert.notEqual(outcome.value, undefined, `transform '${kind}' returned no value`);
    }
    assert.equal(TRANSFORM_FUNCTIONS.length, 14);
  });

  test("an unhandled transform kind is a hard error, not a silent pass-through", () => {
    assert.throws(
      () =>
        applyTransform(
          "x",
          rule({ id: "r", sourcePath: "a", targetPath: "b", transform: "not-a-transform" as never }),
          {},
        ),
      /Unhandled transform/,
    );
  });

  test("concat joins multiple source paths", () => {
    const outcome = applyTransform(
      "ignored",
      rule({
        id: "r",
        sourcePath: "first_name",
        targetPath: "text",
        transform: "concat",
        params: { paths: ["first_name", "last_name"], separator: " " },
      }),
      { first_name: "Jane", last_name: "Doe" },
    );
    assert.deepEqual(outcome, { ok: true, value: "Jane Doe" });
  });

  test("split selects a segment and reports out-of-range indexes", () => {
    const ok = applyTransform(
      "Doe, Jane, Dr",
      rule({ id: "r", sourcePath: "n", targetPath: "t", transform: "split", params: { separator: ", ", index: 1 } }),
      {},
    );
    assert.deepEqual(ok, { ok: true, value: "Jane" });

    const bad = applyTransform(
      "a,b",
      rule({ id: "r", sourcePath: "n", targetPath: "t", transform: "split", params: { separator: ",", index: 5 } }),
      {},
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.issue?.code, "SPLIT_INDEX_OUT_OF_RANGE");
  });

  test("string_to_number respects locale separators and rejects junk", () => {
    const ok = applyTransform(
      "1.234,56",
      rule({
        id: "r",
        sourcePath: "v",
        targetPath: "t",
        transform: "string_to_number",
        params: { decimalSeparator: ",", thousandsSeparator: "." },
      }),
      {},
    );
    assert.deepEqual(ok, { ok: true, value: 1234.56 });

    const bad = applyTransform(
      "abc",
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "string_to_number" }),
      {},
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.issue?.code, "INVALID_NUMBER");
  });

  test("gender mapping normalises known codes and flags unknown ones", () => {
    const male = applyTransform(
      "M",
      rule({ id: "r", sourcePath: "g", targetPath: "gender", transform: "format_gender_fhir" }),
      {},
    );
    assert.deepEqual(male.value, "male");

    const unknown = applyTransform(
      "Z",
      rule({ id: "r", sourcePath: "g", targetPath: "gender", transform: "format_gender_fhir" }),
      {},
    );
    assert.equal(unknown.value, "unknown");
    assert.equal(unknown.issue?.code, "GENDER_CODE_UNMAPPED");
  });
});

describe("mapping execution", () => {
  const patientMapping = mapping([
    rule({ id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true }),
    rule({ id: "r2", sourcePath: "first_name", targetPath: "name.0.given.0", transform: "trim" }),
    rule({ id: "r3", sourcePath: "last_name", targetPath: "name.0.family", transform: "uppercase" }),
    rule({ id: "r4", sourcePath: "gender", targetPath: "gender", transform: "format_gender_fhir" }),
    rule({ id: "r5", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" }),
  ]);

  test("produces array-shaped target data", () => {
    const result = engine.execute(
      { patient_id: "P101", first_name: "Jane", last_name: "Doe", gender: "F", birth_date: "1990-11-23" },
      patientMapping,
    );
    assert.deepEqual(result.targetData, {
      id: "P101",
      name: [{ given: ["Jane"], family: "DOE" }],
      gender: "female",
      birthDate: "1990-11-23",
    });
    assert.equal(result.issues.length, 0);
    assert.ok(result.ruleResults.every((r) => r.status === "mapped"));
  });

  test("missing required field blocks the record and is reported", () => {
    const result = engine.execute({ first_name: "Jane" }, patientMapping);
    const missing = result.issues.find((i) => i.code === "MISSING_REQUIRED_FIELD");
    assert.ok(missing);
    assert.equal(missing?.severity, "error");
    assert.ok(result.ruleResults.some((r) => r.ruleId === "r1" && r.status === "rejected"));
  });

  test("coverage works on leaf paths, not just top-level keys", () => {
    const result = engine.execute(
      { patient_id: "P1", first_name: "A", last_name: "B", unknown_field: "x", nested: { deep: 1 } },
      patientMapping,
    );
    assert.deepEqual(result.coverage.unmappedSourceFields.sort(), ["nested.deep", "unknown_field"]);
    assert.equal(result.coverage.totalSourceFields, 5);
    assert.ok(result.coverage.coveragePercentage > 0 && result.coverage.coveragePercentage < 100);
  });

  test("rejected values are counted and excluded from the target", () => {
    const result = engine.execute({ patient_id: "P1", birth_date: "not-a-date" }, patientMapping);
    assert.equal(result.targetData.birthDate, undefined);
    assert.ok(result.coverage.rejectedValuesCount >= 1);
    assert.ok(result.issues.some((i) => i.code === "INVALID_DATE_FORMAT"));
  });

  test("conditions gate rule execution", () => {
    const conditional = mapping([
      rule({ id: "r1", sourcePath: "id", targetPath: "id", transform: "identity" }),
      rule({
        id: "r2",
        sourcePath: "note",
        targetPath: "text",
        transform: "trim",
        when: [{ path: "note", op: "matches", value: "^keep" }],
      }),
    ]);
    const kept = engine.execute({ id: "1", note: "keep me" }, conditional);
    assert.equal(kept.targetData.text, "keep me");
    const skipped = engine.execute({ id: "1", note: "drop me" }, conditional);
    assert.equal(skipped.targetData.text, undefined);
    assert.ok(skipped.ruleResults.some((r) => r.ruleId === "r2" && r.status === "condition_not_met"));
  });

  test("mapping validation catches structural mistakes before execution", () => {
    const issues = engine.validate(
      mapping([
        rule({ id: "dup", sourcePath: "a", targetPath: "x", transform: "identity" }),
        rule({ id: "dup", sourcePath: "b", targetPath: "x", transform: "nope" as never }),
      ]),
    );
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes("MAPPING_DUPLICATE_RULE_ID"));
    assert.ok(codes.includes("MAPPING_UNKNOWN_TRANSFORM"));
    assert.ok(codes.includes("MAPPING_DUPLICATE_TARGET"));
  });
});
