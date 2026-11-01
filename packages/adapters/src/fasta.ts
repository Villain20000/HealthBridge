/**
 * FASTA / FASTQ adapter — sequence metadata only.
 *
 * Status is honestly `metadata-only`: per-record length, GC content, N
 * count, SHA-256 checksums and a FASTQ quality-encoding guess. Full
 * sequences and quality strings are NEVER embedded in envelopes — only a
 * bounded preview (see `MAX_PREVIEW_BASES`) plus checksums, so traces and
 * envelopes stay small and sequence data cannot leak through them.
 * Malformed records are reported via `ParseContext.onIssue`, never dropped
 * silently. No alignment, assembly, variant calling or clinical
 * interpretation is performed.
 */

import { createHash } from "node:crypto";
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

export const FASTA_ADAPTER_ID = "fasta-fastq-adapter";
export const FASTA_ADAPTER_VERSION = "1.0.0";

/** Maximum number of bases/quality chars ever inlined into an envelope. */
export const MAX_PREVIEW_BASES = 64;

const IUPAC_BASES = new Set("ACGTUNRYWSMKBDHV-.*".split(""));

export type SequenceKind = "fasta" | "fastq";

export interface SequenceRecordMeta {
  kind: SequenceKind;
  recordId: string;
  description?: string;
  length: number;
  gcCount: number;
  /** Null for zero-length records (no division by zero, no fabricated 0). */
  gcFraction: number | null;
  nCount: number;
  /** SHA-256 of the normalised (whitespace-stripped, upper-cased) sequence. */
  sequenceChecksum: string;
  /** First MAX_PREVIEW_BASES bases; the full sequence is never inlined. */
  sequencePreview: string;
  sequenceTruncated: boolean;
  qualityLength?: number;
  /** First MAX_PREVIEW_BASES quality chars; the full string is never inlined. */
  qualityPreview?: string;
  qualityTruncated?: boolean;
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

function normaliseSequence(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function checksumOf(normalised: string): string {
  return `sha256:${createHash("sha256").update(normalised, "utf-8").digest("hex")}`;
}

function buildRecordMeta(
  kind: SequenceKind,
  recordId: string,
  description: string | undefined,
  rawSequence: string,
  lineNumber: number,
  quality?: string,
): SequenceRecordMeta {
  const sequence = normaliseSequence(rawSequence);
  let gcCount = 0;
  let nCount = 0;
  for (const base of sequence) {
    if (base === "G" || base === "C") gcCount++;
    if (base === "N") nCount++;
  }
  const meta: SequenceRecordMeta = {
    kind,
    recordId,
    description,
    length: sequence.length,
    gcCount,
    gcFraction: sequence.length === 0 ? null : gcCount / sequence.length,
    nCount,
    sequenceChecksum: checksumOf(sequence),
    sequencePreview: sequence.slice(0, MAX_PREVIEW_BASES),
    sequenceTruncated: sequence.length > MAX_PREVIEW_BASES,
    lineNumber,
  };
  if (quality !== undefined) {
    meta.qualityLength = quality.length;
    meta.qualityPreview = quality.slice(0, MAX_PREVIEW_BASES);
    meta.qualityTruncated = quality.length > MAX_PREVIEW_BASES;
  }
  return meta;
}

function invalidBases(sequence: string): string[] {
  const bad = new Set<string>();
  for (const base of normaliseSequence(sequence)) {
    if (!IUPAC_BASES.has(base)) bad.add(base);
  }
  return [...bad].sort();
}

export interface ParsedSequences {
  kind: SequenceKind | "unknown";
  records: SequenceRecordMeta[];
  /** Full FASTQ quality strings (parsing memory only — never inlined into envelopes). */
  qualities: string[];
  issues: ValidationIssue[];
}

/** Parse FASTA text: `>id description` headers followed by sequence lines. */
export function parseFasta(lines: string[]): ParsedSequences {
  const records: SequenceRecordMeta[] = [];
  const issues: ValidationIssue[] = [];
  let currentId: string | undefined;
  let currentDescription: string | undefined;
  let currentChunks: string[] = [];
  let currentLine = 0;
  let recordIndex = 0;

  const flush = (): void => {
    if (currentId === undefined) return;
    const rawSequence = currentChunks.join("");
    const meta = buildRecordMeta("fasta", currentId, currentDescription, rawSequence, currentLine);
    if (rawSequence.replace(/\s+/g, "") === "") {
      issues.push({
        code: "FASTA_EMPTY_SEQUENCE",
        severity: "warning",
        message: `Record '${currentId}' has no sequence bases`,
        location: `line ${currentLine}`,
        recordIndex,
      });
    }
    const bad = invalidBases(rawSequence);
    if (bad.length > 0) {
      issues.push({
        code: "FASTA_INVALID_CHARACTER",
        severity: "warning",
        message: `Record '${currentId}' contains non-IUPAC character(s) ${bad.join(",")}; bases kept verbatim in the checksum input`,
        location: `line ${currentLine}`,
        recordIndex,
        offendingValue: bad.join(","),
      });
    }
    records.push(meta);
    recordIndex++;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line === "") return;
    if (line.startsWith(">")) {
      flush();
      const header = line.slice(1).trim();
      if (header === "") {
        issues.push({
          code: "FASTA_EMPTY_HEADER",
          severity: "warning",
          message: "A '>' header line has no identifier; the record id falls back to its position",
          location: `line ${lineNumber}`,
          recordIndex,
        });
      }
      const space = header.search(/\s/);
      currentId = header === "" ? `record-${recordIndex}` : space === -1 ? header : header.slice(0, space);
      currentDescription = space === -1 ? undefined : header.slice(space + 1).trim() || undefined;
      currentChunks = [];
      currentLine = lineNumber;
      return;
    }
    if (currentId === undefined) {
      issues.push({
        code: "FASTA_SEQUENCE_WITHOUT_HEADER",
        severity: "error",
        message: "Sequence data appears before any '>' header, so it cannot be attributed to a record and was skipped",
        location: `line ${lineNumber}`,
      });
      return;
    }
    currentChunks.push(line.trim());
  });
  flush();

