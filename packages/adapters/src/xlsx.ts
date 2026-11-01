/**
 * XLSX / XLSM adapter — workbook structure plus typed row records.
 *
 * Status is honestly `metadata-only`: sheets are enumerated, the first
 * non-blank row of each sheet is treated as the header, and every data row
 * is carried structurally with typed cell values (shared strings, inline
 * strings, numbers, booleans, error tokens and 1900/1904-epoch date serials
 * reported with both the raw serial and the derived ISO string). Formula
 * cells are NEVER evaluated — the cached value is carried alongside the
 * formula text with an explicit warning. Merged ranges are reported as a
 * limitation and are never expanded (only the top-left cell carries the
 * value). Legacy binary `.xls` (OLE2/BIFF) is refused with an explicit
 * issue, never sniffed as text. Macros in `.xlsm` files are ignored; only
 * the sheet XML is read. No clinical interpretation is performed.
 *
 * The reader is dependency-free (Node built-ins only): ZIP entries are
 * inflated with `node:zlib` (`inflateRawSync` over stored/deflated entries)
 * and the SpreadsheetML parts are scanned structurally — no external XML or
 * ZIP library is used. Rows are streamed per sheet: `parse()` drives a
 * row-by-row generator so only the current row's cells are materialised,
 * never the whole sheet.
 */

import { inflateRawSync } from "node:zlib";
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

export const XLSX_ADAPTER_ID = "xlsx-adapter";
export const XLSX_ADAPTER_VERSION = "1.0.0";

/** SpreadsheetML format-version label used in envelopes and inspections. */
export const XLSX_FORMAT_VERSION = "OOXML SpreadsheetML";

/** Refuse any single ZIP entry inflated beyond this size (zip-bomb guard). */
export const XLSX_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Refuse a workbook whose inflated entries exceed this in total (zip-bomb guard). */
export const XLSX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/** Built-in number-format ids that are dates by definition (ECMA-376 §18.8.30). */
const BUILTIN_DATE_NUM_FMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 57,
]);

/** OLE2 compound-document magic: the signature of a legacy binary `.xls`. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function toBuffer(input: InputDescriptor): Buffer | undefined {
  if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
  return undefined;
}

function hasZipMagic(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

function isOle2(data: Buffer): boolean {
  if (data.length < 8) return false;
  return OLE2_MAGIC.every((byte, index) => data[index] === byte);
}

function inferXlsxDomain(headers: string[]): MedicalDomain {
  const haystack = headers.join(" ").toLowerCase();
  if (/(loinc|specimen|analyte|result_value|reference_range|culture|assay|\blab\b)/.test(haystack)) {
    return "laboratory";
  }
  if (/(dicom|modality|pixel|radiolog)/.test(haystack)) return "imaging";
  if (/(vcf|variant|chrom|allele|fastq|reference_genome|assembly|rsid)/.test(haystack)) return "genomics";
  if (/(biobank|aliquot|freezer|biospecimen|cryo)/.test(haystack)) return "biobanking";
  if (/(trial|cohort|protocol|consent|cdisc|omop)/.test(haystack)) return "research";
  if (/(ecg|eeg|waveform|sampling_rate|heart_rate|\bedf\b|\bwfdb\b)/.test(haystack)) return "waveform";
  return "clinical";
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (stored + deflated entries, Node built-ins only)
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function u16(data: Buffer, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function u32(data: Buffer, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function findEocd(data: Buffer): number {
  const start = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= start; i--) {
    if (u32(data, i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

/** List central-directory entries without inflating anything (used for sniffing). */
export function listZipEntries(data: Buffer): ZipEntry[] {
  const eocd = findEocd(data);
  if (eocd < 0) throw new Error("not-a-zip: end-of-central-directory not found");
  const count = u16(data, eocd + 10);
  const cdSize = u32(data, eocd + 12);
  const cdOffset = u32(data, eocd + 16);
  if (cdOffset + cdSize > data.length) throw new Error("zip-central-directory-out-of-bounds");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || u32(data, p) !== ZIP_CENTRAL_SIG) {
      throw new Error("zip-central-directory-corrupt");
    }
    const flags = u16(data, p + 8);
    const method = u16(data, p + 10);
    const compressedSize = u32(data, p + 20);
    const uncompressedSize = u32(data, p + 24);
    const nameLength = u16(data, p + 28);
    const extraLength = u16(data, p + 30);
    const commentLength = u16(data, p + 32);
    const localHeaderOffset = u32(data, p + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("zip64-not-supported");
    }
    const name = data.subarray(p + 46, p + 46 + nameLength).toString("utf-8");
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extract one entry. Sizes come from the central directory (authoritative
 * even when the local header uses a data descriptor with zeroed sizes).
 */
