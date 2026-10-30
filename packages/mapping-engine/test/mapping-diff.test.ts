import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffMappingDefinitions, type MappingDefinition, type MappingRule } from "@healthbridge/mapping-engine";

function rule(
  partial: Partial<MappingRule> & Pick<MappingRule, "id" | "sourcePath" | "targetPath" | "transform">,
): MappingRule {
  return { ...partial };
}

function mapping(overrides: Partial<MappingDefinition> = {}, rules: MappingRule[] = []): MappingDefinition {
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

function plainRule(id: string, overrides: Partial<MappingRule> = {}): MappingRule {
  return rule({
    id,
    sourcePath: `source_${id}`,
    targetPath: `target_${id}`,
    transform: "identity",
    ...overrides,
  });
}

describe("diffMappingDefinitions — identical input", () => {
  test("reports no changes and counts every rule as unchanged", () => {
    const definition = mapping({}, [plainRule("a"), plainRule("b"), plainRule("c")]);
    const diff = diffMappingDefinitions(definition, structuredClone(definition));

    assert.deepEqual(diff, {
      metadata: [],
      rules: { added: [], removed: [], changed: [], reordered: [], unchanged: 3 },
      counts: { added: 0, removed: 0, changed: 0, reordered: 0, unchanged: 3 },
      truncated: false,
    });
  });

  test("treats absent and explicit undefined metadata fields as equal", () => {
    const from = mapping({ targetProfile: undefined });
    const to = mapping();
    const diff = diffMappingDefinitions(from, to);

    assert.deepEqual(diff.metadata, []);
    assert.equal(diff.truncated, false);
  });

  test("does not mutate either definition", () => {
    const from = mapping({ sourceDomains: ["clinical"] }, [
      plainRule("a", { params: { nested: { b: 2, a: 1 } }, defaultValue: { list: [1, 2] } }),
    ]);
    const to = mapping({ name: "Changed" }, [
      plainRule("a", { params: { nested: { a: 1, b: 2 } }, defaultValue: { list: [1, 2] } }),
      plainRule("b"),
    ]);
    const fromSnapshot = structuredClone(from);
    const toSnapshot = structuredClone(to);

    diffMappingDefinitions(from, to);

    assert.deepEqual(from, fromSnapshot);
    assert.deepEqual(to, toSnapshot);
  });
});

describe("diffMappingDefinitions — metadata", () => {
  test("reports only changed fields in the fixed order", () => {
    const from = mapping({ targetProfile: undefined, sourceDomains: ["clinical", "research"] }, [plainRule("a")]);
    const to = mapping(
      {
        name: "Renamed mapping",
        version: "1.1.0",
        targetResourceType: "Patient",
        targetProfile: "https://example.org/fhir/StructureDefinition/patient",
        description: "",
        sourceDomains: ["research", "clinical"],
      },
      [plainRule("a")],
    );

    const diff = diffMappingDefinitions(from, to);

    assert.deepEqual(
      diff.metadata.map((change) => change.field),
      ["name", "version", "targetResourceType", "targetProfile", "description", "sourceDomains"],
    );
    assert.deepEqual(diff.metadata[0], { field: "name", from: "Test mapping", to: "Renamed mapping" });
    assert.deepEqual(diff.metadata[5], {
      field: "sourceDomains",
      from: ["clinical", "research"],
      to: ["research", "clinical"],
    });
    assert.deepEqual(diff.rules, { added: [], removed: [], changed: [], reordered: [], unchanged: 1 });
    assert.equal(diff.counts.unchanged, 1);
    assert.equal(diff.truncated, false);
  });
});

describe("diffMappingDefinitions — rule sets", () => {
  test("reports added, removed, changed and unchanged rules", () => {
    const from = mapping({}, [plainRule("a"), plainRule("b"), plainRule("c", { transform: "identity" })]);
    const to = mapping({}, [plainRule("b"), plainRule("c", { transform: "uppercase" }), plainRule("d")]);

    const diff = diffMappingDefinitions(from, to);

    assert.deepEqual(
      diff.rules.added.map((entry) => entry.id),
      ["d"],
    );
    assert.deepEqual(
      diff.rules.removed.map((entry) => entry.id),
      ["a"],
    );
    assert.deepEqual(diff.rules.changed, [
      {
        ruleId: "c",
        fields: [{ field: "transform", from: "identity", to: "uppercase" }],
      },
    ]);
    assert.deepEqual(diff.rules.reordered, []);
    assert.equal(diff.rules.unchanged, 1);
    assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1, reordered: 0, unchanged: 1 });
    assert.equal(diff.truncated, false);
  });

  test("lists changed rule fields in the fixed order", () => {
    const fromRule = plainRule("a", {
      sourcePath: "old_source",
      targetPath: "old_target",
      transform: "identity",
      defaultValue: { b: 2, a: 1 },
      params: { nested: { b: 2, a: 1 } },
      required: false,
      when: [{ path: "p", op: "equals", value: 1 }],
      description: "old",
    });
    const toRule = plainRule("a", {
      sourcePath: "new_source",
      targetPath: "new_target",
      transform: "uppercase",
      defaultValue: { a: 1, b: 2 },
      params: { nested: { a: 1, b: 2 } },
      required: true,
      when: [{ path: "p", op: "equals", value: 2 }],
      description: "new",
    });

    const diff = diffMappingDefinitions(mapping({}, [fromRule]), mapping({}, [toRule]));

    assert.equal(diff.rules.changed.length, 1);
    assert.deepEqual(
      diff.rules.changed[0].fields.map((change) => change.field),
      ["sourcePath", "targetPath", "transform", "required", "when", "description"],
    );
    assert.equal(diff.rules.unchanged, 0);
    assert.deepEqual(diff.counts, { added: 0, removed: 0, changed: 1, reordered: 0, unchanged: 0 });
  });

  test("key-order-only changes in params and defaultValue produce no diff", () => {
    const fromRule = plainRule("a", {
      defaultValue: { b: 2, a: 1, nested: { y: 2, x: 1 } },
      params: { options: { b: 2, a: 1 }, list: [1, 2] },
      when: [{ path: "p", op: "in", value: [1, 2] }],
    });
    const toRule = plainRule("a", {
      defaultValue: { nested: { x: 1, y: 2 }, a: 1, b: 2 },
      params: { list: [1, 2], options: { a: 1, b: 2 } },
      when: [{ path: "p", op: "in", value: [1, 2] }],
    });

    const diff = diffMappingDefinitions(mapping({}, [fromRule]), mapping({}, [toRule]));

    assert.deepEqual(diff.rules.changed, []);
    assert.deepEqual(diff.rules.reordered, []);
    assert.equal(diff.rules.unchanged, 1);
  });

  test("detects deep changes in params, defaultValue and when", () => {
    const base = {
      defaultValue: { list: [1, 2], nested: { a: 1, b: 2 } },
      params: { options: { a: 1, b: 2 } },
      when: [
        { path: "a" as const, op: "in" as const, value: [1, 2] },
        { path: "b" as const, op: "equals" as const, value: { x: 1, y: 2 } },
      ],
    };
    const fromRule = plainRule("a", base);

    const paramsChanged = diffMappingDefinitions(
      mapping({}, [fromRule]),
      mapping({}, [plainRule("a", { ...base, params: { options: { a: 1, b: 3 } } })]),
    );
    assert.deepEqual(
      paramsChanged.rules.changed[0].fields.map((change) => change.field),
      ["params"],
    );

    const defaultValueChanged = diffMappingDefinitions(
      mapping({}, [fromRule]),
      mapping({}, [plainRule("a", { ...base, defaultValue: { list: [2, 1], nested: { a: 1, b: 2 } } })]),
    );
    assert.deepEqual(
      defaultValueChanged.rules.changed[0].fields.map((change) => change.field),
      ["defaultValue"],
    );

    const whenChanged = diffMappingDefinitions(
      mapping({}, [fromRule]),
      mapping({}, [
        plainRule("a", {
          ...base,
          when: [
            { path: "b", op: "equals", value: { x: 1, y: 3 } },
            { path: "a", op: "in", value: [1, 2] },
          ],
        }),
      ]),
    );
    assert.deepEqual(
      whenChanged.rules.changed[0].fields.map((change) => change.field),
      ["when"],
    );
  });
});

