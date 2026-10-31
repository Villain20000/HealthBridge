import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MappingDefinition } from "@healthbridge/shared-types";
import {
  COALESCE_WINDOW_MS,
  HISTORY_CAP,
  addRule,
  blankSpec,
  canRedo,
  canUndo,
  createHistory,
  defaultValueProblem,
  formatJsonParam,
  hasBlockingIssue,
  isDirty,
  localChecks,
  moveRule,
  newRule,
  nextRuleId,
  paramFields,
  parseConditionLiteral,
  parseJsonParam,
  parseSpec,
  pushEdit,
  redo,
  removeRule,
  setParam,
  undo,
  updateRule,
} from "../src/app/features/studio/editor/editor.logic";

const base = (): MappingDefinition => ({
  id: "lab",
  name: "lab",
  version: "1.0.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  rules: [
    { id: "rule-1", sourcePath: "a", targetPath: "x", transform: "identity" },
    { id: "rule-2", sourcePath: "b", targetPath: "y", transform: "trim" },
    { id: "rule-3", sourcePath: "c", targetPath: "z", transform: "uppercase" },
  ],
});

const codes = (spec: MappingDefinition): string[] => localChecks(spec).map((issue) => issue.code);

describe("history", () => {
  it("ignores identical specs and clears redo on a new edit", () => {
    const h0 = createHistory(base());
    assert.equal(pushEdit(h0, base(), { now: 0 }), h0);

    const h1 = pushEdit(h0, updateRule(base(), "rule-1", { sourcePath: "q" }), { now: 0 });
    const h2 = undo(h1);
    assert.ok(canRedo(h2));
    const h3 = pushEdit(h2, updateRule(base(), "rule-2", { sourcePath: "w" }), { now: 5000 });
    assert.equal(canRedo(h3), false);
  });

  it("undoes and redoes in order", () => {
    let h = createHistory(base());
    h = pushEdit(h, removeRule(h.present, "rule-3"), { now: 0 });
    h = pushEdit(h, removeRule(h.present, "rule-2"), { now: 1 });
    assert.equal(h.present.rules.length, 1);
    h = undo(h);
    assert.equal(h.present.rules.length, 2);
    h = undo(h);
    assert.equal(h.present.rules.length, 3);
    assert.equal(canUndo(h), false);
    assert.equal(undo(h), h);
    h = redo(h);
    assert.equal(h.present.rules.length, 2);
  });

  it("caps the past at the limit, dropping the oldest", () => {
    let h = createHistory(base());
    for (let i = 0; i < HISTORY_CAP + 50; i++) {
      h = pushEdit(h, updateRule(h.present, "rule-1", { sourcePath: `p${i}` }), { now: i });
    }
    assert.equal(h.past.length, HISTORY_CAP);
    assert.equal(h.past[0]?.rules[0]?.sourcePath, "p49");
  });

  it("coalesces same-field edits inside the window only", () => {
    let h = createHistory(base());
    const edit = (value: string, now: number) => {
      h = pushEdit(h, updateRule(h.present, "rule-1", { sourcePath: value }), { key: "rule-1.sourcePath", now });
    };
    edit("p", 0);
    edit("pa", 300);
    edit("pat", 500);
    assert.equal(h.past.length, 1);
    edit("path", 500 + COALESCE_WINDOW_MS + 1);
    assert.equal(h.past.length, 2);
    assert.equal(h.present.rules[0]?.sourcePath, "path");
  });

  it("does not coalesce different fields, and drops the snapshot when an edit returns to it", () => {
    let h = createHistory(base());
    h = pushEdit(h, updateRule(h.present, "rule-1", { sourcePath: "x1" }), { key: "rule-1.sourcePath", now: 0 });
    h = pushEdit(h, updateRule(h.present, "rule-1", { targetPath: "t1" }), { key: "rule-1.targetPath", now: 10 });
    assert.equal(h.past.length, 2);

    let g = createHistory(base());
    g = pushEdit(g, updateRule(g.present, "rule-1", { sourcePath: "zz" }), { key: "k", now: 0 });
    g = pushEdit(g, base(), { key: "k", now: 100 });
    assert.equal(g.past.length, 0);
    assert.equal(canUndo(g), false);
  });

  it("reports dirty state by content, not identity", () => {
    assert.equal(isDirty(base(), base()), false);
    assert.equal(isDirty(updateRule(base(), "rule-1", { sourcePath: "n" }), base()), true);
    assert.equal(isDirty(base(), null), true);
  });
});

