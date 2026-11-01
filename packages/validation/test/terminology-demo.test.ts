import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FhirValidator, type TerminologyProvider } from "@healthbridge/validation";

/**
 * Synthetic, hard-coded demo terminology for tests ONLY. It is not a clinical
 * code system, makes no validity claim about real editions, and must never be
 * shipped as a bundled codeset: production providers are injected by the
 * operator (licence-aware), exactly as `TransformOptions.terminology` does.
 */
const SYNTHETIC_CODES: Record<string, Set<string>> = {
  "http://loinc.org": new Set(["2339-0", "1234-5"]),
  "http://unitsofmeasure.org": new Set(["mg/dL", "g/L", "mL", "L"]),
};

const demoTerminology: TerminologyProvider = {
  name: "synthetic-demo-terminology",
  licence: "synthetic-test-only — not a clinical code system, never bundled",
  validateCode: ({ system, code, path }) => {
    if (!system || !code) {
      return {
        valid: false,
        issues: [
          {
            code: "INCOMPLETE_CODING",
            severity: "warning",
            message: "Coding needs both a system and a code for terminology lookup",
            path,
          },
        ],
      };
    }
    const known = SYNTHETIC_CODES[system];
    if (!known) {
      return {
        valid: false,
        issues: [
          {
            code: "UNKNOWN_CODE_SYSTEM",
            severity: "warning",
            message: `Code system '${system}' is not in the synthetic demo table`,
            path,
          },
        ],
      };
    }
    if (!known.has(code)) {
      return {
        valid: false,
        issues: [
          {
            code: "UNKNOWN_CODE",
            severity: "warning",
            message: `Code '${code}' is not a known code in '${system}' (synthetic demo table)`,
            path,
          },
        ],
      };
    }
    return { valid: true, issues: [] };
  },
};

describe("terminology level with an injected provider", () => {
  test("a known code validates with level 5 executed", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "2339-0" }] },
      },
      { terminology: demoTerminology },
    );
    assert.equal(result.isValid, true);
    assert.deepEqual(result.issues, []);
    const level5 = result.levels.find((l) => l.level === 5);
    assert.equal(level5?.status, "executed");
    assert.equal(level5?.validator, "synthetic-demo-terminology");
  });

  test("an unknown code in a known system reports UNKNOWN_CODE", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "99999-9" }] },
      },
      { terminology: demoTerminology },
    );
    assert.ok(result.issues.some((i) => i.code === "UNKNOWN_CODE"));
    assert.equal(result.levels.find((l) => l.level === 5)?.status, "executed");
  });

  test("a coding without a system reports incomplete coding", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ code: "2339-0" }] },
      },
      { terminology: demoTerminology },
    );
    assert.equal(result.levels.find((l) => l.level === 5)?.status, "executed");
    assert.ok(result.issues.some((i) => i.code === "INCOMPLETE_CODING"));
  });

  test("UCUM-subset units validate against the synthetic table", () => {
    const validator = new FhirValidator();
    const known = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { coding: [{ system: "http://unitsofmeasure.org", code: "mg/dL" }] },
      },
      { terminology: demoTerminology },
    );
    assert.equal(known.isValid, true);

    const unknown = validator.validateWithDetail(
      {
        resourceType: "Observation",
        id: "o2",
        status: "final",
        code: { coding: [{ system: "http://unitsofmeasure.org", code: "furlong" }] },
      },
      { terminology: demoTerminology },
    );
    assert.ok(unknown.issues.some((i) => i.code === "UNKNOWN_CODE"));
  });

  test("without a provider level 5 stays skipped with a licence reason", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail({ resourceType: "Patient", id: "p1" });
    const level5 = result.levels.find((l) => l.level === 5);
    assert.equal(level5?.status, "skipped");
    assert.match(level5?.reason ?? "", /licensed|bundled/);
  });
});
