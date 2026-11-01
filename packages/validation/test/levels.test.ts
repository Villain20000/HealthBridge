import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FhirValidator, checkReferentialIntegrity } from "@healthbridge/validation";

describe("validation levels 4-6 detail", () => {
  test("reports 4-6 as skipped when no providers are configured", () => {
    const v = new FhirValidator();
    const result = v.validateWithDetail({ resourceType: "Patient", id: "p1" });
    assert.equal(result.levels.length, 4);
    assert.deepEqual(
      result.levels.map((l) => l.level),
      [3, 4, 5, 6],
    );
    assert.equal(result.levels.find((l) => l.level === 3)?.status, "executed");
    for (const level of [4, 5, 6] as const) {
      const entry = result.levels.find((l) => l.level === level);
      assert.equal(entry?.status, "skipped");
      assert.ok(entry?.reason);
    }
  });

  test("executes profile and terminology levels when providers are supplied", () => {
    const v = new FhirValidator();
    const result = v.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "99999-9" }] },
      },
      {
        profile: {
          name: "test-profile",
          validate: () => ({
            isValid: false,
            issues: [{ code: "PROFILE_MISMATCH", severity: "error", message: "missing must-support", path: "status" }],
          }),
        },
        terminology: {
          name: "test-terminology",
          licence: "test-only",
          validateCode: (coding) => ({
            valid: false,
            issues: [
              {
                code: "UNKNOWN_CODE",
                severity: "warning",
                message: `Unknown code '${coding.code}'`,
                path: coding.path,
              },
            ],
          }),
        },
      },
    );
    assert.equal(result.levels.find((l) => l.level === 4)?.status, "executed");
    assert.equal(result.levels.find((l) => l.level === 5)?.status, "executed");
    assert.equal(result.isValid, false);
    assert.ok(result.issues.some((i) => i.code === "PROFILE_MISMATCH"));
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_CODE"));
  });

  test("referential integrity warns on dangling references and passes on linked ones", () => {
    const report = { resourceType: "DiagnosticReport", id: "dr1", result: [{ reference: "Observation/missing" }] };
    const dangling = checkReferentialIntegrity([report]);
    assert.ok(dangling.some((i) => i.code === "UNRESOLVED_REFERENCE"));

    const linked = checkReferentialIntegrity([
      report,
      { resourceType: "Observation", id: "missing", status: "final", code: { text: "x" } },
    ]);
    assert.equal(linked.length, 0);
  });
});
