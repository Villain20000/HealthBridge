/**
 * VCF (Variant Call Format) adapter — header metadata + variant records.
 *
 * Status is honestly `metadata-only`: variants are carried structurally
 * (CHROM/POS/ID/REF/ALT/QUAL/FILTER/INFO/FORMAT) with symbolic alleles
 * (`<DEL>`, `<DUP>`, breakends, …) preserved verbatim. No clinical
 * interpretation is performed here — no pathogenicity, no triage, no
 * treatment advice. BCF (binary) and gzip-compressed VCF are refused with
 * an explicit issue, never sniffed as text.
 */

import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";
import { decodeBuffer } from "./csv.js";

export const VCF_ADAPTER_ID = "vcf-adapter";
export const VCF_ADAPTER_VERSION = "1.0.0";

const EXPECTED_COLUMNS = ["CHROM", "POS", "ID", "REF", "ALT", "QUAL", "FILTER", "INFO"] as const;

export interface VcfContig {
  id: string;
  length?: number;
  attributes: Record<string, string>;
}

export interface VcfFieldDefinition {
  id: string;
  number?: string;
  type?: string;
  description?: string;
  attributes: Record<string, string>;
}

export interface VcfHeader {
  fileformat?: string;
  reference?: string;
  contigs: VcfContig[];
  infoDefinitions: VcfFieldDefinition[];
  formatDefinitions: VcfFieldDefinition[];
  otherMeta: Record<string, string>;
  columns: string[];
  sampleNames: string[];
  headerLineCount: number;
}

export interface VcfVariant {
  chrom: string;
  pos: number;
  id: string | null;
  ref: string;
  alt: string[];
  qual: number | null;
  filter: string[];
  info: Record<string, string | string[] | true>;
  format?: string[];
  samples?: Array<{ name: string; calls: Record<string, string | null> }>;
  hasSymbolicAllele: boolean;
  lineNumber: number;
}

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

/** Split `a=1,b="x,y",c=3` on top-level commas (quotes respected). */
function splitStructuredAttributes(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") parts.push(current);
  return parts;
}

function parseStructuredValue(raw: string): Record<string, string> {
  let inner = raw.trim();
  if (inner.startsWith("<") && inner.endsWith(">")) inner = inner.slice(1, -1);
  const attributes: Record<string, string> = {};
  for (const part of splitStructuredAttributes(inner)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    attributes[part.slice(0, eq).trim()] = value;
  }
  return attributes;
}

function toFieldDefinition(attributes: Record<string, string>): VcfFieldDefinition {
  const { ID, Number, Type, Description, ...rest } = attributes;
  return { id: ID ?? "", number: Number, type: Type, description: Description, attributes: rest };
}

/** Parse `##` header lines. Structural problems are returned, never thrown. */
export function parseVcfHeader(headerLines: string[]): { header: VcfHeader; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const header: VcfHeader = {
    contigs: [],
    infoDefinitions: [],
    formatDefinitions: [],
    otherMeta: {},
    columns: [],
    sampleNames: [],
    headerLineCount: headerLines.length,
  };

  headerLines.forEach((line, index) => {
    const location = `line ${index + 1}`;
    const body = line.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) {
      issues.push({
        code: "VCF_MALFORMED_HEADER",
        severity: "warning",
        message: `Header line has no '=' and was ignored: '${body.slice(0, 80)}'`,
        location,
      });
      return;
    }
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    if (key === "fileformat") {
      header.fileformat = value;
    } else if (key === "reference") {
      header.reference = value;
    } else if (key === "contig") {
      const attributes = parseStructuredValue(value);
      if (!attributes.ID) {
        issues.push({
          code: "VCF_CONTIG_WITHOUT_ID",
          severity: "warning",
          message: "A ##contig line has no ID and was ignored",
          location,
        });
        return;
      }
      const length = attributes.length !== undefined ? Number(attributes.length) : NaN;
      header.contigs.push({ id: attributes.ID, length: Number.isFinite(length) ? length : undefined, attributes });
    } else if (key === "INFO") {
      header.infoDefinitions.push(toFieldDefinition(parseStructuredValue(value)));
    } else if (key === "FORMAT") {
      header.formatDefinitions.push(toFieldDefinition(parseStructuredValue(value)));
    } else {
      header.otherMeta[key] = value;
    }
  });

  return { header, issues };
}

