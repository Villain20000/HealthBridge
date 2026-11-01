/**
 * PDF metadata adapter — dependency-free document metadata.
 *
 * Status is honestly `metadata-only`: the `%PDF-` header, indirect-object
 * census (`N G obj`), stream census (`stream`/`endstream`), a best-effort
 * `xref`/`startxref`/`%%EOF` trailer walk, the page tree (`/Type /Pages`
 * `/Count` with a `/Type /Page` object fallback), the Info dictionary
 * (`Title`/`Author`/`Subject`/`Producer`/`Creator`/`CreationDate`/`ModDate`
 * carried structurally) and the encryption/linearization flags are read with
 * hand-rolled scanning over the raw bytes — no PDF library is used
 * (Node built-ins only: `node:zlib` for `/FlateDecode` content streams).
 *
 * Explicitly NOT performed here (refused or marked, never implied):
 * - decryption: encrypted files (`/Encrypt`) are never decrypted. `inspect()`
 *   still reports structural metadata; `parse()` yields the document envelope
 *   with an explicit issue, and refuses page-text extraction with
 *   `PDF_ENCRYPTED_REFUSED` unless only metadata was requested.
 * - full-text fidelity: text extraction is OFF by default and runs only with
 *   the explicit `extractText: true` parse option. `Tj`/`TJ` text-showing
 *   operators are decoded as UTF-16BE (BOM `FE FF`) or WinAnsi
 *   (PDFDocEncoding approximation) and every extracted string is marked
 *   `textUnverified: true`. Layout, reading order, ligatures, embedded-font
 *   encodings, OCR and NLP are out of scope and never implied.
 * - malformed files are tolerated structurally (leading garbage before the
 *   header, missing `xref`/`startxref`/`%%EOF`) with explicit `PDF_*` issues —
 *   never a crash, never silently swallowed.
 */

import { inflateRawSync, inflateSync } from "node:zlib";
import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";

export const PDF_ADAPTER_ID = "pdf-adapter";
export const PDF_ADAPTER_VERSION = "1.0.0";

/** `%PDF-` magic every real PDF carries near byte zero. */
export const PDF_MAGIC = "%PDF-";

/** Only the first bytes are searched for the header (garbage-tolerant). */
export const PDF_HEADER_SNIFF_BYTES = 1024;

/** Per-page extracted text is bounded; the remainder is reported, not hidden. */
export const PDF_MAX_TEXT_CHARS = 32768;

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Raw asset bytes. `contentString` is decoded as latin1 so byte values 0-255
 * survive the round trip for hand-built ASCII fixtures.
 */
function toBytes(input: InputDescriptor): Buffer | undefined {
  if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
  if (input.contentString !== undefined) return Buffer.from(input.contentString, "latin1");
  return undefined;
}

/** True when the first bytes carry `%PDF-` (leading garbage tolerated). */
export function hasPdfMagic(data: Buffer): boolean {
  if (data.length < PDF_MAGIC.length) return false;
  return data.subarray(0, Math.min(data.length, PDF_HEADER_SNIFF_BYTES)).toString("latin1").includes(PDF_MAGIC);
}

/** Decode raw bytes: UTF-16BE when BOM-prefixed, WinAnsi otherwise. */
function decodeRawBytes(bytes: number[]): { text: string; encoding: string } {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const units: number[] = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) units.push((bytes[i] << 8) | bytes[i + 1]);
    return { text: String.fromCharCode(...units), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("windows-1252").decode(Uint8Array.from(bytes)), encoding: "winansi" };
  } catch {
    return { text: String.fromCharCode(...bytes), encoding: "latin1-fallback" };
  }
}

/**
 * Decode one PDF string token — `(literal)` with PDF escapes (incl. octal
 * and line continuations, balanced nested parens) or `<hex>` — structurally.
 * WinAnsi here is a PDFDocEncoding approximation (bytes 0x18-0x1F differ);
 * the approximation is documented, never presented as validated text.
 */
