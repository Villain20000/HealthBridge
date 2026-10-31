import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  MAX_MAPPING_ISSUES,
  mappingSpecChecksum,
  normaliseAndValidate,
  toValidationResult,
} from "../src/common/mapping-spec.js";
import { fixtureJson } from "./harness.js";

/**
 * Spec validation is the gate between an editor's arbitrary JSON and every
 * consumer that needs a `MappingDefinition`. These tests pin the checksum
 * formula and the "blocking vs informational" contract.
 */

const FIXTURE = ["scenarios", "01-hospital-patient-migration", "mapping", "patient.json"];

describe("mapping spec helpers", () => {
  it("preserves JSON key order in the checksum", () => {
    const literal = '{"b":1,"a":2}';
    const expected = `sha256:${createHash("sha256").update(literal).digest("hex")}`;
    assert.equal(mappingSpecChecksum({ b: 1, a: 2 }), expected);
    assert.notEqual(mappingSpecChecksum({ b: 1, a: 2 }), mappingSpecChecksum({ a: 2, b: 1 }));
  });

  it("rejects a non-object spec with a fatal issue", () => {
    const result = normaliseAndValidate(null);
    assert.equal(result.definition, undefined);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.code, "MAPPING_NOT_OBJECT");
    assert.equal(result.issues[0]?.severity, "fatal");
  });

  it("returns the definition for the hospital patient fixture", () => {
    const fixture = fixtureJson<Record<string, unknown>>(...FIXTURE);
    const result = normaliseAndValidate(fixture);

    assert.ok(result.definition);
    assert.equal(result.definition?.id, "hospital-patient-to-fhir");
    assert.equal(result.definition?.name, "Hospital CSV Patient to FHIR R4 Patient");
    assert.equal(
      result.issues.some((issue) => issue.severity === "fatal" || issue.severity === "error"),
      false,
    );
  });

  it("adds exactly one informational issue when the catalogue name differs", () => {
    const fixture = fixtureJson<Record<string, unknown>>(...FIXTURE);
    const anonymous = normaliseAndValidate(fixture);
    const named = normaliseAndValidate(fixture, "different-name");

    assert.ok(named.definition);
    assert.equal(named.definition, fixture, "validation must not copy or mutate the spec");
    assert.equal(
      anonymous.issues.some((issue) => issue.code === "MAPPING_NAME_MISMATCH"),
      false,
    );

    const mismatches = named.issues.filter((issue) => issue.code === "MAPPING_NAME_MISMATCH");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0]?.severity, "information");
    assert.equal(mismatches[0]?.path, "name");
    assert.equal(mismatches[0]?.message, "Mapping display name does not match the catalogue name 'different-name'.");
  });

  it("caps issues at 200 and counts only the capped list", () => {
    const spec = {
      id: "too-many-rules",
      name: "Too many rules",
      version: "1.0.0",
      sourceFormat: "csv",
      targetFormat: "fhir-r4",
      rules: Array.from({ length: 210 }, () => null),
    };

    const result = normaliseAndValidate(spec);
    assert.equal(result.definition, undefined);
    assert.equal(result.issues.length, MAX_MAPPING_ISSUES);

    const validation = toValidationResult(result.issues);
    assert.equal(validation.counts.error, MAX_MAPPING_ISSUES);
    assert.equal(validation.counts.fatal, 0);
    assert.equal(validation.isValid, false);
    assert.equal(validation.issues.length, MAX_MAPPING_ISSUES);
  });
});
