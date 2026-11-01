import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_LINEAGE_MESSAGE,
  STORED_LINEAGE_NOTICE,
  UNRECORDED_TRANSFORM_LABEL,
  buildLineageGraph,
  edgeBackingLabel,
  nodeTone,
  nodesOfKind,
  targetFieldsFromResources,
  type LineageEdge,
  type LineageGraph,
} from "../src/app/features/lineage/lineage.logic";

/**
 * Lineage graph builder. Every claim the page makes — which fields exist, which transform
 * connects them, what was dropped — flows through here, so parsing is pinned against
 * malformed payloads: junk degrades to an empty graph, never throws, and no edge reads as
 * observed without stored trace evidence behind it.
 */

const MAPPING_SPEC = {
  rules: [
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity" },
    { id: "r3", sourcePath: "family_name", targetPath: "name.0.family", transform: "identity" },
    { id: "r5", sourcePath: "sex", targetPath: "gender", transform: "format_gender_fhir" },
  ],
};

function trace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    stage: "mapping",
    status: "success",
    payload: { ruleId: "r1", sourcePath: "patient_id", targetPath: "id", status: "success" },
    ...overrides,
  };
}

describe("buildLineageGraph", () => {
  it("builds source -> transform -> target chains from declared rules and stored traces", () => {
    const graph = buildLineageGraph({
      traces: [
        trace(),
        trace({
          seq: 2,
          payload: { ruleId: "r3", sourcePath: "family_name", targetPath: "name.0.family", status: "success" },
        }),
      ],
      mappingSpec: MAPPING_SPEC,
    });
    assert.equal(graph.summary.sources, 3);
    assert.equal(graph.summary.targets, 3);
    assert.equal(graph.summary.transforms, 3);
    const write = graph.edges.find((edge) => edge.id === "xf:r3->tgt:name.0.family");
    assert.ok(write);
    assert.equal(write.label, "identity");
    assert.equal(write.observed, true);
    assert.deepEqual(write.evidence, [2]);
    const read = graph.edges.find((edge) => edge.id === "src:family_name->xf:r3");
    assert.ok(read);
    assert.equal(read.label, "reads");
    assert.equal(read.observed, true);
  });

  it("labels declared rules with no stored trace as declared-only, never observed", () => {
    const graph = buildLineageGraph({ traces: [trace()], mappingSpec: MAPPING_SPEC });
    const write = graph.edges.find((edge) => edge.id === "xf:r5->tgt:gender");
    assert.ok(write);
    assert.equal(write.observed, false);
    assert.deepEqual(write.evidence, []);
    assert.match(write.note ?? "", /no stored trace event observed it/);
    assert.equal(write.label, "format_gender_fhir");
    assert.equal(graph.summary.declaredOnlyEdges, 4);
    assert.equal(graph.summary.observedEdges, 2);
  });

  it("keeps observed pairs with no declared rule as stored-trace edges without inventing a transform", () => {
    const graph = buildLineageGraph({
      traces: [trace({ seq: 7, payload: { sourcePath: "extra_col", targetPath: "note", status: "success" } })],
      mappingSpec: MAPPING_SPEC,
    });
    const edge = graph.edges.find((e) => e.id === "src:extra_col->tgt:note");
    assert.ok(edge);
    assert.equal(edge.observed, true);
    assert.deepEqual(edge.evidence, [7]);
    assert.equal(edge.label, UNRECORDED_TRANSFORM_LABEL);
  });

  it("keeps observed rule ids missing from the mapping version instead of dropping stored evidence", () => {
    const graph = buildLineageGraph({
      traces: [trace({ seq: 3, payload: { ruleId: "rx", sourcePath: "a", targetPath: "b", status: "success" } })],
      mappingSpec: MAPPING_SPEC,
    });
    const node = graph.nodes.find((n) => n.id === "xf:rx");
    assert.ok(node);
    assert.equal(node.kind, "transform");
    assert.match(node.label, /not in run mapping version/);
  });

  it("makes unmapped and rejected coverage fields first-class dropped nodes", () => {
    const graph = buildLineageGraph({
      traces: [],
      mappingSpec: MAPPING_SPEC,
      coverage: { unmappedSourceFields: ["notes"], rejectedFieldPaths: ["birth_date"] },
    });
    const unmapped = graph.nodes.find((n) => n.id === "dropped:notes");
    const rejected = graph.nodes.find((n) => n.id === "dropped:birth_date");
    assert.ok(unmapped);
    assert.ok(rejected);
    assert.match(unmapped.reason ?? "", /Unmapped/);
    assert.match(rejected.reason ?? "", /Rejected/);
    assert.equal(graph.summary.dropped, 2);
  });

  it("turns error-status trace events without a target field into dropped nodes", () => {
    const graph = buildLineageGraph({
      traces: [trace({ seq: 9, payload: { sourcePath: "birth_date", status: "error" } })],
      mappingSpec: { rules: [] },
    });
    const dropped = graph.nodes.find((n) => n.id === "dropped:birth_date");
    assert.ok(dropped);
    assert.deepEqual(dropped.evidence, [9]);
  });

  it("adds target fields observed in stored resources", () => {
    const graph = buildLineageGraph({
      traces: [],
      mappingSpec: { rules: [] },
      resources: { resources: [{ resourceType: "Patient", id: "p1", data: { name: [], gender: "female" } }] },
    });
    assert.ok(graph.nodes.some((n) => n.id === "tgt:Patient.name"));
    assert.ok(graph.nodes.some((n) => n.id === "tgt:Patient.gender"));
  });

  it("degrades malformed payloads to an empty graph instead of throwing", () => {
    for (const input of [
      { traces: null, mappingSpec: null, coverage: null, resources: null },
      { traces: "junk", mappingSpec: 42, coverage: ["x"], resources: true },
      { traces: [{ payload: null }, 42, "junk", { seq: -1, payload: { ruleId: 7 } }], mappingSpec: { rules: "junk" } },
      { traces: undefined, mappingSpec: { rules: [{ id: "  ", sourcePath: "", targetPath: "" }] } },
    ]) {
      const graph = buildLineageGraph(input);
      assert.deepEqual(graph.nodes, []);
      assert.deepEqual(graph.edges, []);
    }
    assert.doesNotThrow(() =>
      buildLineageGraph({ traces: [{ payload: { toString: "evil" } }], mappingSpec: { toString: 1 } }),
    );
  });

  it("dedupes repeat trace evidence and orders node evidence chronologically", () => {
    const graph = buildLineageGraph({
      traces: [
        trace({ seq: 5, payload: { ruleId: "r1", sourcePath: "patient_id", targetPath: "id", status: "success" } }),
        trace({ seq: 2, payload: { ruleId: "r1", sourcePath: "patient_id", targetPath: "id", status: "success" } }),
      ],
      mappingSpec: MAPPING_SPEC,
    });
    const write = graph.edges.find((edge) => edge.id === "xf:r1->tgt:id");
    assert.ok(write);
    assert.deepEqual(write.evidence, [2, 5]);
    const node = graph.nodes.find((n) => n.id === "src:patient_id");
    assert.ok(node);
    assert.deepEqual(node.evidence, [2, 5]);
  });
});

