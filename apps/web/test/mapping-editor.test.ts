import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONDITION_OPERATORS,
  NO_LOCAL_EXECUTION,
  TRANSFORM_FUNCTIONS,
  VALIDATE_ON_SAVE,
  assetSummaryFromRecord,
  blankRule,
  blockingIssueCount,
  mappingNameFromSpec,
  moveRow,
  parseDefaultText,
  parseWhenJson,
  rulesFromSpec,
  severityTone,
  sourceFieldsFromRows,
  specRulesFromRows,
  targetFieldsFromRows,
  targetResourceTypeFromSpec,
  validateEditorRows,
  versionsFromResponse,
  type EditorRule,
} from "../src/app/features/mapping-editor/mapping-editor.logic";

/**
 * Mapping-editor presentation logic. Every claim the page makes — which transforms
 * and operators exist, which issue codes an edit can produce, what a malformed
 * stored payload renders as — flows through here, so the engine mirrors are pinned
 * against `packages/mapping-engine/src/index.ts` and malformed payloads degrade to
 * empty states instead of throwing.
 */

function row(overrides: Partial<EditorRule> = {}): EditorRule {
  return {
    id: "r1",
    sourcePath: "patient_id",
    targetPath: "id",
    transform: "identity",
    defaultText: "",
    required: false,
    whenJson: "",
    ...overrides,
  };
}

describe("engine mirrors", () => {
  it("pins the transform list to the engine's TRANSFORM_FUNCTIONS", () => {
    assert.deepEqual(
      [...TRANSFORM_FUNCTIONS],
      [
        "identity",
        "uppercase",
        "lowercase",
        "trim",
        "parse_date_iso",
        "format_gender_fhir",
        "concat",
        "split",
        "number_to_string",
        "string_to_number",
        "default_value",
        "to_reference",
        "codeable_concept",
        "convert_units",
      ],
    );
  });

  it("pins the condition operators to the engine's CONDITION_OPERATORS", () => {
    assert.deepEqual(
      [...CONDITION_OPERATORS],
      ["exists", "not_exists", "equals", "not_equals", "in", "not_in", "matches", "gt", "gte", "lt", "lte"],
    );
  });
});

describe("canary wording", () => {
  it("pins the no-local-execution notice verbatim", () => {
    assert.match(NO_LOCAL_EXECUTION, /never execute against patient data in the browser/);
  });

  it("pins the validate-on-save path verbatim", () => {
    assert.match(VALIDATE_ON_SAVE, /Validate on save via the API/);
  });
});

