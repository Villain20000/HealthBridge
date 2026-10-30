import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildDeclaredLineage, LineageBuilder } from "@healthbridge/lineage-engine";
import type { LineageNode, MappingDefinition, MappingRule } from "@healthbridge/shared-types";

function rule(
  partial: Partial<MappingRule> & Pick<MappingRule, "id" | "sourcePath" | "targetPath" | "transform">,
): MappingRule {
  return { ...partial };
}

function mapping(rules: MappingRule[], overrides: Partial<MappingDefinition> = {}): MappingDefinition {
  return {
    id: "mapping-1",
    name: "Test mapping",
    version: "1.0.0",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    rules,
    ...overrides,
  };
}

function nodesById(nodes: LineageNode[]): Map<string, LineageNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe("buildDeclaredLineage — graph shape", () => {
  const definition = mapping(
    [
      rule({
        id: "name",
        sourcePath: "patient.name",
        targetPath: "Patient.name",
        transform: "uppercase",
        required: true,
        when: [{ path: "patient.name", op: "exists" }],
      }),
      rule({
        id: "birth",
        sourcePath: "patient.birthDate",
        targetPath: "Patient.birthDate",
        transform: "parse_date_iso",
      }),
    ],
    { id: "mapping-1", name: "Patient mapping", version: "3.0.0", targetResourceType: "Patient" },
  );

  const result = buildDeclaredLineage({ mapping: definition, sourceAssetId: "asset-1", adapterId: "csv" });

  test("emits asset, adapter, source, rule, target and resource nodes in a stable order", () => {
    assert.deepEqual(
      result.nodes.map((node) => node.id),
      [
        "asset:asset-1",
        "adapter:csv",
        "source:patient.name",
        "source:patient.birthDate",
        "rule:name",
        "rule:birth",
        "target:Patient.name",
        "target:Patient.birthDate",
        "resource:Patient",
      ],
    );
  });

  test("uses the exact labels and metadata for every node kind", () => {
    const nodes = nodesById(result.nodes);

    assert.deepEqual(nodes.get("asset:asset-1"), {
      id: "asset:asset-1",
      label: "Source asset asset-1",
      type: "source_asset",
      metadata: { assetId: "asset-1" },
    });
    assert.deepEqual(nodes.get("adapter:csv"), {
      id: "adapter:csv",
      label: "Adapter csv",
      type: "adapter",
      metadata: { adapterId: "csv" },
    });
    assert.deepEqual(nodes.get("source:patient.name"), {
      id: "source:patient.name",
      label: "patient.name",
      type: "source_field",
      metadata: { path: "patient.name" },
    });
    assert.deepEqual(nodes.get("rule:name"), {
      id: "rule:name",
      label: "patient.name ➔ Patient.name",
      type: "mapping_rule",
      metadata: {
        ruleId: "name",
        sourcePath: "patient.name",
        targetPath: "Patient.name",
        transform: "uppercase",
        conditionCount: 1,
        required: true,
      },
    });
    assert.deepEqual(nodes.get("rule:birth"), {
      id: "rule:birth",
      label: "patient.birthDate ➔ Patient.birthDate",
      type: "mapping_rule",
      metadata: {
        ruleId: "birth",
        sourcePath: "patient.birthDate",
        targetPath: "Patient.birthDate",
        transform: "parse_date_iso",
        conditionCount: 0,
        required: false,
      },
    });
    assert.deepEqual(nodes.get("target:Patient.name"), {
      id: "target:Patient.name",
      label: "Patient.name",
      type: "target_field",
      metadata: { path: "Patient.name" },
    });
    assert.deepEqual(nodes.get("resource:Patient"), {
      id: "resource:Patient",
      label: "Patient",
      type: "target_resource",
      metadata: { resourceType: "Patient" },
    });
  });

  test("labels every edge with the transform kind and the target path", () => {
    const edges = new Map(result.edges.map((edge) => [edge.id, edge]));

    assert.equal(result.edges.length, 4);
    assert.deepEqual(edges.get("edge:source:patient.name->rule:name"), {
      id: "edge:source:patient.name->rule:name",
      sourceId: "source:patient.name",
      targetId: "rule:name",
      label: "uppercase",
    });
    assert.deepEqual(edges.get("edge:rule:name->target:Patient.name"), {
      id: "edge:rule:name->target:Patient.name",
      sourceId: "rule:name",
      targetId: "target:Patient.name",
      label: "Patient.name",
    });
    assert.deepEqual(edges.get("edge:source:patient.birthDate->rule:birth"), {
      id: "edge:source:patient.birthDate->rule:birth",
      sourceId: "source:patient.birthDate",
      targetId: "rule:birth",
      label: "parse_date_iso",
    });
    assert.deepEqual(edges.get("edge:rule:birth->target:Patient.birthDate"), {
      id: "edge:rule:birth->target:Patient.birthDate",
      sourceId: "rule:birth",
      targetId: "target:Patient.birthDate",
      label: "Patient.birthDate",
    });
  });

  test("mirrors the included rules in mapping order", () => {
    assert.equal(result.name, "Patient mapping");
    assert.equal(result.mappingId, "mapping-1");
    assert.equal(result.version, 3);
    assert.deepEqual(result.rules, [
      {
        ruleId: "name",
        sourcePath: "patient.name",
        targetPath: "Patient.name",
        transform: "uppercase",
        conditionCount: 1,
      },
      {
        ruleId: "birth",
        sourcePath: "patient.birthDate",
        targetPath: "Patient.birthDate",
        transform: "parse_date_iso",
        conditionCount: 0,
      },
    ]);
    assert.equal(result.truncated, false);
  });

  test("omits the optional asset, adapter and resource nodes when they are absent or empty", () => {
    const bare = buildDeclaredLineage({
      mapping: mapping([rule({ id: "a", sourcePath: "a", targetPath: "b", transform: "identity" })], {
        targetResourceType: "",
      }),
    });

    assert.equal(
      bare.nodes.some((node) => node.type === "source_asset"),
      false,
    );
    assert.equal(
      bare.nodes.some((node) => node.type === "adapter"),
      false,
    );
    assert.equal(
      bare.nodes.some((node) => node.type === "target_resource"),
      false,
    );
  });
});

