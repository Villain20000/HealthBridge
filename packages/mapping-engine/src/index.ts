import type {
  ConditionOperator,
  CoverageReport,
  MappingDefinition,
  MappingDiff,
  MappingFieldChange,
  MappingRule,
  MappingRuleChange,
  RuleCondition,
  TransformFunctionKind,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { flattenLeafPaths } from "@healthbridge/shared-types";

export type {
  TransformFunctionKind,
  ConditionOperator,
  RuleCondition,
  MappingRule,
  MappingDefinition,
} from "@healthbridge/shared-types";

export const TRANSFORM_FUNCTIONS: readonly TransformFunctionKind[] = [
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
];

export type RuleStatus = "mapped" | "defaulted" | "missing" | "rejected" | "condition_not_met" | "skipped";

export interface RuleExecutionResult {
  ruleId: string;
  sourcePath: string;
  targetPath: string;
  transform: TransformFunctionKind;
  status: RuleStatus;
  /** Target value actually written, when applicable. */
  value?: unknown;
}

export interface MappingExecutionResult {
  targetData: Record<string, unknown>;
  coverage: CoverageReport;
  issues: ValidationIssue[];
  ruleResults: RuleExecutionResult[];
}

interface TransformOutcome {
  ok: boolean;
  value?: unknown;
  issue?: Omit<ValidationIssue, "ruleId" | "path" | "recordIndex">;
}

const PATH_SEGMENT_INDEX = /^\d+$/;

export function splitPath(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function isIndexSegment(segment: string): boolean {
  return PATH_SEGMENT_INDEX.test(segment);
}

/** Read a dotted path, supporting array indices (`name.0.family`). */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Write a dotted path, creating objects for named segments and arrays for
 * numeric segments. `name.0.given.0` therefore yields
 * `{ name: [{ given: ["..."] }] }` — FHIR-valid cardinality — instead of the
 * `{ "name": { "0": ... } }` object graph produced before v3.1.0.
 */
export function setPath(root: Record<string, unknown> | unknown[], path: string, value: unknown): void {
  const segments = splitPath(path);
  if (segments.length === 0) return;
  assign(root as Record<string, unknown>, segments, value);
}

function assign(container: unknown, segments: string[], value: unknown): void {
  const [head, ...rest] = segments;
  const headIsIndex = isIndexSegment(head);

  if (rest.length === 0) {
    if (Array.isArray(container) && headIsIndex) {
      container[Number(head)] = value;
    } else if (!Array.isArray(container)) {
      (container as Record<string, unknown>)[head] = value;
    }
    return;
  }

  const nextIsIndex = isIndexSegment(rest[0]);
  const holder = container as Record<string, unknown> | unknown[];
  const existing = headIsIndex ? (holder as unknown[])[Number(head)] : (holder as Record<string, unknown>)[head];

  const mustBeArray = nextIsIndex;
  let child: unknown = existing;
  if (child === null || typeof child !== "object" || Array.isArray(child) !== mustBeArray) {
    child = mustBeArray ? [] : {};
    if (Array.isArray(holder) && headIsIndex) {
      holder[Number(head)] = child;
    } else if (!Array.isArray(holder)) {
      (holder as Record<string, unknown>)[head] = child;
    }
  }

  assign(child, rest, value);
}

/** Create a root container matching the first path segment. */
export function createRootForPath(path: string): Record<string, unknown> | unknown[] {
  const [first] = splitPath(path);
  return first && isIndexSegment(first) ? [] : {};
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1800 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= maxDay;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

export interface DateParseResult {
  ok: boolean;
  value?: string;
  reason?: "unparsable" | "ambiguous" | "out-of-range";
}

/**
 * Deterministic date parsing. `auto` only accepts unambiguous formats; a value
 * such as `03/04/2024` is rejected with `AMBIGUOUS_DATE_FORMAT` instead of
 * being silently guessed.
 */
export function parseDateValue(raw: string, inputFormat = "auto"): DateParseResult {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "unparsable" };

  const explicit = inputFormat !== "auto" ? normaliseDateFormat(inputFormat) : undefined;

  const isoMatch = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  const isoDateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);

  if (!explicit || explicit === "YYYYMMDD" || explicit === "YYYYMM") {
    if (isoDateTimeMatch) {
      const [, y, m, d] = isoDateTimeMatch;
      return validateDate(Number(y), Number(m), Number(d));
    }
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return validateDate(Number(y), Number(m), d ? Number(d) : 1);
    }
    if (explicit === "YYYYMMDD" && !isoMatch) return { ok: false, reason: "unparsable" };
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if ((!explicit || explicit === "YYYYMMDD") && compact) {
    const [, y, m, d] = compact;
    return validateDate(Number(y), Number(m), Number(d));
  }

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);

    if (explicit === "DDMMYYYY") return validateDate(year, second, first);
    if (explicit === "MMDDYYYY") return validateDate(year, first, second);

    if (explicit === "YYYYMMDD" || explicit === "YYYYMMDD" || explicit === "YYYYMM") {
      return { ok: false, reason: "unparsable" };
    }

    // auto: only accept when unambiguous.
    if (first > 12 && second <= 12) return validateDate(year, second, first); // day first
    if (second > 12 && first <= 12) return validateDate(year, first, second); // month first
    return { ok: false, reason: "ambiguous" };
  }

  return { ok: false, reason: "unparsable" };
}

