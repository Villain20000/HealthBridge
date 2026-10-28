import { ValidationIssue } from "@healthbridge/shared-types";
import { FhirOperationOutcome } from "@healthbridge/fhir-r4";

export class FhirValidator {
  public validate(resource: Record<string, unknown>): { isValid: boolean; issues: ValidationIssue[]; operationOutcome: FhirOperationOutcome } {
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
      if (resource.status && !["available", "unavailable", "unsatisfactory", "entered-in-error"].includes(String(resource.status))) {
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
