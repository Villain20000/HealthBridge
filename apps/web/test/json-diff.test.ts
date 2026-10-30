import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, diffJson, flattenJson, getByPath, jsonPath } from "../src/app/core/json";

/**
 * JSON inspection is the foundation of the Studio's payload views: paths must round-trip, canonical
 * output must be byte-stable, and every cap or cycle must be reported rather than silently applied.
 */
describe("canonicalJson", () => {
  it("is independent of object key order and keeps array order", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson([2, 1]), "[2,1]");
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("serialises nested structures deterministically", () => {
    assert.equal(canonicalJson({ z: [{ b: 2, a: 1 }], a: null }), '{"a":null,"z":[{"a":1,"b":2}]}');
  });

  it("omits unsupported object values and nulls unsupported array elements", () => {
    const value = { keep: 1, drop: undefined, fn: () => 1, sym: Symbol("x") };
    assert.equal(canonicalJson(value), '{"keep":1}');
    assert.equal(canonicalJson([1, undefined, () => 1, Symbol("x")]), "[1,null,null,null]");
  });

  it("never invokes toJSON", () => {
    assert.equal(canonicalJson({ toJSON: () => "hijacked", value: 1 }), '{"value":1}');
  });

  it("replaces non-finite numbers with null and normalises negative zero", () => {
    assert.equal(
      canonicalJson({ nan: Number.NaN, inf: Infinity, ninf: -Infinity }),
      '{"inf":null,"nan":null,"ninf":null}',
    );
    assert.equal(canonicalJson(-0), "0");
    assert.equal(canonicalJson({ zero: -0 }), '{"zero":0}');
  });

  it("always produces valid JSON", () => {
    const value = { n: 1, s: "x", arr: [true, null, { deep: 2 }] };
    assert.deepEqual(JSON.parse(canonicalJson(value)), value);
    assert.equal(canonicalJson(undefined), "null");
    assert.equal(
      canonicalJson(() => 1),
      "null",
    );
  });

  it("rejects circular structures with a TypeError", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;
    assert.throws(
      () => canonicalJson(circular),
      (error: unknown) => error instanceof TypeError && error.message === "Cannot serialise circular structure",
    );
  });

  it("serialises shared but non-cyclic references each time", () => {
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
    assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
  });
});

describe("getByPath", () => {
  const payload = { items: [{ id: "a" }, { id: "b" }], nested: { flag: false } };

  it("returns the root for the empty path and walks objects and arrays", () => {
    assert.equal(getByPath(payload, ""), payload);
    assert.equal(getByPath(payload, "nested.flag"), false);
    assert.equal(getByPath(payload, "items.1.id"), "b");
  });

  it("returns undefined for missing keys and traversal through primitives", () => {
    assert.equal(getByPath(payload, "missing"), undefined);
    assert.equal(getByPath(payload, "items.0.id.length"), undefined);
    assert.equal(getByPath(payload, "nested.flag.missing"), undefined);
    assert.equal(getByPath(null, "a"), undefined);
    assert.equal(getByPath({ a: null }, "a.b"), undefined);
    assert.equal(getByPath(undefined, ""), undefined);
  });

  it("accepts only canonical array index segments", () => {
    const list = ["zero", "one"];
    assert.equal(getByPath(list, "0"), "zero");
    assert.equal(getByPath(list, "1"), "one");
    assert.equal(getByPath(list, "2"), undefined);
    assert.equal(getByPath(list, "01"), undefined);
    assert.equal(getByPath(list, "00"), undefined);
    assert.equal(getByPath(list, "-1"), undefined);
  });

  it("walks own properties only", () => {
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited["own"] = 1;
    assert.equal(getByPath(inherited, "inherited"), undefined);
    assert.equal(getByPath(inherited, "own"), 1);
  });

  it("round-trips escaped dot and backslash keys produced by flattenJson", () => {
    const escaped = { "a.b": { "c\\d": 1 }, plain: 2 };
    const { leaves, truncated } = flattenJson(escaped);
    assert.equal(truncated, false);
    assert.deepEqual(
      leaves.map((leaf) => leaf.path),
      ["a\\.b.c\\\\d", "plain"],
    );
    for (const leaf of leaves) assert.equal(getByPath(escaped, leaf.path), leaf.value);
    assert.equal(getByPath({ "x.y": 3 }, "x\\.y"), 3);
  });
});

