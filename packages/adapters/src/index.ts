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
import { FhirNdjsonFormatAdapter } from "@healthbridge/fhir-ndjson";
import { buildCsvRecords, decodeBuffer, readCsvTable } from "./csv.js";

export * from "./csv.js";
export * from "./kit.js";
export * from "./vcf.js";
export * from "./fasta.js";
export * from "./hl7v2.js";
export * from "./xml-cda.js";
export * from "./xlsx.js";
export * from "./dicom.js";
export * from "./fhir-rest.js";
export * from "./omop.js";
export * from "./pdf.js";
export * from "./edf.js";
export * from "./mysql-connector.js";
export * from "./dicomweb.js";
export * from "./cdisc-odm.js";
export * from "./fhir-validator.js";
export * from "@healthbridge/fhir-ndjson";

const DOMAIN_KEYWORDS: Array<{ domain: MedicalDomain; keywords: string[] }> = [
  {
    domain: "laboratory",
    keywords: ["loinc", "lab", "specimen", "analyte", "result_value", "reference_range", "culture", "assay"],
  },
  { domain: "imaging", keywords: ["dicom", "study_uid", "series_uid", "sopinstance", "modality", "pixel", "radiolog"] },
  {
    domain: "genomics",
    keywords: ["vcf", "variant", "chrom", "allele", "fastq", "reference_genome", "assembly", "rsid"],
  },
  { domain: "biobanking", keywords: ["biobank", "aliquot", "sample_id", "freezer", "storage", "biospecimen", "cryo"] },
  { domain: "research", keywords: ["trial", "cohort", "participant", "protocol", "consent", "cdisc", "omop"] },
  { domain: "waveform", keywords: ["ecg", "eeg", "waveform", "sampling_rate", "heart_rate", "edf", "wfdb"] },
  { domain: "administrative", keywords: ["claim", "invoice", "billing", "appointment", "admission", "insurance"] },
  { domain: "public-health", keywords: ["vaccination", "epidemiolog", "outbreak", "population", "incidence"] },
  { domain: "document", keywords: ["pdf", "discharge_summary", "note_text", "document_type"] },
];

export function inferDomain(headers: string[], fallback: MedicalDomain = "clinical"): MedicalDomain {
  const haystack = headers.join(" ").toLowerCase();
  for (const entry of DOMAIN_KEYWORDS) {
    if (entry.keywords.some((keyword) => haystack.includes(keyword))) return entry.domain;
  }
  return fallback;
}

