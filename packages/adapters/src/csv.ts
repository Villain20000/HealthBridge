/**
 * RFC 4180 compliant CSV tokenizer with encoding and delimiter detection.
 *
 * The previous implementation used `line.split(",")`, which silently corrupted
 * quoted values (`"Doe, John"`), multiline cells, CRLF files, UTF-8 BOM files
 * and semicolon-delimited exports. Everything here is dependency-free so the
 * CLI stays offline-capable.
 */

export interface DecodedText {
  text: string;
  encoding: string;
  warnings: string[];
}

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/** Decode a buffer, preferring UTF-8 and falling back to Windows-1252. */
export function decodeBuffer(buffer: Buffer): DecodedText {
  const warnings: string[] = [];

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      text: buffer.subarray(3).toString("utf-8"),
      encoding: "utf-8-bom",
      warnings,
    };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: decodeWith("utf-16le", buffer.subarray(2), warnings, "utf-16le"), encoding: "utf-16le", warnings };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeWith("utf-16be", buffer.subarray(2), warnings, "utf-16be"), encoding: "utf-16be", warnings };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: "utf-8", warnings };
  } catch {
    warnings.push(
      "File is not valid UTF-8; decoded as windows-1252. Accented or non-Latin characters may need explicit encoding configuration.",
    );
    return {
      text: decodeWith("windows-1252", buffer, warnings, "windows-1252"),
      encoding: "windows-1252",
      warnings,
    };
  }
}

function decodeWith(encoding: string, buffer: Buffer, warnings: string[], label: string): string {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    warnings.push(`Runtime cannot decode ${label}; falling back to utf-8 which may corrupt text.`);
    return buffer.toString("utf-8");
  }
}

/**
 * Guess the delimiter from the first sample of logical lines. Consistency wins
 * over raw frequency so that a comma inside quoted prose cannot outvote a real
 * semicolon delimiter.
 */
export function sniffDelimiter(
  text: string,
  sampleLines = 10,
): {
  delimiter: (typeof CANDIDATE_DELIMITERS)[number];
  confidence: number;
} {
  const sample = firstLogicalLines(text, sampleLines);
  if (sample.length === 0) return { delimiter: ",", confidence: 0 };

  let best: { delimiter: (typeof CANDIDATE_DELIMITERS)[number]; confidence: number } = {
    delimiter: ",",
    confidence: 0,
  };

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));
    const total = counts.reduce((sum, c) => sum + c, 0);
    if (total === 0) continue;
    const nonZero = counts.filter((c) => c > 0).length;
    const consistency = nonZero / counts.length;
    const distinct = new Set(counts.filter((c) => c > 0));
    const uniformity = distinct.size === 1 ? 1 : 1 / distinct.size;
    const confidence = Number((consistency * 0.6 + uniformity * 0.4).toFixed(3));
    if (confidence > best.confidence) best = { delimiter, confidence };
  }

  return best;
}

function firstLogicalLines(text: string, limit: number): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length && lines.length < limit; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (current.trim() !== "") lines.push(current);
      current = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "" && lines.length < limit) lines.push(current);
  return lines;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) count++;
  }
  return count;
}

export interface CsvRow {
  cells: string[];
  /** 1-based physical line number where the row starts. */
  lineNumber: number;
}

export interface TokenizeResult {
  rows: CsvRow[];
  /** Set when the file ended inside an unterminated quoted cell. */
  unterminatedQuote: boolean;
}

export function tokenizeCsv(text: string, delimiter: string): TokenizeResult {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;

  const pushCell = (): void => {
    cells.push(cell);
    cell = "";
  };

  const pushRow = (): void => {
    pushCell();
    const isEmpty = cells.length === 1 && cells[0].trim() === "";
    if (!isEmpty) rows.push({ cells, lineNumber: rowStartLine });
    cells = [];
    rowStartLine = lineNumber;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
        continue;
      }
      if (ch === "\n") lineNumber++;
      cell += ch;
      continue;
    }

    if (ch === '"' && cell === "") {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      pushCell();
      continue;
    }

    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      lineNumber++;
      pushRow();
      rowStartLine = lineNumber;
      continue;
    }

    if (ch === "\n") {
      lineNumber++;
      pushRow();
      rowStartLine = lineNumber;
      continue;
    }

    cell += ch;
  }

  if (cell !== "" || cells.length > 0) pushRow();

  return { rows, unterminatedQuote: inQuotes };
}

export interface CsvTable {
  headers: string[];
  /** Header problems (duplicates, empty names, BOM remnants). */
  warnings: string[];
  rows: CsvRow[];
  delimiter: string;
  encoding: string;
  unterminatedQuote: boolean;
  duplicateHeaders: string[];
}

