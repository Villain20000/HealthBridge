import { ValidationIssue } from "@healthbridge/shared-types";
import { FhirOperationOutcome } from "@healthbridge/fhir-r4";

export interface ProfileValidator {
  readonly name: string;
  validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[] };
}

export interface TerminologyProvider {
  readonly name: string;
  readonly licence: string;
  validateCode(params: { system?: string; code?: string; display?: string; path?: string }): {
    valid: boolean;
    issues: ValidationIssue[];
  };
}

export interface DetailedValidationOptions {
  profile?: ProfileValidator;
  terminology?: TerminologyProvider;
  /** All resources in the run/Bundle, used only for referential-integrity checks. */
  siblingResources?: Array<Record<string, unknown>>;
}

export interface DetailedValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  operationOutcome: FhirOperationOutcome;
  levels: Array<{
    level: 1 | 2 | 3 | 4 | 5 | 6;
    name: string;
    status: "executed" | "skipped";
    validator?: string;
    reason?: string;
  }>;
}

function referenceTargetsOf(resource: Record<string, unknown>): Array<{ path: string; target: string }> {
  const found: Array<{ path: string; target: string }> = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (path === "reference" || path.endsWith(".reference")) {
        found.push({ path, target: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}.${index}`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(resource, "");
  return found;
}

function collectCodings(
  resource: Record<string, unknown>,
): Array<{ system?: string; code?: string; display?: string; path?: string }> {
  const found: Array<{ system?: string; code?: string; display?: string; path?: string }> = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}.${index}`));
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.system === "string" || typeof record.code === "string") {
        found.push({
          system: typeof record.system === "string" ? record.system : undefined,
          code: typeof record.code === "string" ? record.code : undefined,
          display: typeof record.display === "string" ? record.display : undefined,
          path: path || undefined,
        });
      }
      for (const [key, entry] of Object.entries(record)) {
        visit(entry, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(resource, "");
  return found;
}

export function checkReferentialIntegrity(resources: Array<Record<string, unknown>>): ValidationIssue[] {
  const ids = new Set<string>();
  for (const resource of resources) {
    if (typeof resource?.resourceType === "string" && typeof resource?.id === "string") {
      ids.add(`${resource.resourceType}/${resource.id}`);
    }
  }
  const issues: ValidationIssue[] = [];
  resources.forEach((resource, index) => {
    for (const ref of referenceTargetsOf(resource)) {
      const target = ref.target.trim();
      if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
      const normalised = target.includes("/") ? target.split("?")[0] : null;
      if (normalised && !ids.has(normalised) && !ids.has(target.split("?")[0])) {
        issues.push({
          code: "UNRESOLVED_REFERENCE",
          severity: "warning",
          message: `Reference '${target}' does not resolve to any resource in this run`,
          path: ref.path || `output[${index}]`,
        });
      }
    }
  });
  return issues;
}

export class FhirValidator {
  public validate(resource: Record<string, unknown>): {
    isValid: boolean;
    issues: ValidationIssue[];
    operationOutcome: FhirOperationOutcome;
  } {
    const issues: ValidationIssue[] = [];

    if (!resource || typeof resource !== "object") {
      issues.push({
        code: "INVALID_RESOURCE",
        severity: "fatal",
        message: "Target resource must be a valid JSON object",
      });
      return this.formatResult(issues);
    }

    if (!resource.resourceType || typeof resource.resourceType !== "string") {
      issues.push({
        code: "MISSING_RESOURCE_TYPE",
        severity: "error",
        message: "FHIR resource missing required string property 'resourceType'",
        path: "resourceType",
      });
    }

    const type = resource.resourceType;
    if (type === "Patient") {
      if (resource.gender && !["male", "female", "other", "unknown"].includes(String(resource.gender))) {
        issues.push({
          code: "INVALID_GENDER_CODE",
          severity: "error",
          message: `Value '${resource.gender}' is not a valid FHIR administrative gender code`,
          path: "gender",
        });
      }
      if (resource.birthDate) {
        const isIsoDate = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(resource.birthDate));
        if (!isIsoDate) {
          issues.push({
            code: "INVALID_DATE_FORMAT",
            severity: "warning",
            message: `Birthdate '${resource.birthDate}' does not conform to YYYY-MM-DD`,
            path: "birthDate",
          });
        }
      }
    } else if (type === "Observation") {
      if (!resource.status) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          severity: "error",
          message: "Observation resource requires 'status'",
          path: "status",
        });
      }
      if (!resource.code) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          severity: "error",
          message: "Observation resource requires 'code'",
          path: "code",
        });
      }
    } else if (type === "Specimen") {
      if (
        resource.status &&
        !["available", "unavailable", "unsatisfactory", "entered-in-error"].includes(String(resource.status))
      ) {
        issues.push({
          code: "INVALID_STATUS_CODE",
          severity: "error",
          message: `Specimen status '${resource.status}' is invalid`,
          path: "status",
        });
      }
    }

    return this.formatResult(issues);
  }

  public validateWithDetail(
    resource: Record<string, unknown>,
    options: DetailedValidationOptions = {},
  ): DetailedValidationResult {
    const base = this.validate(resource);
    const issues = [...base.issues];
    const levels: DetailedValidationResult["levels"] = [
      { level: 3, name: "target-structural", status: "executed", validator: "fhir-r4-validator" },
    ];

    if (options.profile) {
      const outcome = options.profile.validate(resource);
      issues.push(...outcome.issues);
      levels.push({ level: 4, name: "profile", status: "executed", validator: options.profile.name });
    } else {
      levels.push({
        level: 4,
        name: "profile",
        status: "skipped",
        reason: "no profile validator configured (licence-aware external validator required)",
      });
    }

    if (options.terminology) {
      const codes = collectCodings(resource);
      for (const coding of codes) {
        const outcome = options.terminology.validateCode(coding);
        issues.push(...outcome.issues);
      }
      levels.push({ level: 5, name: "terminology", status: "executed", validator: options.terminology.name });
    } else {
      levels.push({
        level: 5,
        name: "terminology",
        status: "skipped",
        reason: "no terminology provider configured (licensed code systems are never bundled)",
      });
    }

    if (options.siblingResources) {
      issues.push(...checkReferentialIntegrity([resource, ...options.siblingResources]));
      levels.push({ level: 6, name: "referential-integrity", status: "executed", validator: "run-bundle" });
    } else {
      levels.push({
        level: 6,
        name: "referential-integrity",
        status: "skipped",
        reason: "no sibling resources supplied; lands with Bundle workflows",
      });
    }

    const isValid = !issues.some((i) => i.severity === "fatal" || i.severity === "error");
    const operationOutcome: FhirOperationOutcome = {
      resourceType: "OperationOutcome",
      issue: issues.map((i) => ({
        severity: i.severity,
        code: i.code.toLowerCase(),
        diagnostics: i.message,
        expression: i.path ? [i.path] : undefined,
      })),
    };
    return { isValid, issues, operationOutcome, levels };
  }

  private formatResult(issues: ValidationIssue[]) {
    const isValid = !issues.some((i) => i.severity === "fatal" || i.severity === "error");
    const operationOutcome: FhirOperationOutcome = {
      resourceType: "OperationOutcome",
      issue: issues.map((i) => ({
        severity: i.severity,
        code: i.code.toLowerCase(),
        diagnostics: i.message,
        expression: i.path ? [i.path] : undefined,
      })),
    };
    return { isValid, issues, operationOutcome };
  }
}

export * from "./local-terminology.js";
export * from "./miabis.js";