function parseInfo(raw: string): Record<string, string | string[] | true> {
  const info: Record<string, string | string[] | true> = {};
  if (raw === "" || raw === ".") return info;
  for (const entry of raw.split(";")) {
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq === -1) {
      info[entry] = true;
    } else {
      const value = entry.slice(eq + 1);
      info[entry.slice(0, eq)] = value.includes(",") ? value.split(",") : value;
    }
  }
  return info;
}

/**
 * Parse one VCF data line into a variant. Returns the variant, or `null`
 * when the line is unusable (the caller must report the returned issue).
 * Symbolic ALT alleles are preserved verbatim — never resolved or annotated.
 */
export function parseVcfLine(
  line: string,
  lineNumber: number,
  header: VcfHeader,
): { variant: VcfVariant | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const location = `line ${lineNumber}`;
  const cells = line.split("\t");
  if (cells.length < 8) {
    issues.push({
      code: "VCF_MALFORMED_LINE",
      severity: "error",
      message: `Data line has ${cells.length} tab-separated field(s); at least 8 (CHROM..INFO) are required, so the line was skipped`,
      location,
    });
    return { variant: null, issues };
  }

  const [chrom, posRaw, idRaw, ref, altRaw, qualRaw, filterRaw, infoRaw, formatRaw, ...sampleCells] = cells;
  const pos = Number(posRaw);
  if (chrom === "" || !Number.isInteger(pos) || pos < 1) {
    issues.push({
      code: "VCF_INVALID_POS",
      severity: "error",
      message: `POS must be a positive integer (got '${posRaw}'), so the line was skipped`,
      location,
      offendingValue: posRaw,
    });
    return { variant: null, issues };
  }
  if (ref === "" || altRaw === "") {
    issues.push({
      code: "VCF_MISSING_ALLELE",
      severity: "error",
      message: "REF and ALT must both be non-empty, so the line was skipped",
      location,
    });
    return { variant: null, issues };
  }

  const alt = altRaw.split(",");
  const hasSymbolicAllele = alt.some((allele) => allele.startsWith("<") && allele.endsWith(">"));

  let qual: number | null = null;
  if (qualRaw !== "" && qualRaw !== ".") {
    const parsed = Number(qualRaw);
    if (!Number.isFinite(parsed)) {
      issues.push({
        code: "VCF_INVALID_QUAL",
        severity: "warning",
        message: `QUAL is not numeric (got '${qualRaw}'); kept as null`,
        location,
        offendingValue: qualRaw,
      });
    } else {
      qual = parsed;
    }
  }

  const filter = filterRaw === "" || filterRaw === "." ? [] : filterRaw.split(";");

  const variant: VcfVariant = {
    chrom,
    pos,
    id: idRaw === "" || idRaw === "." ? null : idRaw,
    ref,
    alt,
    qual,
    filter,
    info: parseInfo(infoRaw),
    hasSymbolicAllele,
    lineNumber,
  };

  if (formatRaw !== undefined) {
    const formatKeys = formatRaw === "" ? [] : formatRaw.split(":");
    variant.format = formatKeys;
    variant.samples = header.sampleNames.map((name, sampleIndex) => {
      const raw = sampleCells[sampleIndex] ?? "";
      const values = raw.split(":");
      const calls: Record<string, string | null> = {};
      formatKeys.forEach((key, keyIndex) => {
        calls[key] = values[keyIndex] ?? null;
      });
      if (values.length !== formatKeys.length) {
        issues.push({
          code: "VCF_SAMPLE_FIELD_MISMATCH",
          severity: "warning",
          message: `Sample '${name}' has ${values.length} field(s) but FORMAT declares ${formatKeys.length}; missing values kept as null`,
          location,
        });
      }
      return { name, calls };
    });
  }

  return { variant, issues };
}