describe("rule edits", () => {
  it("generates unused rule ids", () => {
    assert.equal(nextRuleId(base()), "rule-4");
    assert.equal(nextRuleId(blankSpec("m")), "rule-1");
    const spec = removeRule(base(), "rule-2");
    assert.equal(nextRuleId(spec), "rule-4");
    assert.equal(newRule(spec).id, "rule-4");
  });

  it("adds, removes and moves rules without mutating the input", () => {
    const spec = base();
    const added = addRule(spec, newRule(spec), 0);
    assert.deepEqual(
      added.rules.map((r) => r.id),
      ["rule-4", "rule-1", "rule-2", "rule-3"],
    );
    assert.equal(spec.rules.length, 3);

    assert.deepEqual(
      moveRule(spec, "rule-1", 2).rules.map((r) => r.id),
      ["rule-2", "rule-3", "rule-1"],
    );
    assert.deepEqual(
      moveRule(spec, "rule-3", -5).rules.map((r) => r.id),
      ["rule-3", "rule-1", "rule-2"],
    );
    assert.equal(moveRule(spec, "rule-1", 0), spec);
    assert.equal(moveRule(spec, "nope", 1), spec);
    assert.equal(removeRule(spec, "nope"), spec);
  });

  it("updates fields and removes keys patched with undefined", () => {
    const spec = updateRule(base(), "rule-1", { required: true, description: "d" });
    assert.equal(spec.rules[0]?.required, true);
    const cleared = updateRule(spec, "rule-1", { description: undefined });
    assert.equal("description" in (cleared.rules[0] ?? {}), false);
    assert.equal(updateRule(spec, "nope", { required: false }), spec);
  });

  it("sets and clears transform params, dropping an empty params object", () => {
    let spec = setParam(base(), "rule-1", "separator", "-");
    assert.deepEqual(spec.rules[0]?.params, { separator: "-" });
    spec = setParam(spec, "rule-1", "paths", ["a", "b"]);
    assert.deepEqual(spec.rules[0]?.params, { separator: "-", paths: ["a", "b"] });
    spec = setParam(spec, "rule-1", "separator", "");
    spec = setParam(spec, "rule-1", "paths", []);
    assert.equal("params" in (spec.rules[0] ?? {}), false);
  });
});

describe("paramFields", () => {
  it("describes the parameters the engine reads", () => {
    assert.deepEqual(
      paramFields("split").map((f) => f.key),
      ["separator", "index"],
    );
    assert.deepEqual(
      paramFields("string_to_number").map((f) => f.key),
      ["decimalSeparator", "thousandsSeparator", "integer"],
    );
    const system = paramFields("codeable_concept").find((f) => f.key === "system");
    assert.equal(system?.required, true);
    assert.equal(paramFields("identity").length, 0);
    assert.equal(paramFields("not-a-transform").length, 0);
  });
});