export function extractZipEntry(data: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (p + 30 > data.length || u32(data, p) !== ZIP_LOCAL_SIG) {
    throw new Error(`local-header-missing:${entry.name}`);
  }
  if ((u16(data, p + 6) & 0x1) !== 0) throw new Error(`encrypted-entry:${entry.name}`);
  const method = u16(data, p + 8);
  const nameLength = u16(data, p + 26);
  const extraLength = u16(data, p + 28);
  const start = p + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) throw new Error(`entry-out-of-bounds:${entry.name}`);
  if (entry.uncompressedSize > XLSX_MAX_ENTRY_BYTES) {
    throw new Error(`entry-too-large:${entry.name}`);
  }
  const raw = data.subarray(start, end);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported-compression-${method}:${entry.name}`);
}

// ---------------------------------------------------------------------------
// Structural SpreadsheetML scanning (no XML library)
// ---------------------------------------------------------------------------

const ENTITY_FALLBACKS: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decode the five predefined entities plus numeric character references. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g, (match, named, dec, hex) => {
    if (named !== undefined) return ENTITY_FALLBACKS[named as string] ?? match;
    const code = dec !== undefined ? Number.parseInt(dec as string, 10) : Number.parseInt(hex as string, 16);
    if (!Number.isFinite(code)) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

/** Parse `key="value"` pairs (namespace prefixes kept verbatim, e.g. `r:id`). */
export function parseXmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrText)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

/** `A` -> 0, `Z` -> 25, `AA` -> 26, ... */
export function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < "A" || ch > "Z") throw new Error(`invalid-column-letters:${letters}`);
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0 -> `A`, 25 -> `Z`, 26 -> `AA`, ... */
export function columnIndexToLetters(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid-column-index:${String(index)}`);
  let letters = "";
  let rest = index;
  while (rest >= 0) {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  }
  return letters;
}

/** Split `BC12` into a 0-based column index and a 1-based row number. */
export function splitCellRef(ref: string): { columnIndex: number; rowNumber: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  return { columnIndex: columnLettersToIndex(match[1]), rowNumber: Number.parseInt(match[2], 10) };
}

/**
 * Heuristic date-format check for custom `formatCode`s. Quoted literals and
 * `[...]` conditions/colours are stripped first; any remaining y/d/h/s token
 * (or a bare `m`, which in a number format can only be month or minutes)
 * marks the format as a date. `General`, plain numbers and currency codes do
 * not match. The call is structural guesswork — the raw serial is always
 * preserved alongside the derived ISO string.
 */
export function isDateFormatCode(formatCode: string): boolean {
  const stripped = formatCode.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  if (/[yY]/.test(stripped)) return true;
  if (/[dD]/.test(stripped)) return true;
  if (/[hH]/.test(stripped)) return true;
  if (/[sS]/.test(stripped)) return true;
  if (/am\/pm/i.test(formatCode)) return true;
  if (/m/i.test(stripped)) return true;
  return false;
}

/**
 * Convert an Excel date serial to an ISO-8601 UTC string. Day 25569 is
 * 1970-01-01 (the well-known round-trip anchor). In the 1900 system the
 * fictitious 1900-02-29 leap day shifts serials 1-60 by one day versus what
 * Excel displays; that quirk is inherent to the format, so the raw serial is
 * always carried next to the ISO string. Returns `null` when out of range.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  if (serial < 0 || serial > 2958465) return null;
  const baseMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(baseMs + Math.round(serial * 86400000));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface XlsxSheetRef {
  name: string;
  sheetId: string;
  relId?: string;
  order: number;
}

export interface XlsxWorkbookInfo {
  sheets: XlsxSheetRef[];
  date1904: boolean;
}

/** Parse `xl/workbook.xml`: sheet names/ids in order plus the 1904 flag. */
export function parseWorkbookXml(xml: string): XlsxWorkbookInfo {
  const sheets: XlsxSheetRef[] = [];
  const block = /<(?:\w+:)?sheets\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheets\s*>/.exec(xml);
  const scope = block ? block[1] : xml;
  const re = /<(?:\w+:)?sheet\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = re.exec(scope)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    sheets.push({
      name: attrs["name"] ?? `Sheet${order + 1}`,
      sheetId: attrs["sheetId"] ?? String(order + 1),
      relId: attrs["r:id"] ?? attrs["id"],
      order: order++,
    });
  }
  const pr = /<(?:\w+:)?workbookPr\b([^>]*?)\/?>/.exec(xml);
  const date1904 = pr ? parseXmlAttributes(pr[1])["date1904"] === "1" : false;
  return { sheets, date1904 };
}

/** Parse `xl/_rels/workbook.xml.rels`: relationship id -> target part. */
export function parseWorkbookRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<(?:\w+:)?Relationship\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    if (attrs["Id"] && attrs["Target"]) map.set(attrs["Id"], attrs["Target"]);
  }
  return map;
}

/** Normalise a workbook-relationship target to a ZIP entry path. */
export function resolveSheetTarget(target: string): string {
  const cleaned = target.replace(/\\/g, "/").replace(/^\//, "").replace(/^\.\//, "");
  if (cleaned.startsWith("xl/")) return cleaned;
  return `xl/${cleaned}`;
}

/** Parse `xl/sharedStrings.xml` into an index-addressed string table. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si\s*>/g;
  let si: RegExpExecArray | null;
  while ((si = siRe.exec(xml)) !== null) {
    const parts: string[] = [];
    const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t\s*>/g;
    let t: RegExpExecArray | null;
    let found = false;
    while ((t = tRe.exec(si[1])) !== null) {
      found = true;
      parts.push(decodeXmlEntities(t[1]));
    }
    out.push(found ? parts.join("") : "");
  }
  return out;
}

export interface XlsxStyles {
  /** Parallel to the `<xf>` entries of `<cellXfs>`; true means "renders as a date". */
  isDateStyle: boolean[];
}