describe("flattenJson", () => {
  it("emits leaves depth-first in insertion order", () => {
    const payload = { a: 1, b: { c: [2, 3] }, d: true };
    assert.deepEqual(flattenJson(payload), {
      leaves: [
        { path: "a", value: 1 },
        { path: "b.c.0", value: 2 },
        { path: "b.c.1", value: 3 },
        { path: "d", value: true },
      ],
      truncated: false,
    });
  });

  it("treats empty containers and root scalars as leaves", () => {
    assert.deepEqual(flattenJson({ a: {}, b: [] }), {
      leaves: [
        { path: "a", value: {} },
        { path: "b", value: [] },
      ],
      truncated: false,
    });
    assert.deepEqual(flattenJson(7), { leaves: [{ path: "", value: 7 }], truncated: false });
    assert.deepEqual(flattenJson({}), { leaves: [{ path: "", value: {} }], truncated: false });
    assert.deepEqual(flattenJson([]), { leaves: [{ path: "", value: [] }], truncated: false });
  });

  it("does not partially emit a subtree at maxDepth", () => {
    const result = flattenJson({ shallow: 1, deep: { deeper: { value: 2 } } }, { maxDepth: 1 });
    assert.deepEqual(result.leaves, [{ path: "shallow", value: 1 }]);
    assert.equal(result.truncated, true);
  });

  it("still emits empty containers at maxDepth but skips non-empty roots", () => {
    assert.deepEqual(flattenJson({ empty: {}, list: [] }, { maxDepth: 1 }), {
      leaves: [
        { path: "empty", value: {} },
        { path: "list", value: [] },
      ],
      truncated: false,
    });
    assert.deepEqual(flattenJson({ a: 1 }, { maxDepth: 0 }), { leaves: [], truncated: true });
    assert.deepEqual(flattenJson(1, { maxDepth: 0 }), { leaves: [{ path: "", value: 1 }], truncated: false });
  });

  it("caps arrays at maxArrayItems", () => {
    assert.deepEqual(flattenJson([1, 2, 3], { maxArrayItems: 2 }), {
      leaves: [
        { path: "0", value: 1 },
        { path: "1", value: 2 },
      ],
      truncated: true,
    });
    assert.equal(flattenJson([1, 2], { maxArrayItems: 2 }).truncated, false);
  });

  it("stops at maxEntries and flags truncation only when more leaves exist", () => {
    assert.deepEqual(flattenJson([1, 2, 3], { maxEntries: 2 }), {
      leaves: [
        { path: "0", value: 1 },
        { path: "1", value: 2 },
      ],
      truncated: true,
    });
    assert.deepEqual(flattenJson([1, 2, 3], { maxEntries: 3 }), {
      leaves: [
        { path: "0", value: 1 },
        { path: "1", value: 2 },
        { path: "2", value: 3 },
      ],
      truncated: false,
    });
  });

  it("flattens arrays of objects", () => {
    assert.deepEqual(flattenJson([{ id: 1 }, { id: 2 }]).leaves, [
      { path: "0.id", value: 1 },
      { path: "1.id", value: 2 },
    ]);
  });

  it("terminates on cycles and flags truncation", () => {
    const object: Record<string, unknown> = { value: 1 };
    object["self"] = object;
    const objectResult = flattenJson(object);
    assert.deepEqual(objectResult.leaves, [{ path: "value", value: 1 }]);
    assert.equal(objectResult.truncated, true);

    const array: unknown[] = [1];
    array.push(array);
    const arrayResult = flattenJson(array);
    assert.deepEqual(arrayResult.leaves, [{ path: "0", value: 1 }]);
    assert.equal(arrayResult.truncated, true);
  });

  it("does not treat shared references as cycles", () => {
    const shared = { x: 1 };
    assert.deepEqual(flattenJson({ a: shared, b: shared }), {
      leaves: [
        { path: "a.x", value: 1 },
        { path: "b.x", value: 1 },
      ],
      truncated: false,
    });
  });

  it("never mutates its input", () => {
    const payload = { a: [1, { b: 2 }], c: "x" };
    const before = JSON.stringify(payload);
    flattenJson(payload);
    assert.equal(JSON.stringify(payload), before);
  });

  it("normalises invalid and fractional limits", () => {
    assert.equal(flattenJson([1, 2], { maxArrayItems: 1.9 }).truncated, true);
    assert.deepEqual(flattenJson({ a: { b: 1 } }, { maxDepth: Number.NaN, maxEntries: -1 }).leaves, [
      { path: "a.b", value: 1 },
    ]);
  });
});

