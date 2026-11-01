/**
 * EDF / EDF+ and WFDB header metadata adapter (ROADMAP Phase G, metadata scope).
 *
 * Status is honestly `metadata-only`: fixed-width EDF headers (256-byte main
 * header plus per-signal headers: label, transducer type, physical/digital
 * min/max, samples-per-record and derived sampling rates) and WFDB `.hea`
 * header files (record line plus signal lines) are parsed structurally.
 * Recording duration and start date/time are carried as raw header strings
 * only — they are never interpreted into timestamps. Waveform samples NEVER
 * enter envelopes, issues or traces: only data-record counts and byte offsets
 * are recorded, and WFDB sample companions (`.dat` and friends) are
 * referenced by name only, never read.
 *
 * Explicitly NOT supported (refused with an issue, never a crash):
 * - empty input (`EDF_WFDB_EMPTY_INPUT`),
 * - truncated headers (`EDF_TRUNCATED_MAIN_HEADER`,
 *   `EDF_TRUNCATED_SIGNAL_HEADERS`),
 * - BDF 24-bit BioSemi variants (`EDF_BDF_REFUSED` — only 16-bit EDF/EDF+
 *   headers are parsed),
 * - binary sample companions fed directly (`WFDB_BINARY_NOT_HEADER`),
 * - signal interpretation of any kind, and any clinical use (the output is
 *   not clinically validated).
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

export const EDF_WFDB_ADAPTER_ID = "edf-wfdb-adapter";
export const EDF_WFDB_ADAPTER_VERSION = "1.0.0";

/** Fixed size of the EDF main header in bytes. */
export const EDF_MAIN_HEADER_BYTES = 256;
/** Fixed size of one EDF per-signal header block in bytes. */
export const EDF_SIGNAL_HEADER_BYTES = 256;
/** Exact 8-byte version field of EDF and EDF+ files (`"0"` + 7 spaces). */
export const EDF_VERSION_FIELD = "0       ";
/** Prefix of the reserved field (bytes 192..236) that marks EDF+ variants. */
export const EDF_PLUS_PREFIX = "EDF+";
/** Refusal budget for WFDB text lines; larger inputs are refused, not walked. */
export const WFDB_MAX_LINES = 65536;

export type EdfVariant = "edf" | "edf-plus";

export interface EdfChannelMeta {
  /** Zero-based signal index. */
  index: number;
  label: string;
  transducerType: string;
  /** Physical dimension, e.g. `"uV"` (header spelling preserved). */
  units: string;
  physicalMin: number | null;
  physicalMax: number | null;
  digitalMin: number | null;
  digitalMax: number | null;
  samplesPerRecord: number;
  /** `samplesPerRecord / dataRecordDurationSec`; null when duration is unknown. */
  samplingHz: number | null;
  /** Byte offset of this signal's first sample inside one data record. */
  byteOffsetInRecord: number;
}

export interface EdfRecordingMeta {
  variant: EdfVariant;
  /** Raw EDF+ marker from the reserved field (e.g. `"EDF+C"`), null for plain EDF. */
  variantMarker: string | null;
  version: string;
  /** Raw header strings, carried structurally (may identify the subject). */
  patientId: string;
  recordingId: string;
  /** Raw `dd.mm.yy` / `hh.mm.ss` strings — never interpreted into timestamps. */
  startDate: string;
  startTime: string;
  /** Declared total header size in bytes (may disagree with the computed size). */
  headerBytesDeclared: number;
  /** Number of data records; null when the header stores `-1` (unknown). */
  dataRecordCount: number | null;
  dataRecordCountUnknown: boolean;
  dataRecordDurationSec: number;
  /** `dataRecordCount * dataRecordDurationSec`; null when the count is unknown. */
  recordingDurationSec: number | null;
  signalCount: number;
  channels: EdfChannelMeta[];
  bytesPerDataRecord: number;
  /** Byte offset where sample bytes would start (declared header size). */
  dataStartOffset: number;
  /** Expected sample payload bytes; null when the record count is unknown. */
  expectedSampleBytes: number | null;
  inputBytesObserved: number;
}

export interface WfdbSignalMeta {
  /** Zero-based signal index. */
  index: number;
  /** Referenced sample-file name (external companion — never read). */
  fileName: string;
  format: string;
  adcGain: number | null;
  adcGainRaw: string;
  baseline: number | null;
  baselineRaw: string | null;
  units: string | null;
  adcResolution: number | null;
  adcZero: number | null;
  initialValue: number | null;
  checksum: number | null;
  blockSize: number | null;
  signalName: string | null;
  /** 1-based physical line number in the `.hea` text. */
  lineNumber: number;
}

export interface WfdbHeaderMeta {
  recordName: string;
  signalCountDeclared: number;
  signals: WfdbSignalMeta[];
  signalCountMismatch: boolean;
  samplingFrequency: number | null;
  samplingFrequencyRaw: string;
  sampleCount: number | null;
  sampleCountRaw: string | null;
  /** Tokens after the sample count, carried raw and never interpreted. */
  extraRecordTokens: string[];
  /** `sampleCount / samplingFrequency`; null when either side is unknown. */
  recordingDurationSec: number | null;
  /** Distinct referenced companion files (external — never read). */
  companionFiles: string[];
  lineCount: number;
}