/** Parse `xl/styles.xml`: custom formats plus the ordered `<cellXfs>` table. */
export function parseStyles(xml: string): XlsxStyles {
  const numFmts = new Map<number, string>();
  const nfRe = /<(?:\w+:)?numFmt\b([^>]*?)\/?>/g;
  let nf: RegExpExecArray | null;
  while ((nf = nfRe.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(nf[1]);
    const id = Number(attrs["numFmtId"]);
    if (Number.isInteger(id) && attrs["formatCode"] !== undefined) numFmts.set(id, attrs["formatCode"]);
  }
  const isDateStyle: boolean[] = [];
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs\s*>/.exec(xml);
  if (xfs) {
    const xfRe = /<(?:\w+:)?xf\b([^>]*?)\/?>/g;
    let xf: RegExpExecArray | null;
    while ((xf = xfRe.exec(xfs[1])) !== null) {
      const id = Number(parseXmlAttributes(xf[1])["numFmtId"] ?? "0");
      isDateStyle.push(
        BUILTIN_DATE_NUM_FMT_IDS.has(id) || (numFmts.has(id) ? isDateFormatCode(numFmts.get(id)!) : false),
      );
    }
  }
  return { isDateStyle };
}

/** Collect `<mergeCell ref="A1:B2"/>` ranges (reported, never expanded). */
export function parseMergedRanges(sheetXml: string): string[] {
  const ranges: string[] = [];
  const re = /<(?:\w+:)?mergeCell\b[^>]*ref="([^"]*)"[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sheetXml)) !== null) {
    if (match[1] !== "") ranges.push(match[1]);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Row streaming: one row at a time, never the whole sheet
// ---------------------------------------------------------------------------

export type XlsxCellType = "text" | "number" | "boolean" | "date" | "blank" | "error";

export interface XlsxRawCell {
  ref?: string;
  typeAttr?: string;
  styleIndex?: number;
  formula?: string;
  valueText?: string;
  inlineText?: string;
}

export interface XlsxRawRow {
  rowNumber?: number;
  cells: XlsxRawCell[];
}

function parseRawCell(attrText: string, inner: string | undefined): XlsxRawCell {
  const attrs = parseXmlAttributes(attrText);
  const cell: XlsxRawCell = {};
  if (attrs["r"]) cell.ref = attrs["r"];
  if (attrs["t"]) cell.typeAttr = attrs["t"];
  if (attrs["s"] !== undefined && attrs["s"] !== "") {
    const styleIndex = Number(attrs["s"]);
    if (Number.isInteger(styleIndex) && styleIndex >= 0) cell.styleIndex = styleIndex;
  }
  if (inner) {
    const formula = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f\s*>/.exec(inner);
    if (formula) cell.formula = decodeXmlEntities(formula[1]);
    const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v\s*>/.exec(inner);
    if (value) cell.valueText = decodeXmlEntities(value[1].trim());
    const inline = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is\s*>/.exec(inner);
    if (inline) {
      const parts: string[] = [];
      const tRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t\s*>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(inline[1])) !== null) parts.push(decodeXmlEntities(t[1]));
      cell.inlineText = parts.join("");
    }
  }
  return cell;
}

/**
 * Yield raw rows in document order. Only the current `<row>` match is held;
 * callers must not accumulate the generator. Scoped to `<sheetData>` when
 * present so header/footer parts can never leak in as rows.
 */
export function* streamSheetRows(sheetXml: string): Generator<XlsxRawRow, void, void> {
  const data = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData\s*>/.exec(sheetXml);
  const scope = data ? data[1] : sheetXml;
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row\s*>)/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(scope)) !== null) {
    const attrs = parseXmlAttributes(rowMatch[1]);
    const inner = rowMatch[2] ?? "";
    const cells: XlsxRawCell[] = [];
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c\s*>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      cells.push(parseRawCell(cellMatch[1], cellMatch[2]));
    }
    const parsed = attrs["r"] !== undefined ? Number(attrs["r"]) : NaN;
    yield { rowNumber: Number.isInteger(parsed) ? parsed : undefined, cells };
  }
}

export interface XlsxResolvedCell {
  type: XlsxCellType;
  value: string | number | boolean | null;
  dateSerial?: number;
  badSharedRef?: boolean;
}

/**
 * Resolve one raw cell to a typed value. Dates need a style that renders as
 * a date AND a serial inside the supported range; anything else numeric
 * stays a number. Formulae are NOT evaluated here — the cached `<v>` value
 * is typed exactly like a plain cell and the caller reports the formula.
 */
