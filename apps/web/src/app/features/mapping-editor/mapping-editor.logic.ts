import type { RuleCondition, ValidationIssue } from "@healthbridge/shared-types";

/**
 * Mapping-editor presentation logic.
 *
 * Pure and framework-free so it is unit-testable with `node:test` (see
 * `apps/web/test/mapping-editor.test.ts`). It only derives views from already-stored
 * payloads — a mapping spec from `GET /mappings/:id`, an asset row from
 * `GET /assets/:id`, versions from `GET /mappings/:name/versions` — and never calls
 * the API itself or executes a mapping.
 *
 * The transform list, condition operators and issue codes below mirror
 * `packages/mapping-engine/src/index.ts` (`TRANSFORM_FUNCTIONS`,
 * `CONDITION_OPERATORS`, `MappingEngine.validate`, `validateMappingDefinition`) as
 * string literals: the web workspace depends only on `@healthbridge/shared-types`,
 * so the engine cannot be imported here. The contract tests pin every literal, and
 * any drift is a bug.
 */

/** Mirrors `TRANSFORM_FUNCTIONS` in `packages/mapping-engine/src/index.ts`. */
export const TRANSFORM_FUNCTIONS: readonly string[] = [
  "identity",
  "uppercase",
  "lowercase",
  "trim",
  "parse_date_iso",
  "format_gender_fhir",
  "concat",
  "split",
  "number_to_string",
  "string_to_number",
  "default_value",
  "to_reference",
  "codeable_concept",
  "convert_units",
];

/** Mirrors `CONDITION_OPERATORS` in `packages/mapping-engine/src/index.ts`. */
export const CONDITION_OPERATORS: readonly string[] = [
  "exists",
  "not_exists",
  "equals",
  "not_equals",
  "in",
  "not_in",
  "matches",
  "gt",
  "gte",
  "lt",
  "lte",
];

/**
 * Exact canary wording. Rendered verbatim by the page so the editor can never read
 * as executing patient data in the browser.
 */
export const NO_LOCAL_EXECUTION =
  "Edits never execute against patient data in the browser. This editor only reshapes the stored spec text.";

/** Exact save-path wording: validation happens server-side when the version is saved. */
export const VALIDATE_ON_SAVE =
  "Validate on save via the API: saving creates a new immutable version and the API validates the spec.";

/** One editable rule row. `whenJson` is the raw `when` condition array as JSON text. */
export interface EditorRule {
  id: string;
  sourcePath: string;
  targetPath: string;
  transform: string;
  /** Raw default-value text; blank means the rule carries no `defaultValue`. */
  defaultText: string;
  required: boolean;
  /** Raw `when` condition array as JSON text; blank means no conditions. */
  whenJson: string;
}

/** Read-only view of one stored mapping version. */
export interface VersionView {
  id: string;
  name: string;
  version: number;
  specChecksum: string;
  createdAt: string;
}

/** Read-only view of the asset the schema explorer describes. */
export interface AssetSummary {
  id: string;
  filename: string;
  sourceFormat: string;
  domain: string;
  sizeBytes: number;
  checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function displayValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const serialised = JSON.stringify(value);
    return serialised === undefined ? "" : serialised;
  } catch {
    return "";
  }
}

/** Parses the raw default-value text: JSON when it parses, the raw string otherwise. */
export function parseDefaultText(text: string): { present: boolean; value?: unknown } {
  if (text.trim().length === 0) return { present: false };
  try {
    return { present: true, value: JSON.parse(text) as unknown };
  } catch {
    return { present: true, value: text };
  }
}

