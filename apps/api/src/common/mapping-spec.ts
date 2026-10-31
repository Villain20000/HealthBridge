import { createHash } from "node:crypto";
import { validateMappingDefinition, type MappingDefinition } from "@healthbridge/mapping-engine";
import type { MappingValidationResult, ValidationIssue } from "@healthbridge/shared-types";

/**
 * Mapping spec helpers shared by the studio and preview services.
 *
 * The checksum is deliberately the same expression the mappings controller has
 * always used (`JSON.stringify`, no sorting): a mapping's identity must not
 * change because two call sites disagree about canonicalisation.
 */

export const MAX_MAPPING_ISSUES = 200;

export function mappingSpecChecksum(spec: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`;
}

/**
 * Validate without touching the caller's spec. The validated definition is only
 * returned when nothing fatal or erroneous was found, so a caller can never cast
 * a broken spec to `MappingDefinition` by accident.
 */
export function normaliseAndValidate(
  spec: unknown,
  name?: string,
): { definition?: MappingDefinition; issues: ValidationIssue[] } {
  const result = validateMappingDefinition(spec);
  const blocking = result.issues.some((issue) => issue.severity === "fatal" || issue.severity === "error");
  const definition = blocking ? undefined : result.definition;

  const issues = [...result.issues];
  if (definition && name !== undefined && definition.name !== name) {
    // The catalogue name and the display name are allowed to differ; this is
    // information for the editor, never a reason to refuse a save or publish.
    issues.push({
      code: "MAPPING_NAME_MISMATCH",
      severity: "information",
      message: `Mapping display name does not match the catalogue name '${name}'.`,
      path: "name",
    });
  }

  return {
    ...(definition === undefined ? {} : { definition }),
    issues: issues.slice(0, MAX_MAPPING_ISSUES),
  };
}

export function toValidationResult(issues: ValidationIssue[]): MappingValidationResult {
  const counts = { fatal: 0, error: 0, warning: 0, information: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return {
    isValid: counts.fatal + counts.error === 0,
    issues,
    counts,
  };
}