export function resolveXlsxCell(
  cell: XlsxRawCell,
  sharedStrings: string[],
  styles: XlsxStyles,
  date1904: boolean,
): XlsxResolvedCell {
  const kind = cell.typeAttr ?? "n";
  if (kind === "s") {
    const index = cell.valueText === undefined ? NaN : Number(cell.valueText);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
      return { type: "text", value: null, badSharedRef: true };
    }
    return { type: "text", value: sharedStrings[index] };
  }
  if (kind === "inlineStr") return { type: "text", value: cell.inlineText ?? "" };
  if (kind === "b") {
    if (cell.valueText === "1") return { type: "boolean", value: true };
    if (cell.valueText === "0") return { type: "boolean", value: false };
    return { type: "boolean", value: null };
  }
  if (kind === "str") return { type: "text", value: cell.valueText ?? "" };
  if (kind === "e") return { type: "error", value: cell.valueText ?? "" };
  if (cell.valueText === undefined || cell.valueText === "") return { type: "blank", value: null };
  const numeric = Number(cell.valueText);
  if (!Number.isFinite(numeric)) return { type: "text", value: cell.valueText };
  const styledAsDate = cell.styleIndex !== undefined && styles.isDateStyle[cell.styleIndex] === true;
  if (styledAsDate) {
    const iso = excelSerialToIso(numeric, date1904);
    if (iso !== null) return { type: "date", value: iso, dateSerial: numeric };
  }
  return { type: "number", value: numeric };
}

/** Map each cell to a 0-based column: explicit `r` refs win, otherwise positional. */
function columnPositions(cells: XlsxRawCell[]): number[] {
  const positions: number[] = [];
  let cursor = 0;
  for (const cell of cells) {
    const split = cell.ref ? splitCellRef(cell.ref) : null;
    const position = split ? split.columnIndex : cursor;
    positions.push(position);
    cursor = position + 1;
  }
  return positions;
}

function isRowBlank(resolved: XlsxResolvedCell[]): boolean {
  return resolved.every((cell) => cell.value === null || (typeof cell.value === "string" && cell.value.trim() === ""));
}

export interface XlsxHeaderDetection {
  headers: string[];
  hadBlank: boolean;
  hadDuplicate: boolean;
}

/** Derive header labels from the first non-blank row (labels trimmed). */
export function detectXlsxHeaders(resolved: XlsxResolvedCell[], positions: number[]): XlsxHeaderDetection {
  const width = positions.reduce((max, p) => Math.max(max, p + 1), 0);
  const slots = new Map<number, XlsxResolvedCell>();
  resolved.forEach((cell, i) => slots.set(positions[i], cell));
  const headers: string[] = [];
  const seen = new Map<string, number>();
  let hadBlank = false;
  let hadDuplicate = false;
  for (let index = 0; index < width; index++) {
    const cell = slots.get(index);
    const raw = cell && cell.value !== null ? String(cell.value).trim() : "";
    let label = raw;
    if (label === "") {
      label = `Column${columnIndexToLetters(index)}`;
      hadBlank = true;
    }
    const seenCount = seen.get(label) ?? 0;
    seen.set(label, seenCount + 1);
    if (seenCount > 0) {
      label = `${label} (${seenCount + 1})`;
      hadDuplicate = true;
    }
    headers.push(label);
  }
  return { headers, hadBlank, hadDuplicate };
}

export interface XlsxRowRecord {
  rowNumber: number;
  values: Record<string, string | number | boolean | null>;
  cellTypes: Record<string, XlsxCellType>;
  formulas: Record<string, string>;
  dateSerials: Record<string, number>;
  errorCells: string[];
  hasFormula: boolean;
  width: number;
}

/** Map one data row onto headers; columns past the header row get `ColumnX` keys. */
export function buildXlsxRowRecord(
  rowNumber: number,
  cells: XlsxRawCell[],
  resolved: XlsxResolvedCell[],
  positions: number[],
  headers: string[],
): XlsxRowRecord {
  const slots = new Map<number, { raw: XlsxRawCell; resolved: XlsxResolvedCell }>();
  cells.forEach((raw, i) => slots.set(positions[i], { raw, resolved: resolved[i] }));
  const width = Math.max(
    headers.length,
    positions.reduce((max, p) => Math.max(max, p + 1), 0),
  );
  const values: Record<string, string | number | boolean | null> = {};
  const cellTypes: Record<string, XlsxCellType> = {};
  const formulas: Record<string, string> = {};
  const dateSerials: Record<string, number> = {};
  const errorCells: string[] = [];
  for (let index = 0; index < width; index++) {
    const key = index < headers.length ? headers[index] : `Column${columnIndexToLetters(index)}`;
    const hit = slots.get(index);
    if (!hit) {
      values[key] = null;
      cellTypes[key] = "blank";
      continue;
    }
    values[key] = hit.resolved.value;
    cellTypes[key] = hit.resolved.type;
    if (hit.raw.formula !== undefined && hit.raw.formula !== "") formulas[key] = hit.raw.formula;
    if (hit.resolved.dateSerial !== undefined) dateSerials[key] = hit.resolved.dateSerial;
    if (hit.resolved.type === "error") errorCells.push(key);
  }
  return {
    rowNumber,
    values,
    cellTypes,
    formulas,
    dateSerials,
    errorCells,
    hasFormula: Object.keys(formulas).length > 0,
    width,
  };
}

