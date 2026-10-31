import { MAPPING_TRANSFORM_KINDS } from "@healthbridge/shared-types";
import type {
  MappingDefinition,
  MappingRule,
  TransformFunctionKind,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { canonicalJson } from "../../../core/json";

/**
 * Pure logic for the mapping editor: undo/redo history, rule edits, transform parameter
 * descriptions and the quick checks shown while typing.
 *
 * Nothing here talks to the API or to Angular. The checks in `localChecks` mirror the server's
 * structural and engine validation so authors get feedback immediately, but they are only a
 * convenience: the server's validation response is authoritative and is what gates publishing.
 */

export const LOCAL_CHECKS_LABEL = "local checks";

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export const HISTORY_CAP = 100;
export const COALESCE_WINDOW_MS = 600;

export interface EditHistory {
  /** Older snapshots, oldest first. Never longer than `HISTORY_CAP`. */
  past: readonly MappingDefinition[];
  present: MappingDefinition;
  /** Snapshots undone and not yet overwritten by a new edit, next redo first. */
  future: readonly MappingDefinition[];
  /** Field key of the last edit, used to merge rapid edits to the same field. */
  lastKey: string | null;
  lastAt: number;
}

export interface PushEditOptions {
  /** Identifies the edited field (for example `rule-1.sourcePath`). Omit for discrete actions. */
  key?: string;
  /** Milliseconds timestamp of the edit; injected so the logic stays deterministic. */
  now: number;
}

export function createHistory(spec: MappingDefinition): EditHistory {
  return { past: [], present: spec, future: [], lastKey: null, lastAt: 0 };
}

export function sameSpec(a: unknown, b: unknown): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

/**
 * Records `next` as the new present. Identical specs are ignored, a new edit clears the redo
 * stack, and consecutive edits to the same field inside the coalescing window replace the present
 * instead of adding a snapshot. A coalesced edit that lands back on the earlier snapshot removes it.
 */
export function pushEdit(history: EditHistory, next: MappingDefinition, options: PushEditOptions): EditHistory {
  if (sameSpec(next, history.present)) return history;

  const key = options.key ?? null;
  const last = history.past[history.past.length - 1];
  const coalesce =
    key !== null && key === history.lastKey && last !== undefined && options.now - history.lastAt < COALESCE_WINDOW_MS;

  if (coalesce) {
    const past = sameSpec(next, last) ? history.past.slice(0, -1) : history.past;
    return { past, present: next, future: [], lastKey: key, lastAt: options.now };
  }

  const past = [...history.past, history.present].slice(-HISTORY_CAP);
  return { past, present: next, future: [], lastKey: key, lastAt: options.now };
}

export function canUndo(history: EditHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditHistory): boolean {
  return history.future.length > 0;
}

export function undo(history: EditHistory): EditHistory {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo(history: EditHistory): EditHistory {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_CAP),
    present: next,
    future: rest,
    lastKey: null,
    lastAt: 0,
  };
}

/** True when the working spec differs from the last saved or published base. */
export function isDirty(spec: MappingDefinition, baseSpec: MappingDefinition | null): boolean {
  return baseSpec === null ? true : !sameSpec(spec, baseSpec);
}

/* -------------------------------------------------------------------------- */
/* Spec shape                                                                 */
/* -------------------------------------------------------------------------- */

export function blankSpec(name: string): MappingDefinition {
  return { id: name, name, version: "1.0.0", sourceFormat: "auto", targetFormat: "fhir-r4", rules: [] };
}

/* -------------------------------------------------------------------------- */
/* Bounded JSON editor helpers                                                */
/* -------------------------------------------------------------------------- */

export type JsonParamShape = "string-list" | "string-map" | "scalar-array";

export type JsonParamParse = { ok: true; value: unknown } | { ok: false; error: string };

export const JSON_PARAM_MAX_CHARS = 10_000;
export const JSON_PARAM_MAX_ITEMS = 100;

function tooLargeJsonError(): string {
  return "JSON is too large (limit 10,000 characters).";
}

function invalidJsonError(): string {
  return "Invalid JSON.";
}

function parseStringList(value: unknown): JsonParamParse {
  if (!Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON array of non-empty strings." };
  }
  if (value.length > JSON_PARAM_MAX_ITEMS) {
    return { ok: false, error: "A string list can have at most 100 items." };
  }
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    return { ok: false, error: "Every item must be a non-empty string." };
  }
  return { ok: true, value };
}

