import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MIABIS_BIOBANK_TABLE,
  MIABIS_COLLECTION_TABLE,
  MIABIS_DONOR_TABLE,
  MIABIS_SAMPLE_TABLE,
  miabisBiobankValidator,
  miabisCollectionValidator,
  miabisSampleDonorValidator,
  miabisSampleValidator,
  miabisValidators,
} from "../src/miabis.js";
import { FhirValidator } from "@healthbridge/validation";

/**
 * MIABIS Core 2.0 profile validators (ROADMAP Phase G).
 *
 * Synthetic fixtures only. These tests assert mapping-limited structural
 * behaviour: missing attributes are reported with MIABIS_* codes and never
 * defaulted, and no operational or consent claims are made.
 */

const fullBiobank = (): Record<string, unknown> => ({
  resourceType: "Organization",
  id: "bb-1",
  name: "Example Biobank",
  alias: ["EB"],
  contact: [{ telecom: [{ system: "email", value: "contact@example.org" }] }],
  extension: [
    { url: "https://example.org/fhir/StructureDefinition/juristic-person", valueString: "Example Foundation" },
    { url: "https://example.org/fhir/StructureDefinition/biobank-url", valueUrl: "https://example.org/bb" },
  ],
});

const fullCollectionOrg = (): Record<string, unknown> => ({
  resourceType: "Organization",
  id: "col-1",
  name: "Example Collection",
  alias: ["EC"],
  partOf: { reference: "Organization/bb-1" },
  extension: [
    { url: "https://example.org/fhir/StructureDefinition/collection-description", valueString: "Frozen serum collection" },
  ],
});

const fullDonor = (): Record<string, unknown> => ({
  resourceType: "Patient",
  id: "donor-1",
  birthDate: "1970-05-01",
  gender: "female",
});

const fullSample = (): Record<string, unknown> => ({
  resourceType: "Specimen",
  id: "sample-1",
  type: { text: "Serum" },
  collection: { collectedDateTime: "2020-01-02" },
  extension: [
    {
      url: "https://example.org/fhir/StructureDefinition/storage-temperature",
      valueCodeableConcept: { text: "-80C" },
    },
  ],
});

