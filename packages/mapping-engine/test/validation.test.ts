import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSFORM_FUNCTIONS,
  validateMappingDefinition,
  type ConditionOperator,
  type MappingDefinition,
  type MappingRule,
} from "@healthbridge/mapping-engine";
import { MAPPING_TRANSFORM_KINDS } from "@healthbridge/shared-types";

function rule(
  partial: Partial<MappingRule> & Pick<MappingRule, "id" | "sourcePath" | "targetPath" | "transform">,
): MappingRule {
  return { ...partial };
}

function mapping(
  overrides: Partial<MappingDefinition> = {},
  rules: MappingRule[] = [
    rule({
      id: "r1",
      sourcePath: "patient_id",
      targetPath: "id",
      transform: "identity",
    }),
  ],
): MappingDefinition {
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

function issuesOf(value: unknown): Array<{ code: string; path?: string; ruleId?: string }> {
  return validateMappingDefinition(value).issues;
}

function signatures(value: unknown): string[] {
  return issuesOf(value).map((issue) => `${issue.code}:${issue.path ?? ""}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe("shared mapping contracts", () => {
  test("TRANSFORM_FUNCTIONS equals MAPPING_TRANSFORM_KINDS in order", () => {
    assert.deepEqual(TRANSFORM_FUNCTIONS, MAPPING_TRANSFORM_KINDS);
    assert.equal(TRANSFORM_FUNCTIONS.length, 13);
    assert.equal(new Set(TRANSFORM_FUNCTIONS).size, 13);
  });
});

describe("validateMappingDefinition — valid input", () => {
  test("accepts a fully populated definition without mutating it", () => {
    const definition = mapping(
      {
        targetResourceType: "Patient",
        targetProfile: "https://example.org/fhir/StructureDefinition/patient",
        description: "Synthetic mapping",
        sourceDomains: ["clinical", "research"],
      },
      [
        rule({
          id: "r1",
          sourcePath: "patient_id",
          targetPath: "id",
          transform: "identity",
          required: true,
          params: { trim: true },
          defaultValue: { nested: [1, null] },
          when: [{ path: "patient_id", op: "exists" }],
          description: "Identifier",
        }),
      ],
    );
    const snapshot = structuredClone(definition);

    const result = validateMappingDefinition(definition);

    assert.ok(result.definition);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(definition, snapshot);
  });

  test("accepts a deep-frozen definition", () => {
    const definition = deepFreeze(
      mapping({}, [
        rule({
          id: "r1",
          sourcePath: "patient_id",
          targetPath: "id",
          transform: "uppercase",
          params: { suffix: "x" },
          defaultValue: { list: [1, 2] },
          when: [{ path: "patient_id", op: "in", value: ["a", "b"] }],
        }),
      ]),
    );

    assert.doesNotThrow(() => validateMappingDefinition(definition));
    assert.deepEqual(validateMappingDefinition(definition).issues, []);
  });

  test("accepts an empty sourceDomains array", () => {
    const result = validateMappingDefinition(mapping({ sourceDomains: [] }));
    assert.deepEqual(result.issues, []);
    assert.ok(result.definition);
  });

  test("accepts every condition operator", () => {
    const operators: ConditionOperator[] = [
      "exists",
      "not_exists",
      "equals",
      "not_equals",
      "in",
      "not_in",
      "matches",
      "gt",
      "gte",
      "lt",
      "lte",
    ];
    const result = validateMappingDefinition(
      mapping({}, [
        rule({
          id: "r1",
          sourcePath: "a",
          targetPath: "b",
          transform: "identity",
          when: operators.map((op) => ({ path: "a", op })),
        }),
      ]),
    );
    assert.deepEqual(result.issues, []);
    assert.ok(result.definition);
  });

  test("does not reject arbitrary defaultValue or condition values", () => {
    const result = validateMappingDefinition(
      mapping({}, [
        rule({
          id: "r1",
          sourcePath: "a",
          targetPath: "b",
          transform: "identity",
          defaultValue: undefined,
          when: [{ path: "a", op: "equals", value: { nested: [1, null, { deep: true }] } }],
        }),
      ]),
    );
    assert.deepEqual(result.issues, []);
    assert.ok(result.definition);
  });

  test("ignores unknown extra keys", () => {
    const definition = {
      ...mapping(),
      extraTopLevel: "ignored",
      rules: [{ ...mapping().rules[0], extraRule: true }],
    };
    const result = validateMappingDefinition(definition);
    assert.deepEqual(result.issues, []);
    assert.ok(result.definition);
  });
});

describe("validateMappingDefinition — totality", () => {
  test("never throws for null, primitives, arrays or empty objects", () => {
    const inputs: unknown[] = [null, undefined, 0, 42, "mapping", true, [], [mapping()], {}, { rules: [] }];

    for (const input of inputs) {
      assert.doesNotThrow(() => validateMappingDefinition(input));
      assert.ok(issuesOf(input).length > 0);
    }

    assert.deepEqual(signatures(null), ["MAPPING_NOT_OBJECT:"]);
    assert.deepEqual(signatures([]), ["MAPPING_NOT_OBJECT:"]);
    assert.ok(signatures({}).includes("MAPPING_RULES_NOT_ARRAY:rules"));
    assert.ok(signatures({}).includes("MAPPING_MISSING_FIELD:id"));
  });

  test("never throws for class instances", () => {
    class EmptySpec {}
    class RuleHolder {
      public rules = [null];
    }

    const inputs: unknown[] = [new EmptySpec(), new RuleHolder(), new Date(), new Map()];
    for (const input of inputs) {
      assert.doesNotThrow(() => validateMappingDefinition(input));
    }
    assert.ok(signatures(new EmptySpec()).includes("MAPPING_RULES_NOT_ARRAY:rules"));
    assert.ok(signatures(new RuleHolder()).includes("MAPPING_RULE_NOT_OBJECT:rules[0]"));
  });

  test("never throws for deeply malformed input", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i++) {
      nested = { level: i, child: nested };
    }

    const malformed = {
      ...mapping(),
      rules: [
        {
          id: "r1",
          sourcePath: { deep: [null, { x: [] }] },
          targetPath: [],
          transform: 42,
          params: nested,
          required: "yes",
          when: [null, { path: { x: 1 }, op: { y: 2 } }, { path: "a", op: "bogus" }],
        },
      ],
    };

    assert.doesNotThrow(() => validateMappingDefinition(malformed));
    const result = validateMappingDefinition(malformed);
    assert.ok(result.issues.length > 0);
    assert.equal(result.definition, undefined);
  });

  test('reports rules: [null] and rules: "x" without calling the engine', () => {
    assert.deepEqual(signatures({ ...mapping(), rules: [null] }), ["MAPPING_RULE_NOT_OBJECT:rules[0]"]);
    assert.deepEqual(signatures({ ...mapping(), rules: "x" }), ["MAPPING_RULES_NOT_ARRAY:rules"]);
  });

  test("marks MAPPING_NOT_OBJECT and MAPPING_RULES_NOT_ARRAY as fatal", () => {
    const notObject = validateMappingDefinition(null);
    assert.equal(notObject.issues[0]?.code, "MAPPING_NOT_OBJECT");
    assert.equal(notObject.issues[0]?.severity, "fatal");

    const notArray = validateMappingDefinition({ ...mapping(), rules: "x" });
    assert.equal(notArray.issues[0]?.code, "MAPPING_RULES_NOT_ARRAY");
    assert.equal(notArray.issues[0]?.severity, "fatal");
  });
});

describe("validateMappingDefinition — top-level fields", () => {
  test("reports every missing required field in order", () => {
    const result = validateMappingDefinition({ rules: [] });
    assert.equal(result.definition, undefined);
    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      [
        "MAPPING_MISSING_FIELD:id",
        "MAPPING_MISSING_FIELD:name",
        "MAPPING_MISSING_FIELD:version",
        "MAPPING_MISSING_FIELD:sourceFormat",
        "MAPPING_MISSING_FIELD:targetFormat",
      ],
    );
  });

  test("reports wrong-typed required fields as MAPPING_MISSING_FIELD", () => {
    const result = validateMappingDefinition({
      id: 1,
      name: "",
      version: [],
      sourceFormat: {},
      targetFormat: null,
      rules: [],
    });
    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      [
        "MAPPING_MISSING_FIELD:id",
        "MAPPING_MISSING_FIELD:name",
        "MAPPING_MISSING_FIELD:version",
        "MAPPING_MISSING_FIELD:sourceFormat",
        "MAPPING_MISSING_FIELD:targetFormat",
      ],
    );
  });

  test("reports wrong-typed optional fields as MAPPING_INVALID_FIELD", () => {
    const result = validateMappingDefinition({
      ...mapping(),
      targetResourceType: 7,
      targetProfile: null,
      description: {},
      sourceDomains: ["clinical", 5],
    });
    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      [
        "MAPPING_INVALID_FIELD:targetResourceType",
        "MAPPING_INVALID_FIELD:targetProfile",
        "MAPPING_INVALID_FIELD:description",
        "MAPPING_INVALID_FIELD:sourceDomains",
      ],
    );
    assert.equal(result.definition, undefined);
  });
});

describe("validateMappingDefinition — rule structure", () => {
  test("reports wrong primitive rule field types without engine issues", () => {
    const result = validateMappingDefinition({
      ...mapping(),
      rules: [
        {
          id: 1,
          sourcePath: 2,
          targetPath: [],
          transform: {},
          params: [],
          required: "yes",
          when: {},
          description: 7,
        },
      ],
    });

    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      [
        "MAPPING_RULE_MISSING_FIELD:rules[0].id",
        "MAPPING_RULE_MISSING_FIELD:rules[0].sourcePath",
        "MAPPING_RULE_MISSING_FIELD:rules[0].targetPath",
        "MAPPING_RULE_MISSING_FIELD:rules[0].transform",
        "MAPPING_RULE_INVALID_FIELD:rules[0].params",
        "MAPPING_RULE_INVALID_FIELD:rules[0].required",
        "MAPPING_RULE_INVALID_FIELD:rules[0].when",
        "MAPPING_RULE_INVALID_FIELD:rules[0].description",
      ],
    );
    assert.equal(result.definition, undefined);
    assert.ok(result.issues.every((issue) => issue.ruleId === undefined));
  });

  test("attaches ruleId to rule-scoped issues when the id is available", () => {
    const result = validateMappingDefinition({
      ...mapping(),
      rules: [{ id: "r1", sourcePath: "a", targetPath: "t", transform: "identity", params: [], required: "yes" }],
    });

    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      ["MAPPING_RULE_INVALID_FIELD:rules[0].params", "MAPPING_RULE_INVALID_FIELD:rules[0].required"],
    );
    assert.ok(result.issues.every((issue) => issue.ruleId === "r1"));
  });

  test("does not validate path contents", () => {
    const result = validateMappingDefinition(
      mapping({}, [rule({ id: "r1", sourcePath: "", targetPath: "", transform: "" })]),
    );

    assert.ok(!result.issues.some((issue) => issue.code === "MAPPING_RULE_MISSING_FIELD"));
    assert.ok(result.definition);
  });
});

describe("validateMappingDefinition — conditions", () => {
  test("reports malformed conditions and unknown operators", () => {
    const result = validateMappingDefinition({
      ...mapping(),
      rules: [
        {
          id: "r1",
          sourcePath: "a",
          targetPath: "t",
          transform: "identity",
          when: ["nope", { path: 5, op: "equals" }, { path: "a" }, { path: "a", op: 9 }, { path: "a", op: "bogus" }],
        },
      ],
    });

    assert.deepEqual(
      result.issues.map((issue) => `${issue.code}:${issue.path}`),
      [
        "MAPPING_RULE_INVALID_FIELD:rules[0].when[0]",
        "MAPPING_RULE_INVALID_FIELD:rules[0].when[1].path",
        "MAPPING_RULE_INVALID_FIELD:rules[0].when[2].op",
        "MAPPING_RULE_INVALID_FIELD:rules[0].when[3].op",
        "MAPPING_UNKNOWN_CONDITION_OPERATOR:rules[0].when[4].op",
      ],
    );
    assert.ok(result.issues.every((issue) => issue.ruleId === "r1"));

    const unknown = result.issues.find((issue) => issue.code === "MAPPING_UNKNOWN_CONDITION_OPERATOR");
    assert.ok(unknown);
    assert.ok(!unknown.message.includes("bogus"));
  });

  test("accepts an empty when array", () => {
    const result = validateMappingDefinition(
      mapping({}, [rule({ id: "r1", sourcePath: "a", targetPath: "t", transform: "identity", when: [] })]),
    );
    assert.deepEqual(result.issues, []);
    assert.ok(result.definition);
  });
});

describe("validateMappingDefinition — engine semantics", () => {
  test("appends MAPPING_UNKNOWN_TRANSFORM and keeps the definition", () => {
    const result = validateMappingDefinition(
      mapping({}, [rule({ id: "r1", sourcePath: "a", targetPath: "t", transform: "not-a-transform" as never })]),
    );
    assert.ok(result.definition);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["MAPPING_UNKNOWN_TRANSFORM"],
    );
  });

  test("appends MAPPING_EMPTY for an empty rule list", () => {
    const result = validateMappingDefinition(mapping({}, []));
    assert.ok(result.definition);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["MAPPING_EMPTY"],
    );
  });

  test("appends duplicate id and duplicate target issues from the engine", () => {
    const result = validateMappingDefinition(
      mapping({}, [
        rule({ id: "dup", sourcePath: "a", targetPath: "t", transform: "identity" }),
        rule({ id: "dup", sourcePath: "b", targetPath: "t", transform: "identity" }),
      ]),
    );
    const codes = result.issues.map((issue) => issue.code);
    assert.ok(result.definition);
    assert.ok(codes.includes("MAPPING_DUPLICATE_RULE_ID"));
    assert.ok(codes.includes("MAPPING_DUPLICATE_TARGET"));
  });

  test("leaves an empty sourcePath to the engine", () => {
    const result = validateMappingDefinition(
      mapping({}, [rule({ id: "r1", sourcePath: "", targetPath: "t", transform: "identity" })]),
    );
    assert.ok(!result.issues.some((issue) => issue.code === "MAPPING_RULE_MISSING_FIELD"));
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["MAPPING_MISSING_SOURCE_PATH"],
    );
    assert.ok(result.definition);
  });

  test("does not surface engine issues when structural issues exist", () => {
    const result = validateMappingDefinition({ ...mapping(), rules: [null] });
    assert.equal(result.definition, undefined);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["MAPPING_RULE_NOT_OBJECT"],
    );
  });
});
