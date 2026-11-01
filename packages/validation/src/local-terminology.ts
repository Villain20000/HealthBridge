/**
 * Local code-table terminology provider — licence-safe terminology depth (ROADMAP Phase F).
 *
 * Licensed clinical code systems (LOINC, SNOMED CT, ICD, RxNorm, ATC) are never
 * bundled: the operator supplies versioned code tables as CSV or JSON files,
 * and every table MUST declare `system`, `version` and `licence` metadata.
 * Tables without a declared licence are refused with an explicit
 * `LOCAL_TERMINOLOGY_LICENCE_MISSING` error — that refusal is the licence
 * gate, not a bundled codeset.
 *
 * The table `version` is recorded in every validation reason this provider
 * produces, so validation traces stay attributable to the exact table
 * edition that was consulted.
 *
 * Supported operator file shapes:
 *
 * JSON (`parseLocalCodeTableJson`):
 * ```json
 * {
 *   "system": "http://example.org/synthetic-test-only",
 *   "version": "2026-10-31-test",
 *   "licence": "operator licence text, e.g. LOINC licence terms accepted separately",
 *   "codes": [{ "code": "AAA", "display": "Alpha A" }]
 * }
 * ```
 *
 * CSV (`parseLocalCodeTableCsv`): metadata rides in `# key: value` comment
 * lines, then a header row with a mandatory `code` column and an optional
 * `display` column (comma-separated; double-quoted fields supported):
 * ```csv
 * # system: http://example.org/synthetic-test-only
 * # version: 2026-10-31-test
 * # licence: operator licence text
 * code,display
 * AAA,Alpha A
 * ```
 *
 * Matching is exact (case-sensitive) for both systems and codes — ambiguity
 * is reported, never resolved by guessing. `display` values are informational
 * only and are never validated against the input.
 */

import type { ValidationIssue } from "@healthbridge/shared-types";
import type { TerminologyProvider } from "./index.js";

/** Provider name used for level-5 attribution in `validateWithDetail`. */
export const LOCAL_TERMINOLOGY_PROVIDER_NAME = "local-code-table-terminology";
/** Version of this provider module (not a code-system edition). */
export const LOCAL_TERMINOLOGY_PROVIDER_VERSION = "1.0.0";

/** One row of an operator-supplied code table. */
export interface LocalCodeTableEntry {
  code: string;
  display?: string;
}

/** Mandatory metadata every operator-supplied table must declare. */
export interface LocalCodeTableMetadata {
  /** Code-system URI the table covers, e.g. `http://loinc.org`. */
  system: string;
  /** Table edition, e.g. `2.80` — recorded in every validation reason. */
  version: string;
  /** Licence under which the operator holds this table — never empty. */
  licence: string;
}

/** A parsed operator-supplied code table: metadata plus entries. */
export interface LocalCodeTable {
  metadata: LocalCodeTableMetadata;
  entries: LocalCodeTableEntry[];
}

/** Machine codes for every refusal this module raises. */
export const LOCAL_TERMINOLOGY_ERROR_CODES = [
  "LOCAL_TERMINOLOGY_LICENCE_MISSING",
  "LOCAL_TERMINOLOGY_SYSTEM_MISSING",
  "LOCAL_TERMINOLOGY_VERSION_MISSING",
  "LOCAL_TERMINOLOGY_MALFORMED",
] as const;

/** Refusal raised for undeclared licences, missing metadata or malformed tables. */
export class LocalTerminologyError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalTerminologyError";
    this.code = code;
  }
}

function readNonEmptyString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Parse an operator-supplied JSON code table. Throws {@link LocalTerminologyError}
 * when `licence` (or `system`/`version`) is missing or blank, or when the
 * payload is malformed. `licence` additionally accepts the `license` spelling.
 */
