import { ValidationIssue } from "@healthbridge/shared-types";

/**
 * Target-format builders.
 *
 * The mapping engine produces a target-shaped object; a builder is responsible
 * for turning that object into a *valid resource of the target standard*:
 * required elements, identifier hygiene, profile declaration, provenance, and
 * removal of empty artefacts left behind by optional rules.
 *
 * Builders never invent clinical meaning. When a required element is missing
 * they either use the standard's explicit "unknown" value (and report it) or
 * reject the record.
 */

export interface BuildMappingInfo {
  id: string;
  version: string;
  targetFormat: string;
  targetResourceType?: string;
  targetProfile?: string;
}

export interface BuildInput {
  data: Record<string, unknown>;
  mapping: BuildMappingInfo;
  envelopeId: string;
  adapterId: string;
  adapterVersion: string;
  importedAt: string;
  sensitivity: "public" | "internal" | "sensitive";
}

export interface BuildResult {
  resource: Record<string, unknown>;
  resourceType: string;
  issues: ValidationIssue[];
  /** True when a required element is missing and the record must not be exported. */
  rejected: boolean;
}

export interface TargetBuilder {
  id: string;
  targetFormat: string;
  /** `undefined` means "handles any resource type" (generic fallback). */
  supports(resourceType: string | undefined): boolean;
  build(input: BuildInput): BuildResult;
}

export const PROVENANCE_EXTENSION_URL = "https://healthbridge.dev/fhir/StructureDefinition/source-provenance";

const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/** Recursively drop undefined, null, empty strings, arrays and objects. */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(child);
      if (pruned !== undefined) out[key] = pruned;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

export function normaliseFhirId(raw: unknown): { id?: string; issue?: ValidationIssue } {
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  const value = String(raw).trim();
  if (FHIR_ID_PATTERN.test(value)) return { id: value };

  const cleaned = value.replace(/[^A-Za-z0-9\-.]/g, "-").slice(0, 64);
  return {
    id: cleaned,
    issue: {
      code: "ID_NORMALISED",
      severity: "warning",
      message: `Identifier '${value}' is not a valid FHIR id and was normalised to '${cleaned}'`,
      path: "id",
      advice: "Map a stable identifier column, or use an identifier instead of id.",
    },
  };
}

function provenanceExtension(input: BuildInput): Record<string, unknown> {
  return {
    url: PROVENANCE_EXTENSION_URL,
    extension: [
      { url: "envelopeId", valueString: input.envelopeId },
      { url: "adapterId", valueString: input.adapterId },
      { url: "adapterVersion", valueString: input.adapterVersion },
      { url: "importedAt", valueDateTime: input.importedAt },
      { url: "mappingId", valueString: input.mapping.id },
      { url: "mappingVersion", valueString: input.mapping.version },
      { url: "sensitivity", valueCode: input.sensitivity },
    ],
  };
}

interface FinaliseOptions {
  resourceType: string;
  issues: ValidationIssue[];
  rejected?: boolean;
}

function finalise(input: BuildInput, options: FinaliseOptions): BuildResult {
  const { resourceType, issues } = options;
  const source = { ...input.data, resourceType };

  const pruned = (pruneEmpty(source) ?? {}) as Record<string, unknown>;
  pruned.resourceType = resourceType;

  const { id, issue } = normaliseFhirId(pruned.id);
  if (id !== undefined) pruned.id = id;
  else delete pruned.id;
  if (issue) issues.push(issue);

  if (input.mapping.targetProfile) {
    const meta = (pruned.meta as Record<string, unknown> | undefined) ?? {};
    const existing = Array.isArray(meta.profile) ? (meta.profile as string[]) : [];
    if (!existing.includes(input.mapping.targetProfile)) {
      meta.profile = [...existing, input.mapping.targetProfile];
    }
    pruned.meta = meta;
  }

  const extensions = Array.isArray(pruned.extension) ? (pruned.extension as unknown[]) : [];
  pruned.extension = [...extensions, provenanceExtension(input)];

  return {
    resource: pruned,
    resourceType,
    issues,
    rejected: options.rejected ?? issues.some((i) => i.severity === "fatal" || i.severity === "error"),
  };
}

function requiredElement(
  data: Record<string, unknown>,
  path: string,
  resourceType: string,
  issues: ValidationIssue[],
): boolean {
  const segments = path.split(".");
  let current: unknown = data;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[segment];
  }
  const present = current !== undefined && current !== null && current !== "";
  if (!present) {
    issues.push({
      code: "MISSING_REQUIRED_ELEMENT",
      severity: "error",
      message: `${resourceType}.${path} is required by the FHIR R4 specification`,
      path,
      advice: "Add a mapping rule for this element (or a defaultValue).",
    });
  }
  return present;
}

/** Values allowed by FHIR R4 `Observation.status` / `DiagnosticReport.status`. */
const UNKNOWN_STATUS = "unknown";

class FhirObservationBuilder implements TargetBuilder {
  public id = "fhir-r4-observation";
  public targetFormat = "fhir-r4";

  public supports(resourceType: string | undefined): boolean {
    return resourceType === "Observation";
  }