/** Parses the raw `when` text into conditions; blank means no conditions. */
export function parseWhenJson(text: string): { ok: true; conditions: RuleCondition[] } | { ok: false } {
  if (text.trim().length === 0) return { ok: true, conditions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  return { ok: true, conditions: parsed as RuleCondition[] };
}

/** A blank keyboard-added row. The caller supplies a unique id. */
export function blankRule(id: string): EditorRule {
  return { id, sourcePath: "", targetPath: "", transform: "identity", defaultText: "", required: false, whenJson: "" };
}

/**
 * Defensive view of a stored mapping spec's rules. Anything malformed yields an
 * empty list (or drops the offending rule) — never a throw — so a corrupt spec
 * renders the empty state instead of crashing the editor.
 */
export function rulesFromSpec(spec: unknown): EditorRule[] {
  if (!isRecord(spec) || !Array.isArray(spec["rules"])) return [];
  const rows: EditorRule[] = [];
  for (const entry of spec["rules"]) {
    if (!isRecord(entry)) continue;
    const when = entry["when"];
    rows.push({
      id: cleanText(entry["id"]),
      sourcePath: typeof entry["sourcePath"] === "string" ? entry["sourcePath"] : "",
      targetPath: typeof entry["targetPath"] === "string" ? entry["targetPath"] : "",
      transform: typeof entry["transform"] === "string" ? entry["transform"] : "",
      defaultText: displayValue(entry["defaultValue"]),
      required: entry["required"] === true,
      whenJson: Array.isArray(when) ? displayValue(when) : "",
    });
  }
  return rows;
}

/** Builds the `rules` array of a mapping spec from the edited rows. */
export function specRulesFromRows(rows: EditorRule[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const rule: Record<string, unknown> = {
      id: row.id,
      sourcePath: row.sourcePath,
      targetPath: row.targetPath,
      transform: row.transform,
    };
    const parsedDefault = parseDefaultText(row.defaultText);
    if (parsedDefault.present) rule["defaultValue"] = parsedDefault.value;
    if (row.required) rule["required"] = true;
    const parsedWhen = parseWhenJson(row.whenJson);
    if (parsedWhen.ok && parsedWhen.conditions.length > 0) rule["when"] = parsedWhen.conditions;
    return rule;
  });
}

/**
 * Client-side static validation of the edited rows. Uses the same issue codes the
 * engine reports (`MappingEngine.validate` plus the structural
 * `MAPPING_UNKNOWN_CONDITION_OPERATOR` / `MAPPING_RULE_INVALID_FIELD`), so an
 * author sees engine-identical codes before saving. The API still validates on
 * save; this list is advisory, never execution.
 */
export function validateEditorRows(rows: EditorRule[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (rows.length === 0) {
    issues.push({ code: "MAPPING_EMPTY", severity: "error", message: "The draft defines no rules" });
    return issues;
  }
  const seenIds = new Set<string>();
  const targetPaths = new Map<string, string>();
  rows.forEach((row, index) => {
    const rulePath = `rules[${index}]`;
    if (seenIds.has(row.id)) {
      issues.push({
        code: "MAPPING_DUPLICATE_RULE_ID",
        severity: "error",
        message: `Duplicate rule id '${row.id}'`,
        ruleId: row.id,
      });
    }
    seenIds.add(row.id);
    if (row.sourcePath.trim().length === 0) {
      issues.push({
        code: "MAPPING_MISSING_SOURCE_PATH",
        severity: "error",
        message: `Rule '${row.id}' has no sourcePath`,
        ruleId: row.id,
      });
    }
    if (row.targetPath.trim().length === 0) {
      issues.push({
        code: "MAPPING_MISSING_TARGET_PATH",
        severity: "error",
        message: `Rule '${row.id}' has no targetPath`,
        ruleId: row.id,
      });
    }
    if (!TRANSFORM_FUNCTIONS.includes(row.transform)) {
      issues.push({
        code: "MAPPING_UNKNOWN_TRANSFORM",
        severity: "error",
        message: `Rule '${row.id}' uses unknown transform '${row.transform}'`,
        ruleId: row.id,
        advice: `Supported transforms: ${TRANSFORM_FUNCTIONS.join(", ")}`,
      });
    }
    if (row.transform === "default_value" && row.defaultText.trim().length === 0) {
      issues.push({
        code: "MAPPING_MISSING_DEFAULT_VALUE",
        severity: "error",
        message: `Rule '${row.id}' uses default_value without a default value`,
        ruleId: row.id,
      });
    }
    if (row.targetPath.trim().length > 0) {
      const existing = targetPaths.get(row.targetPath);
      if (existing !== undefined) {
        issues.push({
          code: "MAPPING_DUPLICATE_TARGET",
          severity: "warning",
          message: `Target path '${row.targetPath}' is written by rules '${existing}' and '${row.id}'`,
          path: row.targetPath,
          ruleId: row.id,
        });
      } else {
        targetPaths.set(row.targetPath, row.id);
      }
    }
    const parsedWhen = parseWhenJson(row.whenJson);
    if (!parsedWhen.ok) {
      issues.push({
        code: "MAPPING_RULE_INVALID_FIELD",
        severity: "error",
        message: `Rule '${row.id}' has a 'when' condition that is not a JSON array`,
        path: `${rulePath}.when`,
        ruleId: row.id,
      });
      return;
    }
    parsedWhen.conditions.forEach((condition, conditionIndex) => {
      const conditionPath = `${rulePath}.when[${conditionIndex}]`;
      if (!isRecord(condition)) {
        issues.push({
          code: "MAPPING_RULE_INVALID_FIELD",
          severity: "error",
          message: `Condition at ${conditionPath} must be an object`,
          path: conditionPath,
          ruleId: row.id,
        });
        return;
      }
      if (typeof condition["path"] !== "string" || (condition["path"] as string).trim().length === 0) {
        issues.push({
          code: "MAPPING_INVALID_CONDITION",
          severity: "error",
          message: `Rule '${row.id}' has a condition without a path`,
          ruleId: row.id,
        });
      }
      const op = condition["op"];
      if (typeof op !== "string") {
        issues.push({
          code: "MAPPING_RULE_INVALID_FIELD",
          severity: "error",
          message: `Condition at ${conditionPath} must name an operator`,
          path: `${conditionPath}.op`,
          ruleId: row.id,
        });
      } else if (!CONDITION_OPERATORS.includes(op)) {
        issues.push({
          code: "MAPPING_UNKNOWN_CONDITION_OPERATOR",
          severity: "error",
          message: `Rule '${row.id}' uses an unsupported condition operator '${op}'`,
          path: `${conditionPath}.op`,
          ruleId: row.id,
        });
      }
    });
  });
  return issues;
}

/** Moves a row without drag-and-drop; out-of-range moves return the list unchanged. */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return rows;
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length || from === to) return rows;
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/** Distinct non-empty source paths in first-seen order: the asset-side explorer. */
export function sourceFieldsFromRows(rows: EditorRule[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const field = row.sourcePath.trim();
    if (field.length > 0 && !seen.has(field)) seen.add(field);
  }
  return [...seen];
}