  return { kind: "fasta", records, qualities: [], issues };
}

/**
 * Parse FASTQ text: strict 4-line groups (`@`, sequence, `+`, quality).
 * Groups that fail structurally are reported and skipped, never swallowed.
 */
export function parseFastq(lines: string[]): ParsedSequences {
  const records: SequenceRecordMeta[] = [];
  const qualities: string[] = [];
  const issues: ValidationIssue[] = [];
  const content = lines.filter((line) => line !== "");
  let recordIndex = 0;

  for (let start = 0; start < content.length; recordIndex++) {
    const lineNumber = start + 1;
    const remaining = content.length - start;
    if (remaining < 4) {
      issues.push({
        code: "FASTQ_TRUNCATED_RECORD",
        severity: "error",
        message: `Trailing ${remaining} line(s) do not form a complete 4-line FASTQ record and were skipped`,
        location: `line ${lineNumber}`,
        recordIndex,
      });
      break;
    }
    const [atLine, sequence, plusLine, quality] = content.slice(start, start + 4);
    start += 4;
    if (!atLine.startsWith("@")) {
      issues.push({
        code: "FASTQ_MISSING_AT",
        severity: "error",
        message: `FASTQ record does not start with '@' (got '${atLine.slice(0, 32)}') and was skipped`,
        location: `line ${lineNumber}`,
        recordIndex,
      });
      continue;
    }
    if (!plusLine.startsWith("+")) {
      issues.push({
        code: "FASTQ_MISSING_PLUS",
        severity: "error",
        message: "FASTQ record has no '+' separator line and was skipped",
        location: `line ${lineNumber + 2}`,
        recordIndex,
      });
      continue;
    }
    if (sequence.length !== quality.length) {
      issues.push({
        code: "FASTQ_LENGTH_MISMATCH",
        severity: "error",
        message: `Sequence length (${sequence.length}) differs from quality length (${quality.length}); the record was skipped`,
        location: `line ${lineNumber}`,
        recordIndex,
      });
      continue;
    }
    const header = atLine.slice(1).trim();
    const space = header.search(/\s/);
    const bad = invalidBases(sequence);
    if (bad.length > 0) {
      issues.push({
        code: "FASTQ_INVALID_CHARACTER",
        severity: "warning",
        message: `Record '${header.slice(0, 32)}' contains non-IUPAC character(s) ${bad.join(",")}`,
        location: `line ${lineNumber + 1}`,
        recordIndex,
        offendingValue: bad.join(","),
      });
    }
    records.push(
      buildRecordMeta(
        "fastq",
        header === "" ? `record-${recordIndex}` : space === -1 ? header : header.slice(0, space),
        space === -1 ? undefined : header.slice(space + 1).trim() || undefined,
        sequence,
        lineNumber,
        quality,
      ),
    );
    qualities.push(quality);
  }

  return { kind: "fastq", records, qualities, issues };
}

