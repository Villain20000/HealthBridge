import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createCanonicalEnvelope } from "@healthbridge/core";
import { CsvFormatAdapter, inferDomain, streamCsvRecordBatches, type CsvRecord } from "@healthbridge/adapters";
import { TransformationPipeline } from "@healthbridge/transformation-engine";
import type { TerminologyProvider } from "@healthbridge/validation";
import type { MappingDefinition } from "@healthbridge/mapping-engine";
import type { MedicalDataEnvelope, TransformationResult, ValidationIssue } from "@healthbridge/shared-types";
import { HealthBridgeError } from "./index.js";

const CSV_ADAPTER = new CsvFormatAdapter();

/** Exact fallback warning mirroring `decodeBuffer` for non-UTF-8 input. */
const WINDOWS_1252_WARNING =
  "File is not valid UTF-8; decoded as windows-1252. Accented or non-Latin characters may need explicit encoding configuration.";

function describeFile(filePath: string): { sizeBytes: number; filename: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HealthBridgeError("INPUT_NOT_FOUND", `Input file not found: ${filePath}`, "input", {
      source: filePath,
    });
  }
  if (!stat.isFile()) {
    throw new HealthBridgeError("INPUT_NOT_A_FILE", `Input path is not a file: ${filePath}`, "input", {
      source: filePath,
    });
  }
  return { sizeBytes: stat.size, filename: path.basename(filePath) };
}

function throwIfAborted(signal: AbortSignal | undefined, context: Record<string, unknown> = {}): void {
  if (signal?.aborted) {
    throw new HealthBridgeError("CANCELLED", "Transformation stream cancelled", "cancelled", context);
  }
}

interface FileDecoding {
  encoding: string;
  preambleBytes: number;
  warnings: string[];
}

function detectFileDecoding(first: Buffer, encodingOverride?: string): FileDecoding {
  if (encodingOverride) {
    try {
      new TextDecoder(encodingOverride);
    } catch {
      throw new HealthBridgeError(
        "UNSUPPORTED_ENCODING",
        `Text encoding '${encodingOverride}' is not supported by this runtime`,
        "usage",
      );
    }
    return { encoding: encodingOverride, preambleBytes: 0, warnings: [] };
  }
  if (first.length >= 3 && first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) {
    return { encoding: "utf-8-bom", preambleBytes: 3, warnings: [] };
  }
  if (first.length >= 2 && first[0] === 0xff && first[1] === 0xfe) {
    return { encoding: "utf-16le", preambleBytes: 2, warnings: [] };
  }
  if (first.length >= 2 && first[0] === 0xfe && first[1] === 0xff) {
    return { encoding: "utf-16be", preambleBytes: 2, warnings: [] };
  }
  const sample = first.subarray(0, 32768);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return { encoding: "utf-8", preambleBytes: 0, warnings: [] };
  } catch {
    return { encoding: "windows-1252", preambleBytes: 0, warnings: [WINDOWS_1252_WARNING] };
  }
}

function decoderFor(encoding: string): TextDecoder {
  const label = encoding === "utf-8-bom" ? "utf-8" : encoding;
  return new TextDecoder(label);
}

