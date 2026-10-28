import { CoverageReport, ValidationIssue } from "@healthbridge/shared-types";

export type TransformFunctionKind =
  | "identity"
  | "uppercase"
  | "lowercase"
  | "trim"
  | "parse_date_iso"
  | "format_gender_fhir"
  | "concat"
  | "split"
  | "number_to_string"
  | "string_to_number"
  | "default_value";

export interface MappingRule {
  id: string;
  sourcePath: string;
  targetPath: string;
  transform: TransformFunctionKind;
  defaultValue?: unknown;
  params?: Record<string, unknown>;
  required?: boolean;
}

export interface MappingDefinition {
  id: string;
  name: string;
  version: string;
  sourceFormat: string;
  targetFormat: string;
  targetResourceType?: string;
  rules: MappingRule[];
}

export class MappingEngine {
  public execute(
    sourceData: Record<string, unknown>,
    mapping: MappingDefinition
  ): { targetData: Record<string, unknown>; coverage: CoverageReport; issues: ValidationIssue[] } {
    const targetData: Record<string, unknown> = {};
    const issues: ValidationIssue[] = [];
    const sourceKeys = Object.keys(sourceData);
    const mappedSourceKeys = new Set<string>();
    let targetFieldsPopulated = 0;
    let rejectedValuesCount = 0;

    for (const rule of mapping.rules) {
      const rawVal = this.getNestedValue(sourceData, rule.sourcePath);
      if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
        mappedSourceKeys.add(rule.sourcePath.split(".")[0]);
      }

      let valToTransform = rawVal ?? rule.defaultValue;
      if ((valToTransform === undefined || valToTransform === null || valToTransform === "") && rule.required) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          severity: "error",
          message: `Required field '${rule.sourcePath}' is missing or empty`,
          path: rule.sourcePath,
          ruleId: rule.id,
        });
        rejectedValuesCount++;
        continue;
      }

      if (valToTransform !== undefined && valToTransform !== null) {
        const transformedVal = this.applyTransform(valToTransform, rule, issues);
        if (transformedVal !== undefined && transformedVal !== null) {
          this.setNestedValue(targetData, rule.targetPath, transformedVal);
          targetFieldsPopulated++;
        }
      }
    }

    const unmappedSourceFields = sourceKeys.filter((k) => !mappedSourceKeys.has(k));
    const coveragePercentage = sourceKeys.length > 0
      ? Math.round((mappedSourceKeys.size / sourceKeys.length) * 100)
      : 100;

    const coverage: CoverageReport = {
      totalSourceFields: sourceKeys.length,
      mappedSourceFields: mappedSourceKeys.size,
      unmappedSourceFields,
      coveragePercentage,
      targetFieldsPopulated,
      rejectedValuesCount,
      preservedExtensionsCount: 0,
      issues,
    };

    return { targetData, coverage, issues };
  }

  private applyTransform(value: unknown, rule: MappingRule, issues: ValidationIssue[]): unknown {
    const strVal = String(value);
    switch (rule.transform) {
      case "identity":
        return value;
      case "uppercase":
        return strVal.toUpperCase();
      case "lowercase":
        return strVal.toLowerCase();
      case "trim":
        return strVal.trim();
      case "parse_date_iso": {
        const date = new Date(strVal);
        if (isNaN(date.getTime())) {
          issues.push({
            code: "INVALID_DATE_FORMAT",
            severity: "warning",
            message: `Could not parse '${strVal}' as valid ISO date`,
            path: rule.sourcePath,
            ruleId: rule.id,
          });
          return strVal;
        }
        return date.toISOString().split("T")[0];
      }
      case "format_gender_fhir": {
        const norm = strVal.trim().toLowerCase();
        if (["m", "male", "man"].includes(norm)) return "male";
        if (["f", "female", "woman"].includes(norm)) return "female";
        if (["o", "other"].includes(norm)) return "other";
        return "unknown";
      }
      case "number_to_string":
        return String(value);
      case "string_to_number": {
        const num = Number(value);
        if (isNaN(num)) {
          issues.push({
            code: "INVALID_NUMBER",
            severity: "warning",
            message: `Value '${strVal}' cannot be converted to number`,
            path: rule.sourcePath,
            ruleId: rule.id,
          });
          return value;
        }
        return num;
      }
      default:
        return value;
    }
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let curr: any = obj;
    for (const p of parts) {
      if (curr === undefined || curr === null) return undefined;
      curr = curr[p];
    }
    return curr;
  }

  private setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".");
    let curr: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!curr[p] || typeof curr[p] !== "object") {
        curr[p] = {};
      }
      curr = curr[p];
    }
    curr[parts[parts.length - 1]] = value;
  }
}