function parseStringMap(value: unknown): JsonParamParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON object whose values are strings." };
  }
  const entries = Object.entries(value);
  if (entries.length > JSON_PARAM_MAX_ITEMS) {
    return { ok: false, error: "A string map can have at most 100 keys." };
  }
  if (!entries.every(([, item]) => typeof item === "string")) {
    return { ok: false, error: "Every value must be a string." };
  }
  return { ok: true, value };
}

function parseScalarArray(value: unknown): JsonParamParse {
  if (!Array.isArray(value)) {
    return { ok: false, error: "Expected a JSON array of strings, finite numbers or booleans." };
  }
  if (value.length > JSON_PARAM_MAX_ITEMS) {
    return { ok: false, error: "A scalar list can have at most 100 items." };
  }
  const scalar = (item: unknown): boolean =>
    typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
  if (!value.every(scalar)) {
    return { ok: false, error: "Every item must be a string, finite number or boolean." };
  }
  return { ok: true, value };
}

/**
 * Parses text typed into a bounded JSON editor. Empty text means "no value" (value: undefined).
 * Never uses `eval` or `Function`; the parsed value is only shape-checked, not executed.
 */
export function parseJsonParam(text: string, shape: JsonParamShape): JsonParamParse {
  if (text.trim() === "") return { ok: true, value: undefined };
  if (text.length > JSON_PARAM_MAX_CHARS) return { ok: false, error: tooLargeJsonError() };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: invalidJsonError() };
  }

  switch (shape) {
    case "string-list":
      return parseStringList(value);
    case "string-map":
      return parseStringMap(value);
    case "scalar-array":
      return parseScalarArray(value);
  }
}

/** Pretty JSON for an editor, "" for undefined. */
export function formatJsonParam(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2) ?? "";
}

/** Parses a single condition value: empty -> undefined; valid JSON keeps its type; else the raw text. */
export function parseConditionLiteral(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Flags a plain-text default value that looks like JSON but does not parse. The value is still
 * stored exactly as typed (`parseDefaultValue` falls back to text); the server remains authoritative.
 */
export function defaultValueProblem(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "Invalid JSON. Plain text cannot start with { or [.";
  }
}

/**
 * Draft specs travel as `unknown`. Returns the spec when the editor can safely work on it: an object
 * whose `rules` is an array of objects. Anything else returns null and the page shows it as unreadable
 * instead of editing a shape it does not understand.
 */
export function parseSpec(value: unknown): MappingDefinition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rules = (value as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return null;
  }
  return value as MappingDefinition;
}

/* -------------------------------------------------------------------------- */
/* Rule edits                                                                 */
/* -------------------------------------------------------------------------- */

/** A patch where an `undefined` value removes the field from the rule. */
export type RulePatch = { [K in keyof MappingRule]?: MappingRule[K] | undefined };

const RULE_ID_PATTERN = /^rule-(\d+)$/;