export type EdfWfdbRefusal = { refused: true; code: string; message: string };

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

/** Raw bytes for EDF parsing; `latin1` keeps byte offsets aligned for text input. */
function toBytes(input: InputDescriptor): Buffer | undefined {
  if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
  if (input.contentString !== undefined) return Buffer.from(input.contentString, "latin1");
  return undefined;
}

/** Decoded text for WFDB parsing. */
function toText(input: InputDescriptor): string | undefined {
  if (input.contentString !== undefined) {
    const text = input.contentString;
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
  if (input.buffer) return decodeBuffer(Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer)).text;
  return undefined;
}

function readAscii(buffer: Buffer, start: number, length: number): string {
  return buffer.toString("ascii", start, start + length).trim();
}

/** True when the 8-byte version field is exactly the EDF/EDF+ magic. */
export function hasEdfMagic(data: Buffer): boolean {
  return data.length >= 8 && data.toString("ascii", 0, 8) === EDF_VERSION_FIELD;
}

/**
 * True for BDF (24-bit BioSemi) headers: first byte `0xFF` followed by
 * `"BIOSEMI"`. BDF is recognised so it can be refused explicitly, never parsed.
 */
export function isBdfBytes(data: Buffer): boolean {
  return data.length >= 8 && data[0] === 0xff && data.toString("ascii", 1, 8) === "BIOSEMI";
}

/** Raw EDF+ marker from the reserved field, or null for plain EDF. */
export function edfPlusMarker(data: Buffer): string | null {
  if (data.length < 236) return null;
  const reserved = data.toString("ascii", 192, 236);
  if (!reserved.startsWith(EDF_PLUS_PREFIX)) return null;
  return reserved.trim() === "" ? EDF_PLUS_PREFIX : reserved.trim().split(/\s+/)[0];
}

/**
 * True when a line looks like a WFDB record line:
 * `<name> <nsignals> <sampling> …` with no CSV-style delimiters.
 */
export function looksLikeWfdbRecordLine(line: string): boolean {
  if (/[,\t;]/.test(line)) return false;
  return /^\S+\s+\d+\s+\S+/.test(line.trim());
}

function firstContentLine(text: string): string | null {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() !== "") return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// EDF fixed-width header parse
// ---------------------------------------------------------------------------

export type EdfParseResult = EdfWfdbRefusal | { refused: false; meta: EdfRecordingMeta; issues: ValidationIssue[] };

/**
 * Refusal for `.edf`-named inputs that fail EDF magic sniffing: too short to
 * hold a header means truncated, long enough without magic means not EDF.
 */
function edfExtensionRefusal(data: Buffer): EdfWfdbRefusal {
  if (data.length < EDF_MAIN_HEADER_BYTES) {
    return {
      refused: true,
      code: "EDF_TRUNCATED_MAIN_HEADER",
      message: `Only ${data.length} byte(s) in an .edf file: the 256-byte EDF main header is truncated, so nothing was parsed`,
    };
  }
  return {
    refused: true,
    code: "EDF_NOT_EDF",
    message: "No EDF version field (bytes 0..8 are not '0' + spaces): not an EDF/EDF+ file, so nothing was parsed",
  };
}

function parseAsciiInt(raw: string, field: string, location: string): number | EdfWfdbRefusal {
  if (!/^[+-]?\d+$/.test(raw)) {
    return {
      refused: true,
      code: "EDF_INVALID_HEADER_FIELD",
      message: `Header field '${field}' (${location}) is not an integer; nothing was parsed`,
    };
  }
  return parseInt(raw, 10);
}

function parseAsciiFloat(raw: string, field: string, location: string): number | EdfWfdbRefusal {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    return {
      refused: true,
      code: "EDF_INVALID_HEADER_FIELD",
      message: `Header field '${field}' (${location}) is not a number; nothing was parsed`,
    };
  }
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) {
    return {
      refused: true,
      code: "EDF_INVALID_HEADER_FIELD",
      message: `Header field '${field}' (${location}) is not finite; nothing was parsed`,
    };
  }
  return value;
}