describe("miabis biobank validator (Biobank -> Organization)", () => {
  test("a complete biobank Organization passes with no issues", () => {
    const outcome = miabisBiobankValidator.validate(fullBiobank());
    assert.equal(outcome.isValid, true);
    assert.deepEqual(outcome.issues, []);
  });

  test("a wrong resourceType is an error, never a retype", () => {
    const outcome = miabisBiobankValidator.validate({ resourceType: "Patient", id: "x" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_BIOBANK_WRONG_RESOURCE_TYPE"));
  });

  test("missing id and name are errors", () => {
    const outcome = miabisBiobankValidator.validate({ resourceType: "Organization" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_BIOBANK_ID_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_BIOBANK_NAME_MISSING"));
  });

  test("missing acronym/contact/juristic-person/url are warnings that keep validity", () => {
    const outcome = miabisBiobankValidator.validate({
      resourceType: "Organization",
      id: "bb-1",
      name: "Example Biobank",
    });
    assert.equal(outcome.isValid, true);
    for (const code of [
      "MIABIS_BIOBANK_ACRONYM_MISSING",
      "MIABIS_BIOBANK_CONTACT_MISSING",
      "MIABIS_BIOBANK_JURISTIC_PERSON_MISSING",
      "MIABIS_BIOBANK_URL_MISSING",
    ]) {
      assert.ok(outcome.issues.some((i) => i.code === code), `expected ${code}`);
    }
  });

  test("missing values are reported, never defaulted, and messages carry the table without PHI", () => {
    const resource = {
      resourceType: "Organization",
      id: "bb-9",
      name: "SecretName-XYZ-Unique",
    };
    const before = structuredClone(resource);
    const outcome = miabisBiobankValidator.validate(resource);
    assert.deepEqual(resource, before);
    assert.ok(outcome.issues.length > 0);
    for (const issue of outcome.issues) {
      assert.match(issue.code, /^MIABIS_/);
      assert.ok(issue.message.includes("MIABIS Core 2.0"), "table in reason string");
      assert.ok(issue.message.includes("never defaulted"), "never-defaulted limit in reason string");
      assert.ok(!issue.message.includes("SecretName-XYZ-Unique"), "no source value echoed");
      assert.equal(issue.offendingValue, undefined);
    }
  });
});

describe("miabis collection validator (Collection -> Organization | ResearchStudy)", () => {
  test("a complete Organization collection with partOf passes", () => {
    const outcome = miabisCollectionValidator.validate(fullCollectionOrg());
    assert.equal(outcome.isValid, true);
    assert.deepEqual(outcome.issues, []);
  });

  test("a ResearchStudy collection shape passes too", () => {
    const outcome = miabisCollectionValidator.validate({
      resourceType: "ResearchStudy",
      id: "col-2",
      title: "Example Study Collection",
      label: [{ text: "ESC" }],
      description: "Plasma collection",
      partOf: [{ reference: "Organization/bb-1" }],
    });
    assert.equal(outcome.isValid, true);
    assert.deepEqual(outcome.issues, []);
  });

  test("a wrong resourceType is an error", () => {
    const outcome = miabisCollectionValidator.validate({ resourceType: "Specimen", id: "x" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_COLLECTION_WRONG_RESOURCE_TYPE"));
  });

  test("missing name fails; missing parent link only warns and is never guessed", () => {
    const resource = { resourceType: "ResearchStudy", id: "col-3" };
    const outcome = miabisCollectionValidator.validate(resource);
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_COLLECTION_NAME_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_COLLECTION_PARENT_LINK_MISSING"));
    assert.deepEqual(resource, { resourceType: "ResearchStudy", id: "col-3" });
  });
});

describe("miabis sample-donor validator (SampleDonor -> Patient)", () => {
  test("a complete donor Patient passes", () => {
    const outcome = miabisSampleDonorValidator.validate(fullDonor());
    assert.equal(outcome.isValid, true);
    assert.deepEqual(outcome.issues, []);
  });

  test("a wrong resourceType is an error", () => {
    const outcome = miabisSampleDonorValidator.validate({ resourceType: "Organization", id: "x" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_DONOR_WRONG_RESOURCE_TYPE"));
  });

  test("missing birthDate/sex warn and are never imputed", () => {
    const resource = { resourceType: "Patient", id: "donor-2" };
    const outcome = miabisSampleDonorValidator.validate(resource);
    assert.equal(outcome.isValid, true);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_DONOR_BIRTHDATE_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_DONOR_SEX_MISSING"));
    assert.deepEqual(resource, { resourceType: "Patient", id: "donor-2" });
  });

  test("malformed birthDate and unrecognised sex warn and are kept as-is", () => {
    const resource = { resourceType: "Patient", id: "donor-3", birthDate: "05/01/1970", gender: "X" };
    const outcome = miabisSampleDonorValidator.validate(resource);
    assert.equal(outcome.isValid, true);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_DONOR_BIRTHDATE_MALFORMED"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_DONOR_SEX_UNRECOGNISED"));
    assert.equal(resource.birthDate, "05/01/1970");
    assert.equal(resource.gender, "X");
  });
});

describe("miabis sample validator (Sample -> Specimen)", () => {
  test("a complete sample Specimen passes", () => {
    const outcome = miabisSampleValidator.validate(fullSample());
    assert.equal(outcome.isValid, true);
    assert.deepEqual(outcome.issues, []);
  });

  test("a wrong resourceType is an error", () => {
    const outcome = miabisSampleValidator.validate({ resourceType: "Patient", id: "x" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_WRONG_RESOURCE_TYPE"));
  });

  test("missing id and type are errors; missing date and temperature warn", () => {
    const outcome = miabisSampleValidator.validate({ resourceType: "Specimen" });
    assert.equal(outcome.isValid, false);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_ID_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_TYPE_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_COLLECTION_DATE_MISSING"));
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_STORAGE_TEMPERATURE_MISSING"));
  });

  test("storage temperature without text warns instead of reading the codes", () => {
    const outcome = miabisSampleValidator.validate({
      resourceType: "Specimen",
      id: "s-2",
      type: { coding: [{ system: "https://example.org/sample-types", code: "SER" }] },
      collection: { collectedDateTime: "2021-06-01" },
      extension: [
        {
          url: "https://example.org/fhir/StructureDefinition/storage-temperature",
          valueCodeableConcept: { coding: [{ code: "ULT" }] },
        },
      ],
    });
    assert.equal(outcome.isValid, true);
    assert.ok(outcome.issues.some((i) => i.code === "MIABIS_SAMPLE_STORAGE_TEMPERATURE_NOT_VERBATIM"));
  });
});

describe("miabis validators as pipeline profiles", () => {
  test("the aggregate exposes four distinctly named validators", () => {
    assert.equal(miabisValidators.length, 4);
    assert.deepEqual(
      miabisValidators.map((v) => v.name),
      [
        "miabis-biobank-2.0",
        "miabis-collection-2.0",
        "miabis-sample-donor-2.0",
        "miabis-sample-2.0",
      ],
    );
  });

  test("attribute tables document mapping limits including unmapped rows", () => {
    for (const table of [MIABIS_BIOBANK_TABLE, MIABIS_COLLECTION_TABLE, MIABIS_DONOR_TABLE, MIABIS_SAMPLE_TABLE]) {
      assert.ok(table.length > 0);
      assert.ok(table.some((row) => row.requirement === "unmapped"), "unmapped attributes are reported");
    }
    assert.ok(MIABIS_DONOR_TABLE.some((row) => row.miabisAttribute.startsWith("consent")));
  });

  test("a validator plugs into FhirValidator level 4 with its own name", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail(fullSample(), { profile: miabisSampleValidator });
    assert.equal(result.levels.find((l) => l.level === 4)?.status, "executed");
    assert.equal(result.levels.find((l) => l.level === 4)?.validator, "miabis-sample-2.0");
    assert.equal(result.isValid, true);
  });

  test("a profile failure surfaces MIABIS_* issues through level 4", () => {
    const validator = new FhirValidator();
    const result = validator.validateWithDetail({ resourceType: "Specimen" }, { profile: miabisSampleValidator });
    assert.equal(result.isValid, false);
    assert.ok(result.issues.some((i) => i.code === "MIABIS_SAMPLE_TYPE_MISSING"));
  });
});