export type XlsxSheetEvent =
  | { kind: "headers"; headers: string[]; headerRowNumber: number; hadBlank: boolean; hadDuplicate: boolean }
  | { kind: "record"; record: XlsxRowRecord }
  | { kind: "end"; dataRowCount: number; columnCount: number; formulaCellCount: number };

/**
 * Stream one sheet: a `headers` event for the first non-blank row, then one
 * `record` event per non-blank data row, then an `end` summary. Fully blank
 * rows are skipped. Only one row is materialised at a time.
 */
export function* streamSheetRecords(
  sheetXml: string,
  sharedStrings: string[],
  styles: XlsxStyles,
  date1904: boolean,
): Generator<XlsxSheetEvent, void, void> {
  let headers: string[] | null = null;
  let dataRowCount = 0;
  let columnCount = 0;
  let formulaCellCount = 0;
  for (const rawRow of streamSheetRows(sheetXml)) {
    const positions = columnPositions(rawRow.cells);
    const resolved = rawRow.cells.map((cell) => resolveXlsxCell(cell, sharedStrings, styles, date1904));
    if (headers === null) {
      if (isRowBlank(resolved)) continue;
      const detected = detectXlsxHeaders(resolved, positions);
      headers = detected.headers;
      columnCount = headers.length;
      yield {
        kind: "headers",
        headers,
        headerRowNumber: rawRow.rowNumber ?? 0,
        hadBlank: detected.hadBlank,
        hadDuplicate: detected.hadDuplicate,
      };
      continue;
    }
    if (isRowBlank(resolved)) continue;
    const record = buildXlsxRowRecord(rawRow.rowNumber ?? 0, rawRow.cells, resolved, positions, headers);
    columnCount = Math.max(columnCount, record.width);
    if (record.hasFormula) formulaCellCount += Object.keys(record.formulas).length;
    dataRowCount++;
    yield { kind: "record", record };
  }
  yield { kind: "end", dataRowCount, columnCount, formulaCellCount };
}

// ---------------------------------------------------------------------------
// Workbook loading shared by inspect() and parse()
// ---------------------------------------------------------------------------

export interface XlsxLoadedWorkbook {
  sheets: XlsxSheetRef[];
  sheetNames: string[];
  date1904: boolean;
  sharedStrings: string[];
  styles: XlsxStyles;
  entries: Map<string, ZipEntry>;
  rels: Map<string, string>;
  data: Buffer;
}

function extractText(data: Buffer, entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name);
  if (!entry) throw new Error(`missing-part:${name}`);
  return extractZipEntry(data, entry).toString("utf-8");
}

function sheetTarget(sheet: XlsxSheetRef, rels: Map<string, string>): string {
  if (sheet.relId && rels.has(sheet.relId)) return resolveSheetTarget(rels.get(sheet.relId)!);
  return `xl/worksheets/sheet${sheet.order + 1}.xml`;
}

/**
 * Inflate the directory parts of a workbook. Throws an `Error` whose message
 * starts with a machine-readable slug (`not-a-zip`, `missing-workbook`, …);
 * callers translate that into a `ValidationIssue` — loading never throws
 * past this boundary.
 */
export function loadXlsxWorkbook(data: Buffer): XlsxLoadedWorkbook {
  const entries = new Map(listZipEntries(data).map((entry) => [entry.name, entry]));
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.uncompressedSize;
    if (total > XLSX_MAX_TOTAL_BYTES) throw new Error("workbook-too-large");
  }
  if (!entries.has("xl/workbook.xml")) throw new Error("missing-workbook");
  const workbook = parseWorkbookXml(extractText(data, entries, "xl/workbook.xml"));
  if (workbook.sheets.length === 0) throw new Error("no-sheets");
  const rels = entries.has("xl/_rels/workbook.xml.rels")
    ? parseWorkbookRels(extractText(data, entries, "xl/_rels/workbook.xml.rels"))
    : new Map<string, string>();
  const sharedStrings = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(extractText(data, entries, "xl/sharedStrings.xml"))
    : [];
  const styles = entries.has("xl/styles.xml")
    ? parseStyles(extractText(data, entries, "xl/styles.xml"))
    : { isDateStyle: [] };
  return {
    sheets: workbook.sheets,
    sheetNames: workbook.sheets.map((sheet) => sheet.name),
    date1904: workbook.date1904,
    sharedStrings,
    styles,
    entries,
    rels,
    data,
  };
}

const LEGACY_REFUSAL =
  "Legacy binary .xls (OLE2/BIFF) is not supported; convert the file to .xlsx first. Nothing was parsed.";