/**
 * Heuristic guess over FASTQ quality strings — returned with an explicit
 * "guessed" label wherever it is surfaced. Sanger Phred+33 spans ASCII
 * 33–74, Illumina 1.3+ Phred+64 spans 64–104, Solexa 59–104.
 */
export function guessQualityEncoding(qualities: string[]): string | undefined {
  let min = Number.MAX_SAFE_INTEGER;
  let max = Number.MIN_SAFE_INTEGER;
  for (const quality of qualities) {
    for (let i = 0; i < quality.length; i++) {
      const code = quality.charCodeAt(i);
      if (code < min) min = code;
      if (code > max) max = code;
    }
  }
  if (min === Number.MAX_SAFE_INTEGER) return undefined;
  if (max <= 74 && min >= 33) return "Phred+33 (Sanger, guessed)";
  if (min >= 64 && max <= 104) return "Phred+64 (Illumina 1.3+, guessed)";
  if (min >= 59 && max <= 104) return "Solexa/Phred+64 (guessed)";
  return "ambiguous (overlapping Phred+33/Phred+64 ranges, guessed)";
}

/** Decide whether text is FASTA, FASTQ or neither — content only, no guessing. */
export function sniffSequenceKind(text: string): SequenceKind | "unknown" {
  const lines = text.split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== "");
  if (!first) return "unknown";
  if (first.startsWith(">")) return "fasta";
  if (first.startsWith("@")) {
    const content = lines.filter((line) => line !== "");
    if (content.length >= 3 && content[2].startsWith("+")) return "fastq";
    // A lone '@' line is not enough evidence — fall through to unknown.
    return "unknown";
  }
  // Leading garbage before the first '>' header still sniffs as FASTA; the
  // stray lines are reported as FASTA_SEQUENCE_WITHOUT_HEADER at parse time.
  if (lines.some((line) => line.startsWith(">"))) return "fasta";
  return "unknown";
}

export function parseSequences(text: string): ParsedSequences {
  const lines = text.split(/\r?\n/);
  const kind = sniffSequenceKind(text);
  if (kind === "fasta") return parseFasta(lines);
  if (kind === "fastq") return parseFastq(lines);
  return { kind: "unknown", records: [], qualities: [], issues: [] };
}

function lengthDistribution(records: SequenceRecordMeta[]): { min: number; max: number; mean: number; total: number } {
  if (records.length === 0) return { min: 0, max: 0, mean: 0, total: 0 };
  let min = Number.MAX_SAFE_INTEGER;
  let max = 0;
  let total = 0;
  for (const record of records) {
    if (record.length < min) min = record.length;
    if (record.length > max) max = record.length;
    total += record.length;
  }
  return { min, max, mean: total / records.length, total };
}