describe("localChecks", () => {
  it("accepts a valid spec", () => {
    assert.deepEqual(localChecks(base()), []);
  });

  it("flags missing top-level fields and an empty rule list", () => {
    const issues = localChecks({ ...blankSpec("m"), sourceFormat: "", targetFormat: "" });
    assert.deepEqual(
      issues.map((i) => i.code),
      ["MAPPING_MISSING_FIELD", "MAPPING_MISSING_FIELD", "MAPPING_EMPTY"],
    );
    assert.deepEqual(
      issues.filter((i) => i.code === "MAPPING_MISSING_FIELD").map((i) => i.path),
      ["sourceFormat", "targetFormat"],
    );
  });

  it("flags rule problems with the server's codes and paths", () => {
    const spec = base();
    spec.rules = [
      { id: "r", sourcePath: "", targetPath: "t", transform: "identity" },
      { id: "r", sourcePath: "s", targetPath: "t", transform: "default_value" },
      { id: "q", sourcePath: "s", targetPath: "u", transform: "bogus" as never },
      { id: "p", sourcePath: "s", targetPath: "v", transform: "identity", when: [{ path: "", op: "exists" }] },
    ];
    const found = localChecks(spec);
    assert.deepEqual(found.map((i) => i.code).sort(), [
      "MAPPING_DUPLICATE_RULE_ID",
      "MAPPING_DUPLICATE_TARGET",
      "MAPPING_INVALID_CONDITION",
      "MAPPING_MISSING_DEFAULT_VALUE",
      "MAPPING_MISSING_SOURCE_PATH",
      "MAPPING_UNKNOWN_TRANSFORM",
    ]);
    assert.equal(found.find((i) => i.code === "MAPPING_MISSING_SOURCE_PATH")?.path, "rules[0].sourcePath");
    assert.equal(hasBlockingIssue(found), true);
  });

  it("warns, without blocking, on a codeable_concept with no system", () => {
    const spec = base();
    spec.rules = [{ id: "c", sourcePath: "s", targetPath: "t", transform: "codeable_concept" }];
    assert.deepEqual(codes(spec), ["CODEABLE_CONCEPT_WITHOUT_SYSTEM"]);
    assert.equal(hasBlockingIssue(localChecks(spec)), false);
    spec.rules[0]!.params = { system: "http://loinc.org" };
    assert.deepEqual(codes(spec), []);
  });
});

describe("parseSpec", () => {
  it("accepts an object with an array of object rules and rejects anything else", () => {
    assert.ok(parseSpec(base()));
    assert.equal(parseSpec(null), null);
    assert.equal(parseSpec([]), null);
    assert.equal(parseSpec("x"), null);
    assert.equal(parseSpec({ rules: "nope" }), null);
    assert.equal(parseSpec({ rules: [1] }), null);
  });
});

describe("blankSpec", () => {
  it("starts with the plan's default formats and no rules", () => {
    assert.deepEqual(blankSpec("lab"), {
      id: "lab",
      name: "lab",
      version: "1.0.0",
      sourceFormat: "auto",
      targetFormat: "fhir-r4",
      rules: [],
    });
  });
});

function parseError(result: ReturnType<typeof parseJsonParam>): string {
  assert.equal(result.ok, false);
  return result.ok ? "" : result.error;
}

describe("parseJsonParam", () => {
  it("treats empty text as no value", () => {
    assert.deepEqual(parseJsonParam("", "string-list"), { ok: true, value: undefined });
    assert.deepEqual(parseJsonParam("  \n\t", "string-map"), { ok: true, value: undefined });
  });

  it("rejects invalid JSON", () => {
    assert.equal(parseError(parseJsonParam("{", "string-list")), "Invalid JSON.");
  });

  it("rejects text over 10,000 characters before parsing", () => {
    const overLimit = `["${"x".repeat(9_999)}"]`;
    assert.equal(overLimit.length, 10_003);
    assert.equal(parseError(parseJsonParam(overLimit, "scalar-array")), "JSON is too large (limit 10,000 characters).");
    assert.equal(parseError(parseJsonParam("x".repeat(10_000), "scalar-array")), "Invalid JSON.");
  });

  it("accepts a string list", () => {
    assert.deepEqual(parseJsonParam('["a", "b"]', "string-list"), { ok: true, value: ["a", "b"] });
  });

  it("rejects a non-array and non-string string-list items", () => {
    assert.match(parseError(parseJsonParam('{"a":"b"}', "string-list")), /array of non-empty strings/);
    assert.match(parseError(parseJsonParam('["a", 1]', "string-list")), /non-empty string/);
    assert.match(parseError(parseJsonParam('["a", ""]', "string-list")), /non-empty string/);
  });

  it("caps a string list at 100 items", () => {
    const hundred = JSON.stringify(Array.from({ length: 100 }, (_, index) => `p${index}`));
    assert.deepEqual(parseJsonParam(hundred, "string-list").ok, true);
    const over = JSON.stringify(Array.from({ length: 101 }, (_, index) => `p${index}`));
    assert.match(parseError(parseJsonParam(over, "string-list")), /at most 100 items/);
  });

  it("accepts a string map", () => {
    assert.deepEqual(parseJsonParam('{"M":"male","F":"female"}', "string-map"), {
      ok: true,
      value: { M: "male", F: "female" },
    });
  });

  it("rejects arrays, null and non-string values for a string map", () => {
    assert.match(parseError(parseJsonParam('["a"]', "string-map")), /object whose values are strings/);
    assert.match(parseError(parseJsonParam("null", "string-map")), /object whose values are strings/);
    assert.match(parseError(parseJsonParam('{"a": 1}', "string-map")), /Every value must be a string/);
  });

  it("caps a string map at 100 keys", () => {
    const entries = Array.from({ length: 100 }, (_, index) => [`k${index}`, "v"] as const);
    assert.equal(parseJsonParam(JSON.stringify(Object.fromEntries(entries)), "string-map").ok, true);
    const over = [...entries, ["k100", "v"] as const];
    assert.match(
      parseError(parseJsonParam(JSON.stringify(Object.fromEntries(over)), "string-map")),
      /at most 100 keys/,
    );
  });

  it("accepts a scalar array", () => {
    assert.deepEqual(parseJsonParam('["a", 1, true]', "scalar-array"), { ok: true, value: ["a", 1, true] });
  });

  it("rejects null and object items in a scalar array", () => {
    assert.match(parseError(parseJsonParam('["a", null]', "scalar-array")), /finite number or boolean/);
    assert.match(parseError(parseJsonParam('[{"a": 1}]', "scalar-array")), /finite number or boolean/);
    assert.match(parseError(parseJsonParam('{"a": 1}', "scalar-array")), /array of strings/);
  });

  it("caps a scalar array at 100 items", () => {
    assert.equal(
      parseJsonParam(JSON.stringify(Array.from({ length: 100 }, (_, index) => index)), "scalar-array").ok,
      true,
    );
    assert.match(
      parseError(parseJsonParam(JSON.stringify(Array.from({ length: 101 }, (_, index) => index)), "scalar-array")),
      /at most 100 items/,
    );
  });
});

