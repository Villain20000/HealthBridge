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