export class XlsxFormatAdapter implements MedicalFormatAdapter {
  public id = XLSX_ADAPTER_ID;
  public version = XLSX_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "xlsx",
      version: XLSX_ADAPTER_VERSION,
      description:
        "Spreadsheet workbook adapter: sheet enumeration, first-row headers and typed row records (shared/inline strings, numbers, booleans, dates, cached formula values)",
      extensions: [".xlsx", ".xlsm"],
      mimeTypes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
      ],
      status: "metadata-only",
      limitations: [
        "Metadata + structural rows only: no clinical interpretation is performed.",
        "Formula cells are never evaluated; the cached value is carried with the formula text and an explicit warning.",
        "Merged ranges are noted but never expanded; only the top-left cell carries the value.",
        "Date cells are reported structurally (ISO string plus the raw 1900/1904 serial); the 1900 leap-year quirk is inherent to the format.",
        "Legacy binary .xls (OLE2/BIFF) is refused with an explicit issue; convert to .xlsx first.",
        "Macros in .xlsm files are ignored; only sheet XML is read.",
        "Transform to FHIR is not implemented (metadata-only).",
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
    try {
      const ext = fileExtension(input);
      if (ext === "xls") return 0;
      if (ext === "xlsx" || ext === "xlsm") return 0.9;
      const bytes = toBuffer(input);
      if (bytes && bytes.length >= 4 && hasZipMagic(bytes)) {
        try {
          const names = listZipEntries(bytes).map((entry) => entry.name);
          if (names.includes("xl/workbook.xml")) return 0.85;
        } catch {
          return 0;
        }
        return 0;
      }
      const text = input.contentString ?? "";
      if (text.includes("spreadsheetml") || text.includes("xl/workbook.xml")) return 0.7;
      return 0;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const manifest = this.getManifest();
    const refusal = (warnings: string[]): InspectionResult => ({
      format: "xlsx",
      domain: "unknown",
      recordCount: 0,
      capabilities: manifest.capabilities,
      status: manifest.status,
      warnings,
    });
    const ext = fileExtension(input);
    const bytes =
      toBuffer(input) ?? (input.contentString !== undefined ? Buffer.from(input.contentString, "utf-8") : undefined);
    if (bytes && isOle2(bytes)) return refusal([`Encoding: binary (OLE2 compound document)`, LEGACY_REFUSAL]);
    if (ext === "xls") return refusal([LEGACY_REFUSAL]);
    if (!bytes || bytes.length === 0) {
      return refusal(["Empty input: no bytes to inspect"]);
    }
    let workbook: XlsxLoadedWorkbook;
    try {
      workbook = loadXlsxWorkbook(bytes);
    } catch (error) {
      return refusal([`Encoding: binary (OOXML ZIP container)`, `Unreadable workbook: ${(error as Error).message}`]);
    }

    const warnings: string[] = ["Encoding: binary (OOXML ZIP container)"];
    warnings.push(`workbook: ${workbook.sheets.length} sheet(s): ${workbook.sheetNames.join(", ")}`);
    if (workbook.date1904) warnings.push("Date system: 1904 (all date serials interpreted against 1904-01-01)");

    let recordCount = 0;
    const sampleRecords: Array<Record<string, unknown>> = [];
    const sheetFieldSources: Array<{ sheet: string; headers: string[]; samples: Array<Record<string, unknown>> }> = [];
    const multiSheet = workbook.sheets.length > 1;

    for (const sheet of workbook.sheets) {
      const target = sheetTarget(sheet, workbook.rels);
      const entry = workbook.entries.get(target);
      if (!entry) {
        warnings.push(`sheet '${sheet.name}': part '${target}' is missing; the sheet was skipped`);
        continue;
      }
      let sheetXml: string;
      try {
        sheetXml = extractZipEntry(workbook.data, entry).toString("utf-8");
      } catch (error) {
        warnings.push(`sheet '${sheet.name}': unreadable part (${(error as Error).message}); the sheet was skipped`);
        continue;
      }
      const merged = parseMergedRanges(sheetXml);
      let headers: string[] = [];
      const sheetSamples: Array<Record<string, unknown>> = [];
      let sheetRows = 0;
      let columnCount = 0;
      let formulaCellCount = 0;
      for (const event of streamSheetRecords(sheetXml, workbook.sharedStrings, workbook.styles, workbook.date1904)) {
        if (event.kind === "headers") {
          headers = event.headers;
          if (event.hadBlank) {
            warnings.push(`sheet '${sheet.name}': blank header cell(s) fell back to ColumnX names`);
          }
          if (event.hadDuplicate) {
            warnings.push(`sheet '${sheet.name}': duplicate header label(s) were uniquified with a (n) suffix`);
          }
        } else if (event.kind === "record") {
          sheetRows++;
          if (sheetSamples.length < 3) {
            sheetSamples.push({ rowNumber: event.record.rowNumber, ...event.record.values });
          }
          if (sampleRecords.length < 5) {
            sampleRecords.push({
              sheet: sheet.name,
              rowNumber: event.record.rowNumber,
              ...event.record.values,
            });
          }
        } else {
          columnCount = event.columnCount;
          formulaCellCount = event.formulaCellCount;
        }
      }
      recordCount += sheetRows;
      if (headers.length > 0) sheetFieldSources.push({ sheet: sheet.name, headers, samples: sheetSamples });
      const headerNote =
        headers.length > 0
          ? `headers: ${headers.slice(0, 20).join(", ")}${headers.length > 20 ? ` (+${headers.length - 20} more)` : ""}`
          : "no header row found";
      warnings.push(`sheet '${sheet.name}': ${sheetRows} data row(s) x ${columnCount} column(s) (${headerNote})`);
      if (formulaCellCount > 0) {
        warnings.push(
          `sheet '${sheet.name}': ${formulaCellCount} formula cell(s) carried as cached values; formulas are never evaluated`,
        );
      }
      if (merged.length > 0) {
        warnings.push(
          `sheet '${sheet.name}': ${merged.length} merged range(s) noted but not expanded (e.g. ${merged.slice(0, 3).join(", ")})`,
        );
      }
    }

    const fields = sheetFieldSources.flatMap((source) =>
      source.headers.map((header) => {
        const values = source.samples.map((row) => row[header]);
        return {
          name: multiSheet ? `${source.sheet}.${header}` : header,
          type: inferColumnType(values),
          sampleValues: values.slice(0, 3),
          nullable: source.samples.some((row) => (row[header] ?? null) === null),
        };
      }),
    );

    return {
      format: "xlsx",
      formatVersion: XLSX_FORMAT_VERSION,
      domain: inferXlsxDomain(sheetFieldSources.flatMap((source) => source.headers)),
      recordCount,
      detectedSchema: { fields },
      sampleRecords,
      capabilities: manifest.capabilities,
      status: manifest.status,
      warnings,
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const report = (issue: ValidationIssue): void => {
      context.onIssue?.(issue);
    };
    try {
      const ext = fileExtension(input);
      const bytes =
        toBuffer(input) ?? (input.contentString !== undefined ? Buffer.from(input.contentString, "utf-8") : undefined);
      if (bytes && isOle2(bytes)) {
        report({ code: "XLS_LEGACY_XLS_REFUSED", severity: "error", message: LEGACY_REFUSAL });
        return;
      }
      if (ext === "xls") {
        report({ code: "XLS_LEGACY_XLS_REFUSED", severity: "error", message: LEGACY_REFUSAL });
        return;
      }
      if (!bytes || bytes.length === 0) {
        report({
          code: "XLS_EMPTY_INPUT",
          severity: "error",
          message: "Input has no readable bytes; nothing was parsed",
        });
        return;
      }
      if (!hasZipMagic(bytes)) {
        report({
          code: "XLS_NOT_A_ZIP",
          severity: "error",
          message: "Input is not a ZIP container (missing PK signature); nothing was parsed",
          offendingValue: input.filename ?? input.uri,
        });
        return;
      }
      let workbook: XlsxLoadedWorkbook;
      try {
        workbook = loadXlsxWorkbook(bytes);
      } catch (error) {
        const message = (error as Error).message;
        report({
          code: message === "missing-workbook" ? "XLS_NOT_SPREADSHEET" : "XLS_ZIP_UNREADABLE",
          severity: "error",
          message:
            message === "missing-workbook"
              ? "ZIP container has no xl/workbook.xml part; not a spreadsheet workbook, nothing was parsed"
              : message === "no-sheets"
                ? "Workbook declares no sheets; nothing was parsed"
                : `Workbook directory is unreadable (${message}); nothing was parsed`,
        });
        return;
      }

      const checksum = computeChecksum(input);
      const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
      let recordIndex = 0;

      for (const sheet of workbook.sheets) {
        if (recordIndex >= limit) break;
        const target = sheetTarget(sheet, workbook.rels);
        const entry = workbook.entries.get(target);
        if (!entry) {
          report({
            code: "XLS_SHEET_MISSING",
            severity: "warning",
            message: `Sheet '${sheet.name}' points at missing part '${target}' and was skipped`,
            location: `sheet '${sheet.name}'`,
          });
          continue;
        }
        let sheetXml: string;
        try {
          sheetXml = extractZipEntry(workbook.data, entry).toString("utf-8");
        } catch (error) {
          report({
            code: "XLS_ENTRY_UNREADABLE",
            severity: "error",
            message: `Sheet '${sheet.name}' part is unreadable (${(error as Error).message}) and was skipped`,
            location: `sheet '${sheet.name}'`,
          });
          continue;
        }

        const merged = parseMergedRanges(sheetXml);
        if (merged.length > 0) {
          report({
            code: "XLS_MERGED_CELLS",
            severity: "warning",
            message:
              `Sheet '${sheet.name}': ${merged.length} merged range(s) ` +
              `(${merged.slice(0, 5).join(", ")}) noted but not expanded; only the top-left cell carries the value`,
            location: `sheet '${sheet.name}'`,
          });
        }

        let headers: string[] | null = null;
        let domain: MedicalDomain = "clinical";
        let sheetFormulaCells = 0;
        for (const event of streamSheetRecords(sheetXml, workbook.sharedStrings, workbook.styles, workbook.date1904)) {
          if (event.kind === "headers") {
            headers = event.headers;
            domain = inferXlsxDomain(headers);
            if (event.hadBlank) {
              report({
                code: "XLS_BLANK_HEADER",
                severity: "warning",
                message: `Sheet '${sheet.name}': blank header cell(s) fell back to ColumnX names`,
                location: `sheet '${sheet.name}' row ${event.headerRowNumber}`,
              });
            }
            if (event.hadDuplicate) {
              report({
                code: "XLS_DUPLICATE_HEADER",
                severity: "warning",
                message: `Sheet '${sheet.name}': duplicate header label(s) were uniquified with a (n) suffix`,
                location: `sheet '${sheet.name}' row ${event.headerRowNumber}`,
              });
            }
            continue;
          }
          if (event.kind === "end") {
            if (headers === null) {
              report({
                code: "XLS_EMPTY_SHEET",
                severity: "warning",
                message: `Sheet '${sheet.name}' has no header row; nothing was parsed from it`,
                location: `sheet '${sheet.name}'`,
              });
            } else if (sheetFormulaCells > 0) {
              report({
                code: "XLS_FORMULA_CACHED",
                severity: "warning",
                message:
                  `Sheet '${sheet.name}': ${sheetFormulaCells} formula cell(s) carried as cached values; ` +
                  "formulas are never evaluated",
                location: `sheet '${sheet.name}'`,
              });
            }
            continue;
          }
          const record = event.record;
          if (record.hasFormula) sheetFormulaCells += Object.keys(record.formulas).length;
          const parseIssues: ValidationIssue[] = [];
          for (const key of record.errorCells) {
            parseIssues.push({
              code: "XLS_ERROR_CELL",
              severity: "warning",
              message: `Cell holds an error token ('${String(record.values[key])}'); carried verbatim`,
              location: `sheet '${sheet.name}' row ${record.rowNumber}`,
              path: key,
              recordIndex,
            });
          }
          for (const [key, formula] of Object.entries(record.formulas)) {
            parseIssues.push({
              code: "XLS_FORMULA_CACHED",
              severity: "warning",
              message: `Formula '${formula}' carried as its cached value; formulas are never evaluated`,
              location: `sheet '${sheet.name}' row ${record.rowNumber}`,
              path: key,
              recordIndex,
            });
          }
          for (const [header, value] of Object.entries(record.values)) {
            if (value === null && record.cellTypes[header] === "text") {
              parseIssues.push({
                code: "XLS_SHARED_STRING_REF",
                severity: "warning",
                message: `Dangling shared-string reference carried as null; the string table has no such entry`,
                location: `sheet '${sheet.name}' row ${record.rowNumber}`,
                path: header,
                recordIndex,
              });
            }
          }

          const data: Record<string, unknown> = {
            sheet: sheet.name,
            sheetIndex: sheet.order,
            rowNumber: record.rowNumber,
            values: record.values,
            cellTypes: record.cellTypes,
          };
          if (record.hasFormula) {
            data["formulas"] = record.formulas;
            data["formulasEvaluated"] = false;
          }
          if (Object.keys(record.dateSerials).length > 0) data["dateSerials"] = record.dateSerials;

          yield createCanonicalEnvelope({
            id: `xlsx-rec-${recordIndex}`,
            domain,
            sourceFormat: "xlsx",
            formatVersion: XLSX_FORMAT_VERSION,
            content: { kind: "structured", data },
            importedAt: context.importedAt,
            adapterId: this.id,
            adapterVersion: this.version,
            recordIndex,
            sourceLocation: `sheet '${sheet.name}' row ${record.rowNumber}`,
            filename: input.filename,
            checksum,
            encoding: "binary",
            metadata: {
              sheet: sheet.name,
              sheetIndex: sheet.order,
              rowNumber: record.rowNumber,
              columnCount: record.width,
              headers,
              workbookSheets: workbook.sheetNames,
              totalSheets: workbook.sheets.length,
              hasFormula: record.hasFormula,
              formulaCount: Object.keys(record.formulas).length,
              formulasNeverEvaluated: true,
              mergedRangeCount: merged.length,
              mergedRanges: merged.slice(0, 10),
              date1904: workbook.date1904,
            },
            parseIssues: parseIssues.length > 0 ? parseIssues : undefined,
          });
          recordIndex++;
          if (recordIndex >= limit) break;
        }
      }
    } catch (error) {
      context.onIssue?.({
        code: "XLS_UNEXPECTED",
        severity: "fatal",
        message: `Unexpected XLSX failure (${(error as Error).message}); parsing aborted`,
      });
      return;
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${XLSX_ADAPTER_ID} ${XLSX_ADAPTER_VERSION} (structural workbook sheets/rows via Node built-ins; formulas never evaluated, dates structural, legacy .xls refused)`,
    };
  }
}

/** Best-effort column type over sampled values (mirrors the CSV adapter's labels, plus ISO dates). */
function inferColumnType(values: unknown[]): string {
  const sample = values.filter((value) => value !== null && value !== undefined && value !== "");
  if (sample.length === 0) return "string";
  if (sample.every((value) => typeof value === "number" && Number.isInteger(value))) return "integer";
  if (sample.every((value) => typeof value === "number")) return "number";
  if (sample.every((value) => typeof value === "boolean")) return "boolean";
  if (sample.every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))) {
    return "date";
  }
  return "string";
}