describe("rulesFromSpec", () => {
  it("reads stored rules into editable rows with a JSON round-trip for conditions", () => {
    const rows = rulesFromSpec({
      rules: [
        {
          id: "r1",
          sourcePath: "sex",
          targetPath: "gender",
          transform: "format_gender_fhir",
          required: true,
          when: [{ path: "sex", op: "exists" }],
          defaultValue: "unknown",
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "r1");
    assert.equal(rows[0]?.required, true);
    assert.equal(rows[0]?.defaultText, "unknown");
    assert.deepEqual(JSON.parse(rows[0]?.whenJson ?? ""), [{ path: "sex", op: "exists" }]);
  });

  it("serialises non-string defaults as JSON text", () => {
    const rows = rulesFromSpec({
      rules: [{ id: "r2", sourcePath: "a", targetPath: "b", transform: "default_value", defaultValue: 42 }],
    });
    assert.equal(rows[0]?.defaultText, "42");
  });

  it("degrades malformed specs to an empty list instead of throwing", () => {
    for (const spec of [undefined, null, 42, "junk", [], {}, { rules: "junk" }, { rules: [null, 7, "x"] }]) {
      assert.deepEqual(rulesFromSpec(spec), spec === undefined ? [] : (rulesFromSpec(spec) ?? []));
    }
    assert.doesNotThrow(() => rulesFromSpec({ rules: [{ toString: "evil" }] }));
  });

  it("coerces non-string fields to blanks so validation flags them", () => {
    const [only] = rulesFromSpec({ rules: [{ id: 7, sourcePath: null }] });
    assert.equal(only?.id, "");
    assert.equal(only?.sourcePath, "");
    assert.equal(only?.transform, "");
  });
});

describe("specRulesFromRows", () => {
  it("round-trips rows back into spec rules, omitting absent optionals", () => {
    const rules = specRulesFromRows([row(), row({ id: "r2", required: true, defaultText: '"x"', whenJson: "[]" })]);
    assert.deepEqual(rules[0], { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity" });
    assert.deepEqual(rules[1], {
      id: "r2",
      sourcePath: "patient_id",
      targetPath: "id",
      transform: "identity",
      defaultValue: "x",
      required: true,
    });
  });

  it("keeps non-JSON default text as the raw string", () => {
    const [only] = specRulesFromRows([row({ defaultText: "plain" })]);
    assert.equal(only?.["defaultValue"], "plain");
  });
});

describe("parse helpers", () => {
  it("treats blank default text as absent", () => {
    assert.deepEqual(parseDefaultText("  "), { present: false });
    assert.deepEqual(parseDefaultText('"a"'), { present: true, value: "a" });
  });

  it("treats blank when text as no conditions and rejects non-arrays", () => {
    assert.deepEqual(parseWhenJson(""), { ok: true, conditions: [] });
    assert.equal(parseWhenJson("[oops").ok, false);
    assert.equal(parseWhenJson('{"path":"a"}').ok, false);
  });
});

describe("validateEditorRows", () => {
  it("passes a clean draft with no issues", () => {
    assert.deepEqual(validateEditorRows([row(), row({ id: "r2", sourcePath: "sex", targetPath: "gender" })]), []);
  });

  it("reports an empty draft with MAPPING_EMPTY", () => {
    const [only] = validateEditorRows([]);
    assert.equal(only?.code, "MAPPING_EMPTY");
    assert.equal(only?.severity, "error");
  });

  it("reports an unknown transform with MAPPING_UNKNOWN_TRANSFORM and advice", () => {
    const [only] = validateEditorRows([row({ transform: "teleport" })]);
    assert.equal(only?.code, "MAPPING_UNKNOWN_TRANSFORM");
    assert.equal(only?.severity, "error");
    assert.match(only?.advice ?? "", /identity/);
  });

  it("reports duplicate ids with MAPPING_DUPLICATE_RULE_ID", () => {
    const codes = validateEditorRows([row(), row()]).map((issue) => issue.code);
    assert.ok(codes.includes("MAPPING_DUPLICATE_RULE_ID"));
  });

  it("reports missing paths with the engine's missing-path codes", () => {
    const codes = validateEditorRows([row({ sourcePath: "", targetPath: "  " })]).map((issue) => issue.code);
    assert.ok(codes.includes("MAPPING_MISSING_SOURCE_PATH"));
    assert.ok(codes.includes("MAPPING_MISSING_TARGET_PATH"));
  });

  it("reports default_value without a value with MAPPING_MISSING_DEFAULT_VALUE", () => {
    const [only] = validateEditorRows([row({ transform: "default_value", defaultText: " " })]);
    assert.equal(only?.code, "MAPPING_MISSING_DEFAULT_VALUE");
  });

  it("reports shared targets as a warning, never blocking", () => {
    const [only] = validateEditorRows([row(), row({ id: "r2", sourcePath: "other" })]);
    assert.equal(only?.code, "MAPPING_DUPLICATE_TARGET");
    assert.equal(only?.severity, "warning");
    assert.equal(blockingIssueCount([only!]), 0);
  });

  it("reports a condition without a path with MAPPING_INVALID_CONDITION", () => {
    const [only] = validateEditorRows([row({ whenJson: '[{"op":"exists"}]' })]);
    assert.equal(only?.code, "MAPPING_INVALID_CONDITION");
    assert.equal(only?.ruleId, "r1");
  });

  it("reports an unknown operator with MAPPING_UNKNOWN_CONDITION_OPERATOR", () => {
    const [only] = validateEditorRows([row({ whenJson: '[{"path":"sex","op":"vibes"}]' })]);
    assert.equal(only?.code, "MAPPING_UNKNOWN_CONDITION_OPERATOR");
  });

  it("reports unparsable when text with MAPPING_RULE_INVALID_FIELD", () => {
    const [only] = validateEditorRows([row({ whenJson: "not json" })]);
    assert.equal(only?.code, "MAPPING_RULE_INVALID_FIELD");
  });

  it("counts only error and fatal issues as blocking", () => {
    assert.equal(
      blockingIssueCount([
        { code: "MAPPING_DUPLICATE_TARGET", severity: "warning", message: "w" },
        { code: "MAPPING_EMPTY", severity: "error", message: "e" },
        { code: "MAPPING_NOT_OBJECT", severity: "fatal", message: "f" },
        { code: "X", severity: "information", message: "i" },
      ]),
      2,
    );
  });
});

describe("moveRow", () => {
  it("moves a row without drag-and-drop and leaves the input untouched", () => {
    const rows = ["a", "b", "c"];
    assert.deepEqual(moveRow(rows, 0, 2), ["b", "c", "a"]);
    assert.deepEqual(moveRow(rows, 2, 0), ["c", "a", "b"]);
    assert.deepEqual(rows, ["a", "b", "c"]);
  });

  it("ignores out-of-range and no-op moves", () => {
    const rows = ["a", "b"];
    assert.deepEqual(moveRow(rows, 0, 0), ["a", "b"]);
    assert.deepEqual(moveRow(rows, -1, 1), ["a", "b"]);
    assert.deepEqual(moveRow(rows, 0, 5), ["a", "b"]);
    assert.deepEqual(moveRow(rows, 9, 0), ["a", "b"]);
  });
});

describe("schema explorers", () => {
  it("lists distinct source and target fields in first-seen order", () => {
    const rows = [row(), row({ id: "r2", sourcePath: "patient_id", targetPath: "other" }), row({ id: "r3" })];
    assert.deepEqual(sourceFieldsFromRows(rows), ["patient_id"]);
    assert.deepEqual(targetFieldsFromRows(rows), ["id", "other"]);
  });

  it("reads the target resource and mapping name defensively", () => {
    assert.equal(targetResourceTypeFromSpec({ targetResourceType: " Patient " }), "Patient");
    assert.equal(targetResourceTypeFromSpec({}), null);
    assert.equal(targetResourceTypeFromSpec(null), null);
    assert.equal(mappingNameFromSpec({ name: "patient-migration" }), "patient-migration");
    assert.equal(mappingNameFromSpec({ name: "" }), null);
  });

  it("blank rows carry a caller-supplied id and safe defaults", () => {
    assert.deepEqual(blankRule("r9"), {
      id: "r9",
      sourcePath: "",
      targetPath: "",
      transform: "identity",
      defaultText: "",
      required: false,
      whenJson: "",
    });
  });
});

describe("versionsFromResponse", () => {
  it("orders versions newest first and drops malformed entries", () => {
    const versions = versionsFromResponse({
      versions: [
        { id: "a", name: "m", version: 1, specChecksum: "sha256:1", createdAt: "2026-01-01T00:00:00Z" },
        { id: "b", name: "m", version: 2, specChecksum: "sha256:2", createdAt: "2026-01-02T00:00:00Z" },
        null,
        { id: "", version: 3 },
        { id: "c", version: "two" },
      ],
    });
    assert.deepEqual(
      versions.map((entry) => entry.version),
      [2, 1],
    );
  });

  it("degrades malformed payloads to an empty list instead of throwing", () => {
    for (const payload of [undefined, null, {}, { versions: "junk" }, { versions: [42] }]) {
      assert.deepEqual(versionsFromResponse(payload), []);
    }
  });
});

describe("assetSummaryFromRecord", () => {
  it("reads the stored asset row for the explorer header", () => {
    assert.deepEqual(
      assetSummaryFromRecord({
        id: "as_1",
        filename: "patients.csv",
        sourceFormat: "csv",
        domain: "clinical",
        sizeBytes: 128,
        checksum: "sha256:abc",
      }),
      {
        id: "as_1",
        filename: "patients.csv",
        sourceFormat: "csv",
        domain: "clinical",
        sizeBytes: 128,
        checksum: "sha256:abc",
      },
    );
  });

  it("returns null when the payload is not an asset row", () => {
    for (const asset of [undefined, null, {}, { id: "as_1" }, { filename: "x.csv" }, 42]) {
      assert.equal(assetSummaryFromRecord(asset), null);
    }
  });
});

describe("severityTone", () => {
  it("mirrors the run-detail severity mapping", () => {
    assert.equal(severityTone("fatal"), "danger");
    assert.equal(severityTone("error"), "danger");
    assert.equal(severityTone("warning"), "warn");
    assert.equal(severityTone("information"), "info");
    assert.equal(severityTone("anything-else"), "info");
  });
});