function validateDate(year: number, month: number, day: number): DateParseResult {
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return { ok: false, reason: "unparsable" };
  }
  if (!isValidCalendarDate(year, month, day)) return { ok: false, reason: "out-of-range" };
  return { ok: true, value: formatIso(year, month, day) };
}

const FHIR_GENDERS = new Set(["male", "female", "other", "unknown"]);

/**
 * Canonicalise a date pattern so that `DD.MM.YYYY`, `DD/MM/YYYY` and `DD-MM-YYYY`
 * all mean the same thing. Accepts YYYYMMDD, YYYYMM, DDMMYYYY and MMDDYYYY.
 */
export function normaliseDateFormat(format: string): string {
  return format.toUpperCase().replace(/[^A-Z]/g, "");
}

function genderToFhir(raw: string, aliases: Record<string, string> = {}): { value: string; mapped: boolean } {
  const normalized = raw.trim().toLowerCase();
  // Locale aliases come from the mapping (e.g. w/m/d for German, H/F for French)
  // so international feeds do not silently degrade to "unknown".
  const alias = aliases[normalized] ?? aliases[raw.trim()];
  if (alias && FHIR_GENDERS.has(alias)) return { value: alias, mapped: true };
  if (["m", "male", "man", "hombre", "homme", "masculino"].includes(normalized)) return { value: "male", mapped: true };
  if (["f", "female", "woman", "mujer", "femme", "feminino"].includes(normalized))
    return { value: "female", mapped: true };
  if (["o", "other", "non-binary", "nonbinary", "x"].includes(normalized)) return { value: "other", mapped: true };
  if (["u", "unknown", "unk", "n/a", "na", ""].includes(normalized)) return { value: "unknown", mapped: true };
  return { value: "unknown", mapped: false };
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Apply one deterministic transform. Transform functions never invent clinical
 * meaning: when a value cannot be converted the rule is *rejected* and an issue
 * is reported, so nothing is silently written with a wrong type.
 */
export function applyTransform(value: unknown, rule: MappingRule, source: Record<string, unknown>): TransformOutcome {
  const params = rule.params ?? {};
  const text = toText(value);

  switch (rule.transform) {
    case "identity":
      return { ok: true, value };

    case "uppercase":
      return { ok: true, value: text.toUpperCase() };

    case "lowercase":
      return { ok: true, value: text.toLowerCase() };

    case "trim":
      return { ok: true, value: text.trim() };

    case "parse_date_iso": {
      const inputFormat = typeof params.inputFormat === "string" ? params.inputFormat : "auto";
      const result = parseDateValue(text, inputFormat);
      if (!result.ok) {
        const ambiguous = result.reason === "ambiguous";
        return {
          ok: false,
          issue: {
            code: ambiguous ? "AMBIGUOUS_DATE_FORMAT" : "INVALID_DATE_FORMAT",
            severity: "warning",
            message: ambiguous
              ? `Date '${text}' is ambiguous (day/month order); set params.inputFormat to DD/MM/YYYY or MM/DD/YYYY`
              : `Could not parse '${text}' as a valid date`,
            advice: "Set params.inputFormat to the exact source format.",
          },
        };
      }
      return { ok: true, value: result.value };
    }

    case "format_gender_fhir": {
      const mapped = genderToFhir(text, (params.codes as Record<string, string> | undefined) ?? {});
      if (!mapped.mapped) {
        return {
          ok: true,
          value: mapped.value,
          issue: {
            code: "GENDER_CODE_UNMAPPED",
            severity: "warning",
            message: `Gender code '${text}' is not a recognised administrative gender; written as 'unknown'`,
            advice: "Add an explicit code mapping for this value.",
          },
        };
      }
      return { ok: true, value: mapped.value };
    }

    case "concat": {
      const paths = Array.isArray(params.paths) ? (params.paths as string[]) : [];
      const separator = typeof params.separator === "string" ? params.separator : "";
      const parts = (paths.length > 0 ? paths.map((p) => toText(getPath(source, p))) : [text]).filter(
        (part) => part !== "",
      );
      if (parts.length === 0) {
        return {
          ok: false,
          issue: {
            code: "CONCAT_NO_VALUES",
            severity: "warning",
            message: "concat produced no values; no source field had content",
          },
        };
      }
      return { ok: true, value: parts.join(separator) };
    }

    case "split": {
      const separator = typeof params.separator === "string" ? params.separator : ",";
      const index = num(params.index) ?? 0;
      const parts = text.split(separator);
      if (index < 0 || index >= parts.length) {
        return {
          ok: false,
          issue: {
            code: "SPLIT_INDEX_OUT_OF_RANGE",
            severity: "warning",
            message: `split index ${index} is outside the ${parts.length} part(s) of '${text}'`,
          },
        };
      }
      return { ok: true, value: parts[index].trim() };
    }

    case "number_to_string": {
      const numeric = typeof value === "number" ? value : Number(toText(value).replace(/\s/g, "").replace(",", "."));
      if (!Number.isFinite(numeric)) {
        return {
          ok: false,
          issue: {
            code: "INVALID_NUMBER",
            severity: "warning",
            message: `Value '${text}' is not numeric`,
          },
        };
      }
      const decimals = num(params.decimals);
      const formatted = decimals !== undefined ? numeric.toFixed(decimals) : String(numeric);
      const decimalSeparator = typeof params.decimalSeparator === "string" ? params.decimalSeparator : ".";
      const out = decimalSeparator === "." ? formatted : formatted.replace(".", decimalSeparator);
      return { ok: true, value: out };
    }

    case "string_to_number": {
      const decimalSeparator = typeof params.decimalSeparator === "string" ? params.decimalSeparator : ".";
      const thousandsSeparator = typeof params.thousandsSeparator === "string" ? params.thousandsSeparator : undefined;
      let cleaned = text.trim().replace(/\s/g, "");
      if (thousandsSeparator) cleaned = cleaned.split(thousandsSeparator).join("");
      if (decimalSeparator !== ".") cleaned = cleaned.split(decimalSeparator).join(".");
      const parsed = Number(cleaned);
      if (cleaned === "" || !Number.isFinite(parsed)) {
        return {
          ok: false,
          issue: {
            code: "INVALID_NUMBER",
            severity: "warning",
            message: `Value '${text}' cannot be converted to a number`,
            advice: "Set params.decimalSeparator / params.thousandsSeparator for locale-specific formats.",
          },
        };
      }
      if (params.integer === true && !Number.isInteger(parsed)) {
        return {
          ok: false,
          issue: {
            code: "INVALID_NUMBER",
            severity: "warning",
            message: `Value '${text}' is not an integer`,
          },
        };
      }
      return { ok: true, value: parsed };
    }

    case "default_value": {
      if (rule.defaultValue === undefined) {
        return {
          ok: false,
          issue: {
            code: "MISSING_DEFAULT_VALUE",
            severity: "error",
            message: "Transform 'default_value' requires rule.defaultValue",
          },
        };
      }
      return { ok: true, value: rule.defaultValue };
    }

    case "to_reference": {
      const resourceType = typeof params.type === "string" ? params.type : "Patient";
      const id = text.trim();
      if (id === "") {
        return {
          ok: false,
          issue: {
            code: "REFERENCE_WITHOUT_ID",
            severity: "warning",
            message: `Cannot build a ${resourceType} reference without an identifier`,
          },
        };
      }
      return { ok: true, value: { reference: `${resourceType}/${id}` } };
    }

    case "codeable_concept": {
      const system = typeof params.system === "string" ? params.system : undefined;
      if (!system) {
        return {
          ok: false,
          issue: {
            code: "CODEABLE_CONCEPT_WITHOUT_SYSTEM",
            severity: "error",
            message: "Transform 'codeable_concept' requires params.system (e.g. http://loinc.org)",
          },
        };
      }
      const code = text.trim();
      if (code === "") {
        return {
          ok: false,
          issue: {
            code: "MISSING_CODE_VALUE",
            severity: "warning",
            message: "No code value to place in the CodeableConcept",
          },
        };
      }
      const displayFrom = typeof params.displayPath === "string" ? toText(getPath(source, params.displayPath)) : "";
      const coding: Record<string, unknown> = { system, code };
      if (displayFrom) coding.display = displayFrom;
      const concept: Record<string, unknown> = { coding: [coding] };
      const textFrom = typeof params.textPath === "string" ? toText(getPath(source, params.textPath)) : "";
      if (textFrom) concept.text = textFrom;
      else if (params.useCodeAsText === true) concept.text = displayFrom || code;
      return { ok: true, value: concept };
    }

    default:
      return assertNeverTransform(rule.transform);
  }
}

function assertNeverTransform(value: never): never {
  throw new Error(`Unhandled transform '${String(value)}' — update applyTransform and TRANSFORM_FUNCTIONS`);
}

function conditionsMatch(conditions: RuleCondition[] | undefined, source: Record<string, unknown>): boolean {
  if (!conditions || conditions.length === 0) return true;

  return conditions.every((condition) => {
    const actual = getPath(source, condition.path);
    switch (condition.op) {
      case "exists":
        return actual !== undefined && actual !== null && actual !== "";
      case "not_exists":
        return actual === undefined || actual === null || actual === "";
      case "equals":
        return toText(actual) === toText(condition.value);
      case "not_equals":
        return toText(actual) !== toText(condition.value);
      case "in":
        return Array.isArray(condition.value) ? condition.value.map(toText).includes(toText(actual)) : false;
      case "not_in":
        return Array.isArray(condition.value) ? !condition.value.map(toText).includes(toText(actual)) : true;
      case "matches":
        try {
          return new RegExp(String(condition.value)).test(toText(actual));
        } catch {
          return false;
        }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const left = Number(toText(actual));
        const right = Number(toText(condition.value));
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        if (condition.op === "gt") return left > right;
        if (condition.op === "gte") return left >= right;
        if (condition.op === "lt") return left < right;
        return left <= right;
      }
      default:
        return false;
    }
  });
}