describe("diffJson", () => {
  it("reports nested additions, removals and changes in traversal order", () => {
    const result = diffJson(
      { keep: 1, change: "a", remove: [1, 2], nested: { x: 1 } },
      { keep: 1, change: "b", add: true, nested: { x: 1, y: 2 } },
    );
    assert.deepEqual(result, {
      changes: [
        { path: "change", kind: "changed", left: "a", right: "b" },
        { path: "remove", kind: "removed", left: [1, 2] },
        { path: "nested.y", kind: "added", right: 2 },
        { path: "add", kind: "added", right: true },
      ],
      truncated: false,
      unchanged: 2,
    });
  });

  it("reports array element additions, removals and changes by index", () => {
    assert.deepEqual(diffJson([1, 2, 3], [1, 9, 3, 4]), {
      changes: [
        { path: "1", kind: "changed", left: 2, right: 9 },
        { path: "3", kind: "added", right: 4 },
      ],
      truncated: false,
      unchanged: 2,
    });
    assert.deepEqual(diffJson([1, 2, 3], [1, 2]).changes, [{ path: "2", kind: "removed", left: 3 }]);
  });

  it("reports container kind changes as a single changed entry", () => {
    const cases = [
      { left: "1", right: 1 },
      { left: null, right: { a: 1 } },
      { left: { a: 1 }, right: [1] },
    ];
    for (const changeCase of cases) {
      const result = diffJson(changeCase.left, changeCase.right);
      assert.deepEqual(result.changes, [{ path: "", kind: "changed", left: changeCase.left, right: changeCase.right }]);
      assert.equal(result.unchanged, 0);
      assert.equal(result.truncated, false);
    }
  });

  it("counts identical deep structures as unchanged", () => {
    const payload = { a: [1, { b: true }], empty: {} };
    assert.deepEqual(diffJson(payload, payload), { changes: [], truncated: false, unchanged: 3 });
  });

  it("compares primitives with numeric equality", () => {
    assert.deepEqual(diffJson(-0, 0), { changes: [], truncated: false, unchanged: 1 });
    assert.deepEqual(diffJson(Number.NaN, Number.NaN), { changes: [], truncated: false, unchanged: 1 });
    assert.deepEqual(diffJson(0, Number.NaN).changes, [{ path: "", kind: "changed", left: 0, right: Number.NaN }]);
    assert.deepEqual(diffJson("1", 1).changes, [{ path: "", kind: "changed", left: "1", right: 1 }]);
  });

  it("escapes dots and backslashes in object-key paths", () => {
    const result = diffJson({ "a.b": 1, "c\\d": 2 }, { "a.b": 3, "c\\d": 4 });
    assert.deepEqual(result.changes, [
      { path: "a\\.b", kind: "changed", left: 1, right: 3 },
      { path: "c\\\\d", kind: "changed", left: 2, right: 4 },
    ]);
    for (const change of result.changes) {
      assert.equal(getByPath({ "a.b": 3, "c\\d": 4 }, change.path), change.right);
    }
  });

  it("distinguishes a missing key from a key set to undefined", () => {
    assert.deepEqual(diffJson({}, { a: undefined }).changes, [{ path: "a", kind: "added", right: undefined }]);
    assert.deepEqual(diffJson({ a: undefined }, {}).changes, [{ path: "a", kind: "removed", left: undefined }]);
    assert.deepEqual(diffJson({ a: undefined }, { a: undefined }), { changes: [], truncated: false, unchanged: 1 });
  });

  it("carries added and removed subtrees without descending", () => {
    assert.deepEqual(diffJson({}, { a: { b: 1, c: [2] } }), {
      changes: [{ path: "a", kind: "added", right: { b: 1, c: [2] } }],
      truncated: false,
      unchanged: 0,
    });
    assert.deepEqual(diffJson({ a: { b: 1 } }, {}).changes, [{ path: "a", kind: "removed", left: { b: 1 } }]);
  });

  it("counts equal empty containers and descends into one-sided ones", () => {
    assert.deepEqual(diffJson({}, {}), { changes: [], truncated: false, unchanged: 1 });
    assert.deepEqual(diffJson([], []), { changes: [], truncated: false, unchanged: 1 });
    assert.deepEqual(diffJson([], [1]), {
      changes: [{ path: "0", kind: "added", right: 1 }],
      truncated: false,
      unchanged: 0,
    });
  });

  it("caps changes at maxChanges while the exact boundary stays untruncated", () => {
    const exact = diffJson({ a: 1 }, { a: 2 }, { maxChanges: 1 });
    assert.equal(exact.changes.length, 1);
    assert.equal(exact.truncated, false);

    const overflow = diffJson({ a: 1, b: 1 }, { a: 2, b: 2 }, { maxChanges: 1 });
    assert.deepEqual(overflow.changes, [{ path: "a", kind: "changed", left: 1, right: 2 }]);
    assert.equal(overflow.truncated, true);
  });

  it("caps compared paths at maxEntries", () => {
    const left = { a: { b: 1 }, c: 2 };
    const right = { a: { b: 1 }, c: 2 };
    assert.deepEqual(diffJson(left, right, { maxEntries: 4 }), { changes: [], truncated: false, unchanged: 2 });
    assert.deepEqual(diffJson(left, right, { maxEntries: 3 }), { changes: [], truncated: true, unchanged: 1 });
  });

  it("caps array comparison at maxArrayItems", () => {
    assert.deepEqual(diffJson([1, 2, 3], [1, 2, 3], { maxArrayItems: 3 }), {
      changes: [],
      truncated: false,
      unchanged: 3,
    });
    assert.deepEqual(diffJson([1, 2, 3], [1, 2, 3], { maxArrayItems: 2 }), {
      changes: [],
      truncated: true,
      unchanged: 2,
    });
  });

  it("falls back to canonical comparison at the depth boundary", () => {
    assert.deepEqual(diffJson({ a: { b: 1 } }, { a: { b: 1 } }, { maxDepth: 1 }), {
      changes: [],
      truncated: false,
      unchanged: 1,
    });
    assert.deepEqual(diffJson({ a: { b: 1 } }, { a: { b: 2 } }, { maxDepth: 1 }).changes, [
      { path: "a", kind: "changed", left: { b: 1 }, right: { b: 2 } },
    ]);
    assert.deepEqual(diffJson({ a: 1 }, { a: 1 }, { maxDepth: 0 }), {
      changes: [],
      truncated: false,
      unchanged: 1,
    });
  });

  it("terminates on cycles and flags truncation", () => {
    const left: Record<string, unknown> = { value: 1, keep: true };
    left["self"] = left;
    const right: Record<string, unknown> = { value: 1, keep: true };
    right["self"] = right;
    assert.deepEqual(diffJson(left, right), { changes: [], truncated: true, unchanged: 2 });

    const leftArray: unknown[] = [1];
    leftArray.push(leftArray);
    const rightArray: unknown[] = [1];
    rightArray.push(rightArray);
    assert.deepEqual(diffJson(leftArray, rightArray), { changes: [], truncated: true, unchanged: 1 });
  });

  it("flags truncation when canonical serialisation hits a cycle at the depth boundary", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assert.deepEqual(diffJson(cyclic, { self: {} }, { maxDepth: 1 }), {
      changes: [],
      truncated: true,
      unchanged: 0,
    });
  });

  it("keeps change order deterministic", () => {
    const result = diffJson({ b: 1, a: 2 }, { b: 9, a: 8, c: 3 });
    assert.deepEqual(
      result.changes.map((change) => change.path),
      ["b", "a", "c"],
    );
  });

  it("never mutates either input", () => {
    const left = { a: [1, { b: 2 }] };
    const right = { a: [1, { b: 3 }] };
    const leftBefore = JSON.stringify(left);
    const rightBefore = JSON.stringify(right);
    diffJson(left, right);
    assert.equal(JSON.stringify(left), leftBefore);
    assert.equal(JSON.stringify(right), rightBefore);
  });

  it("normalises invalid limits", () => {
    assert.deepEqual(diffJson({ a: 1 }, { a: 1 }, { maxDepth: Number.NaN, maxEntries: -1, maxChanges: -2 }), {
      changes: [],
      truncated: false,
      unchanged: 1,
    });
  });
});