export function normaliseHeaders(rawHeaders: string[]): {
  headers: string[];
  warnings: string[];
  duplicateHeaders: string[];
} {
  const warnings: string[] = [];
  const duplicateHeaders: string[] = [];
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((raw, index) => {
    let name = raw.replace(/^\uFEFF/, "").trim();
    if (name === "") {
      name = `column_${index + 1}`;
      warnings.push(`Empty header at position ${index + 1} renamed to '${name}'`);
    }
    const count = seen.get(name) ?? 0;
    if (count > 0) {
      const renamed = `${name}_${count + 1}`;
      duplicateHeaders.push(name);
      warnings.push(`Duplicate header '${name}' renamed to '${renamed}'`);
      seen.set(name, count + 1);
      return renamed;
    }
    seen.set(name, 1);
    return name;
  });
  return { headers, warnings, duplicateHeaders };
}

export function readCsvTable(
  input: { buffer?: Buffer; contentString?: string },
  options: {
    delimiter?: string;
  } = {},
): CsvTable {
  const decoded = input.buffer
    ? decodeBuffer(input.buffer)
    : { text: stripBom(input.contentString ?? ""), encoding: "utf-8", warnings: [] as string[] };

  const text = decoded.text;
  const sniffed = sniffDelimiter(text);
  const delimiter = options.delimiter ?? sniffed.delimiter;
  const warnings = [...decoded.warnings];

  if (!options.delimiter && sniffed.confidence > 0 && sniffed.confidence < 0.6) {
    warnings.push(
      `Delimiter detection confidence is low (${sniffed.confidence}); assuming '${delimiter}'. Use --delimiter to override.`,
    );
  }

  const { rows, unterminatedQuote } = tokenizeCsv(text, delimiter);
  if (unterminatedQuote) {
    warnings.push("File ends inside a quoted cell (unterminated quote); the last record may be truncated.");
  }

  if (rows.length === 0) {
    return {
      headers: [],
      warnings: [...warnings, "No tabular content found"],
      rows: [],
      delimiter,
      encoding: decoded.encoding,
      unterminatedQuote,
      duplicateHeaders: [],
    };
  }

  const headerRow = rows[0];
  const normalised = normaliseHeaders(headerRow.cells);

  return {
    headers: normalised.headers,
    warnings: [...warnings, ...normalised.warnings],
    rows: rows.slice(1),
    delimiter,
    encoding: decoded.encoding,
    unterminatedQuote,
    duplicateHeaders: normalised.duplicateHeaders,
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface CsvRecord {
  data: Record<string, unknown>;
  lineNumber: number;
  issues: Array<{ code: string; message: string; severity: "warning" | "error" }>;
}

/* -------------------------------------------------------------------------- */
/* Chunked (streaming) CSV tokenization                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bounded-memory CSV tokenization. Feed decoded text chunks with `push`;
 * each call returns the rows that completed inside the chunk. `finish`
 * flushes the trailing row and reports an unterminated quote, mirroring
 * `tokenizeCsv` exactly (same rows, same 1-based line numbers) no matter
 * where chunk boundaries fall — including inside quoted cells, `""`
 * escapes and split CRLF sequences.
 */
export interface ChunkedCsvTokenizer {
  push(chunk: string): CsvRow[];
  finish(): { rows: CsvRow[]; unterminatedQuote: boolean };
}

export function createChunkedCsvTokenizer(delimiter: string, startLine = 1): ChunkedCsvTokenizer {
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let lineNumber = startLine;
  let rowStartLine = startLine;
  /** Previous chunk ended with `\r` outside quotes: the `\n` may still follow. */
  let pendingCarriageReturn = false;
  /** Previous chunk ended with `"` inside quotes: escape or close is undecided. */
  let pendingQuote = false;

  let rows: CsvRow[] = [];

  return {
    push(chunk: string): CsvRow[] {
      rows = [];
      let index = 0;

      if (pendingQuote) {
        pendingQuote = false;
        if (chunk[0] === '"') {
          cell += '"';
          index = 1;
        } else {
          inQuotes = false;
        }
      } else if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (chunk[0] === "\n") index = 1;
        lineNumber++;
        pushRowShim();
      }

      for (; index < chunk.length; index++) {
        const ch = chunk[index];

        if (inQuotes) {
          if (ch === '"') {
            if (index + 1 < chunk.length) {
              if (chunk[index + 1] === '"') {
                cell += '"';
                index++;
              } else {
                inQuotes = false;
              }
            } else {
              // Chunk ends right after the quote: wait for the next chunk to
              // decide between an escaped quote and a closing quote.
              pendingQuote = true;
            }
            continue;
          }
          if (ch === "\n") lineNumber++;
          cell += ch;
          continue;
        }

        if (ch === '"' && cell === "") {
          inQuotes = true;
          continue;
        }

        if (ch === delimiter) {
          cells.push(cell);
          cell = "";
          continue;
        }

        if (ch === "\r") {
          if (index + 1 < chunk.length) {
            if (chunk[index + 1] === "\n") index++;
            lineNumber++;
            pushRowShim();
          } else {
            // Chunk ends with `\r`: the `\n` of a CRLF may still follow.
            pendingCarriageReturn = true;
          }
          continue;
        }

        if (ch === "\n") {
          lineNumber++;
          pushRowShim();
          continue;
        }

        cell += ch;
      }

      const completed = rows;
      rows = [];
      return completed;
    },

    finish(): { rows: CsvRow[]; unterminatedQuote: boolean } {
      rows = [];
      if (pendingQuote) {
        // A trailing `"` closes the quoted cell, as in `tokenizeCsv`.
        pendingQuote = false;
        inQuotes = false;
      }
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        lineNumber++;
        pushRowShim();
      }
      const unterminatedQuote = inQuotes;
      if (cell !== "" || cells.length > 0) {
        cells.push(cell);
        cell = "";
        const isEmpty = cells.length === 1 && cells[0].trim() === "";
        if (!isEmpty) rows.push({ cells, lineNumber: rowStartLine });
        cells = [];
      }
      const trailing = rows;
      rows = [];
      cells = [];
      cell = "";
      return { rows: trailing, unterminatedQuote };
    },
  };

  function pushRowShim(): void {
    cells.push(cell);
    cell = "";
    const isEmpty = cells.length === 1 && cells[0].trim() === "";
    if (!isEmpty) rows.push({ cells, lineNumber: rowStartLine });
    cells = [];
    rowStartLine = lineNumber;
    pendingCarriageReturn = false;
  }
}

