import type { ValidationIssue } from "@healthbridge/shared-types";

/**
 * Validation Centre presentation logic.
 *
 * Pure and framework-free so it is unit-testable with `node:test` (see
 * `apps/web/test/validation-centre.test.ts`). It only derives views from already-stored
 * run payloads — `GET /runs/:id` (`run.validation`) and `GET /runs/:id/issues` — and never
 * calls the API itself. The page that uses it is strictly read-only.
 *
 * Level semantics (from `@healthbridge/transformation-engine`): levels 1-3
 * (`source-structural`, `mapping-definition`, `target-structural`) execute in the pipeline;
 * levels 4-6 (`profile`, `terminology`, `referential-integrity`) execute only when a
 * validator or provider is injected (MIABIS validators, external FHIR validator,
 * operator-supplied code tables); otherwise they are reported as skipped.
 * A skipped level is never a pass.
 */

export type ValidationLevelStatus = "executed" | "skipped";

export interface ValidationLevelView {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  status: ValidationLevelStatus;
  /** Validator that produced the level, present only when executed. */
  validator: string | null;
  /** Why the level did not run, present only when skipped. */
  reason: string | null;
}

/** Subset of the stored `ValidationReport` the console actually renders. */
export interface StoredValidationReport {
  standard?: unknown;
  isValid?: unknown;
  levels?: unknown;
  issues?: unknown;
}

/**
 * Exact verdict wording for a level that did not run. Rendered verbatim by the page so a
 * skipped level can never be mistaken for a pass.
 */
export const SKIPPED_VERDICT = "Not run, never passed";

/** Full sentence for a skipped level card, with the stored reason appended when present. */
export function skippedNotice(level: Pick<ValidationLevelView, "level" | "name" | "reason">): string {
  const base =
    `Level ${level.level} (${level.name}) was not run for this stored run, ` +
    `so it ${SKIPPED_VERDICT.toLowerCase()}. No findings could be produced at this level.`;
  return level.reason ? `${base} ${level.reason}` : base;
}

/** Overall verdict for the summary card. Anything ambiguous stays `unknown`, never `valid`. */
export function verdictLabel(isValid: unknown): "valid" | "invalid" | "unknown" {
  if (isValid === true) return "valid";
  if (isValid === false) return "invalid";
  return "unknown";
}

/** Chip tone for a level status. Executed is neutral-ok; skipped is muted, never an error. */
export function levelTone(status: ValidationLevelStatus): "ok" | "muted" {
  return status === "executed" ? "ok" : "muted";
}

/** Chip tone for an issue severity. Mirrors the run-detail issues tab. */
export function severityTone(severity: string): "danger" | "warn" | "info" {
  if (severity === "fatal" || severity === "error") return "danger";
  if (severity === "warning") return "warn";
  return "info";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanLevelNumber(value: unknown): ValidationLevelView["level"] | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value >= 1 && value <= 6) return value as ValidationLevelView["level"];
  return null;
}

/**
 * Defensive view of `run.validation.levels`. Unknown shapes are dropped, never thrown over:
 * a report that is missing or malformed yields an empty list and the page shows its
 * "no validation report stored" empty state instead of inventing levels.
 */
export function normaliseLevels(report: unknown): ValidationLevelView[] {
  if (!isRecord(report) || !Array.isArray(report["levels"])) return [];
  const seen = new Set<number>();
  const views: ValidationLevelView[] = [];
  for (const entry of report["levels"]) {
    if (!isRecord(entry)) continue;
    const level = cleanLevelNumber(entry["level"]);
    if (level === null || seen.has(level)) continue;
    seen.add(level);
    const executed = entry["status"] === "executed";
    views.push({
      level,
      name: cleanText(entry["name"]) ?? `level-${level}`,
      status: executed ? "executed" : "skipped",
      validator: executed ? cleanText(entry["validator"]) : null,
      // A skipped level without a stored reason still names the gap generically; an
      // executed level never carries a reason.
      reason: executed ? null : (cleanText(entry["reason"]) ?? "The stored report gives no reason."),
    });
  }
  views.sort((a, b) => a.level - b.level);
  return views;
}

/** Stored `validation.issues`: the engine fills this channel with level-3 findings only. */
export function normaliseReportIssues(report: unknown): ValidationIssue[] {
  if (!isRecord(report) || !Array.isArray(report["issues"])) return [];
  return report["issues"].filter((issue): issue is ValidationIssue => isRecord(issue));
}

export function executedLevels(levels: ValidationLevelView[]): ValidationLevelView[] {
  return levels.filter((level) => level.status === "executed");
}

export function skippedLevels(levels: ValidationLevelView[]): ValidationLevelView[] {
  return levels.filter((level) => level.status === "skipped");
}

export function summariseLevels(levels: ValidationLevelView[]): {
  total: number;
  executed: number;
  skipped: number;
} {
  const executed = executedLevels(levels).length;
  return { total: levels.length, executed, skipped: levels.length - executed };
}

/** Stable identity for matching the same issue across the two stored issue channels. */
export function issueKey(issue: ValidationIssue): string {
  return [issue.severity, issue.code, issue.message, issue.recordIndex, issue.path, issue.location]
    .map((part) => (part === undefined || part === null ? "" : String(part)))
    .join("|");
}

export interface PartitionedIssues {
  /**
   * Issues from the report's own `validation.issues` channel — the engine writes only
   * level-3 (target-structural) findings there.
   */
  levelIssues: ValidationIssue[];
  /**
   * Every other stored run issue (source-structural, mapping-definition, build). The engine
   * does not tag these per level, so levels 1 and 2 honestly share this one list instead of
   * splitting it by guesswork.
   */
  earlierIssues: ValidationIssue[];
}

/**
 * Splits the run issue list (`summary.issues`, via `GET /runs/:id/issues`) into the level-3
 * channel and everything earlier. Multiset-aware: duplicate issues are only removed as many
 * times as they appear in the level channel.
 */
export function partitionIssues(allIssues: ValidationIssue[], reportIssues: ValidationIssue[]): PartitionedIssues {
  const remaining = new Map<string, number>();
  for (const issue of reportIssues) {
    const key = issueKey(issue);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const levelIssues: ValidationIssue[] = [];
  const earlierIssues: ValidationIssue[] = [];
  for (const issue of allIssues) {
    const key = issueKey(issue);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      levelIssues.push(issue);
    } else {
      earlierIssues.push(issue);
    }
  }
  return { levelIssues, earlierIssues };
}

/**
 * Issue list for one level card. Skipped levels have no list — the card renders
 * {@link SKIPPED_VERDICT} instead. Levels 1 and 2 share the earlier-issues list (see
 * {@link PartitionedIssues}); level 3 gets the report-issues channel.
 */
export function issuesForLevel(
  level: Pick<ValidationLevelView, "level" | "status">,
  partitioned: PartitionedIssues,
): ValidationIssue[] {
  if (level.status === "skipped") return [];
  if (level.level === 3) return partitioned.levelIssues;
  if (level.level === 1 || level.level === 2) return partitioned.earlierIssues;
  return [];
}
