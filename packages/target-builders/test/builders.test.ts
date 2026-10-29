import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVENANCE_EXTENSION_URL,
  TargetBuilderRegistry,
  defaultTargetBuilderRegistry,
  pruneEmpty,
} from "@healthbridge/target-builders";
import { BuildInput } from "@healthbridge/target-builders";

const baseInput = (data: Record<string, unknown>, overrides: Partial<BuildInput> = {}): BuildInput => ({
  data,
  mapping: {
    id: "m1",
    version: "1.0.0",
    targetFormat: "fhir-r4",
    targetResourceType: "Patient",
  },
  envelopeId: "env-1",
  adapterId: "csv-adapter",
  adapterVersion: "1.1.0",
  importedAt: "2024-01-01T00:00:00.000Z",
  sensitivity: "sensitive",
  ...overrides,
});

describe("FHIR target builders", () => {
  test("normalises invalid ids and reports it instead of emitting invalid FHIR", () => {
    const result = defaultTargetBuilderRegistry.build(baseInput({ id: "P 100/1", resourceType: "Patient" }));
    assert.ok(result);
    assert.equal(result.resource.id, "P-100-1");
    assert.ok(result.issues.some((i) => i.code === "ID_NORMALISED"));
  });

  test("attaches provenance describing adapter, mapping and sensitivity", () => {
    const result = defaultTargetBuilderRegistry.build(baseInput({ id: "P1", resourceType: "Patient" }));
    assert.ok(result);
    const extensions = result.resource.extension as Array<Record<string, unknown>>;
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0].url, PROVENANCE_EXTENSION_URL);
    const children = extensions[0].extension as Array<Record<string, unknown>>;
    const byUrl = new Map(children.map((c) => [c.url as string, c]));
    assert.equal(byUrl.get("adapterId")?.valueString, "csv-adapter");
    assert.equal(byUrl.get("mappingVersion")?.valueString, "1.0.0");
    assert.equal(byUrl.get("sensitivity")?.valueCode, "sensitive");
    assert.equal(byUrl.get("importedAt")?.valueDateTime, "2024-01-01T00:00:00.000Z");
  });

  test("removes empty values left behind by optional rules", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput({ resourceType: "Patient", id: "P1", birthDate: "", name: [], address: {} }),
    );
    assert.ok(result);
    assert.equal(result.resource.birthDate, undefined);
    assert.equal(result.resource.name, undefined);
    assert.equal(result.resource.address, undefined);
  });

  test("Observation without status gets an explicit 'unknown' plus a warning", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "2345-7" }] } },
        { mapping: { id: "labs", version: "1.0.0", targetFormat: "fhir-r4", targetResourceType: "Observation" } },
      ),
    );
    assert.ok(result);
    assert.equal(result.resource.status, "unknown");
    assert.ok(result.issues.some((i) => i.code === "STATUS_DEFAULTED" && i.severity === "warning"));
    assert.equal(result.rejected, false);
  });

  test("Observation without a code is rejected, not exported", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "Observation", status: "final" },
        { mapping: { id: "labs", version: "1.0.0", targetFormat: "fhir-r4", targetResourceType: "Observation" } },
      ),
    );
    assert.ok(result);
    assert.equal(result.rejected, true);
    assert.ok(result.issues.some((i) => i.code === "MISSING_REQUIRED_ELEMENT" && i.severity === "error"));
  });

  test("numeric quantity strings are coerced, invalid ones are reported", () => {
    const good = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "Observation", status: "final", code: { text: "x" }, valueQuantity: { value: "5,4" } },
        { mapping: { id: "l", version: "1", targetFormat: "fhir-r4", targetResourceType: "Observation" } },
      ),
    );
    assert.equal((good?.resource.valueQuantity as Record<string, unknown>).value, 5.4);

    const bad = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "Observation", status: "final", code: { text: "x" }, valueQuantity: { value: "abc" } },
        { mapping: { id: "l", version: "1", targetFormat: "fhir-r4", targetResourceType: "Observation" } },
      ),
    );
    assert.equal(bad?.rejected, true);
    assert.ok(bad?.issues.some((i) => i.code === "INVALID_QUANTITY_VALUE"));
  });

  test("DiagnosticReport requires status and code", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "DiagnosticReport" },
        { mapping: { id: "dr", version: "1", targetFormat: "fhir-r4", targetResourceType: "DiagnosticReport" } },
      ),
    );
    assert.ok(result);
    assert.equal(result.resource.status, "unknown");
    assert.equal(result.rejected, true);
  });

  test("Patient without id, identifier or name is flagged", () => {
    const result = defaultTargetBuilderRegistry.build(baseInput({ resourceType: "Patient" }));
    assert.ok(result);
    assert.ok(result.issues.some((i) => i.code === "PATIENT_WITHOUT_IDENTIFIER" && i.severity === "warning"));
    assert.equal(result.rejected, false);
  });

  test("generic builder injects resourceType from the mapping and reports it", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput(
        { id: "X1" },
        { mapping: { id: "g", version: "1", targetFormat: "fhir-r4", targetResourceType: "Encounter" } },
      ),
    );
    assert.ok(result);
    assert.equal(result.resource.resourceType, "Encounter");
    assert.ok(result.issues.some((i) => i.code === "RESOURCE_TYPE_INJECTED"));
  });

  test("targetProfile is declared in meta.profile", () => {
    const result = defaultTargetBuilderRegistry.build(
      baseInput(
        { resourceType: "Patient", id: "P1" },
        {
          mapping: {
            id: "p",
            version: "1",
            targetFormat: "fhir-r4",
            targetResourceType: "Patient",
            targetProfile: "http://hl7.org/fhir/StructureDefinition/Patient",
          },
        },
      ),
    );
    assert.ok(result);
    assert.deepEqual((result.resource.meta as Record<string, unknown>).profile, [
      "http://hl7.org/fhir/StructureDefinition/Patient",
    ]);
  });

  test("no builder is resolved for unimplemented target formats", () => {
    const registry = new TargetBuilderRegistry();
    assert.equal(registry.resolve({ id: "o", version: "1", targetFormat: "omop-cdm" }), undefined);
    assert.equal(
      registry.build(baseInput({ id: "1" }, { mapping: { id: "o", version: "1", targetFormat: "omop-cdm" } })),
      undefined,
    );
  });

  test("pruneEmpty keeps falsy business values", () => {
    assert.deepEqual(pruneEmpty({ a: 0, b: false, c: "", d: [], e: {}, f: "x" }), { a: 0, b: false, f: "x" });
  });
});