/** Distinct non-empty target paths in first-seen order: the target-side explorer. */
export function targetFieldsFromRows(rows: EditorRule[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const field = row.targetPath.trim();
    if (field.length > 0 && !seen.has(field)) seen.add(field);
  }
  return [...seen];
}

/** Target resource type declared by the spec being edited; null when absent. */
export function targetResourceTypeFromSpec(spec: unknown): string | null {
  if (!isRecord(spec)) return null;
  const value = spec["targetResourceType"];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

/** Mapping name declared by the spec being edited; null when absent. */
export function mappingNameFromSpec(spec: unknown): string | null {
  if (!isRecord(spec)) return null;
  const value = spec["name"];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

/**
 * Defensive view of `GET /mappings/:name/versions`. Malformed payloads yield an
 * empty list, never a throw; entries missing an id or version number are dropped.
 */
export function versionsFromResponse(payload: unknown): VersionView[] {
  if (!isRecord(payload) || !Array.isArray(payload["versions"])) return [];
  const views: VersionView[] = [];
  for (const entry of payload["versions"]) {
    if (!isRecord(entry)) continue;
    const id = cleanText(entry["id"]);
    const version = entry["version"];
    if (id.length === 0 || typeof version !== "number" || !Number.isInteger(version)) continue;
    views.push({
      id,
      name: typeof entry["name"] === "string" ? entry["name"] : "",
      version,
      specChecksum: typeof entry["specChecksum"] === "string" ? entry["specChecksum"] : "",
      createdAt: typeof entry["createdAt"] === "string" ? entry["createdAt"] : "",
    });
  }
  views.sort((a, b) => b.version - a.version);
  return views;
}

/**
 * Defensive view of `GET /assets/:id` for the schema explorer header. Returns
 * null when the payload is not an asset row, so the explorer renders its empty
 * state instead of inventing metadata.
 */
export function assetSummaryFromRecord(asset: unknown): AssetSummary | null {
  if (!isRecord(asset)) return null;
  const id = cleanText(asset["id"]);
  const filename = cleanText(asset["filename"]);
  if (id.length === 0 || filename.length === 0) return null;
  return {
    id,
    filename,
    sourceFormat: typeof asset["sourceFormat"] === "string" ? asset["sourceFormat"] : "unknown",
    domain: typeof asset["domain"] === "string" ? asset["domain"] : "unknown",
    sizeBytes: typeof asset["sizeBytes"] === "number" ? asset["sizeBytes"] : 0,
    checksum: typeof asset["checksum"] === "string" ? asset["checksum"] : "",
  };
}

/** Counts blocking (error/fatal) issues; warnings never block saving. */
export function blockingIssueCount(issues: ValidationIssue[]): number {
  return issues.filter((issue) => issue.severity === "error" || issue.severity === "fatal").length;
}

/** Chip tone for an issue severity, mirroring the run-detail issues tab. */
export function severityTone(severity: string): "danger" | "warn" | "info" {
  if (severity === "fatal" || severity === "error") return "danger";
  if (severity === "warning") return "warn";
  return "info";
}