describe("diffMappingDefinitions — reordering", () => {
  test("reports only common rules whose common-id position changed", () => {
    const from = mapping({}, [plainRule("a"), plainRule("b"), plainRule("c")]);
    const to = mapping({}, [plainRule("x"), plainRule("b"), plainRule("a"), plainRule("c")]);

    const diff = diffMappingDefinitions(from, to);

    assert.deepEqual(diff.rules.reordered, [
      { ruleId: "b", fromIndex: 1, toIndex: 0 },
      { ruleId: "a", fromIndex: 0, toIndex: 1 },
    ]);
    assert.equal(diff.counts.reordered, 2);
    assert.equal(diff.rules.unchanged, 3);
    assert.equal(diff.counts.unchanged, 3);
    assert.deepEqual(
      diff.rules.added.map((entry) => entry.id),
      ["x"],
    );
  });

  test("counts a moved but identical rule as unchanged", () => {
    const from = mapping({}, [plainRule("a"), plainRule("b")]);
    const to = mapping({}, [plainRule("b"), plainRule("a")]);

    const diff = diffMappingDefinitions(from, to);

    assert.equal(diff.rules.changed.length, 0);
    assert.equal(diff.rules.unchanged, 2);
    assert.deepEqual(diff.rules.reordered, [
      { ruleId: "b", fromIndex: 1, toIndex: 0 },
      { ruleId: "a", fromIndex: 0, toIndex: 1 },
    ]);
  });

  test("ignores additions and removals when computing positions", () => {
    const from = mapping({}, [plainRule("removed"), plainRule("a"), plainRule("b")]);
    const to = mapping({}, [plainRule("added"), plainRule("a"), plainRule("b")]);

    const diff = diffMappingDefinitions(from, to);

    assert.deepEqual(diff.rules.reordered, []);
    assert.equal(diff.rules.unchanged, 2);
  });
});