async function* readFileTextChunks(
  filePath: string,
  decoding: FileDecoding,
  chunkBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
  const decoder = decoderFor(decoding.encoding);
  let skippedPreamble = false;
  let firstText = true;
  try {
    for await (const bytes of stream) {
      throwIfAborted(signal);
      let buffer = bytes as Buffer;
      if (!skippedPreamble) {
        skippedPreamble = true;
        buffer = buffer.subarray(decoding.preambleBytes);
      }
      let text = decoder.decode(buffer, { stream: true });
      if (firstText) {
        firstText = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (text !== "") yield text;
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } finally {
    stream.destroy();
  }
}

async function checksumFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  try {
    for await (const bytes of stream) {
      throwIfAborted(signal, { phase: "checksum" });
      hash.update(bytes as Buffer);
    }
  } finally {
    stream.destroy();
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface CsvFileBatch {
  batchIndex: number;
  headers: string[];
  delimiter: string;
  encoding: string;
  records: CsvRecord[];
}

export interface CsvFileStreamOptions {
  /** Records per yielded batch. Defaults to 500. */
  batchSize?: number;
  /** Explicit delimiter; otherwise sniffed from the head of the file. */
  delimiter?: string;
  /** Stop after this many records (stops file reading early). */
  maxRecords?: number;
  /** Stream chunk size in bytes. Defaults to 65536. */
  chunkBytes?: number;
  /** Explicit text encoding (a `TextDecoder` label); otherwise sniffed. */
  encoding?: string;
  signal?: AbortSignal;
}

/**
 * Stream a CSV file from disk in record batches without ever loading the
 * whole file. Decoding, delimiter sniffing, header normalisation, ragged-row
 * reporting and line numbers match the buffered CSV adapter, so streamed and
 * buffered parses of the same file produce identical records.
 */
export async function* streamCsvFileBatches(
  filePath: string,
  options: CsvFileStreamOptions = {},
): AsyncGenerator<CsvFileBatch> {
  describeFile(filePath);
  throwIfAborted(options.signal);
  const chunkBytes =
    options.chunkBytes !== undefined && options.chunkBytes > 0 ? Math.floor(options.chunkBytes) : 65536;

  const head = await readHeadBytes(filePath, 32768 + 8, options.signal);
  // The encoding label is preserved for envelope metadata so streamed runs
  // report the same encoding as the buffered adapter.
  const decoding = detectFileDecoding(head, options.encoding);

  const textChunks = readFileTextChunks(filePath, decoding, chunkBytes, options.signal);
  for await (const batch of streamCsvRecordBatches(textChunks, {
    delimiter: options.delimiter,
    batchSize: options.batchSize,
    maxRecords: options.maxRecords,
    onIssue: () => undefined,
  })) {
    throwIfAborted(options.signal);
    yield {
      batchIndex: batch.batchIndex,
      headers: batch.headers,
      delimiter: batch.delimiter,
      encoding: decoding.encoding,
      records: batch.records,
    };
  }
}

async function readHeadBytes(filePath: string, count: number, signal?: AbortSignal): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    throwIfAborted(signal);
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface CsvFileStreamTransformOptions {
  filePath: string;
  mapping: MappingDefinition;
  adapterId?: string;
  maxRecords?: number;
  batchSize?: number;
  chunkBytes?: number;
  delimiter?: string;
  encoding?: string;
  runId?: string;
  /** Fixed import timestamp for reproducible runs. Defaults to the run start. */
  importedAt?: string;
  pipelineVersion?: string;
  redactSensitiveData?: boolean;
  /** Optional terminology provider: level 5 reports `executed` end-to-end. */
  terminology?: TerminologyProvider;
  signal?: AbortSignal;
  onBatch?: (batch: { batchIndex: number; recordIndexes: number[]; resources: unknown[] }) => void | Promise<void>;
}

/**
 * End-to-end streaming transform of a CSV file: the file is read in chunks
 * (two sequential passes — one for the checksum, one for parsing — with O(1)
 * memory), envelopes are built with the same ids, line numbers, warnings and
 * metadata as the buffered CSV adapter, and the pipeline consumes them
 * incrementally via `executeEnvelopes`.
 */
export async function transformCsvFileStreamed(options: CsvFileStreamTransformOptions): Promise<TransformationResult> {
  const { filename } = describeFile(options.filePath);
  throwIfAborted(options.signal);
  const runImportedAt = options.importedAt ?? new Date().toISOString();
  const adapterId = options.adapterId ?? CSV_ADAPTER.id;
  const adapterVersion = CSV_ADAPTER.version;

  const checksum = await checksumFile(options.filePath, options.signal);
  const head = await readHeadBytes(options.filePath, 32768 + 8, options.signal);
  const decoding = detectFileDecoding(head, options.encoding);

  const chunkBytes =
    options.chunkBytes !== undefined && options.chunkBytes > 0 ? Math.floor(options.chunkBytes) : 65536;
  const parseIssues: ValidationIssue[] = decoding.warnings.map((message) => ({
    code: "CSV_STRUCTURE_WARNING",
    severity: "warning",
    message,
  }));

  const textChunks = readFileTextChunks(options.filePath, decoding, chunkBytes, options.signal);

  let globalIndex = 0;

  async function* envelopes(): AsyncGenerator<MedicalDataEnvelope> {
    for await (const batch of streamCsvRecordBatches(textChunks, {
      delimiter: options.delimiter,
      batchSize: options.batchSize,
      maxRecords: options.maxRecords,
      onIssue: (issue) => {
        parseIssues.push({ code: issue.code, severity: issue.severity, message: issue.message });
      },
    })) {
      throwIfAborted(options.signal, { emitted: globalIndex });
      const domain = inferDomain(batch.headers);
      for (const record of batch.records) {
        const envelope = createCanonicalEnvelope({
          id: `csv-rec-${globalIndex}`,
          domain,
          sourceFormat: "csv",
          formatVersion: "RFC4180",
          content: { kind: "structured", data: record.data },
          importedAt: runImportedAt,
          adapterId,
          adapterVersion,
          recordIndex: globalIndex,
          sourceLocation: `line ${record.lineNumber}`,
          filename,
          checksum,
          encoding: decoding.encoding,
          metadata: {
            delimiter: batch.delimiter,
            encoding: decoding.encoding,
            columns: batch.headers.length,
            lineNumber: record.lineNumber,
            hasExtraCells: Array.isArray(record.data.__extra),
          },
          parseIssues: record.issues.map((issue) => ({
            ...issue,
            code: issue.code,
            location: `line ${record.lineNumber}`,
            recordIndex: globalIndex,
          })),
        });
        globalIndex++;
        yield envelope;
      }
    }
  }

  const pipeline = new TransformationPipeline();
  return pipeline.executeEnvelopes({
    envelopes: envelopes(),
    mapping: options.mapping,
    adapterId,
    adapterVersion,
    sourceFormat: "csv",
    parseIssues,
    inputChecksum: checksum,
    runId: options.runId,
    maxRecords: options.maxRecords,
    redactSensitiveData: options.redactSensitiveData,
    importedAt: runImportedAt,
    pipelineVersion: options.pipelineVersion,
    terminology: options.terminology,
    batchSize: options.batchSize,
    onBatch: options.onBatch,
  });
}