function pathMatches(leafPath: string, rulePath: string): boolean {
  return leafPath === rulePath || leafPath.startsWith(`${rulePath}.`) || rulePath.startsWith(`${leafPath}.`);
}

export class MappingEngine {
  public execute(sourceData: Record<string, unknown>, mapping: MappingDefinition): MappingExecutionResult {
    const targetData = createRootForPath(mapping.rules[0]?.targetPath ?? "id") as Record<string, unknown>;
    const issues: ValidationIssue[] = [];
    const ruleResults: RuleExecutionResult[] = [];

    const sourceLeaves = flattenLeafPaths(sourceData);
    const consumedLeaves = new Set<string>();
    const rejectedLeaves = new Set<string>();
    let targetFieldsPopulated = 0;

    for (const rule of mapping.rules) {
      const rawValue = getPath(sourceData, rule.sourcePath);
      const isPresent = rawValue !== undefined && rawValue !== null && toText(rawValue) !== "";

      if (!conditionsMatch(rule.when, sourceData)) {
        ruleResults.push({
          ruleId: rule.id,
          sourcePath: rule.sourcePath,
          targetPath: rule.targetPath,
          transform: rule.transform,
          status: "condition_not_met",
        });
        continue;
      }

      if (!isPresent && rule.defaultValue === undefined) {
        if (rule.required) {
          issues.push({
            code: "MISSING_REQUIRED_FIELD",
            severity: "error",
            message: `Required field '${rule.sourcePath}' is missing or empty`,
            path: rule.sourcePath,
            ruleId: rule.id,
            advice: "Provide the source field, or set rule.defaultValue.",
          });
          rejectedLeaves.add(rule.sourcePath);
          ruleResults.push({
            ruleId: rule.id,
            sourcePath: rule.sourcePath,
            targetPath: rule.targetPath,
            transform: rule.transform,
            status: "rejected",
          });
        } else {
          ruleResults.push({
            ruleId: rule.id,
            sourcePath: rule.sourcePath,
            targetPath: rule.targetPath,
            transform: rule.transform,
            status: "missing",
          });
        }
        continue;
      }

      const value = isPresent ? rawValue : rule.defaultValue;
      const outcome = applyTransform(value, rule, sourceData);

      if (!outcome.ok) {
        const baseIssue = outcome.issue!;
        issues.push({
          ...baseIssue,
          // A required value that cannot be converted means the record is not
          // exportable: escalate so the record is reported as rejected.
          severity: rule.required ? "error" : baseIssue.severity,
          path: rule.sourcePath,
          ruleId: rule.id,
          advice: rule.required
            ? `${baseIssue.advice ?? ""} Required element rejected: the record will not be exported.`.trim()
            : baseIssue.advice,
        });
        if (isPresent) rejectedLeaves.add(rule.sourcePath);
        ruleResults.push({
          ruleId: rule.id,
          sourcePath: rule.sourcePath,
          targetPath: rule.targetPath,
          transform: rule.transform,
          status: "rejected",
        });
        continue;
      }

      if (outcome.issue) {
        issues.push({ ...outcome.issue, path: rule.sourcePath, ruleId: rule.id });
      }

      setPath(targetData as Record<string, unknown>, rule.targetPath, outcome.value);
      targetFieldsPopulated++;
      if (isPresent) {
        for (const leaf of sourceLeaves) {
          if (pathMatches(leaf, rule.sourcePath)) consumedLeaves.add(leaf);
        }
      }

      ruleResults.push({
        ruleId: rule.id,
        sourcePath: rule.sourcePath,
        targetPath: rule.targetPath,
        transform: rule.transform,
        status: isPresent ? "mapped" : "defaulted",
        value: outcome.value,
      });
    }

    const unmappedSourceFields = sourceLeaves.filter((leaf) => !consumedLeaves.has(leaf));
    const coveragePercentage =
      sourceLeaves.length > 0 ? Math.round((consumedLeaves.size / sourceLeaves.length) * 100) : 100;

    const coverage: CoverageReport = {
      totalSourceFields: sourceLeaves.length,
      mappedSourceFields: consumedLeaves.size,
      unmappedSourceFields,
      coveragePercentage,
      targetFieldsPopulated,
      rejectedValuesCount: ruleResults.filter((r) => r.status === "rejected").length,
      preservedExtensionsCount: 0,
      issues,
      mappedFieldPaths: Array.from(consumedLeaves),
      rejectedFieldPaths: Array.from(rejectedLeaves),
      recordsConsidered: 1,
    };

    return { targetData, coverage, issues, ruleResults };
  }

