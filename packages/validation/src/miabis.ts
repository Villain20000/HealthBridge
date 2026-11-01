/**
 * HealthBridge OS — MIABIS Core 2.0 profile validators.
 *
 * Structural, mapping-limited {@link ProfileValidator} implementations over the
 * FHIR R4 resources the pipeline already produces:
 *
 * - Biobank     -> Organization (contact, alias, juristic person as text/extensions)
 * - Collection  -> Organization (partOf) | ResearchStudy (attributes carried verbatim)
 * - SampleDonor -> Patient (birthDate/sex carried structurally only)
 * - Sample      -> Specimen (type, collection date, storage temperature as text)
 *
 * Explicit limits (see also PLAN.md section 19 / ROADMAP Phase G):
 * - Mapping-limited, not a MIABIS certification or completeness claim. Each
 *   validator checks that the mapped attributes the pipeline produced are
 *   present and structurally sound, nothing more.
 * - No biobank operational claims are checked (opening hours, SOPs, networks,
 *   throughput): anything operational is out of scope and ignored.
 * - No consent semantics: consent is never read, inferred, or validated here.
 * - Values are NEVER invented: missing or unmapped attributes are reported as
 *   `MIABIS_*` issues, never defaulted, and issue messages never echo source
 *   values (no PHI in diagnostics).
 *
 * Every issue message carries the validator's MIABIS attribute table plus the
 * limits above, so a bare issue list still states the mapping contract.
 */

import type { ValidationIssue } from "@healthbridge/shared-types";
import type { ProfileValidator } from "./index.js";

/* -------------------------------------------------------------------------- */
/* Attribute-table model                                                      */
/* -------------------------------------------------------------------------- */

/** One row of a validator's MIABIS attribute table (also used for docs). */
export interface MiabisAttributeMapping {
  /** MIABIS Core 2.0 component, e.g. `"Biobank"`. */
  readonly miabisComponent: string;
  /** MIABIS attribute name, e.g. `"juristicPerson"`. */
  readonly miabisAttribute: string;
  /** FHIR R4 target path in this profile, or `"(none)"` when unmapped. */
  readonly fhirTarget: string;
  /** `required` fails validation when missing; `optional` warns; `unmapped` documents a mapping limit. */
  readonly requirement: "required" | "optional" | "unmapped";
  /** Mapping limit for this row, e.g. `"text only; no legal-entity claim"`. */
  readonly note: string;
}

const MIABIS_LIMITS =
  "Limits: attributes are carried verbatim and never interpreted; " +
  "missing or unmapped attributes are reported, never defaulted; " +
  "no biobank operational claims; no consent semantics.";

function compactTable(table: readonly MiabisAttributeMapping[]): string {
  const component = table[0]?.miabisComponent ?? "MIABIS";
  const rows = table.map(
    (row) => `${row.miabisAttribute}→${row.fhirTarget} [${row.requirement}${row.note ? `; ${row.note}` : ""}]`,
  );
  return `MIABIS Core 2.0 ${component} attribute table (structural, verbatim-only): ${rows.join(" | ")}. ${MIABIS_LIMITS}`;
}

function withTable(table: readonly MiabisAttributeMapping[], message: string): string {
  return `${message} ${compactTable(table)}`;
}

function hint(target: string): string {
  return `Populate ${target} from the source biobank record; the validator never defaults it.`;
}

/* -------------------------------------------------------------------------- */
/* Structural helpers (presence only — never interpretation)                  */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/** `id` or a non-empty `identifier` array — identity, never invented. */
function hasIdentity(resource: Record<string, unknown>): boolean {
  return nonEmptyString(resource.id) || nonEmptyArray(resource.identifier);
}

interface FhirExtension {
  readonly url?: unknown;
  readonly valueString?: unknown;
  readonly valueMarkdown?: unknown;
  readonly valueUrl?: unknown;
  readonly valueCodeableConcept?: unknown;
}

function extensionsOf(resource: Record<string, unknown>): FhirExtension[] {
  if (!nonEmptyArray(resource.extension)) return [];
  return resource.extension.filter(isRecord) as FhirExtension[];
}