describe("formatJsonParam", () => {
  it("renders nothing for undefined and pretty JSON otherwise", () => {
    assert.equal(formatJsonParam(undefined), "");
    assert.equal(formatJsonParam({ a: 1 }), '{\n  "a": 1\n}');
    assert.equal(formatJsonParam(["a", 2]), '[\n  "a",\n  2\n]');
  });
});

describe("parseConditionLiteral", () => {
  it("treats empty text as no value", () => {
    assert.equal(parseConditionLiteral(""), undefined);
    assert.equal(parseConditionLiteral("   "), undefined);
  });

  it("keeps the JSON type of valid literals", () => {
    assert.equal(parseConditionLiteral("3"), 3);
    assert.equal(parseConditionLiteral("true"), true);
    assert.equal(parseConditionLiteral("null"), null);
    assert.deepEqual(parseConditionLiteral(' ["a", 1] '), ["a", 1]);
  });

  it("falls back to the original text when JSON parsing fails", () => {
    assert.equal(parseConditionLiteral(" abc "), " abc ");
    assert.equal(parseConditionLiteral("not json"), "not json");
  });
});

describe("defaultValueProblem", () => {
  const message = "Invalid JSON. Plain text cannot start with { or [.";

  it("flags text that starts like JSON but does not parse", () => {
    assert.equal(defaultValueProblem("{"), message);
    assert.equal(defaultValueProblem("{not json"), message);
    assert.equal(defaultValueProblem("  [1, 2"), message);
    assert.equal(defaultValueProblem(" [oops] "), message);
  });

  it("accepts valid JSON object and array text", () => {
    assert.equal(defaultValueProblem('{"a":1}'), null);
    assert.equal(defaultValueProblem(' {"a": 1} '), null);
    assert.equal(defaultValueProblem("[1, 2]"), null);
  });

  it("accepts plain text that does not look like JSON", () => {
    assert.equal(defaultValueProblem("unknown"), null);
    assert.equal(defaultValueProblem(""), null);
    assert.equal(defaultValueProblem("42"), null);
  });

  it("ignores non-string values", () => {
    assert.equal(defaultValueProblem(undefined), null);
    assert.equal(defaultValueProblem(null), null);
    assert.equal(defaultValueProblem({ a: 1 }), null);
    assert.equal(defaultValueProblem(3), null);
  });
});