export function nextRuleId(spec: MappingDefinition): string {
  const used = new Set(spec.rules.map((rule) => rule.id));
  let max = 0;
  for (const id of used) {
    const match = typeof id === "string" ? RULE_ID_PATTERN.exec(id) : null;
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  let n = max + 1;
  while (used.has(`rule-${n}`)) n++;
  return `rule-${n}`;
}

export function newRule(spec: MappingDefinition): MappingRule {
  return { id: nextRuleId(spec), sourcePath: "", targetPath: "", transform: "identity" };
}

export function addRule(spec: MappingDefinition, rule: MappingRule, index?: number): MappingDefinition {
  const at = index === undefined ? spec.rules.length : Math.max(0, Math.min(index, spec.rules.length));
  const rules = [...spec.rules.slice(0, at), rule, ...spec.rules.slice(at)];
  return { ...spec, rules };
}

export function removeRule(spec: MappingDefinition, ruleId: string): MappingDefinition {
  if (!spec.rules.some((rule) => rule.id === ruleId)) return spec;
  return { ...spec, rules: spec.rules.filter((rule) => rule.id !== ruleId) };
}

export function moveRule(spec: MappingDefinition, ruleId: string, toIndex: number): MappingDefinition {
  const from = spec.rules.findIndex((rule) => rule.id === ruleId);
  if (from < 0) return spec;
  const to = Math.max(0, Math.min(toIndex, spec.rules.length - 1));
  if (to === from) return spec;
  const rules = [...spec.rules];
  const [moved] = rules.splice(from, 1);
  if (moved === undefined) return spec;
  rules.splice(to, 0, moved);
  return { ...spec, rules };
}

export function updateRule(spec: MappingDefinition, ruleId: string, patch: RulePatch): MappingDefinition {
  const index = spec.rules.findIndex((rule) => rule.id === ruleId);
  const current = spec.rules[index];
  if (index < 0 || current === undefined) return spec;

  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const rules = [...spec.rules];
  rules[index] = next as unknown as MappingRule;
  return { ...spec, rules };
}

function isEmptyParam(value: unknown): boolean {
  if (value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length === 0;
  return false;
}

/** Sets one transform parameter. Empty values remove the key, and an empty `params` is dropped. */
export function setParam(spec: MappingDefinition, ruleId: string, key: string, value: unknown): MappingDefinition {
  const rule = spec.rules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) return spec;

  const params: Record<string, unknown> = { ...((rule.params as Record<string, unknown> | undefined) ?? {}) };
  if (isEmptyParam(value)) delete params[key];
  else params[key] = value;

  const next = Object.keys(params).length === 0 ? undefined : (params as MappingRule["params"]);
  return updateRule(spec, ruleId, { params: next });
}

/* -------------------------------------------------------------------------- */
/* Transform parameters                                                       */
/* -------------------------------------------------------------------------- */

export type ParamFieldKind = "string" | "number" | "boolean" | "string-list" | "string-map";

export interface ParamField {
  key: string;
  label: string;
  kind: ParamFieldKind;
  help: string;
  required?: boolean;
  /** What the engine uses when the parameter is absent, shown as a placeholder. */
  defaultText?: string;
}

const NO_PARAMS: readonly ParamField[] = [];

const PARAM_FIELDS: Record<TransformFunctionKind, readonly ParamField[]> = {
  identity: NO_PARAMS,
  uppercase: NO_PARAMS,
  lowercase: NO_PARAMS,
  trim: NO_PARAMS,
  parse_date_iso: [
    {
      key: "inputFormat",
      label: "Input format",
      kind: "string",
      defaultText: "auto",
      help: "Exact source date format, for example DD/MM/YYYY. Needed when day and month order is ambiguous.",
    },
  ],
  format_gender_fhir: [
    {
      key: "codes",
      label: "Code map",
      kind: "string-map",
      help: "Source code to FHIR administrative gender, for example M = male.",
    },
  ],
  concat: [
    {
      key: "paths",
      label: "Source paths",
      kind: "string-list",
      help: "Fields joined in order. When empty, the rule's own source value is used.",
    },
    { key: "separator", label: "Separator", kind: "string", defaultText: "(none)", help: "Text placed between parts." },
  ],
  split: [
    { key: "separator", label: "Separator", kind: "string", defaultText: ",", help: "Text to split the value on." },
    { key: "index", label: "Part index", kind: "number", defaultText: "0", help: "Zero-based part to keep." },
  ],
  number_to_string: [
    { key: "decimals", label: "Decimals", kind: "number", help: "Fixed number of decimal places." },
    {
      key: "decimalSeparator",
      label: "Decimal separator",
      kind: "string",
      defaultText: ".",
      help: "Character written between the integer and decimal parts.",
    },
  ],
  string_to_number: [
    {
      key: "decimalSeparator",
      label: "Decimal separator",
      kind: "string",
      defaultText: ".",
      help: "Character the source uses for decimals.",
    },
    {
      key: "thousandsSeparator",
      label: "Thousands separator",
      kind: "string",
      help: "Character removed before parsing.",
    },
    { key: "integer", label: "Integer only", kind: "boolean", help: "Reject values that are not whole numbers." },
  ],
  default_value: NO_PARAMS,
  to_reference: [
    {
      key: "type",
      label: "Resource type",
      kind: "string",
      defaultText: "Patient",
      help: "FHIR resource type written in the reference.",
    },
  ],
  codeable_concept: [
    {
      key: "system",
      label: "Code system",
      kind: "string",
      required: true,
      help: "Coding system URI, for example http://loinc.org.",
    },
    { key: "displayPath", label: "Display path", kind: "string", help: "Source path holding the display text." },
    { key: "textPath", label: "Text path", kind: "string", help: "Source path holding the concept text." },
    {
      key: "useCodeAsText",
      label: "Use code as text",
      kind: "boolean",
      help: "Fall back to the display text or code when no text path is set.",
    },
  ],
};

/** Parameters the engine reads for a transform. Unknown transforms have none. */
export function paramFields(transform: string): readonly ParamField[] {
  return (PARAM_FIELDS as Record<string, readonly ParamField[] | undefined>)[transform] ?? NO_PARAMS;
}

/** Only `default_value` reads `rule.defaultValue` as its source. */
export function usesDefaultValue(transform: string): boolean {
  return transform === "default_value";
}

/* -------------------------------------------------------------------------- */
/* Local checks                                                               */
/* -------------------------------------------------------------------------- */

const REQUIRED_TOP_LEVEL_FIELDS = ["id", "name", "version", "sourceFormat", "targetFormat"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Checks the editor can run without the server. They follow the server's structural and engine
 * validation (same codes and paths) and are labelled "local checks" in the UI. A clean result here
 * does not mean the server will accept the spec.
 */
export function localChecks(spec: MappingDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!nonEmptyString(spec[field])) {
      issues.push({
        code: "MAPPING_MISSING_FIELD",
        severity: "error",
        message: `Mapping definition field '${field}' is required`,
        path: field,
      });
    }
  }

  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  if (rules.length === 0) {
    issues.push({
      code: "MAPPING_EMPTY",
      severity: "error",
      message: `Mapping '${String(spec.id ?? "")}' defines no rules`,
    });
    return issues;
  }

  const ruleIds = new Set<string>();
  const targetPaths = new Map<string, string>();
  const knownTransforms: readonly string[] = MAPPING_TRANSFORM_KINDS;

  rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    const ruleId = nonEmptyString(rule.id) ? rule.id : undefined;
    const withRuleId = ruleId !== undefined ? { ruleId } : {};

    if (ruleId === undefined) {
      issues.push({
        code: "MAPPING_RULE_MISSING_FIELD",
        severity: "error",
        message: "Rule field 'id' is required",
        path: `${at}.id`,
      });
    } else {
      if (ruleIds.has(ruleId)) {
        issues.push({
          code: "MAPPING_DUPLICATE_RULE_ID",
          severity: "error",
          message: `Duplicate rule id '${ruleId}'`,
          path: `${at}.id`,
          ruleId,
        });
      }
      ruleIds.add(ruleId);
    }

    const label = ruleId ?? at;

    if (!nonEmptyString(rule.sourcePath)) {
      issues.push({
        code: "MAPPING_MISSING_SOURCE_PATH",
        severity: "error",
        message: `Rule '${label}' has no sourcePath`,
        path: `${at}.sourcePath`,
        ...withRuleId,
      });
    }

    if (!nonEmptyString(rule.targetPath)) {
      issues.push({
        code: "MAPPING_MISSING_TARGET_PATH",
        severity: "error",
        message: `Rule '${label}' has no targetPath`,
        path: `${at}.targetPath`,
        ...withRuleId,
      });
    }

    if (!knownTransforms.includes(rule.transform)) {
      issues.push({
        code: "MAPPING_UNKNOWN_TRANSFORM",
        severity: "error",
        message: `Rule '${label}' uses unknown transform '${String(rule.transform)}'`,
        path: `${at}.transform`,
        advice: `Supported transforms: ${knownTransforms.join(", ")}`,
        ...withRuleId,
      });
    }

    if (rule.transform === "default_value" && rule.defaultValue === undefined) {
      issues.push({
        code: "MAPPING_MISSING_DEFAULT_VALUE",
        severity: "error",
        message: `Rule '${label}' uses default_value without rule.defaultValue`,
        path: `${at}.defaultValue`,
        ...withRuleId,
      });
    }

    if (rule.transform === "codeable_concept") {
      const system = (rule.params as Record<string, unknown> | undefined)?.["system"];
      if (!nonEmptyString(system)) {
        issues.push({
          code: "CODEABLE_CONCEPT_WITHOUT_SYSTEM",
          severity: "warning",
          message: `Rule '${label}' uses codeable_concept without params.system; every value will be rejected at run time`,
          path: `${at}.params.system`,
          ...withRuleId,
        });
      }
    }

    if (nonEmptyString(rule.targetPath)) {
      const existing = targetPaths.get(rule.targetPath);
      if (existing !== undefined) {
        issues.push({
          code: "MAPPING_DUPLICATE_TARGET",
          severity: "warning",
          message: `Target path '${rule.targetPath}' is written by rules '${existing}' and '${label}'`,
          path: `${at}.targetPath`,
          ...withRuleId,
        });
      } else {
        targetPaths.set(rule.targetPath, label);
      }
    }

    (rule.when ?? []).forEach((condition, j) => {
      if (!nonEmptyString(condition.path)) {
        issues.push({
          code: "MAPPING_INVALID_CONDITION",
          severity: "error",
          message: `Rule '${label}' has a condition without a path`,
          path: `${at}.when[${j}].path`,
          ...withRuleId,
        });
      }
    });
  });

  return issues;
}

/** True when any issue would stop the server from accepting the spec. */
export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error" || issue.severity === "fatal");
}