describe("buildDeclaredLineage — shared source paths", () => {
  test("creates one source node but one edge per rule reading the same path", () => {
    const result = buildDeclaredLineage({
      mapping: mapping([
        rule({ id: "a", sourcePath: "patient.id", targetPath: "Patient.identifier", transform: "identity" }),
        rule({ id: "b", sourcePath: "patient.id", targetPath: "Observation.subject", transform: "identity" }),
      ]),
    });

    assert.equal(result.nodes.filter((node) => node.type === "source_field").length, 1);
    assert.equal(result.nodes.filter((node) => node.type === "mapping_rule").length, 2);
    assert.deepEqual(
      result.edges.filter((edge) => edge.sourceId === "source:patient.id").map((edge) => edge.targetId),
      ["rule:a", "rule:b"],
    );
  });
});

describe("buildDeclaredLineage — duplicate rule ids", () => {
  test("gives duplicate ids unique node ids and points each edge at its own rule node", () => {
    const result = buildDeclaredLineage({
      mapping: mapping([
        rule({ id: "dup", sourcePath: "a", targetPath: "x", transform: "identity" }),
        rule({ id: "dup", sourcePath: "b", targetPath: "y", transform: "identity" }),
      ]),
    });

    const ruleNodes = result.nodes.filter((node) => node.type === "mapping_rule");
    assert.deepEqual(
      ruleNodes.map((node) => node.id),
      ["rule:dup", "rule:dup#2"],
    );
    assert.deepEqual(
      ruleNodes.map((node) => node.metadata?.ruleId),
      ["dup", "dup"],
    );

    const ids = result.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);

    assert.deepEqual(
      result.edges.filter((edge) => edge.targetId === "rule:dup").map((edge) => edge.sourceId),
      ["source:a"],
    );
    assert.deepEqual(
      result.edges.filter((edge) => edge.targetId === "rule:dup#2").map((edge) => edge.sourceId),
      ["source:b"],
    );
    assert.deepEqual(
      result.edges.filter((edge) => edge.sourceId === "rule:dup").map((edge) => edge.targetId),
      ["target:x"],
    );
    assert.deepEqual(
      result.edges.filter((edge) => edge.sourceId === "rule:dup#2").map((edge) => edge.targetId),
      ["target:y"],
    );
  });

  test("keeps generated suffixes unique when an explicit id already uses one", () => {
    const result = buildDeclaredLineage({
      mapping: mapping([
        rule({ id: "dup", sourcePath: "a", targetPath: "x", transform: "identity" }),
        rule({ id: "dup", sourcePath: "b", targetPath: "y", transform: "identity" }),
        rule({ id: "dup#2", sourcePath: "c", targetPath: "z", transform: "identity" }),
      ]),
    });

    const ids = result.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      result.nodes.filter((node) => node.type === "mapping_rule").map((node) => node.id),
      ["rule:dup", "rule:dup#2", "rule:dup#2#2"],
    );
  });
});