export interface CsvRecordBatch {
  /** Zero-based batch sequence number. */
  batchIndex: number;
  /** Normalised header row shared by every batch of the stream. */
  headers: string[];
  /** Delimiter used for the stream (explicit option or sniffed). */
  delimiter: string;
  /** Records in this batch, with line numbers and ragged-row issues. */
  records: CsvRecord[];
}

export interface CsvStreamOptions {
  /** Explicit delimiter; otherwise sniffed from the first buffered text. */
  delimiter?: string;
  /** Characters buffered for delimiter sniffing before tokenizing. Defaults to 32768. */
  sniffSampleChars?: number;
  /** Records per yielded batch. Defaults to 500. */
  batchSize?: number;
  /** Stop after this many records (mirrors `ParseContext.maxRecords`). */
  maxRecords?: number;
  /**
   * Structural warnings (header problems, low sniff confidence, unterminated
   * quote). Mirrors the warnings `readCsvTable` reports for buffered input.
   */
  onIssue?: (issue: { code: string; message: string; severity: "warning" | "error" }) => void;
}

/**
 * Stream decoded CSV text into record batches with bounded memory: only the
 * sniff sample, one in-flight row and the current batch are ever retained.
 * Header handling, delimiter sniffing, ragged-row reporting and line numbers
 * match `readCsvTable` + `buildCsvRecords`, so streamed and buffered parses
 * of the same input produce identical records.
 */