function hasTextExtension(resource: Record<string, unknown>): boolean {
  return extensionsOf(resource).some((ext) => nonEmptyString(ext.valueString) || nonEmptyString(ext.valueMarkdown));
}

function hasUrlExtension(resource: Record<string, unknown>): boolean {
  return extensionsOf(resource).some((ext) => nonEmptyString(ext.valueUrl));
}

function storageTemperatureText(resource: Record<string, unknown>): string | undefined {
  for (const ext of extensionsOf(resource)) {
    if (isRecord(ext.valueCodeableConcept)) {
      const text = ext.valueCodeableConcept.text;
      if (nonEmptyString(text)) return text;
      return "";
    }
  }
  return undefined;
}

function resultFor(issues: ValidationIssue[]): { isValid: boolean; issues: ValidationIssue[] } {
  return { isValid: !issues.some((i) => i.severity === "fatal" || i.severity === "error"), issues };
}

function wrongType(
  table: readonly MiabisAttributeMapping[],
  code: string,
  expected: string,
  resource: Record<string, unknown>,
): ValidationIssue {
  return {
    code,
    severity: "error",
    message: withTable(
      table,
      `Expected resourceType '${expected}' for this MIABIS component but found '${String(resource.resourceType)}'.`,
    ),
    path: "resourceType",
    advice: `Map this record to '${expected}' or run the matching MIABIS validator; the validator never retypes a resource.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Biobank -> Organization                                                    */
/* -------------------------------------------------------------------------- */

/** MIABIS Core 2.0 Biobank attribute table (mapping-limited, verbatim-only). */
export const MIABIS_BIOBANK_TABLE: readonly MiabisAttributeMapping[] = [
  {
    miabisComponent: "Biobank",
    miabisAttribute: "ID",
    fhirTarget: "Organization.id | identifier",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "name",
    fhirTarget: "Organization.name",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "acronym",
    fhirTarget: "Organization.alias",
    requirement: "optional",
    note: "verbatim",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "contactInformation",
    fhirTarget: "Organization.contact",
    requirement: "optional",
    note: "verbatim; never interpreted",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "juristicPerson",
    fhirTarget: "Organization.extension (valueString)",
    requirement: "optional",
    note: "text only; no legal-entity claim",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "URL",
    fhirTarget: "Organization.extension (valueUrl)",
    requirement: "optional",
    note: "verbatim; never dereferenced",
  },
  {
    miabisComponent: "Biobank",
    miabisAttribute: "country / network / type",
    fhirTarget: "(none)",
    requirement: "unmapped",
    note: "no FHIR R4 Organization target in this profile; reported, never defaulted",
  },
];

/** MIABIS Core 2.0 Biobank as a profile over FHIR R4 Organization. */
export const miabisBiobankValidator: ProfileValidator = {
  name: "miabis-biobank-2.0",
  validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    if (resource.resourceType !== "Organization") {
      return resultFor([
        wrongType(MIABIS_BIOBANK_TABLE, "MIABIS_BIOBANK_WRONG_RESOURCE_TYPE", "Organization", resource),
      ]);
    }
    if (!hasIdentity(resource)) {
      issues.push({
        code: "MIABIS_BIOBANK_ID_MISSING",
        severity: "error",
        message: withTable(
          MIABIS_BIOBANK_TABLE,
          "MIABIS Biobank.ID is missing (Organization.id or Organization.identifier).",
        ),
        path: "identifier",
        advice: hint("Organization.id or Organization.identifier"),
      });
    }
    if (!nonEmptyString(resource.name)) {
      issues.push({
        code: "MIABIS_BIOBANK_NAME_MISSING",
        severity: "error",
        message: withTable(MIABIS_BIOBANK_TABLE, "MIABIS Biobank.name is missing (Organization.name)."),
        path: "name",
        advice: hint("Organization.name"),
      });
    }
    if (!nonEmptyArray(resource.alias) || !resource.alias.some(nonEmptyString)) {
      issues.push({
        code: "MIABIS_BIOBANK_ACRONYM_MISSING",
        severity: "warning",
        message: withTable(MIABIS_BIOBANK_TABLE, "MIABIS Biobank.acronym is missing (Organization.alias, verbatim)."),
        path: "alias",
        advice: hint("Organization.alias"),
      });
    }
    if (!nonEmptyArray(resource.contact)) {
      issues.push({
        code: "MIABIS_BIOBANK_CONTACT_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_BIOBANK_TABLE,
          "MIABIS Biobank.contactInformation is missing (Organization.contact, verbatim, never interpreted).",
        ),
        path: "contact",
        advice: hint("Organization.contact"),
      });
    }
    if (!hasTextExtension(resource)) {
      issues.push({
        code: "MIABIS_BIOBANK_JURISTIC_PERSON_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_BIOBANK_TABLE,
          "MIABIS Biobank.juristicPerson is missing (Organization.extension valueString, text only; no legal-entity claim).",
        ),
        path: "extension",
        advice: hint("an Organization.extension carrying the juristic person as text"),
      });
    }
    if (!hasUrlExtension(resource)) {
      issues.push({
        code: "MIABIS_BIOBANK_URL_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_BIOBANK_TABLE,
          "MIABIS Biobank.URL is missing (Organization.extension valueUrl, verbatim, never dereferenced).",
        ),
        path: "extension",
        advice: hint("an Organization.extension carrying the biobank URL"),
      });
    }
    return resultFor(issues);
  },
};

/* -------------------------------------------------------------------------- */
/* Collection -> Organization (partOf) | ResearchStudy                        */
/* -------------------------------------------------------------------------- */

/** MIABIS Core 2.0 Sample Collection attribute table (verbatim-only). */
export const MIABIS_COLLECTION_TABLE: readonly MiabisAttributeMapping[] = [
  {
    miabisComponent: "Collection",
    miabisAttribute: "ID",
    fhirTarget: "Organization.id | identifier / ResearchStudy.id | identifier",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "Collection",
    miabisAttribute: "name",
    fhirTarget: "Organization.name / ResearchStudy.title",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "Collection",
    miabisAttribute: "acronym",
    fhirTarget: "Organization.alias / ResearchStudy.label.text | name",
    requirement: "optional",
    note: "verbatim",
  },
  {
    miabisComponent: "Collection",
    miabisAttribute: "description",
    fhirTarget: "ResearchStudy.description / Organization.extension (text)",
    requirement: "optional",
    note: "verbatim; never summarised",
  },
  {
    miabisComponent: "Collection",
    miabisAttribute: "parentBiobank",
    fhirTarget: "Organization.partOf / ResearchStudy.partOf",
    requirement: "optional",
    note: "reference only; target is never created or guessed",
  },
  {
    miabisComponent: "Collection",
    miabisAttribute: "orderOfMagnitude / dataCategories / collectionType",
    fhirTarget: "(none)",
    requirement: "unmapped",
    note: "no FHIR R4 target in this profile; reported, never defaulted",
  },
];

function collectionName(resource: Record<string, unknown>): boolean {
  if (resource.resourceType === "Organization") return nonEmptyString(resource.name);
  return nonEmptyString(resource.title);
}

function collectionAcronym(resource: Record<string, unknown>): boolean {
  if (resource.resourceType === "Organization") {
    return nonEmptyArray(resource.alias) && resource.alias.some(nonEmptyString);
  }
  if (nonEmptyString(resource.name)) return true;
  if (!nonEmptyArray(resource.label)) return false;
  return resource.label.some((entry) => isRecord(entry) && (nonEmptyString(entry.text) || nonEmptyArray(entry.coding)));
}

function collectionDescription(resource: Record<string, unknown>): boolean {
  if (resource.resourceType === "ResearchStudy") return nonEmptyString(resource.description);
  return hasTextExtension(resource);
}

function collectionParentLink(resource: Record<string, unknown>): boolean {
  // Organization.partOf is 0..1 (single Reference); ResearchStudy.partOf is
  // 0..* (list of References). Both shapes are accepted; the target is only
  // ever referenced, never created or guessed.
  if (isRecord(resource.partOf)) return true;
  return nonEmptyArray(resource.partOf) && resource.partOf.some(isRecord);
}

/** MIABIS Core 2.0 Sample Collection as a profile over Organization | ResearchStudy. */
export const miabisCollectionValidator: ProfileValidator = {
  name: "miabis-collection-2.0",
  validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    if (resource.resourceType !== "Organization" && resource.resourceType !== "ResearchStudy") {
      return resultFor([
        {
          code: "MIABIS_COLLECTION_WRONG_RESOURCE_TYPE",
          severity: "error",
          message: withTable(
            MIABIS_COLLECTION_TABLE,
            `Expected resourceType 'Organization' or 'ResearchStudy' for a MIABIS collection but found '${String(resource.resourceType)}'.`,
          ),
          path: "resourceType",
          advice:
            "Map this record to Organization (with partOf) or ResearchStudy; the validator never retypes a resource.",
        },
      ]);
    }
    if (!hasIdentity(resource)) {
      issues.push({
        code: "MIABIS_COLLECTION_ID_MISSING",
        severity: "error",
        message: withTable(MIABIS_COLLECTION_TABLE, "MIABIS Collection.ID is missing (id or identifier)."),
        path: "identifier",
        advice: hint("id or identifier"),
      });
    }
    if (!collectionName(resource)) {
      issues.push({
        code: "MIABIS_COLLECTION_NAME_MISSING",
        severity: "error",
        message: withTable(
          MIABIS_COLLECTION_TABLE,
          "MIABIS Collection.name is missing (Organization.name or ResearchStudy.title).",
        ),
        path: resource.resourceType === "Organization" ? "name" : "title",
        advice: hint("Organization.name or ResearchStudy.title"),
      });
    }
    if (!collectionAcronym(resource)) {
      issues.push({
        code: "MIABIS_COLLECTION_ACRONYM_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_COLLECTION_TABLE,
          "MIABIS Collection.acronym is missing (Organization.alias or ResearchStudy.label/name, verbatim).",
        ),
        path: resource.resourceType === "Organization" ? "alias" : "label",
        advice: hint("Organization.alias or ResearchStudy.label"),
      });
    }
    if (!collectionDescription(resource)) {
      issues.push({
        code: "MIABIS_COLLECTION_DESCRIPTION_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_COLLECTION_TABLE,
          "MIABIS Collection.description is missing (ResearchStudy.description or Organization.extension text, verbatim, never summarised).",
        ),
        path: resource.resourceType === "Organization" ? "extension" : "description",
        advice: hint("ResearchStudy.description or an Organization text extension"),
      });
    }
    if (!collectionParentLink(resource)) {
      issues.push({
        code: "MIABIS_COLLECTION_PARENT_LINK_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_COLLECTION_TABLE,
          "MIABIS Collection is not linked to a parent biobank (partOf reference, reference only; the link target is never created or guessed).",
        ),
        path: "partOf",
        advice: hint("partOf pointing at the parent biobank Organization"),
      });
    }
    return resultFor(issues);
  },
};

/* -------------------------------------------------------------------------- */
/* SampleDonor -> Patient                                                     */
/* -------------------------------------------------------------------------- */

/** MIABIS Core 2.0 Sample Donor attribute table (structural carry only). */
export const MIABIS_DONOR_TABLE: readonly MiabisAttributeMapping[] = [
  {
    miabisComponent: "SampleDonor",
    miabisAttribute: "ID",
    fhirTarget: "Patient.id | identifier",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "SampleDonor",
    miabisAttribute: "birthDate",
    fhirTarget: "Patient.birthDate",
    requirement: "optional",
    note: "ISO format checked structurally; never coerced or imputed",
  },
  {
    miabisComponent: "SampleDonor",
    miabisAttribute: "sex",
    fhirTarget: "Patient.gender",
    requirement: "optional",
    note: "structural carry only; no semantic equation beyond the code list",
  },
  {
    miabisComponent: "SampleDonor",
    miabisAttribute: "consent.*",
    fhirTarget: "(none)",
    requirement: "unmapped",
    note: "no consent semantics anywhere in this profile; reported, never defaulted",
  },
];

const ISO_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const FHIR_GENDERS = new Set(["male", "female", "other", "unknown"]);

/** MIABIS Core 2.0 Sample Donor as a profile over FHIR R4 Patient. */
export const miabisSampleDonorValidator: ProfileValidator = {
  name: "miabis-sample-donor-2.0",
  validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    if (resource.resourceType !== "Patient") {
      return resultFor([wrongType(MIABIS_DONOR_TABLE, "MIABIS_DONOR_WRONG_RESOURCE_TYPE", "Patient", resource)]);
    }
    if (!hasIdentity(resource)) {
      issues.push({
        code: "MIABIS_DONOR_ID_MISSING",
        severity: "error",
        message: withTable(MIABIS_DONOR_TABLE, "MIABIS SampleDonor.ID is missing (Patient.id or Patient.identifier)."),
        path: "identifier",
        advice: hint("Patient.id or Patient.identifier"),
      });
    }
    if (resource.birthDate === undefined) {
      issues.push({
        code: "MIABIS_DONOR_BIRTHDATE_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_DONOR_TABLE,
          "MIABIS SampleDonor.birthDate is missing (Patient.birthDate); the value is never imputed.",
        ),
        path: "birthDate",
        advice: hint("Patient.birthDate"),
      });
    } else if (!nonEmptyString(resource.birthDate) || !ISO_DATE.test(resource.birthDate)) {
      issues.push({
        code: "MIABIS_DONOR_BIRTHDATE_MALFORMED",
        severity: "warning",
        message: withTable(
          MIABIS_DONOR_TABLE,
          "MIABIS SampleDonor.birthDate is not a structural ISO date (Patient.birthDate); the value is kept as-is and never coerced.",
        ),
        path: "birthDate",
        advice: "Fix Patient.birthDate to YYYY, YYYY-MM, or YYYY-MM-DD at the source; the validator never rewrites it.",
      });
    }
    if (resource.gender === undefined) {
      issues.push({
        code: "MIABIS_DONOR_SEX_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_DONOR_TABLE,
          "MIABIS SampleDonor.sex is missing (Patient.gender, structural carry only); the value is never imputed.",
        ),
        path: "gender",
        advice: hint("Patient.gender"),
      });
    } else if (!FHIR_GENDERS.has(String(resource.gender))) {
      issues.push({
        code: "MIABIS_DONOR_SEX_UNRECOGNISED",
        severity: "warning",
        message: withTable(
          MIABIS_DONOR_TABLE,
          "MIABIS SampleDonor.sex uses a code outside the FHIR administrative list (Patient.gender); carried structurally, never reinterpreted.",
        ),
        path: "gender",
        advice: "Use male | female | other | unknown at the source, or leave it absent; the validator never maps it.",
      });
    }
    return resultFor(issues);
  },
};

/* -------------------------------------------------------------------------- */
/* Sample -> Specimen                                                         */
/* -------------------------------------------------------------------------- */

/** MIABIS Core 2.0 Sample attribute table (text carried, never interpreted). */
export const MIABIS_SAMPLE_TABLE: readonly MiabisAttributeMapping[] = [
  {
    miabisComponent: "Sample",
    miabisAttribute: "ID",
    fhirTarget: "Specimen.id | identifier",
    requirement: "required",
    note: "verbatim",
  },
  {
    miabisComponent: "Sample",
    miabisAttribute: "sampleType",
    fhirTarget: "Specimen.type",
    requirement: "required",
    note: "CodeableConcept carried as-is; codes never inferred",
  },
  {
    miabisComponent: "Sample",
    miabisAttribute: "collectionDate",
    fhirTarget: "Specimen.collection.collected[x]",
    requirement: "optional",
    note: "verbatim; never reinterpreted",
  },
  {
    miabisComponent: "Sample",
    miabisAttribute: "storageTemperature",
    fhirTarget: "Specimen.extension (valueCodeableConcept.text)",
    requirement: "optional",
    note: "text required verbatim; codes never interpreted or inferred",
  },
  {
    miabisComponent: "Sample",
    miabisAttribute: "parentCollection / anatomicalSite",
    fhirTarget: "(none)",
    requirement: "unmapped",
    note: "no FHIR R4 Specimen target in this profile; reported, never defaulted",
  },
];

function hasSampleType(resource: Record<string, unknown>): boolean {
  if (!isRecord(resource.type)) return false;
  return nonEmptyString(resource.type.text) || nonEmptyArray(resource.type.coding);
}

function hasCollectionDate(resource: Record<string, unknown>): boolean {
  if (!isRecord(resource.collection)) return false;
  const collected = resource.collection;
  return nonEmptyString(collected.collectedDateTime) || isRecord(collected.collectedPeriod);
}

/** MIABIS Core 2.0 Sample as a profile over FHIR R4 Specimen. */
export const miabisSampleValidator: ProfileValidator = {
  name: "miabis-sample-2.0",
  validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    if (resource.resourceType !== "Specimen") {
      return resultFor([wrongType(MIABIS_SAMPLE_TABLE, "MIABIS_SAMPLE_WRONG_RESOURCE_TYPE", "Specimen", resource)]);
    }
    if (!hasIdentity(resource)) {
      issues.push({
        code: "MIABIS_SAMPLE_ID_MISSING",
        severity: "error",
        message: withTable(MIABIS_SAMPLE_TABLE, "MIABIS Sample.ID is missing (Specimen.id or Specimen.identifier)."),
        path: "identifier",
        advice: hint("Specimen.id or Specimen.identifier"),
      });
    }
    if (!hasSampleType(resource)) {
      issues.push({
        code: "MIABIS_SAMPLE_TYPE_MISSING",
        severity: "error",
        message: withTable(
          MIABIS_SAMPLE_TABLE,
          "MIABIS Sample.sampleType is missing (Specimen.type CodeableConcept); codes are never inferred.",
        ),
        path: "type",
        advice: hint("Specimen.type (text and/or coding, carried as-is)"),
      });
    }
    if (!hasCollectionDate(resource)) {
      issues.push({
        code: "MIABIS_SAMPLE_COLLECTION_DATE_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_SAMPLE_TABLE,
          "MIABIS Sample.collectionDate is missing (Specimen.collection.collected[x], verbatim, never reinterpreted).",
        ),
        path: "collection",
        advice: hint("Specimen.collection.collectedDateTime"),
      });
    }
    const storageText = storageTemperatureText(resource);
    if (storageText === undefined) {
      issues.push({
        code: "MIABIS_SAMPLE_STORAGE_TEMPERATURE_MISSING",
        severity: "warning",
        message: withTable(
          MIABIS_SAMPLE_TABLE,
          "MIABIS Sample.storageTemperature is missing (Specimen.extension valueCodeableConcept with text, verbatim); the value is never defaulted.",
        ),
        path: "extension",
        advice: hint("a Specimen.extension carrying storage temperature as CodeableConcept text"),
      });
    } else if (storageText === "") {
      issues.push({
        code: "MIABIS_SAMPLE_STORAGE_TEMPERATURE_NOT_VERBATIM",
        severity: "warning",
        message: withTable(
          MIABIS_SAMPLE_TABLE,
          "MIABIS Sample.storageTemperature has a CodeableConcept without text (Specimen.extension); temperature text is required verbatim and codes are never interpreted or inferred.",
        ),
        path: "extension",
        advice:
          "Add the storage temperature as CodeableConcept.text at the source; the validator never reads meaning into codes.",
      });
    }
    return resultFor(issues);
  },
};

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                  */
/* -------------------------------------------------------------------------- */

/** All MIABIS Core 2.0 profile validators in component order. */
export const miabisValidators: ProfileValidator[] = [
  miabisBiobankValidator,
  miabisCollectionValidator,
  miabisSampleDonorValidator,
  miabisSampleValidator,
];