describe("diffMappingDefinitions — duplicate ids", () => {
  test("uses the first occurrence of a repeated id and never throws", () => {
    const firstFrom = plainRule("a", { sourcePath: "first_from" });
    const secondFrom = plainRule("a", { sourcePath: "second_from" });
    const firstTo = plainRule("a", { sourcePath: "first_from" });
    const secondTo = plainRule("a", { sourcePath: "second_to" });
    const common = plainRule("b");

    const diff = diffMappingDefinitions(
      mapping({}, [firstFrom, secondFrom, common]),
      mapping({}, [firstTo, secondTo, common]),
    );

    assert.deepEqual(diff.rules.added, []);
    assert.deepEqual(diff.rules.removed, []);
    assert.deepEqual(diff.rules.changed, []);
    assert.equal(diff.rules.unchanged, 2);
    assert.equal(diff.truncated, false);
  });
});

describe("diffMappingDefinitions — truncation", () => {
  test("caps added rules at 500 while keeping full counts", () => {
    const toRules = Array.from({ length: 501 }, (_, index) =>
      plainRule(`r${index}`, { sourcePath: `source_${index}` }),
    );

    const diff = diffMappingDefinitions(mapping({}, []), mapping({}, toRules));

    assert.equal(diff.rules.added.length, 500);
    assert.equal(diff.counts.added, 501);
    assert.equal(diff.truncated, true);
    assert.equal(diff.rules.unchanged, 0);
  });

  test("caps removed rules at 500 while keeping full counts", () => {
    const fromRules = Array.from({ length: 501 }, (_, index) =>
      plainRule(`r${index}`, { sourcePath: `source_${index}` }),
    );

    const diff = diffMappingDefinitions(mapping({}, fromRules), mapping({}, []));

    assert.equal(diff.rules.removed.length, 500);
    assert.equal(diff.counts.removed, 501);
    assert.equal(diff.truncated, true);
  });
});