  /**
   * Static validation of a mapping definition. Catching these at authoring time
   * keeps runtime failures meaningful.
   */
  public validate(mapping: MappingDefinition): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const ruleIds = new Set<string>();
    const targetPaths = new Map<string, string>();

    if (!mapping.rules || mapping.rules.length === 0) {
      issues.push({
        code: "MAPPING_EMPTY",
        severity: "error",
        message: `Mapping '${mapping.id}' defines no rules`,
      });
      return issues;
    }

    for (const rule of mapping.rules) {
      if (ruleIds.has(rule.id)) {
        issues.push({
          code: "MAPPING_DUPLICATE_RULE_ID",
          severity: "error",
          message: `Duplicate rule id '${rule.id}'`,
          ruleId: rule.id,
        });
      }
      ruleIds.add(rule.id);

      if (!rule.sourcePath) {
        issues.push({
          code: "MAPPING_MISSING_SOURCE_PATH",
          severity: "error",
          message: `Rule '${rule.id}' has no sourcePath`,
          ruleId: rule.id,
        });
      }

      if (!rule.targetPath) {
        issues.push({
          code: "MAPPING_MISSING_TARGET_PATH",
          severity: "error",
          message: `Rule '${rule.id}' has no targetPath`,
          ruleId: rule.id,
        });
      }

      if (!TRANSFORM_FUNCTIONS.includes(rule.transform)) {
        issues.push({
          code: "MAPPING_UNKNOWN_TRANSFORM",
          severity: "error",
          message: `Rule '${rule.id}' uses unknown transform '${rule.transform}'`,
          ruleId: rule.id,
          advice: `Supported transforms: ${TRANSFORM_FUNCTIONS.join(", ")}`,
        });
      }

      if (rule.transform === "default_value" && rule.defaultValue === undefined) {
        issues.push({
          code: "MAPPING_MISSING_DEFAULT_VALUE",
          severity: "error",
          message: `Rule '${rule.id}' uses default_value without rule.defaultValue`,
          ruleId: rule.id,
        });
      }

      if (rule.targetPath) {
        const existing = targetPaths.get(rule.targetPath);
        if (existing) {
          issues.push({
            code: "MAPPING_DUPLICATE_TARGET",
            severity: "warning",
            message: `Target path '${rule.targetPath}' is written by rules '${existing}' and '${rule.id}'`,
            path: rule.targetPath,
            ruleId: rule.id,
          });
        } else {
          targetPaths.set(rule.targetPath, rule.id);
        }
      }

      for (const condition of rule.when ?? []) {
        if (!condition.path) {
          issues.push({
            code: "MAPPING_INVALID_CONDITION",
            severity: "error",
            message: `Rule '${rule.id}' has a condition without a path`,
            ruleId: rule.id,
          });
        }
      }
    }