function parseOptionalFloat(raw: string): number | null {
  if (raw === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** Parse EDF/EDF+ fixed-width headers. Sample bytes are never touched. */
export function parseEdfBytes(data: Buffer): EdfParseResult {
  const issues: ValidationIssue[] = [];
  if (isBdfBytes(data)) {
    return {
      refused: true,
      code: "EDF_BDF_REFUSED",
      message:
        "BDF (24-bit BioSemi) variant detected (0xFF + BIOSEMI magic): only 16-bit EDF/EDF+ headers are parsed, so nothing was parsed",
    };
  }
  if (data.length < EDF_MAIN_HEADER_BYTES) {
    return {
      refused: true,
      code: "EDF_TRUNCATED_MAIN_HEADER",
      message: `Only ${data.length} byte(s): the 256-byte EDF main header is truncated, so nothing was parsed`,
    };
  }
  if (!hasEdfMagic(data)) {
    return {
      refused: true,
      code: "EDF_NOT_EDF",
      message: "No EDF version field (bytes 0..8 are not '0' + spaces): not an EDF/EDF+ file, so nothing was parsed",
    };
  }

  const version = readAscii(data, 0, 8);
  const patientId = readAscii(data, 8, 80);
  const recordingId = readAscii(data, 88, 80);
  const startDate = readAscii(data, 168, 8);
  const startTime = readAscii(data, 176, 8);
  const marker = edfPlusMarker(data);

  const headerBytesRaw = readAscii(data, 184, 8);
  const numRecordsRaw = readAscii(data, 236, 8);
  const durationRaw = readAscii(data, 244, 8);
  const numSignalsRaw = readAscii(data, 252, 4);

  const headerBytes = parseAsciiInt(headerBytesRaw, "headerBytes", "bytes 184..192");
  if (typeof headerBytes !== "number") return headerBytes;
  const numRecords = parseAsciiInt(numRecordsRaw, "numDataRecords", "bytes 236..244");
  if (typeof numRecords !== "number") return numRecords;
  const recordDuration = parseAsciiFloat(durationRaw, "dataRecordDuration", "bytes 244..252");
  if (typeof recordDuration !== "number") return recordDuration;
  const numSignals = parseAsciiInt(numSignalsRaw, "numSignals", "bytes 252..256");
  if (typeof numSignals !== "number") return numSignals;

  if (numSignals < 1) {
    return {
      refused: true,
      code: "EDF_NO_SIGNALS",
      message: "Header declares zero signals; there is no channel metadata to report, so nothing was parsed",
    };
  }
  if (recordDuration <= 0) {
    return {
      refused: true,
      code: "EDF_INVALID_HEADER_FIELD",
      message: "Header field 'dataRecordDuration' (bytes 244..252) must be positive; nothing was parsed",
    };
  }
  if (numRecords < -1) {
    return {
      refused: true,
      code: "EDF_INVALID_HEADER_FIELD",
      message:
        "Header field 'numDataRecords' (bytes 236..244) must be -1 (unknown) or non-negative; nothing was parsed",
    };
  }

  const required = EDF_MAIN_HEADER_BYTES + numSignals * EDF_SIGNAL_HEADER_BYTES;
  if (data.length < required) {
    return {
      refused: true,
      code: "EDF_TRUNCATED_SIGNAL_HEADERS",
      message:
        `Header declares ${numSignals} signal(s) needing ${required} byte(s) but only ${data.length} byte(s) ` +
        "are present: per-signal headers are truncated, so nothing was parsed",
    };
  }
  if (headerBytes !== required) {
    issues.push({
      code: "EDF_HEADER_BYTES_MISMATCH",
      severity: "warning",
      message:
        `Declared header size is ${headerBytes} byte(s) but ${numSignals} signal(s) imply ${required} byte(s); ` +
        "the declared size is used as the data start offset",
      location: "bytes 184..192",
    });
  }
  if (!/^\d{2}\.\d{2}\.\d{2}$/.test(startDate) || !/^\d{2}\.\d{2}\.\d{2}$/.test(startTime)) {
    issues.push({
      code: "EDF_MALFORMED_DATE",
      severity: "warning",
      message: "Start date/time do not match dd.mm.yy hh.mm.ss; they are carried raw and never interpreted",
      location: "bytes 168..184",
    });
  }

  // Per-signal fields are laid out as field-major spans: each field occupies
  // numSignals consecutive slots before the next field starts.
  const fieldBase = (fieldOffset: number, slot: number): number => EDF_MAIN_HEADER_BYTES + fieldOffset + slot;
  const labelBase = 0;
  const transducerBase = numSignals * 16;
  const unitsBase = transducerBase + numSignals * 80;
  const physMinBase = unitsBase + numSignals * 8;
  const physMaxBase = physMinBase + numSignals * 8;
  const digMinBase = physMaxBase + numSignals * 8;
  const digMaxBase = digMinBase + numSignals * 8;
  const prefilterBase = digMaxBase + numSignals * 8;
  const samplesBase = prefilterBase + numSignals * 80;

  const channels: EdfChannelMeta[] = [];
  let byteOffset = 0;
  for (let i = 0; i < numSignals; i++) {
    const samplesRaw = readAscii(data, fieldBase(samplesBase, i * 8), 8);
    const samples = parseAsciiInt(samplesRaw, `samplesPerRecord[signal ${i}]`, `signal header ${i}`);
    if (typeof samples !== "number") return samples;
    if (samples < 1) {
      return {
        refused: true,
        code: "EDF_INVALID_HEADER_FIELD",
        message: `Header field 'samplesPerRecord[signal ${i}]' must be at least 1; nothing was parsed`,
      };
    }
    const physMinRaw = readAscii(data, fieldBase(physMinBase, i * 8), 8);
    const physMaxRaw = readAscii(data, fieldBase(physMaxBase, i * 8), 8);
    const digMinRaw = readAscii(data, fieldBase(digMinBase, i * 8), 8);
    const digMaxRaw = readAscii(data, fieldBase(digMaxBase, i * 8), 8);
    const physicalMin = parseOptionalFloat(physMinRaw);
    const physicalMax = parseOptionalFloat(physMaxRaw);
    const digitalMin = parseOptionalFloat(digMinRaw);
    const digitalMax = parseOptionalFloat(digMaxRaw);
    if (
      (physMinRaw !== "" && physicalMin === null) ||
      (physMaxRaw !== "" && physicalMax === null) ||
      (digMinRaw !== "" && digitalMin === null) ||
      (digMaxRaw !== "" && digitalMax === null)
    ) {
      issues.push({
        code: "EDF_UNPARSEABLE_CALIBRATION",
        severity: "warning",
        message: `Signal ${i}: a physical/digital min/max field is not numeric and is reported as null`,
        location: `signal header ${i}`,
      });
    }
    const channel: EdfChannelMeta = {
      index: i,
      label: readAscii(data, fieldBase(labelBase, i * 16), 16),
      transducerType: readAscii(data, fieldBase(transducerBase, i * 80), 80),
      units: readAscii(data, fieldBase(unitsBase, i * 8), 8),
      physicalMin,
      physicalMax,
      digitalMin,
      digitalMax,
      samplesPerRecord: samples,
      samplingHz: samples / recordDuration,
      byteOffsetInRecord: byteOffset,
    };
    channels.push(channel);
    byteOffset += samples * 2;
  }

  const countUnknown = numRecords === -1;
  const meta: EdfRecordingMeta = {
    variant: marker === null ? "edf" : "edf-plus",
    variantMarker: marker,
    version,
    patientId,
    recordingId,
    startDate,
    startTime,
    headerBytesDeclared: headerBytes,
    dataRecordCount: countUnknown ? null : numRecords,
    dataRecordCountUnknown: countUnknown,
    dataRecordDurationSec: recordDuration,
    recordingDurationSec: countUnknown ? null : numRecords * recordDuration,
    signalCount: numSignals,
    channels,
    bytesPerDataRecord: byteOffset,
    dataStartOffset: headerBytes,
    expectedSampleBytes: countUnknown ? null : numRecords * byteOffset,
    inputBytesObserved: data.length,
  };
  return { refused: false, meta, issues };
}

// ---------------------------------------------------------------------------
// WFDB `.hea` structural parse
// ---------------------------------------------------------------------------

export type WfdbParseResult = EdfWfdbRefusal | { refused: false; meta: WfdbHeaderMeta; issues: ValidationIssue[] };

function parseLeadingFloat(raw: string): number | null {
  const match = /^[+-]?\d+(\.\d+)?/.exec(raw);
  if (!match) return null;
  const value = parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function parseGainToken(raw: string): { gain: number | null; baseline: number | null; baselineRaw: string | null } {
  const match = /^([^()]*)(?:\(([^()]*)\))?$/.exec(raw);
  if (!match) return { gain: null, baseline: null, baselineRaw: null };
  const gain = match[1] === "" ? null : parseOptionalNumber(match[1]);
  const baselineRaw = match[2] === undefined || match[2] === "" ? null : match[2];
  return {
    gain: match[1] === "" ? null : gain,
    baseline: baselineRaw === null ? null : parseOptionalNumber(baselineRaw),
    baselineRaw,
  };
}

/**
 * Parse a WFDB `.hea` header file structurally. Referenced sample files are
 * never opened — only their names are recorded as external companions.
 */
export function parseWfdbText(text: string): WfdbParseResult {
  const issues: ValidationIssue[] = [];
  if (text.includes("\0")) {
    return {
      refused: true,
      code: "WFDB_BINARY_NOT_HEADER",
      message: "Input contains NUL bytes: binary sample data, not a WFDB text header, so nothing was parsed",
    };
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > WFDB_MAX_LINES) {
    return {
      refused: true,
      code: "WFDB_HEADER_TOO_LARGE",
      message: `Header has ${lines.length} line(s) (budget ${WFDB_MAX_LINES}); nothing was parsed`,
    };
  }
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex === -1) {
    return {
      refused: true,
      code: "WFDB_INVALID_RECORD_LINE",
      message: "Header has no record line: not a WFDB .hea file, so nothing was parsed",
    };
  }
  const recordLine = lines[firstIndex].trim();
  const recordTokens = recordLine.split(/\s+/);
  if (recordTokens.length < 3 || !/^\d+$/.test(recordTokens[1])) {
    return {
      refused: true,
      code: "WFDB_INVALID_RECORD_LINE",
      message: `Line ${firstIndex + 1} is not a WFDB record line ('<name> <nsignals> <sampling> …'); nothing was parsed`,
    };
  }
  const signalCountDeclared = parseInt(recordTokens[1], 10);
  if (signalCountDeclared < 1) {
    return {
      refused: true,
      code: "WFDB_INVALID_RECORD_LINE",
      message: `Line ${firstIndex + 1} declares zero signals; there is no channel metadata to report, so nothing was parsed`,
    };
  }
  const samplingFrequencyRaw = recordTokens[2];
  const samplingFrequency = parseLeadingFloat(samplingFrequencyRaw);
  if (samplingFrequency === null || samplingFrequency <= 0) {
    issues.push({
      code: "WFDB_UNPARSEABLE_SAMPLING",
      severity: "warning",
      message: `Line ${firstIndex + 1}: sampling frequency is not numeric and is reported as null`,
      location: `line ${firstIndex + 1}`,
    });
  }
  const sampleCountRaw = recordTokens.length > 3 ? recordTokens[3] : null;
  const sampleCount = sampleCountRaw !== null && /^\d+$/.test(sampleCountRaw) ? parseInt(sampleCountRaw, 10) : null;
  if (sampleCountRaw !== null && sampleCount === null) {
    issues.push({
      code: "WFDB_UNPARSEABLE_SAMPLE_COUNT",
      severity: "warning",
      message: `Line ${firstIndex + 1}: sample count is not numeric and is reported as null`,
      location: `line ${firstIndex + 1}`,
    });
  }

  const signals: WfdbSignalMeta[] = [];
  for (let lineNumber = firstIndex + 2; lineNumber <= lines.length; lineNumber++) {
    const raw = lines[lineNumber - 1];
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 3) {
      issues.push({
        code: "WFDB_INVALID_SIGNAL_LINE",
        severity: "warning",
        message: `Line ${lineNumber} has fewer than 3 fields and is skipped (expected '<file> <format> <gain> …')`,
        location: `line ${lineNumber}`,
      });
      continue;
    }
    const gain = parseGainToken(tokens[2]);
    let rest = tokens.slice(3);
    // Bare baseline (older headers without parentheses): when the gain token
    // carries no baseline and the next token is numeric, it is the baseline.
    let baseline = gain.baseline;
    let baselineRaw = gain.baselineRaw;
    if (baseline === null && rest.length > 0 && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(rest[0])) {
      baseline = parseFloat(rest[0]);
      baselineRaw = rest[0];
      rest = rest.slice(1);
    }
    // Units: parenthesised, or a bare non-numeric token followed later by
    // numeric fields (otherwise the trailing token is the signal name).
    let units: string | null = null;
    if (rest.length > 0 && /^\(.*\)$/.test(rest[0])) {
      units = rest[0].slice(1, -1);
      rest = rest.slice(1);
    } else if (
      rest.length > 1 &&
      !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(rest[0]) &&
      rest.slice(1).some((token) => /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(token))
    ) {
      units = rest[0];
      rest = rest.slice(1);
    }
    const numericKeys = ["adcResolution", "adcZero", "initialValue", "checksum", "blockSize"] as const;
    const numeric: Record<(typeof numericKeys)[number], number | null> = {
      adcResolution: null,
      adcZero: null,
      initialValue: null,
      checksum: null,
      blockSize: null,
    };
    let consumed = 0;
    for (const key of numericKeys) {
      if (consumed >= rest.length || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(rest[consumed])) break;
      numeric[key] = parseFloat(rest[consumed]);
      consumed++;
    }
    const leftover = rest.slice(consumed);
    signals.push({
      index: signals.length,
      fileName: tokens[0],
      format: tokens[1],
      adcGain: gain.gain,
      adcGainRaw: tokens[2],
      baseline,
      baselineRaw,
      units,
      adcResolution: numeric.adcResolution,
      adcZero: numeric.adcZero,
      initialValue: numeric.initialValue,
      checksum: numeric.checksum,
      blockSize: numeric.blockSize,
      signalName: leftover.length > 0 ? leftover.join(" ") : null,
      lineNumber,
    });
  }

  if (signals.length === 0) {
    return {
      refused: true,
      code: "WFDB_NO_SIGNAL_LINES",
      message: "Record line declares signals but no signal lines follow; nothing was parsed",
    };
  }
  const signalCountMismatch = signals.length !== signalCountDeclared;
  if (signalCountMismatch) {
    issues.push({
      code: "WFDB_SIGNAL_COUNT_MISMATCH",
      severity: "warning",
      message:
        `Record line declares ${signalCountDeclared} signal(s) but ${signals.length} signal line(s) were found; ` +
        "the lines present are reported",
      location: `line ${firstIndex + 1}`,
    });
  }

  const meta: WfdbHeaderMeta = {
    recordName: recordTokens[0],
    signalCountDeclared,
    signals,
    signalCountMismatch,
    samplingFrequency: samplingFrequency !== null && samplingFrequency > 0 ? samplingFrequency : null,
    samplingFrequencyRaw,
    sampleCount,
    sampleCountRaw,
    extraRecordTokens: recordTokens.slice(4),
    recordingDurationSec:
      sampleCount !== null && samplingFrequency !== null && samplingFrequency > 0
        ? sampleCount / samplingFrequency
        : null,
    companionFiles: [...new Set(signals.map((signal) => signal.fileName))],
    lineCount: lines.length,
  };
  return { refused: false, meta, issues };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function edfSummaryWarnings(meta: EdfRecordingMeta): string[] {
  const duration =
    meta.recordingDurationSec === null
      ? "unknown duration"
      : `${meta.recordingDurationSec} second(s) of header-declared recording`;
  const channels = meta.channels
    .map(
      (channel) =>
        `${channel.label === "" ? `signal-${channel.index}` : channel.label} (${channel.units === "" ? "units unknown" : channel.units}, ${channel.samplingHz ?? "?"} Hz)`,
    )
    .join("; ");
  return [
    `Variant: ${meta.variant === "edf-plus" ? `EDF+ (${meta.variantMarker})` : "EDF"}`,
    `Channels: ${meta.signalCount} (${channels})`,
    `Duration: ${duration} across ${meta.dataRecordCount === null ? "unknown" : meta.dataRecordCount} data record(s) of ${meta.dataRecordDurationSec}s`,
    `Data layout: ${meta.bytesPerDataRecord} byte(s) per data record starting at byte ${meta.dataStartOffset}; sample bytes never inlined`,
  ];
}

function wfdbSummaryWarnings(meta: WfdbHeaderMeta): string[] {
  const duration =
    meta.recordingDurationSec === null
      ? "unknown duration"
      : `${meta.recordingDurationSec} second(s) of header-declared recording`;
  const channels = meta.signals
    .map(
      (signal) =>
        `${signal.signalName ?? `signal-${signal.index}`} (${signal.units ?? "units unknown"}, file ${signal.fileName})`,
    )
    .join("; ");
  return [
    `Record: ${meta.recordName}, sampling ${meta.samplingFrequencyRaw} Hz`,
    `Channels: ${meta.signals.length} declared ${meta.signalCountDeclared} (${channels})`,
    `Duration: ${duration} (${meta.sampleCount === null ? "unknown sample count" : `${meta.sampleCount} samples`})`,
    `Companions: ${meta.companionFiles.join(", ")} — external sample files, referenced by name only and never read`,
  ];
}

export class EdfWfdbFormatAdapter implements MedicalFormatAdapter {
  public id = EDF_WFDB_ADAPTER_ID;
  public version = EDF_WFDB_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "edf-wfdb",
      version: EDF_WFDB_ADAPTER_VERSION,
      description:
        "EDF/EDF+ fixed-width header and WFDB .hea header metadata adapter: channels, units, sampling and durations without samples",
      extensions: [".edf", ".hea", ".dat"],
      mimeTypes: ["application/x-edf", "text/vnd.physionet-wfdb"],
      status: "metadata-only",
      limitations: [
        "Metadata only: headers are parsed structurally — waveform samples never enter envelopes, issues or traces.",
        "Recording dates and durations are carried as raw header values only, never interpreted into timestamps.",
        "No signal interpretation is performed and output is not clinically validated; no clinical use.",
        "BDF (24-bit BioSemi) variants are refused with EDF_BDF_REFUSED; only 16-bit EDF/EDF+ headers are parsed.",
        "WFDB sample companions (.dat and other referenced files) are listed by name only and never read.",
        "EDF+ annotation channels are listed as channels only; annotations are never interpreted.",
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
      const buf = toBytes(input);
      if (buf !== undefined && buf.length > 0) {
        if (isBdfBytes(buf)) return 0.85;
        if (hasEdfMagic(buf)) return 0.95;
      }
      const ext = fileExtension(input);
      if (ext === "dat") {
        // Companion awareness without claiming binaries: .dat sample files are
        // recognised as belonging to this family but never claimed (detect stays false).
        if (buf !== undefined && buf.length > 0 && hasEdfMagic(buf)) return 0.95;
        const text = toText(input);
        if (text !== undefined) {
          const first = firstContentLine(text);
          if (first !== null && looksLikeWfdbRecordLine(first)) return 0.75;
        }
        return 0.3;
      }
      if (ext === "edf") return 0.9;
      if (ext === "hea") {
        const text = toText(input);
        if (text !== undefined) {
          const first = firstContentLine(text);
          if (first !== null && looksLikeWfdbRecordLine(first)) return 0.95;
        }
        return 0.9;
      }
      if (input.mimeType === "application/x-edf" || input.mimeType === "text/vnd.physionet-wfdb") return 0.9;
      if (buf !== undefined && buf.length > 0) {
        const text = toText(input);
        if (text !== undefined) {
          const first = firstContentLine(text);
          // Extension-less (or .txt) text matching the record-line pattern is
          // plausibly a WFDB header; delimited text (CSV/JSON) never matches.
          if (first !== null && looksLikeWfdbRecordLine(first) && (ext === "" || ext === "txt")) return 0.75;
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const capabilities = this.getManifest().capabilities;
    const status = this.getManifest().status;
    try {
      const buf = toBytes(input);
      if (buf === undefined || buf.length === 0) {
        return {
          format: "edf-wfdb",
          domain: "waveform",
          recordCount: 0,
          capabilities,
          status,
          warnings: ["Input has no readable bytes; nothing was inspected"],
        };
      }
      if (isBdfBytes(buf)) {
        return {
          format: "edf-wfdb",
          formatVersion: "bdf-refused",
          domain: "waveform",
          recordCount: 0,
          capabilities,
          status,
          warnings: [
            "EDF_BDF_REFUSED: BDF (24-bit BioSemi) variants are refused; only 16-bit EDF/EDF+ headers are parsed",
          ],
        };
      }
      if (fileExtension(input) === "edf" && !hasEdfMagic(buf)) {
        const refused = edfExtensionRefusal(buf);
        return {
          format: "edf-wfdb",
          formatVersion: "edf-refused",
          domain: "waveform",
          recordCount: 0,
          capabilities,
          status,
          warnings: [`${refused.code}: ${refused.message}`],
        };
      }
      if (hasEdfMagic(buf)) {
        const parsed = parseEdfBytes(buf);
        if (parsed.refused) {
          return {
            format: "edf-wfdb",
            formatVersion: "edf-refused",
            domain: "waveform",
            recordCount: 0,
            capabilities,
            status,
            warnings: [`${parsed.code}: ${parsed.message}`],
          };
        }
        const { meta, issues } = parsed;
        return {
          format: "edf-wfdb",
          formatVersion: meta.variant === "edf-plus" ? `EDF+ (${meta.variantMarker})` : "EDF",
          domain: "waveform",
          recordCount: 1,
          detectedSchema: {
            fields: meta.channels.map((channel) => ({
              name: channel.label === "" ? `signal-${channel.index}` : channel.label,
              type: channel.units === "" ? "unknown-units" : channel.units,
              sampleValues: [channel.samplingHz],
              nullable: false,
            })),
          },
          sampleRecords: [
            {
              variant: meta.variant,
              signalCount: meta.signalCount,
              recordingDurationSec: meta.recordingDurationSec,
              dataRecordCount: meta.dataRecordCount,
              dataStartOffset: meta.dataStartOffset,
              bytesPerDataRecord: meta.bytesPerDataRecord,
            } as unknown as Record<string, unknown>,
          ],
          capabilities,
          status,
          warnings: [
            ...edfSummaryWarnings(meta),
            ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
          ],
        };
      }
      const text = toText(input);
      if (text === undefined) {
        return {
          format: "edf-wfdb",
          domain: "waveform",
          recordCount: 0,
          capabilities,
          status,
          warnings: ["Input has no readable text; nothing was inspected"],
        };
      }
      const parsed = parseWfdbText(text);
      if (parsed.refused) {
        return {
          format: "edf-wfdb",
          formatVersion: "wfdb-refused",
          domain: "waveform",
          recordCount: 0,
          capabilities,
          status,
          warnings: [`${parsed.code}: ${parsed.message}`],
        };
      }
      const { meta, issues } = parsed;
      return {
        format: "edf-wfdb",
        formatVersion: "WFDB-hea",
        domain: "waveform",
        recordCount: 1,
        detectedSchema: {
          fields: meta.signals.map((signal) => ({
            name: signal.signalName ?? `signal-${signal.index}`,
            type: signal.units ?? "unknown-units",
            sampleValues: [signal.fileName],
            nullable: false,
          })),
        },
        sampleRecords: [
          {
            recordName: meta.recordName,
            signalCount: meta.signals.length,
            samplingFrequency: meta.samplingFrequency,
            recordingDurationSec: meta.recordingDurationSec,
            companionFiles: meta.companionFiles,
          } as unknown as Record<string, unknown>,
        ],
        capabilities,
        status,
        warnings: [
          ...wfdbSummaryWarnings(meta),
          ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
        ],
      };
    } catch (error) {
      return {
        format: "edf-wfdb",
        domain: "waveform",
        recordCount: 0,
        capabilities,
        status,
        warnings: [`Inspection failed without throwing semantics: ${(error as Error).message}`],
      };
    }
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const emit = (issue: ValidationIssue): void => {
      try {
        context.onIssue?.(issue);
      } catch {
        // Listener failures must never break the walk.
      }
    };
    let buf: Buffer | undefined;
    try {
      buf = toBytes(input);
    } catch (error) {
      emit({
        code: "EDF_WFDB_EMPTY_INPUT",
        severity: "error",
        message: `Input bytes could not be read: ${(error as Error).message}`,
      });
      return;
    }
    if (buf === undefined || buf.length === 0) {
      emit({
        code: "EDF_WFDB_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable bytes; nothing was parsed",
      });
      return;
    }
    if (isBdfBytes(buf)) {
      emit({
        code: "EDF_BDF_REFUSED",
        severity: "error",
        message:
          "BDF (24-bit BioSemi) variant detected (0xFF + BIOSEMI magic): only 16-bit EDF/EDF+ headers are parsed, so nothing was parsed",
      });
      return;
    }
    if (fileExtension(input) === "edf" && !hasEdfMagic(buf)) {
      const refused = edfExtensionRefusal(buf);
      emit({ code: refused.code, severity: "error", message: refused.message });
      return;
    }
    if (hasEdfMagic(buf)) {
      let parsed: EdfParseResult;
      try {
        parsed = parseEdfBytes(buf);
      } catch (error) {
        emit({
          code: "EDF_PARSE_FAILED",
          severity: "fatal",
          message: `Unexpected parser failure (no partial state kept): ${(error as Error).message}`,
        });
        return;
      }
      if (parsed.refused) {
        emit({ code: parsed.code, severity: "error", message: parsed.message });
        return;
      }
      for (const issue of parsed.issues) emit(issue);
      const { meta } = parsed;
      const checksum = computeChecksum(input);
      yield createCanonicalEnvelope({
        id: "edf-recording-0",
        domain: "waveform",
        sourceFormat: "edf-wfdb",
        formatVersion: meta.variant === "edf-plus" ? `EDF+ (${meta.variantMarker})` : "EDF",
        content: {
          kind: "structured",
          data: {
            kind: "edf-recording",
            variant: meta.variant,
            variantMarker: meta.variantMarker,
            version: meta.version,
            patientId: meta.patientId,
            recordingId: meta.recordingId,
            startDate: meta.startDate,
            startTime: meta.startTime,
            signalCount: meta.signalCount,
            channels: meta.channels as unknown as Record<string, unknown>,
            dataRecordCount: meta.dataRecordCount,
            dataRecordCountUnknown: meta.dataRecordCountUnknown,
            dataRecordDurationSec: meta.dataRecordDurationSec,
            recordingDurationSec: meta.recordingDurationSec,
            dataLayout: {
              headerBytesDeclared: meta.headerBytesDeclared,
              dataStartOffset: meta.dataStartOffset,
              bytesPerDataRecord: meta.bytesPerDataRecord,
              dataRecordCount: meta.dataRecordCount,
              expectedSampleBytes: meta.expectedSampleBytes,
              inputBytesObserved: meta.inputBytesObserved,
            },
            samples: {
              inlined: false,
              note: "Metadata only: data-record sample bytes never enter envelopes, issues or traces",
            },
          },
        },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: 0,
        sourceLocation: "header",
        filename: input.filename,
        checksum,
        encoding: "edf-binary",
        metadata: {
          variant: meta.variant,
          signalCount: meta.signalCount,
          channelLabels: meta.channels.map((channel) => channel.label),
          channelUnits: meta.channels.map((channel) => channel.units),
          samplingHz: meta.channels.map((channel) => channel.samplingHz),
          recordingDurationSec: meta.recordingDurationSec,
          dataRecordCount: meta.dataRecordCount,
          dataStartOffset: meta.dataStartOffset,
          bytesPerDataRecord: meta.bytesPerDataRecord,
        },
        parseIssues: parsed.issues.length > 0 ? [...parsed.issues] : undefined,
      });
      return;
    }
    let text: string | undefined;
    try {
      text = toText(input);
    } catch (error) {
      emit({
        code: "EDF_WFDB_EMPTY_INPUT",
        severity: "error",
        message: `Input text could not be read: ${(error as Error).message}`,
      });
      return;
    }
    if (text === undefined) {
      emit({
        code: "EDF_WFDB_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }
    let parsed: WfdbParseResult;
    try {
      parsed = parseWfdbText(text);
    } catch (error) {
      emit({
        code: "WFDB_PARSE_FAILED",
        severity: "fatal",
        message: `Unexpected parser failure (no partial state kept): ${(error as Error).message}`,
      });
      return;
    }
    if (parsed.refused) {
      emit({ code: parsed.code, severity: "error", message: parsed.message });
      return;
    }
    for (const issue of parsed.issues) emit(issue);
    const { meta } = parsed;
    const checksum = computeChecksum(input);
    yield createCanonicalEnvelope({
      id: "wfdb-record-0",
      domain: "waveform",
      sourceFormat: "edf-wfdb",
      formatVersion: "WFDB-hea",
      content: {
        kind: "structured",
        data: {
          kind: "wfdb-recording",
          recordName: meta.recordName,
          signalCountDeclared: meta.signalCountDeclared,
          signalCountMismatch: meta.signalCountMismatch,
          signals: meta.signals as unknown as Record<string, unknown>,
          samplingFrequency: meta.samplingFrequency,
          samplingFrequencyRaw: meta.samplingFrequencyRaw,
          sampleCount: meta.sampleCount,
          sampleCountRaw: meta.sampleCountRaw,
          extraRecordTokens: meta.extraRecordTokens,
          recordingDurationSec: meta.recordingDurationSec,
          companions: {
            files: meta.companionFiles,
            external: true,
            note: "Sample bytes live in external companion files, referenced by name only and never read",
          },
          samples: {
            inlined: false,
            note: "Metadata only: sample bytes never enter envelopes, issues or traces",
          },
        },
      },
      importedAt: context.importedAt,
      adapterId: this.id,
      adapterVersion: this.version,
      recordIndex: 0,
      sourceLocation: "header",
      filename: input.filename,
      checksum,
      encoding: "wfdb-hea-text",
      metadata: {
        recordName: meta.recordName,
        signalCount: meta.signals.length,
        signalNames: meta.signals.map((signal) => signal.signalName),
        samplingFrequency: meta.samplingFrequency,
        recordingDurationSec: meta.recordingDurationSec,
        sampleCount: meta.sampleCount,
        companionFiles: meta.companionFiles,
      },
      parseIssues: parsed.issues.length > 0 ? [...parsed.issues] : undefined,
    });
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${EDF_WFDB_ADAPTER_ID} ${EDF_WFDB_ADAPTER_VERSION} (EDF/EDF+ and WFDB header metadata only; samples never inlined, no signal interpretation, no clinical use)`,
    };
  }
}