describe("stored coverage backing", () => {
  it("backs rule edges from coverage.mappedFieldPaths when one rule reads the field", () => {
    const graph = buildLineageGraph({
      traces: [],
      mappingSpec: MAPPING_SPEC,
      coverage: { mappedFieldPaths: ["sex", "birth_date"] },
    });
    const write = graph.edges.find((edge) => edge.id === "xf:r5->tgt:gender");
    assert.ok(write);
    assert.equal(write.observed, false);
    assert.equal(write.coverageBacked, true);
    assert.equal(edgeBackingLabel(write), "stored run coverage: source field consumed by the run's mapping");
    assert.equal(graph.summary.coverageBackedEdges, 2);
    assert.equal(graph.summary.declaredOnlyEdges, 4);
  });

  it("keeps shared source fields declared-only because coverage names the field, not the rule", () => {
    const graph = buildLineageGraph({
      traces: [],
      mappingSpec: {
        rules: [
          { id: "a", sourcePath: "sex", targetPath: "x", transform: "identity" },
          { id: "b", sourcePath: "sex", targetPath: "y", transform: "trim" },
        ],
      },
      coverage: { mappedFieldPaths: ["sex"] },
    });
    for (const edge of graph.edges) assert.equal(edge.coverageBacked, false);
    assert.equal(graph.summary.coverageBackedEdges, 0);
    assert.equal(graph.summary.declaredOnlyEdges, 4);
  });

  it("prefers stored trace evidence over coverage when both exist", () => {
    const graph = buildLineageGraph({
      traces: [
        trace({ seq: 4, payload: { ruleId: "r1", sourcePath: "patient_id", targetPath: "id", status: "success" } }),
      ],
      mappingSpec: MAPPING_SPEC,
      coverage: { mappedFieldPaths: ["patient_id"] },
    });
    const write = graph.edges.find((edge) => edge.id === "xf:r1->tgt:id");
    assert.ok(write);
    assert.equal(write.observed, true);
    assert.equal(edgeBackingLabel(write), "stored trace seq 4");
  });

  it("pins the declared-only disclaimer so it can never read as observed", () => {
    const edge = { observed: false, coverageBacked: false, evidence: [], note: null } as LineageEdge;
    assert.match(edgeBackingLabel(edge), /no stored trace event observed it/);
    assert.match(edgeBackingLabel(null as unknown as LineageEdge), /no stored trace event observed it/);
  });
});

describe("targetFieldsFromResources", () => {
  it("reads top-level fields and never throws on junk", () => {
    assert.deepEqual(targetFieldsFromResources({ resources: [] }), []);
    assert.deepEqual(targetFieldsFromResources(null), []);
    assert.deepEqual(targetFieldsFromResources("junk"), []);
    assert.deepEqual(
      targetFieldsFromResources([{ resourceType: "Observation", data: { status: "final", code: {} } }]),
      ["Observation.status", "Observation.code"],
    );
  });
});

describe("wording, tones and selectors", () => {
  it("pins the stored-traces wording so the page can never claim live execution", () => {
    assert.match(STORED_LINEAGE_NOTICE, /stored traces/);
    assert.match(STORED_LINEAGE_NOTICE, /never a live execution/);
    assert.match(EMPTY_LINEAGE_MESSAGE, /no trace field pairs/);
  });

  it("keeps node tones on the global chip palette with dropped as a warning", () => {
    assert.equal(nodeTone("source"), "info");
    assert.equal(nodeTone("transform"), "muted");
    assert.equal(nodeTone("target"), "ok");
    assert.equal(nodeTone("dropped"), "warn");
  });

  it("selects nodes by kind in graph order and tolerates junk", () => {
    const graph = buildLineageGraph({ traces: [trace()], mappingSpec: MAPPING_SPEC });
    assert.ok(nodesOfKind(graph, "source").length >= 1);
    assert.ok(nodesOfKind(graph, "transform").length >= 1);
    assert.deepEqual(nodesOfKind(null as unknown as LineageGraph, "source"), []);
    assert.deepEqual(nodesOfKind({} as LineageGraph, "target"), []);
  });
});