describe("buildDeclaredLineage — rule metadata", () => {
  test("reports conditionCount and required exactly", () => {
    const result = buildDeclaredLineage({
      mapping: mapping([
        rule({ id: "plain", sourcePath: "a", targetPath: "b", transform: "identity" }),
        rule({
          id: "conditional",
          sourcePath: "c",
          targetPath: "d",
          transform: "identity",
          required: true,
          when: [
            { path: "c", op: "exists" },
            { path: "c", op: "equals", value: "x" },
          ],
        }),
      ]),
    });

    const nodes = nodesById(result.nodes);
    assert.equal(nodes.get("rule:plain")?.metadata?.conditionCount, 0);
    assert.equal(nodes.get("rule:plain")?.metadata?.required, false);
    assert.equal(nodes.get("rule:conditional")?.metadata?.conditionCount, 2);
    assert.equal(nodes.get("rule:conditional")?.metadata?.required, true);
    assert.deepEqual(
      result.rules.map((entry) => [entry.ruleId, entry.conditionCount]),
      [
        ["plain", 0],
        ["conditional", 2],
      ],
    );
  });
});

describe("buildDeclaredLineage — truncation", () => {
  const definition = mapping([
    rule({ id: "r1", sourcePath: "a", targetPath: "a1", transform: "identity" }),
    rule({ id: "r2", sourcePath: "b", targetPath: "b1", transform: "identity" }),
    rule({ id: "r3", sourcePath: "c", targetPath: "c1", transform: "identity" }),
  ]);

  test("includes every rule by default", () => {
    const result = buildDeclaredLineage({ mapping: definition });

    assert.equal(result.rules.length, 3);
    assert.equal(result.truncated, false);
  });

  test("maxRules 1 includes one rule and flags the result as truncated", () => {
    const result = buildDeclaredLineage({ mapping: definition, maxRules: 1 });

    assert.deepEqual(
      result.rules.map((entry) => entry.ruleId),
      ["r1"],
    );
    assert.deepEqual(
      result.nodes.filter((node) => node.type === "mapping_rule").map((node) => node.id),
      ["rule:r1"],
    );
    assert.equal(result.edges.length, 2);
    assert.equal(result.truncated, true);
  });

  test("maxRules 0 includes no rules and flags truncation", () => {
    const result = buildDeclaredLineage({ mapping: definition, maxRules: 0 });

    assert.equal(result.rules.length, 0);
    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
    assert.equal(result.truncated, true);
  });

  test("a non-finite maxRules falls back to the default of 500", () => {
    const result = buildDeclaredLineage({ mapping: definition, maxRules: Number.NaN });

    assert.equal(result.rules.length, 3);
    assert.equal(result.truncated, false);
  });

  test("500 rules with unique paths produce exactly 1,000 field nodes", () => {
    const rules = Array.from({ length: 500 }, (_, index) =>
      rule({
        id: `r${index}`,
        sourcePath: `source.${index}`,
        targetPath: `target.${index}`,
        transform: "identity",
      }),
    );

    const result = buildDeclaredLineage({ mapping: mapping(rules) });
    const sourceFields = result.nodes.filter((node) => node.type === "source_field");
    const targetFields = result.nodes.filter((node) => node.type === "target_field");

    assert.equal(sourceFields.length, 500);
    assert.equal(targetFields.length, 500);
    assert.equal(sourceFields.length + targetFields.length, 1_000);
    assert.equal(result.rules.length, 500);
    assert.equal(result.truncated, false);
  });
});