export async function* streamCsvRecordBatches(
  textChunks: AsyncIterable<string>,
  options: CsvStreamOptions = {},
): AsyncGenerator<CsvRecordBatch> {
  const batchSize = options.batchSize !== undefined && options.batchSize > 0 ? Math.floor(options.batchSize) : 500;
  const sampleChars =
    options.sniffSampleChars !== undefined && options.sniffSampleChars > 0 ? options.sniffSampleChars : 32768;

  // Buffer until the sniff sample is full; short inputs just buffer entirely.
  // Everything consumed here lives in `buffered` — remaining text is pulled
  // lazily via `take`, so at most the sample plus one chunk is ever retained.
  let buffered = "";
  const source: AsyncGenerator<string> = (async function* () {
    yield* textChunks;
  })();
  const iterator = source[Symbol.asyncIterator]();
  let exhausted = false;
  const take = async (): Promise<string | undefined> => {
    if (exhausted) return undefined;
    const next = await iterator.next();
    if (next.done) {
      exhausted = true;
      return undefined;
    }
    return next.value;
  };

  let chunk = await take();
  while (chunk !== undefined && buffered.length < sampleChars) {
    buffered += chunk;
    chunk = buffered.length >= sampleChars ? undefined : await take();
  }

  const sniffed = sniffDelimiter(buffered);
  const delimiter = options.delimiter ?? sniffed.delimiter;
  if (!options.delimiter && sniffed.confidence > 0 && sniffed.confidence < 0.6) {
    options.onIssue?.({
      code: "CSV_STRUCTURE_WARNING",
      severity: "warning",
      message: `Delimiter detection confidence is low (${sniffed.confidence}); assuming '${delimiter}'. Use --delimiter to override.`,
    });
  }

  const tokenizer = createChunkedCsvTokenizer(delimiter);
  let headers: string[] | undefined;
  let batch: CsvRecord[] = [];
  let batchIndex = 0;
  let emitted = 0;

  const convert = (rows: CsvRow[]): CsvRecord[] => {
    if (!headers) return [];
    const table: CsvTable = {
      headers,
      warnings: [],
      rows,
      delimiter,
      encoding: "utf-8",
      unterminatedQuote: false,
      duplicateHeaders: [],
    };
    return buildCsvRecords(table).records;
  };

  const flushBatch = function* (): Generator<CsvRecordBatch> {
    if (batch.length === 0 || !headers) return;
    yield { batchIndex: batchIndex++, headers, delimiter, records: batch };
    batch = [];
  };

  const feedRows = function* (rows: CsvRow[]): Generator<CsvRecordBatch> {
    if (rows.length === 0) return;
    if (!headers) {
      const headerRow = rows[0];
      const normalised = normaliseHeaders(headerRow.cells);
      for (const warning of normalised.warnings) {
        options.onIssue?.({ code: "CSV_STRUCTURE_WARNING", severity: "warning", message: warning });
      }
      headers = normalised.headers;
      rows = rows.slice(1);
    }
    for (const record of convert(rows)) {
      if (options.maxRecords !== undefined && emitted >= options.maxRecords) return;
      batch.push(record);
      emitted++;
      if (batch.length >= batchSize) yield* flushBatch();
      if (options.maxRecords !== undefined && emitted >= options.maxRecords) return;
    }
  };

  const feedText = function* (text: string): Generator<CsvRecordBatch> {
    if (options.maxRecords !== undefined && emitted >= options.maxRecords) return;
    yield* feedRows(tokenizer.push(text));
  };

  if (buffered !== "") yield* feedText(buffered);
  if (options.maxRecords === undefined || emitted < options.maxRecords) {
    for (;;) {
      const next = await take();
      if (next === undefined) break;
      yield* feedText(next);
      if (options.maxRecords !== undefined && emitted >= options.maxRecords) break;
    }
  }
  if (options.maxRecords === undefined || emitted < options.maxRecords) {
    const { rows, unterminatedQuote } = tokenizer.finish();
    if (unterminatedQuote) {
      options.onIssue?.({
        code: "CSV_STRUCTURE_WARNING",
        severity: "warning",
        message: "File ends inside a quoted cell (unterminated quote); the last record may be truncated.",
      });
    }
    if (rows.length > 0) {
      if (!headers) {
        const normalised = normaliseHeaders(rows[0].cells);
        for (const warning of normalised.warnings) {
          options.onIssue?.({ code: "CSV_STRUCTURE_WARNING", severity: "warning", message: warning });
        }
        headers = normalised.headers;
        yield* feedRows(rows.slice(1));
      } else {
        yield* feedRows(rows);
      }
    } else if (!headers) {
      options.onIssue?.({ code: "CSV_STRUCTURE_WARNING", severity: "warning", message: "No tabular content found" });
    }
  }
  yield* flushBatch();
}

/** Build one record per row, reporting ragged rows instead of padding silently. */
export function buildCsvRecords(table: CsvTable): { records: CsvRecord[]; warnings: string[] } {
  const records: CsvRecord[] = [];
  const warnings: string[] = [];

  for (const row of table.rows) {
    const issues: CsvRecord["issues"] = [];
    const data: Record<string, unknown> = {};

    if (row.cells.length !== table.headers.length) {
      const delta = row.cells.length - table.headers.length;
      issues.push({
        code: "RAGGED_ROW",
        severity: "warning",
        message:
          delta > 0
            ? `Row has ${delta} more cell(s) than the header defines; extra values preserved under __extra`
            : `Row has ${Math.abs(delta)} missing cell(s); missing values treated as empty`,
      });
    }

    table.headers.forEach((header, index) => {
      data[header] = row.cells[index] ?? "";
    });

    if (row.cells.length > table.headers.length) {
      data.__extra = row.cells.slice(table.headers.length);
    }

    records.push({ data, lineNumber: row.lineNumber, issues });
  }

  return { records, warnings };
}