describe("jsonPath", () => {
  it("joins segments with a dot and returns the segment alone at the root", () => {
    assert.equal(jsonPath("", "name"), "name");
    assert.equal(jsonPath("patient", "name"), "patient.name");
    assert.equal(jsonPath("patient.name", ""), "patient.name.");
  });

  it("escapes dots and backslashes in object keys", () => {
    assert.equal(jsonPath("", "a.b"), "a\\.b");
    assert.equal(jsonPath("", "c\\d"), "c\\\\d");
    assert.equal(jsonPath("root", "a.b"), "root.a\\.b");
    assert.equal(jsonPath("root", "c\\d"), "root.c\\\\d");
    assert.equal(jsonPath("a\\.b", "c.d"), "a\\.b.c\\.d");
  });

  it("renders numeric segments raw at the root and nested", () => {
    assert.equal(jsonPath("", 0), "0");
    assert.equal(jsonPath("", 12), "12");
    assert.equal(jsonPath("items", 3), "items.3");
    assert.equal(jsonPath("items.3.tags", 0), "items.3.tags.0");
  });

  it("round-trips escaped keys and indices through getByPath", () => {
    const payload = { "a.b": [{ "c\\d": { "e.f": 1 } }], plain: [2] };
    const escaped = jsonPath(jsonPath(jsonPath(jsonPath("", "a.b"), 0), "c\\d"), "e.f");
    assert.equal(escaped, "a\\.b.0.c\\\\d.e\\.f");
    assert.equal(getByPath(payload, escaped), 1);
    assert.equal(getByPath(payload, jsonPath(jsonPath("", "plain"), 0)), 2);
  });
});