export function parseLocalCodeTableJson(text: string): LocalCodeTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_MALFORMED",
      `Local code table is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_MALFORMED",
      "Local code table JSON must be an object with system/version/licence metadata and a codes array",
    );
  }
  const record = parsed as Record<string, unknown>;
  const system = readNonEmptyString(record, ["system"]);
  if (!system) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_SYSTEM_MISSING",
      "Refused local code table: table metadata declares no `system` (every table must name the code system it covers)",
    );
  }
  const version = readNonEmptyString(record, ["version"]);
  if (!version) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_VERSION_MISSING",
      `Refused local code table for system '${system}': table metadata declares no \`version\` (every table must be versioned)`,
    );
  }
  const licence = readNonEmptyString(record, ["licence", "license"]);
  if (!licence) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_LICENCE_MISSING",
      `Refused local code table for system '${system}' version '${version}': table metadata declares no \`licence\` (licensed code systems stay licence-aware by refusing unlicensed tables; the operator must declare the licence they hold)`,
    );
  }
  if (!Array.isArray(record.codes)) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_MALFORMED",
      `Local code table for system '${system}' must carry a \`codes\` array of { code, display? } entries`,
    );
  }
  const entries: LocalCodeTableEntry[] = record.codes.map((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LocalTerminologyError(
        "LOCAL_TERMINOLOGY_MALFORMED",
        `Local code table for system '${system}': entry ${index + 1} is not an object`,
      );
    }
    const code = (entry as Record<string, unknown>).code;
    if (typeof code !== "string" || code.trim() === "") {
      throw new LocalTerminologyError(
        "LOCAL_TERMINOLOGY_MALFORMED",
        `Local code table for system '${system}': entry ${index + 1} has no usable \`code\``,
      );
    }
    const display = (entry as Record<string, unknown>).display;
    return {
      code: code.trim(),
      ...(typeof display === "string" && display.trim() !== "" ? { display: display.trim() } : {}),
    };
  });
  return { metadata: { system, version, licence }, entries };
}

/** Split one comma-separated line honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse an operator-supplied CSV code table. Metadata rides in `# key: value`
 * comment lines (`system`, `version`, `licence` — `license` also accepted);
 * `fallbackMetadata` fills gaps the file leaves open. Throws
 * {@link LocalTerminologyError} when the merged metadata still lacks a
 * licence (or system/version), or when the rows are malformed.
 */
export function parseLocalCodeTableCsv(
  text: string,
  fallbackMetadata?: Partial<LocalCodeTableMetadata>,
): LocalCodeTable {
  const fromFile: Record<string, string> = {};
  const rows: string[] = [];
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      const separator = body.indexOf(":");
      if (separator !== -1) {
        const key = body.slice(0, separator).trim().toLowerCase();
        const value = body.slice(separator + 1).trim();
        if ((key === "system" || key === "version" || key === "licence" || key === "license") && value !== "") {
          fromFile[key === "license" ? "licence" : key] = value;
        }
      }
      continue;
    }
    rows.push(rawLine);
  }
  if (rows.length === 0) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_MALFORMED",
      "Local code table CSV has no header row (expected a `code` column with an optional `display` column)",
    );
  }
  const header = splitCsvLine(rows[0]).map((name) => name.toLowerCase());
  const codeIndex = header.indexOf("code");
  if (codeIndex === -1) {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_MALFORMED",
      "Local code table CSV header must contain a `code` column",
    );
  }
  const displayIndex = header.indexOf("display");
  const entries: LocalCodeTableEntry[] = [];
  for (let row = 1; row < rows.length; row++) {
    const fields = splitCsvLine(rows[row]);
    const code = (fields[codeIndex] ?? "").trim();
    if (code === "") {
      throw new LocalTerminologyError(
        "LOCAL_TERMINOLOGY_MALFORMED",
        `Local code table CSV row ${row + 1} has an empty code value`,
      );
    }
    const display = displayIndex === -1 ? "" : (fields[displayIndex] ?? "").trim();
    entries.push({ code, ...(display !== "" ? { display } : {}) });
  }
  const merged: LocalCodeTableMetadata = {
    system: fromFile.system ?? fallbackMetadata?.system?.trim() ?? "",
    version: fromFile.version ?? fallbackMetadata?.version?.trim() ?? "",
    licence: fromFile.licence ?? fallbackMetadata?.licence?.trim() ?? "",
  };
  if (merged.system === "") {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_SYSTEM_MISSING",
      "Refused local code table CSV: no `system` declared (add a `# system: <uri>` comment or pass fallback metadata)",
    );
  }
  if (merged.version === "") {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_VERSION_MISSING",
      `Refused local code table CSV for system '${merged.system}': no \`version\` declared (add a \`# version: <edition>\` comment or pass fallback metadata)`,
    );
  }
  if (merged.licence === "") {
    throw new LocalTerminologyError(
      "LOCAL_TERMINOLOGY_LICENCE_MISSING",
      `Refused local code table CSV for system '${merged.system}' version '${merged.version}': no \`licence\` declared (licensed code systems stay licence-aware by refusing unlicensed tables; the operator must declare the licence they hold)`,
    );
  }
  return { metadata: merged, entries };
}