    return issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Safe structural validation                                                 */
/* -------------------------------------------------------------------------- */

const REQUIRED_TOP_LEVEL_FIELDS = ["id", "name", "version", "sourceFormat", "targetFormat"] as const;
const OPTIONAL_TOP_LEVEL_STRING_FIELDS = ["targetResourceType", "targetProfile", "description"] as const;
const REQUIRED_RULE_STRING_FIELDS = ["id", "sourcePath", "targetPath", "transform"] as const;
const CONDITION_OPERATORS: readonly ConditionOperator[] = [
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
const CONDITION_OPERATOR_SET: ReadonlySet<string> = new Set(CONDITION_OPERATORS);

interface StructuralValidationResult {
  definition?: MappingDefinition;
  issues: ValidationIssue[];
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeArrayLength(value: unknown[]): number {
  try {
    return value.length;
  } catch {
    return 0;
  }
}

function readProperty(container: unknown, key: string | number): unknown {
  try {
    return (container as Record<string | number, unknown>)[key];
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !safeIsArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalidRuleField(pathPrefix: string, field: string, ruleId?: string): ValidationIssue {
  return {
    code: "MAPPING_RULE_INVALID_FIELD",
    severity: "error",
    message: `Rule field '${field}' has an invalid type`,
    path: `${pathPrefix}.${field}`,
    ...(ruleId !== undefined ? { ruleId } : {}),
  };
}

function collectStructuralIssues(spec: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!isNonEmptyString(readProperty(spec, field))) {
      issues.push({
        code: "MAPPING_MISSING_FIELD",
        severity: "error",
        message: `Mapping definition field '${field}' is required`,
        path: field,
      });
    }
  }

  for (const field of OPTIONAL_TOP_LEVEL_STRING_FIELDS) {
    const value = readProperty(spec, field);
    if (value !== undefined && typeof value !== "string") {
      issues.push({
        code: "MAPPING_INVALID_FIELD",
        severity: "error",
        message: `Mapping definition field '${field}' must be a string`,
        path: field,
      });
    }
  }

  const sourceDomains = readProperty(spec, "sourceDomains");
  if (sourceDomains !== undefined) {
    const domains = safeIsArray(sourceDomains) ? sourceDomains : undefined;
    if (!domains || domains.some((domain) => typeof domain !== "string")) {
      issues.push({
        code: "MAPPING_INVALID_FIELD",
        severity: "error",
        message: "Mapping definition field 'sourceDomains' must be an array of strings",
        path: "sourceDomains",
      });
    }
  }

  const rules = readProperty(spec, "rules");
  if (!safeIsArray(rules)) {
    issues.push({
      code: "MAPPING_RULES_NOT_ARRAY",
      severity: "fatal",
      message: "Mapping definition field 'rules' must be an array",
      path: "rules",
    });
    return issues;
  }

  const ruleCount = safeArrayLength(rules);
  for (let i = 0; i < ruleCount; i++) {
    const rule = readProperty(rules, i);
    const rulePath = `rules[${i}]`;

    if (!isObjectLike(rule)) {
      issues.push({
        code: "MAPPING_RULE_NOT_OBJECT",
        severity: "error",
        message: `Rule at ${rulePath} must be an object`,
        path: rulePath,
      });
      continue;
    }

    const idValue = readProperty(rule, "id");
    const ruleId = isNonEmptyString(idValue) ? idValue : undefined;
    const withRuleId = ruleId !== undefined ? { ruleId } : {};

    for (const field of REQUIRED_RULE_STRING_FIELDS) {
      const value = readProperty(rule, field);
      const valid = field === "id" ? isNonEmptyString(value) : typeof value === "string";
      if (!valid) {
        issues.push({
          code: "MAPPING_RULE_MISSING_FIELD",
          severity: "error",
          message: `Rule field '${field}' is required`,
          path: `${rulePath}.${field}`,
          ...withRuleId,
        });
      }
    }

    const params = readProperty(rule, "params");
    if (params !== undefined && !isPlainObject(params)) {
      issues.push(invalidRuleField(rulePath, "params", ruleId));
    }

    const required = readProperty(rule, "required");
    if (required !== undefined && typeof required !== "boolean") {
      issues.push(invalidRuleField(rulePath, "required", ruleId));
    }

    const when = readProperty(rule, "when");
    if (when !== undefined && !safeIsArray(when)) {
      issues.push(invalidRuleField(rulePath, "when", ruleId));
    }

    const description = readProperty(rule, "description");
    if (description !== undefined && typeof description !== "string") {
      issues.push(invalidRuleField(rulePath, "description", ruleId));
    }

    if (!safeIsArray(when)) continue;

    const conditionCount = safeArrayLength(when);
    for (let j = 0; j < conditionCount; j++) {
      const condition = readProperty(when, j);
      const conditionPath = `${rulePath}.when[${j}]`;

      if (!isObjectLike(condition)) {
        issues.push({
          code: "MAPPING_RULE_INVALID_FIELD",
          severity: "error",
          message: `Condition at ${conditionPath} must be an object`,
          path: conditionPath,
          ...withRuleId,
        });
        continue;
      }

      if (typeof readProperty(condition, "path") !== "string") {
        issues.push(invalidRuleField(conditionPath, "path", ruleId));
      }

      const op = readProperty(condition, "op");
      if (typeof op !== "string") {
        issues.push(invalidRuleField(conditionPath, "op", ruleId));
      } else if (!CONDITION_OPERATOR_SET.has(op)) {
        issues.push({
          code: "MAPPING_UNKNOWN_CONDITION_OPERATOR",
          severity: "error",
          message: "Condition operator is not supported",
          path: `${conditionPath}.op`,
          ...withRuleId,
        });
      }
    }
  }

  return issues;
}

function validateStructure(spec: unknown): StructuralValidationResult {
  if (!isObjectLike(spec)) {
    return {
      issues: [
        {
          code: "MAPPING_NOT_OBJECT",
          severity: "fatal",
          message: "Mapping definition must be an object",
        },
      ],
    };
  }

  const issues = collectStructuralIssues(spec);
  if (issues.length > 0) return { issues };

  const definition = spec as unknown as MappingDefinition;
  try {
    issues.push(...new MappingEngine().validate(definition));
    return { definition, issues };
  } catch {
    return {
      issues: [
        ...issues,
        {
          code: "MAPPING_NOT_OBJECT",
          severity: "fatal",
          message: "Mapping definition could not be read safely",
        },
      ],
    };
  }
}

/**
 * Total structural validator. Malformed input (including `null`, arrays,
 * primitives, `rules: [null]` and class instances) never throws; when the
 * structure is sound the existing semantic checks are appended.
 */
export function validateMappingDefinition(spec: unknown): {
  definition?: MappingDefinition;
  issues: ValidationIssue[];
} {
  try {
    return validateStructure(spec);
  } catch {
    return {
      issues: [
        {
          code: "MAPPING_NOT_OBJECT",
          severity: "fatal",
          message: "Mapping definition could not be read safely",
        },
      ],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping diff                                                               */
/* -------------------------------------------------------------------------- */

const METADATA_FIELDS = [
  "name",
  "version",
  "sourceFormat",
  "targetFormat",
  "targetResourceType",
  "targetProfile",
  "description",
  "sourceDomains",
] as const satisfies ReadonlyArray<keyof MappingDefinition>;

const RULE_FIELDS = [
  "sourcePath",
  "targetPath",
  "transform",
  "defaultValue",
  "params",
  "required",
  "when",
  "description",
] as const satisfies ReadonlyArray<keyof MappingRule>;

const MAX_DIFF_ENTRIES = 500;

/**
 * Structural equality for JSON-like values. Object key order is irrelevant,
 * array order matters, and an absent key equals an explicit `undefined`.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) return false;

  if (leftIsArray && rightIsArray) {
    const leftArray = left as unknown[];
    const rightArray = right as unknown[];
    if (leftArray.length !== rightArray.length) return false;
    for (let i = 0; i < leftArray.length; i++) {
      if (!valuesEqual(leftArray[i], rightArray[i])) return false;
    }
    return true;
  }

  const leftEntries = Object.entries(left as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const rightEntries = Object.entries(right as Record<string, unknown>).filter(([, value]) => value !== undefined);
  if (leftEntries.length !== rightEntries.length) return false;

  const rightMap = new Map(rightEntries);
  for (const [key, value] of leftEntries) {
    if (!rightMap.has(key)) return false;
    if (!valuesEqual(value, rightMap.get(key))) return false;
  }
  return true;
}

function indexRulesById(rules: MappingRule[]): Map<string, MappingRule> {
  const byId = new Map<string, MappingRule>();
  for (const rule of rules) {
    // First occurrence wins when an id repeats.
    if (!byId.has(rule.id)) byId.set(rule.id, rule);
  }
  return byId;
}

/**
 * Compare two mapping definitions. Rule matching is by `id`; the result is
 * deterministic, non-mutating, and caps each rule list at 500 entries while
 * keeping full counts.
 */
export function diffMappingDefinitions(from: MappingDefinition, to: MappingDefinition): MappingDiff {
  const metadata: MappingFieldChange[] = [];
  for (const field of METADATA_FIELDS) {
    const fromValue = from[field];
    const toValue = to[field];
    if (!valuesEqual(fromValue, toValue)) {
      metadata.push({ field, from: fromValue, to: toValue });
    }
  }

  const fromById = indexRulesById(from.rules);
  const toById = indexRulesById(to.rules);

  const fromCommonIds = Array.from(fromById.keys()).filter((id) => toById.has(id));
  const toCommonIds = Array.from(toById.keys()).filter((id) => fromById.has(id));

  const added: MappingRule[] = [];
  const addedIds = new Set<string>();
  for (const rule of to.rules) {
    if (fromById.has(rule.id) || addedIds.has(rule.id)) continue;
    addedIds.add(rule.id);
    added.push(rule);
  }

  const removed: MappingRule[] = [];
  const removedIds = new Set<string>();
  for (const rule of from.rules) {
    if (toById.has(rule.id) || removedIds.has(rule.id)) continue;
    removedIds.add(rule.id);
    removed.push(rule);
  }

  const changed: MappingRuleChange[] = [];
  for (const ruleId of toCommonIds) {
    const fromRule = fromById.get(ruleId)!;
    const toRule = toById.get(ruleId)!;
    const fields: MappingFieldChange[] = [];
    for (const field of RULE_FIELDS) {
      const fromValue = fromRule[field];
      const toValue = toRule[field];
      if (!valuesEqual(fromValue, toValue)) {
        fields.push({ field, from: fromValue, to: toValue });
      }
    }
    if (fields.length > 0) changed.push({ ruleId, fields });
  }

  const fromPositions = new Map(fromCommonIds.map((ruleId, index) => [ruleId, index]));
  const toPositions = new Map(toCommonIds.map((ruleId, index) => [ruleId, index]));
  const reordered: Array<{ ruleId: string; fromIndex: number; toIndex: number }> = [];
  for (const ruleId of toCommonIds) {
    const fromIndex = fromPositions.get(ruleId)!;
    const toIndex = toPositions.get(ruleId)!;
    if (fromIndex !== toIndex) reordered.push({ ruleId, fromIndex, toIndex });
  }

  const unchanged = toCommonIds.length - changed.length;
  const truncated =
    added.length > MAX_DIFF_ENTRIES ||
    removed.length > MAX_DIFF_ENTRIES ||
    changed.length > MAX_DIFF_ENTRIES ||
    reordered.length > MAX_DIFF_ENTRIES;

  return {
    metadata,
    rules: {
      added: added.slice(0, MAX_DIFF_ENTRIES),
      removed: removed.slice(0, MAX_DIFF_ENTRIES),
      changed: changed.slice(0, MAX_DIFF_ENTRIES),
      reordered: reordered.slice(0, MAX_DIFF_ENTRIES),
      unchanged,
    },
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      reordered: reordered.length,
      unchanged,
    },
    truncated,
  };
}
