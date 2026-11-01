/**
 * OMOP CDM staging-subset adapter — person / measurement / specimen CSV extracts
 * (observation and condition_occurrence are tolerated structurally).
 *
 * Status is honestly `metadata-only`: clinical rows are carried structurally
 * (verbatim CSV cells) with one envelope per row, SHA-256 checksum and
 * provenance. This is a staging subset only — no OHDSI validation is claimed,
 * no vocabulary / ATHENA lookup is performed, and concept_ids are carried
 * verbatim with an UNMAPPED_CONCEPT warning channel, never clinically
 * interpreted. Malformed rows are reported via `ParseContext.onIssue` and
 * skipped — never swallowed silently.
 */

import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  MedicalDomain,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";
import { buildCsvRecords, decodeBuffer, readCsvTable } from "./csv.js";

export const OMOP_ADAPTER_ID = "omop-adapter";
export const OMOP_ADAPTER_VERSION = "1.0.0";

export type OmopTable = "person" | "measurement" | "specimen" | "observation" | "condition_occurrence";

const OMOP_TABLES: readonly OmopTable[] = ["person", "measurement", "specimen", "observation", "condition_occurrence"];

/** Row-identity column per OMOP table (staging subset). */
const PRIMARY_ID: Record<OmopTable, string> = {
  person: "person_id",
  measurement: "measurement_id",
  specimen: "specimen_id",
  observation: "observation_id",
  condition_occurrence: "condition_occurrence_id",
};

/** Columns that must be present and non-empty for a row to yield an envelope. */
const REQUIRED_FIELDS: Record<OmopTable, string[]> = {
  person: ["person_id"],
  measurement: ["measurement_id", "person_id"],
  specimen: ["specimen_id", "person_id"],
  observation: ["observation_id", "person_id"],
  condition_occurrence: ["condition_occurrence_id", "person_id"],
};

const TABLE_DOMAINS: Record<OmopTable, MedicalDomain> = {
  person: "research",
  measurement: "research",
  specimen: "biobanking",
  observation: "research",
  condition_occurrence: "research",
};

function readInputText(input: InputDescriptor): { text: string; encoding: string; warnings: string[] } {
  if (input.contentString !== undefined) {
    const text = input.contentString.charCodeAt(0) === 0xfeff ? input.contentString.slice(1) : input.contentString;
    return { text, encoding: "utf-8", warnings: [] };
  }
  if (input.buffer) return decodeBuffer(input.buffer);
  return { text: "", encoding: "utf-8", warnings: ["Input has neither contentString nor buffer"] };
}

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

/** Lower-cased file basename without its extension (`PERSON.csv` -> `person`). */
function tableBasename(input: InputDescriptor): string {
  const name = input.filename ?? input.uri ?? "";
  const base = name.split(/[\\/]/).pop() ?? "";
  return base
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .trim()
    .toLowerCase();
}

function parseTableName(value: string): OmopTable | undefined {
  const normalised = value.trim().toLowerCase();
  return OMOP_TABLES.includes(normalised as OmopTable) ? (normalised as OmopTable) : undefined;
}