/**
 * Licence-aware {@link TerminologyProvider} over operator-supplied versioned
 * code tables. Ships no codesets: every table (and its licence) comes from
 * the operator. Tables without a declared licence are refused at construction.
 */
export class LocalCodeTableProvider implements TerminologyProvider {
  public readonly name: string;
  public readonly licence: string;
  private readonly tables = new Map<
    string,
    { metadata: LocalCodeTableMetadata; codes: Map<string, string | undefined> }
  >();

  constructor(tables: LocalCodeTable[], options?: { name?: string }) {
    for (const table of tables) {
      const system = table?.metadata?.system?.trim() ?? "";
      const version = table?.metadata?.version?.trim() ?? "";
      const licence = table?.metadata?.licence?.trim() ?? "";
      if (system === "") {
        throw new LocalTerminologyError(
          "LOCAL_TERMINOLOGY_SYSTEM_MISSING",
          "Refused local code table: table metadata declares no `system`",
        );
      }
      if (version === "") {
        throw new LocalTerminologyError(
          "LOCAL_TERMINOLOGY_VERSION_MISSING",
          `Refused local code table for system '${system}': table metadata declares no \`version\``,
        );
      }
      if (licence === "") {
        throw new LocalTerminologyError(
          "LOCAL_TERMINOLOGY_LICENCE_MISSING",
          `Refused local code table for system '${system}' version '${version}': table metadata declares no \`licence\``,
        );
      }
      const codes = new Map<string, string | undefined>();
      for (const entry of table.entries ?? []) {
        // Duplicate codes resolve last-wins; tables are operator-owned and validated at load.
        codes.set(entry.code, entry.display);
      }
      // Duplicate systems resolve last-wins so re-supplied editions replace older ones.
      this.tables.set(system, { metadata: { system, version, licence }, codes });
    }
    this.name = options?.name?.trim() !== "" && options?.name ? options.name.trim() : LOCAL_TERMINOLOGY_PROVIDER_NAME;
    const licences = [...new Set([...this.tables.values()].map((table) => table.metadata.licence))];
    this.licence =
      licences.length > 0
        ? licences.join("; ")
        : "no local code tables loaded (operator must supply licence-declared tables; licensed code systems are never bundled)";
  }

  /** Metadata-only summary of loaded tables (systems/versions/licences/counts — never code values). */
  public describeTables(): Array<{ system: string; version: string; licence: string; codeCount: number }> {
    return [...this.tables.values()].map((table) => ({
      system: table.metadata.system,
      version: table.metadata.version,
      licence: table.metadata.licence,
      codeCount: table.codes.size,
    }));
  }

  public validateCode(params: { system?: string; code?: string; display?: string; path?: string }): {
    valid: boolean;
    issues: ValidationIssue[];
  } {
    const loaded =
      this.tables.size > 0
        ? `loaded local tables: ${[...this.tables.values()].map((t) => `${t.metadata.system}@${t.metadata.version}`).join(", ")}`
        : "no local code tables loaded";
    if (!params.system || !params.code) {
      return {
        valid: false,
        issues: [
          {
            code: "INCOMPLETE_CODING",
            severity: "warning",
            message: `Coding needs both a system and a code for terminology lookup (${loaded})`,
            path: params.path,
          },
        ],
      };
    }
    const table = this.tables.get(params.system);
    if (!table) {
      return {
        valid: false,
        issues: [
          {
            code: "UNKNOWN_CODE_SYSTEM",
            severity: "warning",
            message: `Code system '${params.system}' is not covered by any operator-supplied local table (${loaded})`,
            path: params.path,
          },
        ],
      };
    }
    if (!table.codes.has(params.code)) {
      return {
        valid: false,
        issues: [
          {
            code: "UNKNOWN_CODE",
            severity: "warning",
            message: `Code '${params.code}' is not a known code in '${table.metadata.system}' (local table version '${table.metadata.version}', licence '${table.metadata.licence}')`,
            path: params.path,
          },
        ],
      };
    }
    return { valid: true, issues: [] };
  }
}