function referenceGenomeOf(header: VcfHeader, context: ParseContext): string {
  const override = context.options?.referenceGenome;
  if (typeof override === "string" && override !== "") return override;
  if (header.reference && header.reference !== "") return header.reference;
  return "not-declared";
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export class VcfFormatAdapter implements MedicalFormatAdapter {
  public id = VCF_ADAPTER_ID;
  public version = VCF_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "vcf",
      version: VCF_ADAPTER_VERSION,
      description:
        "VCF variant adapter: header metadata (fileformat, contigs, INFO/FORMAT) plus per-line variant records",
      extensions: [".vcf"],
      mimeTypes: ["text/vcf", "text/x-vcf"],
      status: "metadata-only",
      limitations: [
        "Metadata + variant structure only: no clinical interpretation is performed (no pathogenicity, triage or treatment advice).",
        "BCF binary and gzip-compressed VCF (.vcf.gz) are not supported.",
        "Genotype calls are carried structurally; phasing and allele-depth semantics are not validated.",
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
    const ext = fileExtension(input);
    if (ext === "vcf") return 0.9;
    if (ext === "bcf" || ext === "vcf.gz" || ext === "gz") return 0;
    const text = input.contentString ?? "";
    if (text.includes("##fileformat=VCF")) return 0.85;
    if (/^#CHROM\t/m.test(text)) return 0.8;
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    const lines = splitLines(text);
    const headerLines = lines.filter((line) => line.startsWith("##"));
    const columnLine = lines.find((line) => line.startsWith("#CHROM"));

    const { header, issues } = parseVcfHeader(headerLines);
    let recordCount = 0;
    const samples: VcfVariant[] = [];
    for (const line of lines) {
      if (line === "" || line.startsWith("#")) continue;
      const parsed = parseVcfLine(line, 0, header);
      if (parsed.variant) {
        recordCount++;
        if (samples.length < 5) samples.push(parsed.variant);
      }
    }

    return {
      format: "vcf",
      formatVersion: header.fileformat ?? "unknown",
      domain: "genomics",
      recordCount,
      detectedSchema: {
        fields: [
          { name: "CHROM", type: "string", sampleValues: samples.slice(0, 3).map((v) => v.chrom), nullable: false },
          { name: "POS", type: "integer", sampleValues: samples.slice(0, 3).map((v) => v.pos), nullable: false },
          { name: "ID", type: "string", sampleValues: samples.slice(0, 3).map((v) => v.id), nullable: true },
          { name: "REF", type: "string", sampleValues: samples.slice(0, 3).map((v) => v.ref), nullable: false },
          {
            name: "ALT",
            type: "string",
            sampleValues: samples.slice(0, 3).map((v) => v.alt.join(",")),
            nullable: false,
          },
          { name: "QUAL", type: "number", sampleValues: samples.slice(0, 3).map((v) => v.qual), nullable: true },
          {
            name: "FILTER",
            type: "string",
            sampleValues: samples.slice(0, 3).map((v) => v.filter.join(";")),
            nullable: true,
          },
          {
            name: "INFO",
            type: "string",
            sampleValues: samples.slice(0, 3).map((v) => JSON.stringify(v.info)),
            nullable: true,
          },
        ],
      },
      sampleRecords: samples as unknown as Array<Record<string, unknown>>,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${encoding}`,
        header.fileformat ? `fileformat: ${header.fileformat}` : "No ##fileformat declaration found",
        columnLine
          ? "Column header (#CHROM..INFO) present"
          : "No #CHROM column header found; data lines parsed positionally",
        `contigs: ${header.contigs.length}, INFO definitions: ${header.infoDefinitions.length}, FORMAT definitions: ${header.formatDefinitions.length}`,
        ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readInputText(input);
    if (text === "") {
      context.onIssue?.({
        code: "VCF_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }
    const lines = splitLines(text);
    const headerLines: string[] = [];
    let columnSeen = false;
    const header: VcfHeader = {
      contigs: [],
      infoDefinitions: [],
      formatDefinitions: [],
      otherMeta: {},
      columns: [],
      sampleNames: [],
      headerLineCount: 0,
    };

    // First pass: header block (leading ## lines + optional #CHROM line).
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("##")) {
        headerLines.push(line);
        bodyStart = i + 1;
        continue;
      }
      if (line.startsWith("#CHROM")) {
        const columns = line.slice(1).split("\t");
        header.columns = columns;
        header.sampleNames = columns.slice(9);
        columnSeen = true;
        const missing = EXPECTED_COLUMNS.filter((name, position) => columns[position] !== name);
        if (missing.length > 0) {
          context.onIssue?.({
            code: "VCF_INVALID_HEADER",
            severity: "warning",
            message: `Column header does not start with ${EXPECTED_COLUMNS.join(" ")} (mismatch: ${missing.join(",")}); data lines parsed positionally`,
            location: `line ${i + 1}`,
          });
        }
        bodyStart = i + 1;
        continue;
      }
      if (line === "") {
        bodyStart = i + 1;
        continue;
      }
      break;
    }

    const parsed = parseVcfHeader(headerLines);
    Object.assign(header, {
      ...parsed.header,
      headerLineCount: headerLines.length,
      columns: header.columns,
      sampleNames: header.sampleNames,
    });
    for (const issue of parsed.issues) context.onIssue?.(issue);
    if (headerLines.length === 0) {
      context.onIssue?.({
        code: "VCF_MISSING_HEADER",
        severity: "warning",
        message: "No ## header lines found; data lines parsed positionally",
      });
    } else if (!columnSeen) {
      context.onIssue?.({
        code: "VCF_MISSING_COLUMNS",
        severity: "warning",
        message: "No #CHROM column header found; data lines parsed positionally",
      });
    }
    if (!header.fileformat) {
      context.onIssue?.({
        code: "VCF_MISSING_FILEFORMAT",
        severity: "warning",
        message: "No ##fileformat declaration found",
      });
    }

    const checksum = computeChecksum(input);
    const referenceGenome = referenceGenomeOf(header, context);
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
    let recordIndex = 0;

    for (let i = bodyStart; i < lines.length && recordIndex < limit; i++) {
      const line = lines[i];
      if (line === "" || line.startsWith("#")) continue;
      const lineNumber = i + 1;
      const { variant, issues } = parseVcfLine(line, lineNumber, header);
      for (const issue of issues) context.onIssue?.({ ...issue, recordIndex });
      if (!variant) continue;

      const { lineNumber: _lineNumber, ...variantData } = variant;
      void _lineNumber;
      yield createCanonicalEnvelope({
        id: variant.id ?? `vcf-var-${recordIndex}`,
        domain: "genomics",
        sourceFormat: "vcf",
        formatVersion: header.fileformat ?? "unknown",
        content: { kind: "structured", data: variantData as unknown as Record<string, unknown> },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex,
        sourceLocation: `line ${lineNumber}`,
        filename: input.filename,
        checksum,
        encoding,
        metadata: {
          fileformat: header.fileformat ?? "unknown",
          referenceGenome,
          lineNumber,
          hasSymbolicAllele: variant.hasSymbolicAllele,
          contigCount: header.contigs.length,
          sampleCount: header.sampleNames.length,
        },
      });
      recordIndex++;
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${VCF_ADAPTER_ID} ${VCF_ADAPTER_VERSION} (metadata + variants, no clinical interpretation)`,
    };
  }
}