export class FastaFastqFormatAdapter implements MedicalFormatAdapter {
  public id = FASTA_ADAPTER_ID;
  public version = FASTA_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "fasta-fastq",
      version: FASTA_ADAPTER_VERSION,
      description:
        "FASTA/FASTQ sequence adapter: record counts, length distribution, GC content, checksums and quality-encoding guess",
      extensions: [".fa", ".fasta", ".fas", ".fastq", ".fq"],
      mimeTypes: ["text/x-fasta", "text/x-fastq"],
      status: "metadata-only",
      limitations: [
        "Metadata only: full sequences and quality strings are never embedded in envelopes or traces — only bounded previews and SHA-256 checksums.",
        "No alignment, assembly, variant calling or clinical interpretation is performed.",
        "The FASTQ quality-encoding call is a heuristic guess, not a validated measurement.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: false,
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
    if (["fa", "fasta", "fas", "fastq", "fq"].includes(ext)) return 0.9;
    // Content sniffing is limited to generic text names so a `.csv` or
    // `.vcf` file is never claimed by content alone (same rule as CSV).
    if (!input.contentString || (ext !== "" && ext !== "txt")) return 0;
    const kind = sniffSequenceKind(input.contentString);
    if (kind === "fasta" || kind === "fastq") return 0.75;
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    const parsed = parseSequences(text);
    const distribution = lengthDistribution(parsed.records);
    const gcValues = parsed.records.filter((record) => record.gcFraction !== null);
    const meanGc =
      gcValues.length === 0
        ? null
        : gcValues.reduce((sum, record) => sum + (record.gcFraction ?? 0), 0) / gcValues.length;
    const qualityGuess = parsed.kind === "fastq" ? guessQualityEncoding(parsed.qualities) : undefined;

    return {
      format: "fasta-fastq",
      formatVersion: parsed.kind === "unknown" ? "unknown" : parsed.kind,
      domain: "genomics",
      recordCount: parsed.records.length,
      detectedSchema: {
        fields: [
          {
            name: "recordId",
            type: "string",
            sampleValues: parsed.records.slice(0, 3).map((r) => r.recordId),
            nullable: false,
          },
          {
            name: "length",
            type: "integer",
            sampleValues: parsed.records.slice(0, 3).map((r) => r.length),
            nullable: false,
          },
          {
            name: "gcFraction",
            type: "number",
            sampleValues: parsed.records.slice(0, 3).map((r) => r.gcFraction),
            nullable: true,
          },
          {
            name: "sequenceChecksum",
            type: "string",
            sampleValues: parsed.records.slice(0, 3).map((r) => r.sequenceChecksum),
            nullable: false,
          },
          ...(parsed.kind === "fastq"
            ? [
                {
                  name: "qualityLength",
                  type: "integer",
                  sampleValues: parsed.records.slice(0, 3).map((r) => r.qualityLength),
                  nullable: false,
                },
              ]
            : []),
        ],
      },
      sampleRecords: parsed.records.slice(0, 5) as unknown as Array<Record<string, unknown>>,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${encoding}`,
        parsed.kind === "unknown" ? "Content is neither recognisable FASTA nor FASTQ" : `kind: ${parsed.kind}`,
        `records: ${parsed.records.length}, length: min ${distribution.min}, max ${distribution.max}, mean ${distribution.mean.toFixed(1)}, total ${distribution.total}`,
        meanGc === null ? "mean GC: n/a (no non-empty records)" : `mean GC: ${meanGc.toFixed(3)}`,
        ...(qualityGuess ? [`quality encoding guess: ${qualityGuess}`] : []),
        ...parsed.issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding } = readInputText(input);
    if (text.trim() === "") {
      context.onIssue?.({
        code: "SEQ_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }
    const parsed = parseSequences(text);
    if (parsed.kind === "unknown") {
      context.onIssue?.({
        code: "SEQ_UNRECOGNIZED_FORMAT",
        severity: "error",
        message: "Content is neither recognisable FASTA ('>' headers) nor FASTQ ('@'/'+' records); nothing was parsed",
      });
      return;
    }
    for (const issue of parsed.issues) context.onIssue?.(issue);

    const checksum = computeChecksum(input);
    const qualityGuess = parsed.kind === "fastq" ? guessQualityEncoding(parsed.qualities) : undefined;
    const limit = context.maxRecords ?? parsed.records.length;

    for (let index = 0; index < Math.min(parsed.records.length, limit); index++) {
      const record = parsed.records[index];
      const { lineNumber, ...recordData } = record;
      yield createCanonicalEnvelope({
        id: `seq-rec-${index}`,
        domain: "genomics",
        sourceFormat: "fasta-fastq",
        formatVersion: parsed.kind,
        content: { kind: "structured", data: recordData as unknown as Record<string, unknown> },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index,
        sourceLocation: `line ${lineNumber}`,
        filename: input.filename,
        checksum,
        encoding,
        metadata: {
          kind: parsed.kind,
          recordId: record.recordId,
          length: record.length,
          gcFraction: record.gcFraction,
          sequenceChecksum: record.sequenceChecksum,
          previewLength: MAX_PREVIEW_BASES,
          ...(qualityGuess ? { qualityEncodingGuess: qualityGuess } : {}),
        },
      });
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${FASTA_ADAPTER_ID} ${FASTA_ADAPTER_VERSION} (sequence metadata only; full sequences never inlined)`,
    };
  }
}