function inferValueType(values: string[]): string {
  const sample = values.filter((v) => v !== "" && v !== undefined && v !== null);
  if (sample.length === 0) return "string";
  if (sample.every((v) => /^-?\d+$/.test(v))) return "integer";
  if (sample.every((v) => /^-?\d*[.,]\d+$/.test(v))) return "number";
  if (sample.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return "date";
  if (sample.every((v) => /^(true|false|yes|no|0|1)$/i.test(v))) return "boolean";
  return "string";
}

function readText(input: InputDescriptor): { text: string; encoding: string; warnings: string[] } {
  if (input.contentString !== undefined) {
    return { text: input.contentString, encoding: "utf-8", warnings: [] };
  }
  if (input.buffer) return decodeBuffer(input.buffer);
  return { text: "", encoding: "utf-8", warnings: ["Input has neither contentString nor buffer"] };
}

function extension(input: InputDescriptor): string {
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function looksLikeNdjson(text: string): boolean {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  return lines.every((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export class CsvFormatAdapter implements MedicalFormatAdapter {
  public id = "csv-adapter";
  public version = "1.1.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "csv",
      version: "1.1.0",
      description: "Delimited medical dataset adapter (RFC 4180, encoding and delimiter detection)",
      extensions: [".csv", ".tsv", ".txt"],
      mimeTypes: ["text/csv", "application/csv", "text/tab-separated-values"],
      status: "supported",
      limitations: [
        "No clinical semantics are inferred; content is parsed structurally only.",
        "Excel-specific quirks such as merged cells are not represented.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: false,
        transformToFHIR: true,
        validateFormat: true,
        exportOriginal: true,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    const ext = extension(input);
    if (ext === "tsv") return 0.92;
    if (ext === "csv") return 0.9;

    if (input.contentString) {
      const sample = input.contentString.slice(0, 4096);
      const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length < 2) return 0;
      const delimiters = [",", ";", "\t", "|"];
      for (const delimiter of delimiters) {
        const counts = lines.slice(0, 5).map((line) => line.split(delimiter).length - 1);
        if (counts.every((c) => c > 0) && new Set(counts).size === 1) {
          return ext === "txt" ? 0.65 : 0.7;
        }
      }
    }
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const table = readCsvTable({ buffer: input.buffer, contentString: input.contentString });
    const { records, warnings } = buildCsvRecords(table);

    const fields = table.headers.map((name) => {
      const values = records.slice(0, 200).map((r) => String(r.data[name] ?? ""));
      return {
        name,
        type: inferValueType(values),
        sampleValues: values.slice(0, 5),
        nullable: values.some((v) => v === ""),
      };
    });

    const ragged = records.filter((r) => r.issues.length > 0).length;

    return {
      format: "csv",
      formatVersion: "RFC4180",
      domain: inferDomain(table.headers),
      recordCount: records.length,
      detectedSchema: { fields },
      sampleRecords: records.slice(0, 5).map((r) => r.data),
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...table.warnings,
        ...warnings,
        `Delimiter: '${table.delimiter === "\t" ? "\\t" : table.delimiter}', encoding: ${table.encoding}`,
        ...(ragged > 0 ? [`${ragged} row(s) have a different cell count than the header`] : []),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const delimitersOption = context.options?.delimiter;
    const table = readCsvTable(
      { buffer: input.buffer, contentString: input.contentString },
      { delimiter: typeof delimitersOption === "string" ? delimitersOption : undefined },
    );
    const { records } = buildCsvRecords(table);
    const checksum = computeChecksum(input);
    const domain = inferDomain(table.headers);

    for (const warning of table.warnings) {
      context.onIssue?.({ code: "CSV_STRUCTURE_WARNING", severity: "warning", message: warning });
    }

    const limit = context.maxRecords ?? records.length;
    for (let index = 0; index < Math.min(records.length, limit); index++) {
      const record = records[index];
      const parseIssues: ValidationIssue[] = record.issues.map((issue) => ({
        ...issue,
        code: issue.code,
        location: `line ${record.lineNumber}`,
        recordIndex: index,
      }));

      const envelope = createCanonicalEnvelope({
        id: `csv-rec-${index}`,
        domain,
        sourceFormat: "csv",
        formatVersion: "RFC4180",
        content: { kind: "structured", data: record.data },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index,
        sourceLocation: `line ${record.lineNumber}`,
        filename: input.filename,
        checksum,
        encoding: table.encoding,
        metadata: {
          delimiter: table.delimiter,
          encoding: table.encoding,
          columns: table.headers.length,
          lineNumber: record.lineNumber,
          hasExtraCells: Array.isArray(record.data.__extra),
        },
        parseIssues,
      });

      yield envelope;
    }
  }
}

// ---------------------------------------------------------------------------
// Generic JSON
// ---------------------------------------------------------------------------

export class JsonFormatAdapter implements MedicalFormatAdapter {
  public id = "json-adapter";
  public version = "1.1.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "json",
      version: "1.1.0",
      description: "Structured JSON medical asset adapter (object or array of objects)",
      extensions: [".json"],
      mimeTypes: ["application/json"],
      status: "supported",
      limitations: ["Streaming JSON (`application/json-seq`) is not supported yet."],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: true,
        transformToFHIR: true,
        validateFormat: true,
        exportOriginal: true,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    if (extension(input) === "json") return 0.6;
    const trimmed = (input.contentString ?? "").trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return looksLikeNdjson(trimmed) ? 0.5 : 0.6;
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readText(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        format: "json",
        domain: "unknown",
        recordCount: 0,
        capabilities: this.getManifest().capabilities,
        status: this.getManifest().status,
        warnings: [...warnings, `Malformed JSON: ${(error as Error).message}`],
      };
    }

    const records = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    const firstKeys =
      records.length > 0 && typeof records[0] === "object" && records[0] !== null ? Object.keys(records[0]) : [];

    return {
      format: "json",
      domain: inferDomain(firstKeys),
      recordCount: records.length,
      detectedSchema: {
        fields: firstKeys.map((name) => ({
          name,
          type: typeof (records[0] as Record<string, unknown>)[name],
          sampleValues: records.slice(0, 3).map((r) => (r as Record<string, unknown>)[name]),
          nullable: records.some(
            (r) => (r as Record<string, unknown>)[name] === null || (r as Record<string, unknown>)[name] === undefined,
          ),
        })),
      },
      sampleRecords: records.slice(0, 5),
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [...warnings, `Encoding: ${encoding}`],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readText(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      context.onIssue?.({
        code: "MALFORMED_JSON",
        severity: "fatal",
        message: `Input is not valid JSON: ${(error as Error).message}`,
      });
      return;
    }

    const records = Array.isArray(parsed) ? parsed : [parsed];
    const checksum = computeChecksum(input);
    const limit = context.maxRecords ?? records.length;

    for (let index = 0; index < Math.min(records.length, limit); index++) {
      const record = records[index];
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        context.onIssue?.({
          code: "JSON_RECORD_NOT_OBJECT",
          severity: "warning",
          message: `Record ${index} is not an object and was kept as a binary/document reference`,
          recordIndex: index,
        });
      }

      const recordObject = (record ?? {}) as Record<string, unknown>;
      const domain = inferDomain(Object.keys(recordObject));

      yield createCanonicalEnvelope({
        id: typeof recordObject.id === "string" ? recordObject.id : `json-rec-${index}`,
        domain,
        sourceFormat: "json",
        content: { kind: "structured", data: record },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index,
        sourceLocation: Array.isArray(parsed) ? `$[${index}]` : "$",
        filename: input.filename,
        checksum,
        encoding,
        metadata: { jsonPointer: Array.isArray(parsed) ? `$[${index}]` : "$" },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// FHIR R4 (JSON bundle, single resource; NDJSON lives in @healthbridge/fhir-ndjson)
// ---------------------------------------------------------------------------

export class FhirJsonFormatAdapter implements MedicalFormatAdapter {
  public id = "fhir-r4-json-adapter";
  public version = "1.1.0";

  public getManifest(): CapabilityManifest {
    return {
      format: "fhir-r4-json",
      version: "4.0.1",
      description: "HL7 FHIR R4 JSON and Bundle adapter (structural inspection only)",
      extensions: [".json", ".fhir", ".fhir.json"],
      mimeTypes: ["application/fhir+json"],
      status: "partial",
      limitations: [
        "Structural adapter only: profiles and terminology are not validated here.",
        "FHIR R5 and STU3 payloads are not declared supported.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: true,
        transformToFHIR: true,
        validateFormat: "adapter-required",
        exportOriginal: true,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  public async score(input: InputDescriptor): Promise<number> {
    const name = (input.filename ?? "").toLowerCase();
    // NDJSON inputs belong to FhirNdjsonFormatAdapter (split out of this adapter).
    if (name.endsWith(".ndjson")) return 0;
    const text = input.contentString ?? "";
    if (looksLikeNdjson(text)) return 0;
    if (name.endsWith(".fhir") || name.endsWith(".fhir.json")) return 0.95;
    if (text.includes('"resourceType"') || text.includes('"resourceType":')) return 0.9;
    if (input.mimeType === "application/fhir+json") return 0.9;
    return 0;
  }

  private extractResources(text: string): { resources: Array<Record<string, unknown>>; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const trimmed = text.trim();
    if (trimmed === "") return { resources: [], issues };

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.resourceType === "Bundle" && Array.isArray(parsed.entry)) {
        const resources = parsed.entry
          .map((entry: Record<string, unknown>) => entry?.resource)
          .filter((resource: unknown): resource is Record<string, unknown> => Boolean(resource));
        if (resources.length !== parsed.entry.length) {
          issues.push({
            code: "BUNDLE_ENTRY_WITHOUT_RESOURCE",
            severity: "warning",
            message: "Some Bundle entries have no `resource` and were skipped",
          });
        }
        return { resources, issues };
      }
      if (parsed?.resourceType) return { resources: [parsed], issues };
      issues.push({
        code: "NOT_A_FHIR_RESOURCE",
        severity: "warning",
        message: "JSON payload has no `resourceType`; treat as generic JSON",
      });
      return { resources: [], issues };
    } catch (error) {
      issues.push({
        code: "MALFORMED_JSON",
        severity: "fatal",
        message: `Input is not valid FHIR JSON: ${(error as Error).message}`,
      });
      return { resources: [], issues };
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding } = readText(input);
    const { resources, issues } = this.extractResources(text);
    const typeCounts: Record<string, number> = {};
    for (const resource of resources) {
      const type = String(resource.resourceType ?? "unknown");
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }

    return {
      format: "fhir-r4-json",
      formatVersion: "4.0.1",
      domain: "clinical",
      recordCount: resources.length,
      sampleRecords: resources.slice(0, 5),
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        `Encoding: ${encoding}`,
        ...Object.entries(typeCounts).map(([type, count]) => `${type}: ${count}`),
        ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readText(input);
    const { resources, issues } = this.extractResources(text);
    const checksum = computeChecksum(input);

    for (const issue of issues) context.onIssue?.(issue);

    const limit = context.maxRecords ?? resources.length;
    for (let index = 0; index < Math.min(resources.length, limit); index++) {
      const resource = resources[index];
      yield createCanonicalEnvelope({
        id: typeof resource.id === "string" ? resource.id : `fhir-${index}`,
        domain: "clinical",
        sourceFormat: "fhir-r4-json",
        formatVersion: "4.0.1",
        content: { kind: "structured", data: resource },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index,
        sourceLocation: `$[${index}]`,
        filename: input.filename,
        checksum,
        encoding,
        metadata: { resourceType: resource.resourceType },
      });
    }
  }
}

/** Built-in adapter bundle used by the engine, SDK, CLI and API. */
export function createBuiltInAdapters(): MedicalFormatAdapter[] {
  return [new CsvFormatAdapter(), new JsonFormatAdapter(), new FhirJsonFormatAdapter(), new FhirNdjsonFormatAdapter()];
}