export function decodePdfString(token: string): { text: string; encoding: string } {
  const raw = token.trim();
  if (raw.startsWith("(")) {
    const bytes: number[] = [];
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "(") {
        depth++;
        if (depth > 1) bytes.push(0x28);
        continue;
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) break;
        bytes.push(0x29);
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === "n") {
          bytes.push(0x0a);
          i++;
        } else if (next === "r") {
          bytes.push(0x0d);
          i++;
        } else if (next === "t") {
          bytes.push(0x09);
          i++;
        } else if (next === "b") {
          bytes.push(0x08);
          i++;
        } else if (next === "f") {
          bytes.push(0x0c);
          i++;
        } else if (next === "(" || next === ")" || next === "\\") {
          bytes.push(next.charCodeAt(0));
          i++;
        } else if (next === "\r" || next === "\n") {
          // Line continuation: backslash + EOL contributes nothing.
          i += next === "\r" && raw[i + 2] === "\n" ? 2 : 1;
        } else if (next >= "0" && next <= "7") {
          let octal = "";
          for (let k = i + 1; k < raw.length && k < i + 4 && raw[k] >= "0" && raw[k] <= "7"; k++) octal += raw[k];
          bytes.push(parseInt(octal, 8) & 0xff);
          i += octal.length;
        } else {
          // Per spec the backslash is ignored before any other character.
          bytes.push(next.charCodeAt(0) & 0xff);
          i++;
        }
        continue;
      }
      if (ch === "\r" && raw[i + 1] === "\n") {
        bytes.push(0x0a);
        i++;
        continue;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return decodeRawBytes(bytes);
  }
  if (raw.startsWith("<")) {
    const hex = raw.replace(/^</, "").replace(/>$/, "").replace(/\s+/g, "");
    const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
    const bytes: number[] = [];
    for (let i = 0; i < padded.length; i += 2) {
      const byte = parseInt(padded.slice(i, i + 2), 16);
      bytes.push(Number.isFinite(byte) ? byte : 0x3f);
    }
    return decodeRawBytes(bytes);
  }
  return { text: raw, encoding: "unknown" };
}

export interface PdfInfoDict {
  title?: string;
  author?: string;
  subject?: string;
  producer?: string;
  creator?: string;
  creationDate?: string;
  modDate?: string;
  keywords?: string;
}

const INFO_KEYS: Array<keyof PdfInfoDict> = [
  "title",
  "author",
  "subject",
  "producer",
  "creator",
  "creationDate",
  "modDate",
  "keywords",
];

const INFO_PDF_NAMES: Record<keyof PdfInfoDict, string> = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  producer: "Producer",
  creator: "Creator",
  creationDate: "CreationDate",
  modDate: "ModDate",
  keywords: "Keywords",
};

/**
 * First `/Key (literal)` or `/Key <hex>` value in a dictionary region,
 * scanned with balanced parens (nested `(a(b)c)` survives intact).
 */