function normaliseHeaderCells(headers: string[]): string[] {
  return headers.map((h) =>
    h
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * Resolve the OMOP table from header evidence. Concept-id columns are the
 * primary discriminator; a bare `person_id` only resolves `person` together
 * with another person-table marker (or an explicit `person` filename, handled
 * by the caller), so generic `person_id` CSVs are never claimed by headers.
 */
export function identifyOmopTable(headers: string[]): OmopTable | undefined {
  const set = new Set(normaliseHeaderCells(headers));
  if (set.has("measurement_concept_id")) return "measurement";
  if (set.has("specimen_concept_id")) return "specimen";
  if (set.has("observation_concept_id")) return "observation";
  if (set.has("condition_concept_id")) return "condition_occurrence";
  if (
    set.has("person_id") &&
    (set.has("gender_concept_id") ||
      set.has("year_of_birth") ||
      set.has("race_concept_id") ||
      set.has("ethnicity_concept_id"))
  ) {
    return "person";
  }
  return undefined;
}

/** Any `*_concept_id` column: carried verbatim, reported, never resolved. */
export function isConceptColumn(header: string): boolean {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .endsWith("_concept_id");
}

function headerLookup(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers) {
    const key = header
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase();
    if (!map.has(key)) map.set(key, header);
  }
  return map;
}

function cellOf(data: Record<string, unknown>, lookup: Map<string, string>, column: string): string {
  const actual = lookup.get(column);
  const raw = actual !== undefined ? data[actual] : undefined;
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

export class OmopFormatAdapter implements MedicalFormatAdapter {
  public id = OMOP_ADAPTER_ID;
  public version = OMOP_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "omop",
      version: OMOP_ADAPTER_VERSION,
      description:
        "OMOP CDM staging-subset adapter: person/measurement/specimen CSV extracts " +
        "(observation/condition_occurrence tolerated) carried structurally, one envelope per clinical row",
      extensions: [".csv"],
      mimeTypes: ["text/csv"],
      status: "metadata-only",
      limitations: [
        "Staging subset only: person, measurement and specimen semantics are carried structurally; " +
          "observation and condition_occurrence are tolerated structurally. No OHDSI validation is claimed.",
        "No vocabulary/ATHENA lookup is performed: concept_ids are carried verbatim and reported via " +
          "the UNMAPPED_CONCEPT warning channel, never clinically interpreted.",
        "No clinical interpretation is performed (no diagnoses, triage or treatment advice).",
        "Only single-table CSV extracts are parsed; multi-table exports must be split one file per table.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: false,
        transformToFHIR: false,
        validateFormat: true,
        exportOriginal: true,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    const filenameTable = parseTableName(tableBasename(input));
    let text: string | undefined;
    try {
      if (input.contentString !== undefined) {
        text = input.contentString;
      } else if (input.buffer) {
        text = decodeBuffer(input.buffer).text;
      }
    } catch {
      return filenameTable ? 0.6 : 0;
    }
    if (text === undefined || text.trim() === "") return filenameTable ? 0.6 : 0;
    let headers: string[];
    try {
      headers = readCsvTable({ contentString: text }).headers;
    } catch {
      return filenameTable ? 0.6 : 0;
    }
    const normalised = new Set(normaliseHeaderCells(headers));
    const headerTable = identifyOmopTable(headers);
    if (headerTable && headerTable === filenameTable) return 0.95;
    if (headerTable) return 0.8;
    if (filenameTable) {
      const primary = PRIMARY_ID[filenameTable].toLowerCase();
      if (normalised.has(primary)) return 0.7;
      if (normalised.has("person_id")) return 0.55;
    }
    void fileExtension(input);
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    const filenameTable = parseTableName(tableBasename(input));
    let table: OmopTable | undefined;
    let headers: string[] = [];
    let rowCount = 0;
    let sampleRecords: Array<Record<string, unknown>> = [];
    const tableWarnings: string[] = [];
    if (text.trim() !== "") {
      try {
        const csv = readCsvTable({ contentString: text });
        headers = csv.headers;
        tableWarnings.push(...csv.warnings);
        table =
          identifyOmopTable(headers) ??
          (filenameTable && new Set(normaliseHeaderCells(headers)).has(PRIMARY_ID[filenameTable].toLowerCase())
            ? filenameTable
            : undefined);
        rowCount = csv.rows.length;
        const { records } = buildCsvRecords(csv);
        sampleRecords = records.slice(0, 5).map((r) => {
          const { __extra, ...rest } = r.data as Record<string, unknown> & { __extra?: unknown };
          void __extra;
          return rest as Record<string, unknown>;
        });
        const conceptValues = new Map<string, Set<string>>();
        for (const record of records) {
          for (const header of headers) {
            if (!isConceptColumn(header)) continue;
            const value = String((record.data as Record<string, unknown>)[header] ?? "").trim();
            if (value === "") continue;
            if (!conceptValues.has(header)) conceptValues.set(header, new Set());
            conceptValues.get(header)?.add(value);
          }
        }
        const distinct = [...conceptValues.values()].reduce((sum, values) => sum + values.size, 0);
        if (distinct > 0) {
          tableWarnings.push(
            `unmapped concepts (verbatim, no vocabulary lookup): ${distinct} distinct value(s) across ${conceptValues.size} column(s)`,
          );
        }
      } catch {
        tableWarnings.push("Content could not be read as a CSV table");
      }
    }

    return {
      format: "omop",
      formatVersion: table ?? "unknown",
      domain: table ? TABLE_DOMAINS[table] : "unknown",
      recordCount: rowCount,
      detectedSchema: {
        fields: headers.map((name) => ({
          name,
          type: "string",
          sampleValues: sampleRecords.slice(0, 3).map((r) => r[name]),
          nullable: true,
        })),
      },
      sampleRecords,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${encoding}`,
        table ? `OMOP table: ${table}` : "No OMOP CDM table recognised (expected person/measurement/specimen headers)",
        filenameTable ? `filename table hint: ${filenameTable}` : "filename carries no OMOP table hint",
        `tables: ${table ? 1 : 0}, rows: ${rowCount}`,
        ...tableWarnings,
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding, warnings } = readInputText(input);
    for (const warning of warnings) {
      context.onIssue?.({ code: "OMOP_DECODING_WARNING", severity: "warning", message: warning });
    }
    if (text.trim() === "") {
      context.onIssue?.({
        code: "OMOP_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }
    const filenameTable = parseTableName(tableBasename(input));
    let csv: ReturnType<typeof readCsvTable>;
    try {
      csv = readCsvTable({ contentString: text });
    } catch {
      context.onIssue?.({
        code: "OMOP_UNREADABLE_TABLE",
        severity: "error",
        message: "Content could not be read as a CSV table; nothing was parsed",
      });
      return;
    }
    for (const warning of csv.warnings) {
      context.onIssue?.({ code: "OMOP_TABLE_WARNING", severity: "warning", message: warning });
    }
    const normalised = new Set(normaliseHeaderCells(csv.headers));
    const table =
      identifyOmopTable(csv.headers) ??
      (filenameTable && normalised.has(PRIMARY_ID[filenameTable].toLowerCase()) ? filenameTable : undefined) ??
      (filenameTable && normalised.has("person_id") ? filenameTable : undefined);
    if (!table) {
      context.onIssue?.({
        code: "OMOP_UNRECOGNIZED_TABLE",
        severity: "error",
        message:
          "Headers match no OMOP CDM staging table (expected person_id, measurement_concept_id, " +
          "specimen_concept_id, observation_concept_id or condition_concept_id); nothing was parsed",
      });
      return;
    }

    const lookup = headerLookup(csv.headers);
    const conceptColumns = csv.headers.filter(isConceptColumn);
    const checksum = computeChecksum(input);
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
    const seenConcepts = new Set<string>();
    const { records } = buildCsvRecords(csv);
    let recordIndex = 0;

    for (const record of records) {
      if (recordIndex >= limit) return;
      const data = record.data as Record<string, unknown> & { __extra?: unknown };
      const lineNumber = record.lineNumber;
      for (const issue of record.issues) {
        context.onIssue?.({
          code: "OMOP_RAGGED_ROW",
          severity: "warning",
          message: `${issue.message}; row carried with missing cells as empty and extra cells preserved`,
          location: `line ${lineNumber}`,
          recordIndex,
        });
      }

      const missing = REQUIRED_FIELDS[table].filter((column) => cellOf(data, lookup, column) === "");
      if (missing.length > 0) {
        context.onIssue?.({
          code: "OMOP_MISSING_REQUIRED_FIELD",
          severity: "error",
          message:
            `Row is missing required ${missing.join(", ")} for OMOP table '${table}' ` +
            `and was skipped (reported, never swallowed)`,
          location: `line ${lineNumber}`,
          recordIndex,
          offendingValue: missing.join(","),
        });
        continue;
      }

      const rowId = cellOf(data, lookup, PRIMARY_ID[table]);
      const personId = cellOf(data, lookup, "person_id");
      const conceptIds: Record<string, string> = {};
      for (const column of conceptColumns) {
        const value = String(data[column] ?? "").trim();
        if (value === "") continue;
        const key = column.replace(/^\uFEFF/, "").trim();
        conceptIds[key] = value;
        const seenKey = `${key}=${value}`;
        if (!seenConcepts.has(seenKey)) {
          seenConcepts.add(seenKey);
          context.onIssue?.({
            code: "OMOP_UNMAPPED_CONCEPT",
            severity: "warning",
            message:
              `Concept ${key} value '${value}' carried verbatim; no vocabulary/ATHENA lookup ` +
              `performed and no OHDSI validation claimed`,
            location: `line ${lineNumber}`,
            recordIndex,
            offendingValue: value,
          });
        }
      }

      const { __extra, ...rowData } = data;
      void __extra;
      const rowIssues: ValidationIssue[] = record.issues.map((issue) => ({
        code: "OMOP_RAGGED_ROW",
        severity: "warning" as const,
        message: issue.message,
        location: `line ${lineNumber}`,
        recordIndex,
      }));

      yield createCanonicalEnvelope({
        id: rowId !== "" ? `omop-${table}-${rowId}` : `omop-${table}-row-${recordIndex}`,
        domain: TABLE_DOMAINS[table],
        sourceFormat: "omop",
        formatVersion: table,
        content: { kind: "structured", data: rowData as Record<string, unknown> },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex,
        sourceLocation: `line ${lineNumber}`,
        filename: input.filename,
        checksum,
        encoding,
        metadata: {
          omopTable: table,
          rowId: rowId !== "" ? rowId : undefined,
          personId: personId !== "" ? personId : undefined,
          conceptIds,
          lineNumber,
          encoding,
        },
        unmappedFields:
          data.__extra !== undefined && (data.__extra as unknown[]).length > 0 ? { __extra: data.__extra } : undefined,
        parseIssues: rowIssues.length > 0 ? rowIssues : undefined,
      });
      recordIndex++;
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details:
        `${OMOP_ADAPTER_ID} ${OMOP_ADAPTER_VERSION} ` +
        "(OMOP CDM staging subset: person/measurement/specimen structural rows; " +
        "no vocabulary lookup, no OHDSI validation claim, no clinical interpretation)",
    };
  }
}