  public build(input: BuildInput): BuildResult {
    const issues: ValidationIssue[] = [];
    const data = { ...input.data };

    if (data.status === undefined || data.status === "") {
      data.status = UNKNOWN_STATUS;
      issues.push({
        code: "STATUS_DEFAULTED",
        severity: "warning",
        message: `Observation.status was not mapped; wrote '${UNKNOWN_STATUS}' because FHIR requires a status`,
        path: "status",
        advice: "Map an explicit status (final, preliminary, corrected, …) to preserve clinical meaning.",
      });
    }

    requiredElement(data, "code", "Observation", issues);

    const quantity = data.valueQuantity as Record<string, unknown> | undefined;
    if (quantity && typeof quantity === "object") {
      const numeric = quantity.value;
      if (typeof numeric === "string") {
        const parsed = Number(numeric.replace(",", "."));
        if (Number.isFinite(parsed)) quantity.value = parsed;
        else
          issues.push({
            code: "INVALID_QUANTITY_VALUE",
            severity: "error",
            message: `valueQuantity.value '${numeric}' is not numeric`,
            path: "valueQuantity.value",
          });
      }
    }

    return finalise({ ...input, data }, { resourceType: "Observation", issues });
  }
}

class FhirPatientBuilder implements TargetBuilder {
  public id = "fhir-r4-patient";
  public targetFormat = "fhir-r4";

  public supports(resourceType: string | undefined): boolean {
    return resourceType === "Patient";
  }

  public build(input: BuildInput): BuildResult {
    const issues: ValidationIssue[] = [];
    const data = { ...input.data };

    const hasIdentifier = Array.isArray(data.identifier) && data.identifier.length > 0;
    const hasName = Array.isArray(data.name) && data.name.length > 0;
    if (!hasIdentifier && !hasName && data.id === undefined) {
      issues.push({
        code: "PATIENT_WITHOUT_IDENTIFIER",
        severity: "warning",
        message: "Patient has no id, identifier or name; it cannot be linked to a real subject",
        advice: "Map a stable local identifier, e.g. patient_id → identifier.0.value.",
      });
    }

    return finalise({ ...input, data }, { resourceType: "Patient", issues });
  }
}

class FhirSpecimenBuilder implements TargetBuilder {
  public id = "fhir-r4-specimen";
  public targetFormat = "fhir-r4";

  public supports(resourceType: string | undefined): boolean {
    return resourceType === "Specimen";
  }

  public build(input: BuildInput): BuildResult {
    const issues: ValidationIssue[] = [];
    return finalise({ ...input, data: { ...input.data } }, { resourceType: "Specimen", issues });
  }
}

class FhirDiagnosticReportBuilder implements TargetBuilder {
  public id = "fhir-r4-diagnostic-report";
  public targetFormat = "fhir-r4";

  public supports(resourceType: string | undefined): boolean {
    return resourceType === "DiagnosticReport";
  }

  public build(input: BuildInput): BuildResult {
    const issues: ValidationIssue[] = [];
    const data = { ...input.data };

    if (data.status === undefined || data.status === "") {
      data.status = UNKNOWN_STATUS;
      issues.push({
        code: "STATUS_DEFAULTED",
        severity: "warning",
        message: `DiagnosticReport.status was not mapped; wrote '${UNKNOWN_STATUS}' because FHIR requires a status`,
        path: "status",
      });
    }

    requiredElement(data, "code", "DiagnosticReport", issues);

    return finalise({ ...input, data }, { resourceType: "DiagnosticReport", issues });
  }
}

class GenericFhirBuilder implements TargetBuilder {
  public id = "fhir-r4-generic";
  public targetFormat = "fhir-r4";

  public supports(): boolean {
    return true;
  }

  public build(input: BuildInput): BuildResult {
    const issues: ValidationIssue[] = [];
    const resourceType =
      typeof input.data.resourceType === "string" && input.data.resourceType !== ""
        ? input.data.resourceType
        : input.mapping.targetResourceType;

    if (!resourceType) {
      issues.push({
        code: "MISSING_RESOURCE_TYPE",
        severity: "error",
        message: "Cannot build a FHIR resource without resourceType",
        path: "resourceType",
        advice: "Set mapping.targetResourceType or map a constant resourceType.",
      });
      return { resource: {}, resourceType: "Unknown", issues, rejected: true };
    }

    if (!input.data.resourceType) {
      issues.push({
        code: "RESOURCE_TYPE_INJECTED",
        severity: "information",
        message: `resourceType '${resourceType}' was taken from the mapping target and injected into the resource`,
        path: "resourceType",
        advice: "Mapping exports are cleaner when resourceType is produced explicitly.",
      });
    }

    return finalise(input, { resourceType, issues });
  }
}

export class TargetBuilderRegistry {
  private readonly builders: TargetBuilder[] = [];
  private readonly generic = new GenericFhirBuilder();

  constructor(builders: TargetBuilder[] = createDefaultBuilders()) {
    this.builders.push(...builders);
  }

  public register(builder: TargetBuilder): void {
    this.builders.push(builder);
  }

  public list(): Array<{ id: string; targetFormat: string }> {
    return this.builders.map((b) => ({ id: b.id, targetFormat: b.targetFormat }));
  }

  /**
   * Resolve the builder for a mapping. Returns `undefined` when the target
   * format has no builder, so callers can report that honestly instead of
   * pretending the output is a valid resource.
   */
  public resolve(mapping: BuildMappingInfo): TargetBuilder | undefined {
    const resourceType = mapping.targetResourceType;
    const match = this.builders.find(
      (builder) => builder.targetFormat === mapping.targetFormat && builder.supports(resourceType),
    );
    if (match) return match;
    if (mapping.targetFormat === "fhir-r4") return this.generic;
    return undefined;
  }

  public build(input: BuildInput): BuildResult | undefined {
    const builder = this.resolve(input.mapping);
    if (!builder) return undefined;
    return builder.build(input);
  }
}

export function createDefaultBuilders(): TargetBuilder[] {
  return [
    new FhirPatientBuilder(),
    new FhirObservationBuilder(),
    new FhirSpecimenBuilder(),
    new FhirDiagnosticReportBuilder(),
  ];
}

export const defaultTargetBuilderRegistry = new TargetBuilderRegistry();