function findInfoValue(region: string, pdfName: string): { text: string; encoding: string } | undefined {
  const key = `/${pdfName}`;
  let from = 0;
  for (;;) {
    const at = region.indexOf(key, from);
    if (at === -1) return undefined;
    const after = region[at + key.length] ?? "";
    if (/[A-Za-z0-9]/.test(after)) {
      from = at + key.length;
      continue;
    }
    let i = at + key.length;
    while (i < region.length && /\s/.test(region[i])) i++;
    if (region[i] === "(") {
      let depth = 0;
      let j = i;
      let token = "";
      while (j < region.length) {
        const ch = region[j];
        token += ch;
        if (ch === "\\" && j + 1 < region.length) {
          token += region[j + 1];
          j += 2;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      return decodePdfString(token);
    }
    if (region[i] === "<" && region[i + 1] !== "<") {
      const close = region.indexOf(">", i + 1);
      if (close === -1) return undefined;
      return decodePdfString(region.slice(i, close + 1));
    }
    from = i + 1;
  }
}

/** Parse Info-dict string values out of one dictionary region, structurally. */
export function parseInfoDict(region: string): PdfInfoDict {
  const info: PdfInfoDict = {};
  for (const key of INFO_KEYS) {
    const value = findInfoValue(region, INFO_PDF_NAMES[key]);
    if (value !== undefined) info[key] = value.text;
  }
  return info;
}

export interface PdfIndirectObject {
  num: number;
  gen: number;
  /** Byte offset of the object header (`N G obj`). */
  headOffset: number;
  /** Raw body between `obj` and the first following `endobj` (or EOF). */
  body: string;
}

export type PdfPageCountSource = "count" | "objects" | "unknown";

export interface PdfStructure {
  headerVersion?: string;
  /** Byte offset of `%PDF-`, or -1 when the file carries no header. */
  headerOffset: number;
  objectCount: number;
  streamCount: number;
  endstreamCount: number;
  encrypted: boolean;
  linearized: boolean;
  /** Null when neither `/Count` nor page objects were found. */
  pageCount: number | null;
  pageCountSource: PdfPageCountSource;
  info: PdfInfoDict;
  /** `xref` table entries walked from `startxref`; null when not walkable. */
  xrefEntryCount: number | null;
  /** True when the cross-reference lives in an `/XRef` stream object. */
  xrefStream: boolean;
  hasStartxref: boolean;
  hasEof: boolean;
  byteLength: number;
  issues: ValidationIssue[];
}

/**
 * Split the file into indirect objects (`N G obj … endobj`). Stream spans
 * are skipped with their declared `/Length` so binary bytes that happen to
 * spell `endobj` cannot truncate the object.
 */
export function splitPdfObjects(text: string): PdfIndirectObject[] {
  const objects: PdfIndirectObject[] = [];
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    let bodyEnd = text.indexOf("endobj", bodyStart);
    if (bodyEnd === -1) {
      objects.push({
        num: Number(match[1]),
        gen: Number(match[2]),
        headOffset: match.index,
        body: text.slice(bodyStart),
      });
      break;
    }
    const streamMatch = /stream(?:\r\n|\n|\r)/.exec(text.slice(bodyStart, bodyEnd));
    if (streamMatch) {
      const dataStart = bodyStart + streamMatch.index + streamMatch[0].length;
      const lengthMatch = /\/Length\s+(\d+)/.exec(text.slice(bodyStart, dataStart));
      if (lengthMatch) {
        const afterData = text.indexOf("endobj", dataStart + Number(lengthMatch[1]));
        bodyEnd = afterData === -1 ? text.length : afterData;
      }
    }
    objects.push({
      num: Number(match[1]),
      gen: Number(match[2]),
      headOffset: match.index,
      body: text.slice(bodyStart, bodyEnd),
    });
    if (objects.length > 500000) break; // pathological-input guard
  }
  return objects;
}

function walkXrefTable(text: string, offset: number, issues: ValidationIssue[]): number | null {
  const head = text.slice(offset, offset + 16);
  const xrefMatch = /^\s*xref[\r\n\s]/.exec(head);
  if (!xrefMatch) return null;
  let pos = offset + xrefMatch[0].length;
  let total = 0;
  for (let section = 0; section < 10000; section++) {
    const next = text.slice(pos, pos + 64);
    if (/^\s*trailer\b/.test(next)) break;
    const sub = /^\s*(\d+)\s+(\d+)\s*/.exec(next);
    if (!sub) {
      if (section === 0) return null;
      issues.push({
        code: "PDF_XREF_UNREADABLE",
        severity: "warning",
        message: `Cross-reference subsection ${section} near byte ${pos} is not 'start count'; walked ${total} entries before stopping`,
        location: `byte ${pos}`,
      });
      return total;
    }
    const count = Number(sub[2]);
    if (!Number.isInteger(count) || count < 0 || count > 200000) {
      issues.push({
        code: "PDF_XREF_UNREADABLE",
        severity: "warning",
        message: `Cross-reference subsection declares an implausible entry count ('${sub[2]}'); walked ${total} entries before stopping`,
        location: `byte ${pos}`,
      });
      return total;
    }
    pos += sub[0].length;
    for (let k = 0; k < count; k++) {
      const entry = /^\d{10} \d{5} [fn][^\S\r\n]*(?:\r\n|\n|\r)?/.exec(text.slice(pos, pos + 28));
      if (!entry) {
        issues.push({
          code: "PDF_XREF_UNREADABLE",
          severity: "warning",
          message: `Cross-reference entry ${total} near byte ${pos} is malformed; walked ${total} entries before stopping`,
          location: `byte ${pos}`,
        });
        return total;
      }
      pos += entry[0].length;
      total++;
      if (total > 500000) {
        issues.push({
          code: "PDF_XREF_TRUNCATED",
          severity: "warning",
          message: "Cross-reference table exceeds the 500000-entry walk budget; the count is capped there",
          location: `byte ${pos}`,
        });
        return total;
      }
    }
  }
  return total;
}

/**
 * Hand-rolled structural walk: header, object/stream census, encryption and
 * linearization flags, page tree, Info dict, xref/trailer. Never throws on
 * malformed input — every anomaly becomes a `PDF_*` issue.
 */
export function parsePdfStructure(data: Buffer): PdfStructure {
  const text = data.toString("latin1");
  const issues: ValidationIssue[] = [];

  // -- Header (garbage-tolerant): `%PDF-` must sit inside the first bytes. --
  let headerVersion: string | undefined;
  let headerOffset = -1;
  const head = text.slice(0, PDF_HEADER_SNIFF_BYTES);
  const headAt = head.indexOf(PDF_MAGIC);
  if (headAt !== -1) {
    headerOffset = headAt;
    const version = /%PDF-(\d+\.\d+)/.exec(head.slice(headAt, headAt + 16));
    headerVersion = version ? version[1] : undefined;
    if (headAt > 0) {
      issues.push({
        code: "PDF_GARBAGE_PREFIX",
        severity: "warning",
        message: `${headAt} leading byte(s) precede '%PDF-'; the prefix was skipped and parsing continued`,
        location: "byte 0",
      });
    }
    if (!headerVersion) {
      issues.push({
        code: "PDF_MALFORMED_HEADER",
        severity: "warning",
        message: "The '%PDF-' marker has no readable version number; the version is reported as unknown",
        location: `byte ${headAt}`,
      });
    }
  } else {
    const later = text.indexOf(PDF_MAGIC);
    if (later !== -1) {
      headerOffset = later;
      const version = /%PDF-(\d+\.\d+)/.exec(text.slice(later, later + 16));
      headerVersion = version ? version[1] : undefined;
      issues.push({
        code: "PDF_HEADER_OFFSET",
        severity: "warning",
        message: `'%PDF-' starts at byte ${later} (beyond the first ${PDF_HEADER_SNIFF_BYTES} bytes); the file is malformed but was parsed anyway`,
        location: `byte ${later}`,
      });
    } else {
      issues.push({
        code: "PDF_MISSING_HEADER",
        severity: "error",
        message:
          "No '%PDF-' marker found anywhere; this is not a recognisable PDF and every count below is best-effort",
        location: "byte 0",
      });
    }
  }

  // -- Object / stream census. --
  const objects = splitPdfObjects(text);
  const streamMatches = text.match(/\bstream(?:\r\n|\n|\r)/g) ?? [];
  const endstreamMatches = text.match(/endstream\b/g) ?? [];
  if (streamMatches.length > endstreamMatches.length) {
    issues.push({
      code: "PDF_TRUNCATED_STREAM",
      severity: "warning",
      message: `${streamMatches.length - endstreamMatches.length} 'stream' keyword(s) have no matching 'endstream'; the file looks truncated`,
    });
  }

  const encrypted = /\/Encrypt\b/.test(text);
  if (encrypted) {
    issues.push({
      code: "PDF_ENCRYPTED_LIMITED",
      severity: "warning",
      message: "The file carries an /Encrypt dictionary; it is never decrypted — only structural metadata is reported",
    });
  }
  const linearized = /\/Linearized\b/.test(text.slice(0, 8192));

  // -- Page tree: authoritative `/Count` first, page-object census fallback. --
  let rootCount: number | undefined;
  for (const object of objects) {
    if (/\/Type\s*\/Pages\b/.test(object.body)) {
      const count = /\/Count\s+(\d+)/.exec(object.body);
      if (count) {
        rootCount = Number(count[1]);
        break;
      }
    }
  }
  let pageObjectCount = 0;
  for (const object of objects) {
    if (/\/Type\s*\/Page(?!s)/.test(object.body)) pageObjectCount++;
  }
  let pageCount: number | null = null;
  let pageCountSource: PdfPageCountSource = "unknown";
  if (rootCount !== undefined) {
    pageCount = rootCount;
    pageCountSource = "count";
    if (pageObjectCount > 0 && pageObjectCount !== rootCount) {
      issues.push({
        code: "PDF_PAGE_COUNT_MISMATCH",
        severity: "warning",
        message: `Page-tree /Count is ${rootCount} but ${pageObjectCount} /Page objects were found; /Count is reported`,
      });
    }
  } else if (pageObjectCount > 0) {
    pageCount = pageObjectCount;
    pageCountSource = "objects";
  } else {
    issues.push({
      code: "PDF_PAGE_COUNT_UNKNOWN",
      severity: "warning",
      message: "No page-tree /Count and no /Page objects found; the page count is reported as unknown",
    });
  }

  // -- Info dict: resolve the trailer /Info reference, else scan the tail. --
  let info: PdfInfoDict = {};
  const infoRef = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(text);
  if (infoRef) {
    const target = objects.find((o) => o.num === Number(infoRef[1]) && o.gen === Number(infoRef[2]));
    if (target) {
      info = parseInfoDict(target.body);
    } else {
      issues.push({
        code: "PDF_INFO_UNRESOLVED",
        severity: "warning",
        message: `Trailer /Info points at object ${infoRef[1]} ${infoRef[2]} R, which is absent; Info metadata is reported as unknown`,
      });
    }
  } else {
    info = parseInfoDict(text.slice(Math.max(0, text.length - 8192)));
  }

  // -- Trailer: startxref walk (table) or XRef-stream note. --
  const startIdx = text.lastIndexOf("startxref");
  const hasStartxref = startIdx !== -1;
  const hasEof = text.includes("%%EOF");
  let xrefEntryCount: number | null = null;
  let xrefStream = false;
  if (!hasStartxref) {
    issues.push({
      code: "PDF_MISSING_STARTXREF",
      severity: "warning",
      message:
        "No 'startxref' keyword found; the cross-reference table was not walked (object census is independent of it)",
    });
  } else {
    const after = text.slice(startIdx + "startxref".length);
    const num = /^\s*(\d+)/.exec(after);
    if (!num) {
      issues.push({
        code: "PDF_MALFORMED_STARTXREF",
        severity: "warning",
        message: "'startxref' is not followed by a byte offset; the cross-reference table was not walked",
        location: `byte ${startIdx}`,
      });
    } else {
      const offset = Number(num[1]);
      const walked = walkXrefTable(text, offset, issues);
      if (walked !== null) {
        xrefEntryCount = walked;
      } else if (/\/Type\s*\/XRef/.test(text)) {
        xrefStream = true;
        issues.push({
          code: "PDF_XREF_STREAM",
          severity: "information",
          message: `startxref points at byte ${offset}, which is not an 'xref' table (likely a compressed /XRef stream object); entry counts come from the object census instead`,
          location: `byte ${offset}`,
        });
      } else {
        issues.push({
          code: "PDF_XREF_UNREADABLE",
          severity: "warning",
          message: `startxref points at byte ${offset}, which holds neither an 'xref' table nor a recognisable /XRef stream; entry counts come from the object census instead`,
          location: `byte ${offset}`,
        });
      }
    }
  }
  if (!hasEof) {
    issues.push({
      code: "PDF_MISSING_EOF",
      severity: "warning",
      message: "No '%%EOF' marker found; the file looks truncated but was parsed best-effort",
    });
  }

  return {
    headerVersion,
    headerOffset,
    objectCount: objects.length,
    streamCount: streamMatches.length,
    endstreamCount: endstreamMatches.length,
    encrypted,
    linearized,
    pageCount,
    pageCountSource,
    info,
    xrefEntryCount,
    xrefStream,
    hasStartxref,
    hasEof,
    byteLength: data.length,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Opt-in text extraction (Tj/TJ operators only, structural, unverified)
// ---------------------------------------------------------------------------

export interface PdfPageText {
  pageNumber: number;
  /** Decoded show-string fragments joined structurally (no layout inference). */
  text: string;
  /** Always true: operator-decoded text is never presented as validated. */
  textUnverified: true;
  encoding: string;
  charCount: number;
  truncated: boolean;
  streamsDecoded: number;
  issues: ValidationIssue[];
}

function readBalancedLiteral(text: string, start: number): { token: string; end: number } {
  let token = "";
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    token += ch;
    if (ch === "\\" && i + 1 < text.length) {
      token += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      i++;
      if (depth === 0) break;
      continue;
    }
    i++;
  }
  return { token, end: i };
}

/**
 * Scan one content stream for `Tj`/`TJ` text-showing operations with a
 * minimal PDF lexer (balanced literals, hex strings, arrays, names, numbers).
 * Anything else — positioning, fonts, images, `'`/`"` shorthands — is ignored.
 */
export function decodeContentStream(streamText: string): { fragments: Array<{ text: string; encoding: string }> } {
  const fragments: Array<{ text: string; encoding: string }> = [];
  let pendingString: string | null = null;
  let pendingArray: string[] | null = null;
  let i = 0;

  const skipWord = (): string => {
    const start = i;
    while (i < streamText.length && /[A-Za-z0-9'*"]/.test(streamText[i])) i++;
    return streamText.slice(start, i);
  };

  while (i < streamText.length) {
    const ch = streamText[i];
    if (ch === "%") {
      const nl = streamText.indexOf("\n", i);
      i = nl === -1 ? streamText.length : nl + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      const read = readBalancedLiteral(streamText, i);
      pendingString = read.token;
      pendingArray = null;
      i = read.end;
      continue;
    }
    if (ch === "<" && streamText[i + 1] !== "<") {
      const close = streamText.indexOf(">", i + 1);
      if (close === -1) break;
      pendingString = streamText.slice(i, close + 1);
      pendingArray = null;
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      const items: string[] = [];
      i++;
      for (;;) {
        while (i < streamText.length && /\s/.test(streamText[i])) i++;
        if (i >= streamText.length) break;
        if (streamText[i] === "]") {
          i++;
          break;
        }
        if (streamText[i] === "(") {
          const read = readBalancedLiteral(streamText, i);
          items.push(read.token);
          i = read.end;
        } else if (streamText[i] === "<" && streamText[i + 1] !== "<") {
          const close = streamText.indexOf(">", i + 1);
          if (close === -1) {
            i = streamText.length;
            break;
          }
          items.push(streamText.slice(i, close + 1));
          i = close + 1;
        } else if (/[0-9.+-]/.test(streamText[i])) {
          while (i < streamText.length && /[0-9.eE+-]/.test(streamText[i])) i++;
        } else {
          break;
        }
      }
      pendingArray = items;
      pendingString = null;
      continue;
    }
    if (ch === "/" || ch === "{") {
      i++;
      continue;
    }
    if (/[A-Za-z'"]/.test(ch)) {
      const word = skipWord();
      if (word === "Tj" && pendingString !== null) {
        const decoded = decodePdfString(pendingString);
        fragments.push(decoded);
      } else if (word === "TJ" && pendingArray !== null) {
        const parts = pendingArray.map((token) => decodePdfString(token));
        if (parts.length > 0) {
          fragments.push({
            text: parts.map((p) => p.text).join(""),
            encoding: parts.some((p) => p.encoding === "utf-16be") ? "utf-16be" : parts[0].encoding,
          });
        }
      }
      pendingString = null;
      pendingArray = null;
      continue;
    }
    i++;
  }
  return { fragments };
}

function decodeStreamBytes(
  raw: Buffer,
  filterClause: string | undefined,
  location: string,
  issues: ValidationIssue[],
): string | undefined {
  const filters = filterClause ? [...filterClause.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]) : [];
  if (filters.length === 0) return raw.toString("latin1");
  if (filters.every((name) => name === "FlateDecode")) {
    for (const inflate of [inflateSync, inflateRawSync] as const) {
      try {
        return inflate(raw).toString("latin1");
      } catch {
        continue;
      }
    }
    issues.push({
      code: "PDF_DECOMPRESS_FAILED",
      severity: "warning",
      message: "A /FlateDecode content stream could not be inflated; its text was skipped (never fabricated)",
      location,
    });
    return undefined;
  }
  issues.push({
    code: "PDF_FILTER_UNSUPPORTED",
    severity: "warning",
    message: `Content stream uses unsupported filter(s) ${filters.join(",")}; only unfiltered and /FlateDecode streams are decoded, the rest are skipped`,
    location,
  });
  return undefined;
}

/**
 * Extract per-page text from page `/Contents` streams, in file order (the
 * structural order, which may differ from the page-tree order — said so in
 * the envelope metadata). Returns one entry per `/Page` object found.
 */
export function extractPdfPageTexts(data: Buffer): PdfPageText[] {
  const text = data.toString("latin1");
  const objects = splitPdfObjects(text);
  const byRef = new Map<string, PdfIndirectObject>();
  for (const object of objects) byRef.set(`${object.num} ${object.gen}`, object);
  const pages = objects.filter((o) => /\/Type\s*\/Page(?!s)/.test(o.body));
  const result: PdfPageText[] = [];

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const location = `page ${pageNumber}`;
    const issues: ValidationIssue[] = [];
    const contents = /\/Contents\s*(\d+\s+\d+\s+R|\[[^\]]*\])/.exec(page.body);
    let decodedText = "";
    let streamsDecoded = 0;
    const encodings = new Set<string>();
    if (!contents) {
      issues.push({
        code: "PDF_PAGE_WITHOUT_CONTENTS",
        severity: "information",
        message: "Page object has no /Contents reference; the page contributes structural presence only, no text",
        location,
      });
    } else {
      const refs = [...contents[1].matchAll(/(\d+)\s+(\d+)\s+R/g)].map((m) => `${m[1]} ${m[2]}`);
      const targets = contents[1].startsWith("[")
        ? refs
        : [contents[1].trim().replace(/\s+/g, " ").replace(/\s+R$/, "")];
      for (const ref of targets) {
        const target = byRef.get(ref);
        if (!target) {
          issues.push({
            code: "PDF_CONTENTS_UNRESOLVED",
            severity: "warning",
            message: `Page /Contents reference ${ref} R is absent; that stream's text was skipped`,
            location,
          });
          continue;
        }
        const streamAt = /stream(?:\r\n|\n|\r)/.exec(target.body);
        const endAt = target.body.lastIndexOf("endstream");
        if (!streamAt || endAt === -1 || endAt < streamAt.index) {
          issues.push({
            code: "PDF_STREAM_MALFORMED",
            severity: "warning",
            message: `Object ${ref} obj has no usable stream…endstream span; its text was skipped`,
            location,
          });
          continue;
        }
        const dict = target.body.slice(0, streamAt.index);
        const filterClause = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(dict)?.[1];
        const dataStart = streamAt.index + streamAt[0].length;
        // Prefer the declared /Length so `endstream`-like bytes inside the
        // data cannot cut the span short.
        const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
        const dataEnd =
          lengthMatch && dataStart + Number(lengthMatch[1]) <= target.body.length
            ? dataStart + Number(lengthMatch[1])
            : endAt;
        const raw = Buffer.from(target.body.slice(dataStart, dataEnd), "latin1");
        const decoded = decodeStreamBytes(raw, filterClause, location, issues);
        if (decoded === undefined) continue;
        const { fragments } = decodeContentStream(decoded);
        for (const fragment of fragments) {
          decodedText += fragment.text;
          encodings.add(fragment.encoding);
        }
        streamsDecoded++;
      }
    }
    const truncated = decodedText.length > PDF_MAX_TEXT_CHARS;
    if (truncated) {
      issues.push({
        code: "PDF_TEXT_TRUNCATED",
        severity: "information",
        message: `Page text (${decodedText.length} chars) exceeds the ${PDF_MAX_TEXT_CHARS}-char envelope budget and was truncated; the remainder is not inlined`,
        location,
      });
    }
    result.push({
      pageNumber,
      text: truncated ? decodedText.slice(0, PDF_MAX_TEXT_CHARS) : decodedText,
      textUnverified: true,
      encoding: encodings.size === 0 ? "none" : [...encodings].join("+"),
      charCount: decodedText.length,
      truncated,
      streamsDecoded,
      issues,
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function documentSummary(structure: PdfStructure): Record<string, unknown> {
  return {
    kind: "pdf-document",
    headerVersion: structure.headerVersion ?? "unknown",
    pageCount: structure.pageCount,
    pageCountSource: structure.pageCountSource,
    objectCount: structure.objectCount,
    streamCount: structure.streamCount,
    xrefEntryCount: structure.xrefEntryCount,
    xrefStream: structure.xrefStream,
    encrypted: structure.encrypted,
    linearized: structure.linearized,
    info: structure.info,
    byteLength: structure.byteLength,
  };
}

export class PdfFormatAdapter implements MedicalFormatAdapter {
  public id = PDF_ADAPTER_ID;
  public version = PDF_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "pdf",
      version: PDF_ADAPTER_VERSION,
      description:
        "PDF document adapter: dependency-free structural metadata (page count, Info dict, object/stream census, xref walk, encryption flag) with opt-in unverified text extraction",
      extensions: [".pdf"],
      mimeTypes: ["application/pdf"],
      status: "metadata-only",
      limitations: [
        "Metadata only: page content is never interpreted — no layout, reading order, OCR or NLP is performed or implied.",
        "Encrypted files (/Encrypt) are never decrypted; text extraction on them is refused with an explicit issue.",
        "Text extraction is opt-in (parse option `extractText: true`, default off) and structural only: Tj/TJ operators decoded as UTF-16BE/WinAnsi, every string marked textUnverified.",
        "Page counts prefer the page-tree /Count and fall back to the /Page object census; page text follows file order, which may differ from page-tree order.",
        "No clinical interpretation is performed.",
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
      // Extension or media type claims first; magic sniffing never claims a
      // file that carries no `%PDF-` marker.
      if (fileExtension(input) === "pdf") return 0.9;
      if (input.mimeType === "application/pdf") return 0.9;
      const bytes = toBytes(input);
      if (bytes && bytes.length >= PDF_MAGIC.length && hasPdfMagic(bytes)) return 0.85;
      return 0;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const manifest = this.getManifest();
    const bytes = toBytes(input);
    if (!bytes || bytes.length === 0) {
      return {
        format: "pdf",
        domain: "unknown",
        recordCount: 0,
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: ["Empty input: no bytes to inspect"],
      };
    }
    const structure = parsePdfStructure(bytes);
    const warnings = [
      `header: ${structure.headerVersion ? `%PDF-${structure.headerVersion}` : "unknown"}${structure.headerOffset > 0 ? ` (after ${structure.headerOffset} leading byte(s))` : ""}`,
      `pages: ${structure.pageCount ?? "unknown"} (source: ${structure.pageCountSource})`,
      `objects: ${structure.objectCount}, streams: ${structure.streamCount}`,
      structure.xrefEntryCount !== null
        ? `xref entries walked: ${structure.xrefEntryCount}`
        : structure.xrefStream
          ? "xref lives in a compressed /XRef stream (counted via object census)"
          : "xref table not walked (see issues)",
      structure.encrypted ? "encrypted: yes (/Encrypt present; never decrypted)" : "encrypted: no",
      structure.linearized ? "linearized: yes" : "linearized: no",
      `Info: ${Object.keys(structure.info).length === 0 ? "absent" : Object.keys(structure.info).join(", ")}`,
      "parse yields one document envelope, plus one envelope per page only with `extractText: true`",
      ...structure.issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
    ];
    return {
      format: "pdf",
      formatVersion: structure.headerVersion ?? "unknown",
      domain: "document",
      recordCount: structure.pageCount ?? 0,
      detectedSchema: {
        fields: [
          { name: "pageCount", type: "integer", sampleValues: [structure.pageCount], nullable: true },
          { name: "objectCount", type: "integer", sampleValues: [structure.objectCount], nullable: false },
          { name: "streamCount", type: "integer", sampleValues: [structure.streamCount], nullable: false },
          { name: "encrypted", type: "boolean", sampleValues: [structure.encrypted], nullable: false },
          {
            name: "title",
            type: "string",
            sampleValues: structure.info.title ? [structure.info.title] : [],
            nullable: true,
          },
          {
            name: "author",
            type: "string",
            sampleValues: structure.info.author ? [structure.info.author] : [],
            nullable: true,
          },
          {
            name: "subject",
            type: "string",
            sampleValues: structure.info.subject ? [structure.info.subject] : [],
            nullable: true,
          },
          {
            name: "producer",
            type: "string",
            sampleValues: structure.info.producer ? [structure.info.producer] : [],
            nullable: true,
          },
        ],
      },
      sampleRecords: [documentSummary(structure) as unknown as Record<string, unknown>],
      capabilities: manifest.capabilities,
      status: manifest.status,
      warnings,
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const bytes = toBytes(input);
    if (!bytes || bytes.length === 0) {
      context.onIssue?.({
        code: "PDF_EMPTY_INPUT",
        severity: "error",
        message: "Input has no bytes; nothing was parsed",
      });
      return;
    }
    const structure = parsePdfStructure(bytes);
    for (const issue of structure.issues) context.onIssue?.(issue);

    const extractText = context.options?.extractText === true;
    if (structure.encrypted && extractText) {
      context.onIssue?.({
        code: "PDF_ENCRYPTED_REFUSED",
        severity: "error",
        message:
          "Text extraction refused: the file is encrypted and this adapter never attempts decryption — rerun without `extractText: true` for metadata only",
      });
    }

    const checksum = computeChecksum(input);
    yield createCanonicalEnvelope({
      id: "pdf-doc-0",
      domain: "document",
      sourceFormat: "pdf",
      formatVersion: structure.headerVersion ?? "unknown",
      content: { kind: "structured", data: documentSummary(structure) as unknown as Record<string, unknown> },
      importedAt: context.importedAt,
      adapterId: this.id,
      adapterVersion: this.version,
      recordIndex: 0,
      sourceLocation: "document",
      filename: input.filename,
      checksum,
      encoding: "binary (PDF)",
      metadata: {
        ...documentSummary(structure),
        textExtraction: extractText && !structure.encrypted ? "per-page (opt-in, unverified)" : "off",
      },
      parseIssues: structure.issues.map((issue) => ({ ...issue })),
    });

    if (!extractText || structure.encrypted) return;

    const pages = extractPdfPageTexts(bytes);
    const pageLimit = context.maxRecords !== undefined ? Math.max(0, context.maxRecords - 1) : pages.length;
    for (let index = 0; index < Math.min(pages.length, pageLimit); index++) {
      const page = pages[index];
      for (const issue of page.issues) context.onIssue?.({ ...issue, recordIndex: index + 1 });
      yield createCanonicalEnvelope({
        id: `pdf-page-${page.pageNumber}`,
        domain: "document",
        sourceFormat: "pdf",
        formatVersion: structure.headerVersion ?? "unknown",
        content: {
          kind: "structured",
          data: {
            kind: "pdf-page-text",
            pageNumber: page.pageNumber,
            text: page.text,
            textUnverified: true,
            extractionMethod: "Tj/TJ operators (structural, unverified — no OCR, no NLP, no layout inference)",
            encoding: page.encoding,
            charCount: page.charCount,
            truncated: page.truncated,
            streamsDecoded: page.streamsDecoded,
          } as unknown as Record<string, unknown>,
        },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: index + 1,
        sourceLocation: `page ${page.pageNumber} (file order, structural)`,
        filename: input.filename,
        checksum,
        encoding: "binary (PDF)",
        metadata: {
          pageNumber: page.pageNumber,
          charCount: page.charCount,
          truncated: page.truncated,
          textUnverified: true,
          encoding: page.encoding,
          streamsDecoded: page.streamsDecoded,
        },
        parseIssues: page.issues.map((issue) => ({ ...issue, recordIndex: index + 1 })),
      });
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${PDF_ADAPTER_ID} ${PDF_ADAPTER_VERSION} (dependency-free metadata; extraction opt-in, encrypted files never decrypted)`,
    };
  }
}