describe("buildDeclaredLineage — version resolution", () => {
  test("parses mapping.version when no explicit version is given", () => {
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "2.1.0" }) }).version, 2);
  });

  test("prefers an explicit non-negative integer version", () => {
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "2.1.0" }), version: 7 }).version, 7);
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "2.1.0" }), version: 0 }).version, 0);
  });

  test("falls back to parsing when the explicit version is not a non-negative integer", () => {
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "2.1.0" }), version: -1 }).version, 2);
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "2.1.0" }), version: 2.5 }).version, 2);
  });

  test("uses 0 when mapping.version is not numeric", () => {
    assert.equal(buildDeclaredLineage({ mapping: mapping([], { version: "not-a-version" }) }).version, 0);
  });
});

describe("buildDeclaredLineage — declared basis", () => {
  test("is always declared and never carries observed data", () => {
    const result = buildDeclaredLineage({
      mapping: mapping([rule({ id: "a", sourcePath: "a", targetPath: "b", transform: "identity" })]),
    });

    assert.equal(result.basis, "declared");
    assert.equal(Object.hasOwn(result, "observed"), false);
    assert.equal(Object.hasOwn(result.rules[0], "observed"), false);
    assert.equal(JSON.stringify(result).includes('"observed"'), false);
  });

  test("does not mutate the mapping or its rules", () => {
    const definition = mapping(
      [
        rule({
          id: "a",
          sourcePath: "a",
          targetPath: "b",
          transform: "identity",
          required: true,
          when: [{ path: "a", op: "exists" }],
        }),
      ],
      { targetResourceType: "Patient" },
    );
    const snapshot = structuredClone(definition);

    buildDeclaredLineage({ mapping: definition, sourceAssetId: "asset-1", adapterId: "adapter-1" });

    assert.deepEqual(definition, snapshot);
  });
});

describe("LineageBuilder.buildLineageFromTrace", () => {
  test("still returns the original nodes and edges", () => {
    const graph = new LineageBuilder().buildLineageFromTrace("asset-1", "csv", "fhir-r4", [
      { id: "r1", sourcePath: "a", targetPath: "b" },
    ]);

    assert.deepEqual(graph.nodes, [
      {
        id: "asset:asset-1",
        label: "Source (csv)",
        type: "source_asset",
        metadata: { assetId: "asset-1" },
      },
      {
        id: "target:fhir-r4",
        label: "Target (fhir-r4)",
        type: "target_resource",
      },
      {
        id: "rule:r1",
        label: "a ➔ b",
        type: "mapping_rule",
        metadata: { sourcePath: "a", targetPath: "b" },
      },
    ]);
    assert.deepEqual(graph.edges, [
      {
        id: "edge:asset:asset-1->rule:r1",
        sourceId: "asset:asset-1",
        targetId: "rule:r1",
        label: "a",
      },
      {
        id: "edge:rule:r1->target:fhir-r4",
        sourceId: "rule:r1",
        targetId: "target:fhir-r4",
        label: "b",
      },
    ]);
  });
});
