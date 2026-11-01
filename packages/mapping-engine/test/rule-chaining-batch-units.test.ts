import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MappingEngine,
  applyTransform,
  convertUnits,
  resolveReference,
  type MappingDefinition,
  type MappingRule,
  type RecordResolutionScope,
} from "@healthbridge/mapping-engine";

const engine = new MappingEngine();

function rule(
  partial: Partial<MappingRule> & Pick<MappingRule, "id" | "sourcePath" | "targetPath" | "transform">,
): MappingRule {
  return { ...partial };
}

function mapping(rules: MappingRule[], overrides: Partial<MappingDefinition> = {}): MappingDefinition {
  return {
    id: "test-mapping",
    name: "Test mapping",
    version: "1.0.0",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    rules,
    ...overrides,
  };
}

function scopeFor(source: Record<string, unknown>, produced: Record<string, unknown> = {}): RecordResolutionScope {
  return {
    source,
    ruleOutputs: new Map(Object.entries(produced)),
    knownRuleIds: new Set(["r1", "r2", "r3"]),
  };
}

describe("convert_units transform", () => {
  test("converts within each dimension of the UCUM subset", () => {
    const cases: Array<[number, string, string, number]> = [
      [95, "mg/dL", "g/L", 0.95],
      [1000, "mg", "g", 1],
      [2.5, "g", "mg", 2500],
      [1500, "mL", "L", 1.5],
      [1, "L", "mL", 1000],
      [5, "mmol/L", "umol/L", 5000],
      [10, "cm", "mm", 100],
      [1, "g/dL", "g/L", 10],
      [95, "mg/dL", "mg/dL", 95],
    ];
    for (const [value, from, to, expected] of cases) {
      const result = convertUnits(value, from, to);
      assert.equal(result.ok, true, `${from} -> ${to} should convert`);
      assert.ok(Math.abs((result as { value: number }).value - expected) < 1e-9, `${value} ${from} -> ${to}`);
    }
  });

  test("accepts micro-sign spellings and the documented mcg alias", () => {
    assert.equal(convertUnits(1000, "µg", "mg").ok, true);
    assert.equal(convertUnits(1000, "μg", "mg").ok, true);
    assert.equal(convertUnits(1000, "mcg", "mg").ok, true);
    assert.equal(convertUnits(1, "µL", "uL").ok, true);
  });

  test("rejects unknown units explicitly instead of guessing", () => {
    const from = convertUnits(1, "furlong", "m");
    assert.equal(from.ok, false);
    assert.equal(from.ok ? undefined : from.issue.code, "UNKNOWN_UNIT");

    const to = convertUnits(1, "m", "parsec");
    assert.equal(to.ok, false);
    assert.equal(to.ok ? undefined : to.issue.code, "UNKNOWN_UNIT");
  });

  test("rejects cross-dimension conversions", () => {
    const result = convertUnits(1, "mg", "mL");
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.issue.code, "INCOMPATIBLE_UNITS");
  });

  test("applyTransform honours from/to aliases and rejects junk input", () => {
    const ok = applyTransform(
      "95",
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg/dL", to: "g/L" } }),
      { v: "95" },
    );
    assert.equal(ok.ok, true);
    assert.ok(Math.abs((ok.value as number) - 0.95) < 1e-9);

    const aliased = applyTransform(
      2,
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { fromUnit: "g", toUnit: "mg" } }),
      {},
    );
    assert.equal(aliased.ok, true);
    assert.ok(Math.abs(((aliased as { value: number }).value) - 2000) < 1e-9);

    const missing = applyTransform(
      "95",
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units" }),
      {},
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.issue?.code, "CONVERT_UNITS_MISSING_PARAMS");

    const junk = applyTransform(
      "not-a-number",
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg", to: "g" } }),
      {},
    );
    assert.equal(junk.ok, false);
    assert.equal(junk.issue?.code, "INVALID_NUMBER");

    const badUnit = applyTransform(
      "95",
      rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg/dL", to: "furlong" } }),
      {},
    );
    assert.equal(badUnit.ok, false);
    assert.equal(badUnit.issue?.code, "UNKNOWN_UNIT");
  });

  test("a required convert_units failure escalates to error", () => {
    const result = engine.execute(
      { v: "junk" },
      mapping([rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg", to: "g" }, required: true })]),
    );
    assert.ok(result.issues.some((i) => i.code === "INVALID_NUMBER" && i.severity === "error"));
    assert.ok(result.ruleResults.some((r) => r.status === "rejected"));
  });

  test("static validation pins units at authoring time", () => {
    const missing = engine.validate(
      mapping([rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units" })]),
    );
    assert.ok(missing.some((i) => i.code === "MAPPING_MISSING_UNIT_PARAMS" && i.severity === "error"));

    const unknown = engine.validate(
      mapping([rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg", to: "furlong" } })]),
    );
    assert.ok(unknown.some((i) => i.code === "MAPPING_UNKNOWN_UNIT" && i.severity === "error"));

    const incompatible = engine.validate(
      mapping([rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg", to: "mL" } })]),
    );
    assert.ok(incompatible.some((i) => i.code === "MAPPING_INCOMPATIBLE_UNITS" && i.severity === "error"));

    const good = engine.validate(
      mapping([rule({ id: "r", sourcePath: "v", targetPath: "t", transform: "convert_units", params: { from: "mg/dL", to: "g/L" } })]),
    );
    assert.deepEqual(good, []);
  });
});

describe("rule chaining via __rule.", () => {
  const chained = mapping([
    rule({ id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true }),
    rule({ id: "r2", sourcePath: "__rule.r1", targetPath: "ref", transform: "to_reference", params: { type: "Patient" } }),
  ]);

  test("a rule reads a prior rule's output", () => {
    const result = engine.execute({ patient_id: "P101" }, chained);
    assert.deepEqual(result.targetData, { id: "P101", ref: { reference: "Patient/P101" } });
    assert.deepEqual(result.issues, []);
    assert.ok(result.ruleResults.every((r) => r.status === "mapped"));
  });

  test("chains compose across several hops and sub-paths", () => {
    const multi = mapping([
      rule({ id: "r1", sourcePath: "first", targetPath: "a", transform: "trim" }),
      rule({ id: "r2", sourcePath: "__rule.r1", targetPath: "b", transform: "uppercase" }),
      rule({ id: "r3", sourcePath: "__rule.r2", targetPath: "c", transform: "identity" }),
    ]);
    const result = engine.execute({ first: "  x " }, multi);
    assert.deepEqual(result.targetData, { a: "x", b: "X", c: "X" });
  });

  test("conditions observe prior rule outputs", () => {
    const conditional = mapping([
      rule({ id: "r1", sourcePath: "code", targetPath: "code", transform: "trim" }),
      rule({
        id: "r2",
        sourcePath: "__rule.r1",
        targetPath: "flag",
        transform: "default_value",
        defaultValue: "known",
        when: [{ path: "__rule.r1", op: "equals", value: "A" }],
      }),
    ]);
    assert.equal(engine.execute({ code: "A" }, conditional).targetData.flag, "known");
    const skipped = engine.execute({ code: "B" }, conditional);
    assert.equal(skipped.targetData.flag, undefined);
    assert.ok(skipped.ruleResults.some((r) => r.ruleId === "r2" && r.status === "condition_not_met"));
  });

  test("an unknown rule id is rejected with an explicit issue", () => {
    const result = engine.execute(
      { a: "1" },
      mapping([rule({ id: "r1", sourcePath: "__rule.nope", targetPath: "t", transform: "identity" })]),
    );
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_RULE_REFERENCE" && i.severity === "warning"));
    assert.ok(result.ruleResults.some((r) => r.status === "rejected"));
  });

  test("a forward reference is rejected at runtime and flagged statically", () => {
    const forward = mapping([
      rule({ id: "r1", sourcePath: "__rule.r2", targetPath: "a", transform: "identity" }),
      rule({ id: "r2", sourcePath: "x", targetPath: "b", transform: "identity" }),
    ]);
    const result = engine.execute({ x: "1" }, forward);
    assert.ok(result.issues.some((i) => i.code === "RULE_REFERENCE_NOT_READY"));
    const staticIssues = engine.validate(forward);
    assert.ok(staticIssues.some((i) => i.code === "MAPPING_FORWARD_RULE_REFERENCE" && i.severity === "error"));
  });

  test("a reference to no rule at all is flagged statically", () => {
    const issues = engine.validate(
      mapping([rule({ id: "r1", sourcePath: "__rule.ghost", targetPath: "t", transform: "identity" })]),
    );
    assert.ok(issues.some((i) => i.code === "MAPPING_UNKNOWN_RULE_REFERENCE" && i.severity === "error"));
  });

  test("a required chained rule escalates an unresolvable reference to error", () => {
    const result = engine.execute(
      {},
      mapping([rule({ id: "r1", sourcePath: "__rule.ghost", targetPath: "t", transform: "identity", required: true })]),
    );
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_RULE_REFERENCE" && i.severity === "error"));
  });

  test("resolveReference reads rule outputs, sources and sub-paths", () => {
    assert.deepEqual(resolveReference("__rule.r1", scopeFor({}, { r1: "P1" })), { ok: true, value: "P1" });
    assert.deepEqual(resolveReference("__rule.r1.nested", scopeFor({}, { r1: { nested: 7 } })), {
      ok: true,
      value: 7,
    });
    assert.deepEqual(resolveReference("plain", scopeFor({ plain: "v" })), { ok: true, value: "v" });
    const missing = resolveReference("__rule.late", scopeFor({}));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "UNKNOWN_RULE_REFERENCE");
  });

  test("mappings without the namespace behave exactly as before", () => {
    const plain = mapping([
      rule({ id: "r1", sourcePath: "a", targetPath: "x", transform: "uppercase" }),
    ]);
    const result = engine.execute({ a: "hi", extra: 1 }, plain);
    assert.deepEqual(result.targetData, { x: "HI" });
    assert.deepEqual(result.coverage.unmappedSourceFields, ["extra"]);
  });
});

describe("executeBatch and cross-record context", () => {
  const sources = [
    { patient_id: "P1", name: "Ann" },
    { patient_id: "P2", name: "Bob" },
  ];

  test("without the flag, executeBatch equals per-record execution", () => {
    const plain = mapping([
      rule({ id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true }),
      rule({ id: "r2", sourcePath: "name", targetPath: "label", transform: "uppercase" }),
    ]);
    const batched = engine.executeBatch(sources, plain);
    const single = sources.map((source) => engine.execute(source, plain));
    assert.deepEqual(batched, single);
  });

  test("batch sources are visible via __batch.<index>.<path>", () => {
    const batch = mapping(
      [
        rule({ id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity" }),
        rule({ id: "r2", sourcePath: "__batch.1.patient_id", targetPath: "sibling", transform: "identity" }),
      ],
      { allowCrossRecordContext: true },
    );
    const [first, second] = engine.executeBatch(sources, batch);
    assert.equal(first.targetData.sibling, "P2");
    assert.equal(second.targetData.sibling, "P2");
  });

  test("produced targets are visible via __output.<index>.<path> for earlier records", () => {
    const batch = mapping(
      [
        rule({ id: "r1", sourcePath: "name", targetPath: "label", transform: "uppercase" }),
        rule({ id: "r2", sourcePath: "__output.0.label", targetPath: "firstLabel", transform: "identity" }),
      ],
      { allowCrossRecordContext: true },
    );
    const [, second] = engine.executeBatch(sources, batch);
    assert.equal(second.targetData.firstLabel, "ANN");
  });

  test("a future __output reference is rejected, never read ahead", () => {
    const batch = mapping(
      [rule({ id: "r1", sourcePath: "__output.1.label", targetPath: "x", transform: "identity" })],
      { allowCrossRecordContext: true },
    );
    const [first] = engine.executeBatch(sources, batch);
    assert.ok(first.issues.some((i) => i.code === "BATCH_REFERENCE_NOT_READY"));
  });

  test("an out-of-range batch index is rejected", () => {
    const batch = mapping(
      [rule({ id: "r1", sourcePath: "__batch.9.patient_id", targetPath: "x", transform: "identity" })],
      { allowCrossRecordContext: true },
    );
    const [first] = engine.executeBatch(sources, batch);
    assert.ok(first.issues.some((i) => i.code === "UNKNOWN_BATCH_REFERENCE"));
  });

  test("batch namespaces without the flag are rejected at runtime and flagged statically", () => {
    const noFlag = mapping([
      rule({ id: "r1", sourcePath: "__batch.0.patient_id", targetPath: "x", transform: "identity" }),
    ]);
    const [first] = engine.executeBatch(sources, noFlag);
    assert.ok(first.issues.some((i) => i.code === "UNKNOWN_BATCH_REFERENCE"));
    const issues = engine.validate(noFlag);
    assert.ok(issues.some((i) => i.code === "MAPPING_BATCH_REFERENCE_WITHOUT_CONTEXT" && i.severity === "error"));
  });

  test("executeBatch is pure: inputs are never mutated", () => {
    const batch = mapping(
      [rule({ id: "r1", sourcePath: "__batch.0", targetPath: "everything", transform: "identity" })],
      { allowCrossRecordContext: true },
    );
    const frozen = sources.map((source) => structuredClone(source));
    engine.executeBatch(sources, batch);
    assert.deepEqual(sources, frozen);
  });
});
