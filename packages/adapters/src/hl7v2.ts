/**
 * HL7 v2 (2.3-2.9) metadata adapter — MSH/segment/field/component parsing.
 *
 * Status is honestly `metadata-only`: messages are inspected structurally and
 * carried as structural envelopes (ADT^A01 as Patient-shaped, ORU^R01 as
 * Observation/DiagnosticReport-shaped). No clinical interpretation is performed
 * here — values are preserved verbatim, coded mappings are documented lookup
 * tables with the raw HL7 value always retained in envelope metadata, and
 * abnormal flags / diagnoses / Z-segments are never interpreted.
 *
 * Parsing rules (HL7 v2.x chapter 2 — message control, section 2.7 escapes):
 * - Segments terminate on CR, LF or CRLF; MLLP framing bytes are stripped.
 * - MSH-1 is the field separator; MSH-2 carries the encoding characters
 *   (component ^, repetition ~, escape \, subcomponent & by default).
 * - Fields split into repetitions, components and subcomponents on those
 *   separators; escape sequences are decoded per the HL7 table inside the
 *   smallest unit only, so an escaped separator decodes to a literal
 *   character and never acts as structure.
 * - Every segment that is not structurally mapped (including Z-segments and
 *   site-defined segments) is reported via `ParseContext.onIssue` and preserved
 *   in `unmappedFields` — never swallowed.
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
import { decodeBuffer } from "./csv.js";

export const HL7V2_ADAPTER_ID = "hl7v2-adapter";
export const HL7V2_ADAPTER_VERSION = "1.0.0";

/** HL7 v2 versions this adapter structurally supports (PLAN section 3). */
export const SUPPORTED_HL7_VERSIONS = [
  "2.3",
  "2.3.1",
  "2.4",
  "2.5",
  "2.5.1",
  "2.6",
  "2.7",
  "2.7.1",
  "2.8",
  "2.8.1",
  "2.8.2",
  "2.9",
];

/** Segments structurally mapped into envelopes; everything else is reported. */
const HANDLED_SEGMENTS = new Set(["MSH", "PID", "PV1", "OBR", "OBX"]);

export interface Hl7Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

export const DEFAULT_DELIMITERS: Hl7Delimiters = {
  field: "|",
  component: "^",
  repetition: "~",
  escape: "\\",
  subcomponent: "&",
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

/**
 * Decode one HL7 escape sequence body (the text between the escape-character
 * pair) per HL7 v2 section 2.7. Unknown or local sequences are kept verbatim
 * so no source data is ever lost by decoding.
 */
function decodeEscapeBody(body: string, delimiters: Hl7Delimiters): string {
  switch (body) {
    case "F":
      return delimiters.field;
    case "S":
      return delimiters.component;
    case "R":
      return delimiters.repetition;
    case "E":
      return delimiters.escape;
    case "T":
      return delimiters.subcomponent;
    case ".br":
    case "BR":
      return "\n";
    default:
      break;
  }
  if (body.startsWith("X") && body.length > 1) {
    const hex = body.slice(1);
    if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length % 2 === 0) {
      let decoded = "";
      for (let i = 0; i < hex.length; i += 2) {
        decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      return decoded;
    }
  }
  // \Z...\, \C...\, \M...\, \H\, \N\ and anything unrecognised: verbatim.
  return `${delimiters.escape}${body}${delimiters.escape}`;
}

/**
 * Decode HL7 escape sequences inside a single subcomponent value. The escape
 * character itself is the only trigger; an unterminated trailing escape is
 * kept verbatim and reported by the caller when it matters.
 */
export function decodeEscapes(value: string, delimiters: Hl7Delimiters = DEFAULT_DELIMITERS): string {
  if (!value.includes(delimiters.escape)) return value;
  const esc = delimiters.escape;
  let result = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf(esc, i);
    if (start === -1) {
      result += value.slice(i);
      break;
    }
    result += value.slice(i, start);
    const end = value.indexOf(esc, start + esc.length);
    if (end === -1) {
      result += value.slice(start);
      break;
    }
    result += decodeEscapeBody(value.slice(start + esc.length, end), delimiters);
    i = end + esc.length;
  }
  return result;
}

/** A parsed component: decoded subcomponent strings. */
export type Hl7Component = string[];

/** A parsed field: repetitions of components of subcomponents (all decoded). */
export type Hl7Field = Hl7Component[][];

export interface Hl7Segment {
  name: string;
  lineNumber: number;
  raw: string;
  /** Fields in segment order (MSH fields[0] is MSH-2, the encoding characters). */
  fields: Hl7Field[];
}

function parseField(raw: string, delimiters: Hl7Delimiters): Hl7Field {
  if (raw === "") return [];
  return raw
    .split(delimiters.repetition)
    .map((rep) =>
      rep
        .split(delimiters.component)
        .map((comp) => comp.split(delimiters.subcomponent).map((sub) => decodeEscapes(sub, delimiters))),
    );
}

/** First repetition, first component, first subcomponent — or "" when absent. */
function fieldFirst(field: Hl7Field | undefined): string {
  return field?.[0]?.[0]?.[0] ?? "";
}

/** First repetition as component texts (subcomponents rejoined with `&`). */
function fieldComponents(field: Hl7Field | undefined, delimiters: Hl7Delimiters, repetition = 0): string[] {
  const rep = field?.[repetition];
  if (!rep) return [];
  return rep.map((comp) => comp.join(delimiters.subcomponent));
}

export interface MshHeader {
  fieldSeparator: string;
  delimiters: Hl7Delimiters;
  /** Raw MSH fields: fields[0] is MSH-2 (encoding characters), fields[1] MSH-3, ... */
  fields: Hl7Field[];
  messageCode: string;
  triggerEvent: string;
  messageStructure: string;
  messageControlId: string;
  version: string;
  sendingApplication: string;
  sendingFacility: string;
}

/**
 * Parse an MSH segment line. MSH is special: MSH-1 is the separator itself,
 * so fields start at MSH-2. Returns the header plus any structural issues
 * (never throws — the caller reports the issues).
 */
export function parseMshHeader(
  raw: string,
  lineNumber: number,
): { header: MshHeader | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const location = `line ${lineNumber}`;
  if (!raw.startsWith("MSH") || raw.length < 4) {
    issues.push({
      code: "HL7_MALFORMED_MSH",
      severity: "error",
      message: "MSH segment is shorter than 'MSH' plus a field separator; the message was skipped",
      location,
    });
    return { header: null, issues };
  }
  const fieldSeparator = raw[3];
  const rawFields = raw.slice(4).split(fieldSeparator);
  const encoding = rawFields[0] ?? "";
  const delimiters: Hl7Delimiters = {
    field: fieldSeparator,
    component: encoding[0] ?? DEFAULT_DELIMITERS.component,
    repetition: encoding[1] ?? DEFAULT_DELIMITERS.repetition,
    escape: encoding[2] ?? DEFAULT_DELIMITERS.escape,
    subcomponent: encoding[3] ?? DEFAULT_DELIMITERS.subcomponent,
  };
  if (encoding.length !== 4) {
    issues.push({
      code: "HL7_INVALID_ENCODING_CHARACTERS",
      severity: "warning",
      message: `MSH-2 encoding characters should be 4 characters (got '${encoding}'); missing separators fall back to '^~\\&'`,
      location,
    });
  }
  // MSH-2 is atomic (it *defines* the separators); every other field parses normally.
  const fields: Hl7Field[] = rawFields.map((rawField, index) =>
    index === 0 ? (rawField === "" ? [] : [[[`MSH-2:${rawField}`]]]) : parseField(rawField, delimiters),
  );
  const messageParts = fieldComponents(fields[7], delimiters);
  const header: MshHeader = {
    fieldSeparator,
    delimiters,
    fields,
    messageCode: messageParts[0] ?? "",
    triggerEvent: messageParts[1] ?? "",
    messageStructure: messageParts[2] ?? "",
    messageControlId: fieldFirst(fields[8]),
    version: fieldFirst(fields[10]),
    sendingApplication: fieldFirst(fields[1]),
    sendingFacility: fieldFirst(fields[2]),
  };
  return { header, issues };
}

/**
 * Normalise an HL7 DTM/DT/TM value (`YYYYMMDD[HH[MM[SS[.S]]]][±ZZZZ]`) to an
 * ISO-8601 prefix. Returns null when the value is not a valid HL7 datetime —
 * the caller keeps the raw value and reports it instead of guessing.
 */
export function normaliseHl7DateTime(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d+))?)?)?)?\s*(Z|[+-]\d{4})?$/.exec(
    trimmed,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (month < "01" || month > "12" || day < "01" || day > "31") return null;
  if (hour !== undefined && (hour < "00" || hour > "23")) return null;
  if (minute !== undefined && (minute < "00" || minute > "59")) return null;
  if (second !== undefined && (second < "00" || second > "59")) return null;
  let iso = `${year}-${month}-${day}`;
  if (hour !== undefined) {
    iso += `T${hour}:${minute ?? "00"}`;
    if (second !== undefined) iso += `:${second}`;
    if (fraction !== undefined) iso += `.${fraction}`;
    if (zone !== undefined && zone !== "Z") iso += `${zone.slice(0, 3)}:${zone.slice(3)}`;
    else if (zone === "Z") iso += "Z";
  }
  return iso;
}

/** HL7 table 0001 (administrative sex) mapped structurally to FHIR-shaped gender. */
function mapAdminSex(raw: string): string | undefined {
  switch (raw.toUpperCase()) {
    case "M":
      return "male";
    case "F":
      return "female";
    case "O":
    case "A":
    case "N":
      return "other";
    case "U":
      return "unknown";
    default:
      return undefined;
  }
}

/** HL7 table 0123 (result status, OBR-25) mapped structurally to a DiagnosticReport status. */
function mapResultStatus(raw: string): string {
  switch (raw.toUpperCase()) {
    case "F":
      return "final";
    case "C":
      return "corrected";
    case "X":
    case "Y":
    case "Z":
      return "cancelled";
    case "P":
    case "R":
      return "preliminary";
    case "A":
      return "partial";
    case "O":
    case "I":
    case "S":
      return "registered";
    default:
      return "unknown";
  }
}

/** HL7 table 0085 (observation result status, OBX-11) mapped structurally to an Observation status. */
function mapObservationStatus(raw: string): string {
  switch (raw.toUpperCase()) {
    case "F":
    case "U":
      return "final";
    case "P":
    case "R":
    case "S":
      return "preliminary";
    case "C":
      return "corrected";
    case "D":
    case "X":
      return "cancelled";
    case "W":
      return "entered-in-error";
    case "I":
    case "O":
      return "registered";
    default:
      return "unknown";
  }
}

interface ParsedMessage {
  index: number;
  header: MshHeader;
  headerIssues: ValidationIssue[];
  segments: Hl7Segment[];
  /** Segment names in message order (for schema/counts). */
  segmentCounts: Record<string, number>;
  unhandled: Array<{ name: string; lineNumber: number; raw: string }>;
  messageIssues: ValidationIssue[];
}

function parseSegmentLine(
  raw: string,
  lineNumber: number,
  delimiters: Hl7Delimiters,
): { segment: Hl7Segment | null; issue: ValidationIssue | null } {
  const name = raw.slice(0, 3);
  if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) {
    return {
      segment: null,
      issue: {
        code: "HL7_MALFORMED_SEGMENT",
        severity: "warning",
        message: `Line does not start with a 3-character segment name and was skipped: '${raw.slice(0, 24)}'`,
        location: `line ${lineNumber}`,
      },
    };
  }
  const rest = raw.slice(3);
  let body = rest;
  if (body.length > 0) {
    if (!body.startsWith(delimiters.field)) {
      return {
        segment: null,
        issue: {
          code: "HL7_MALFORMED_SEGMENT",
          severity: "warning",
          message: `Segment '${name}' is not followed by the field separator '${delimiters.field}' and was skipped`,
          location: `line ${lineNumber}`,
        },
      };
    }
    body = body.slice(1);
  }
  return {
    segment: {
      name,
      lineNumber,
      raw,
      fields: body === "" ? [] : body.split(delimiters.field).map((f) => parseField(f, delimiters)),
    },
    issue: null,
  };
}

function splitMessageLines(text: string): Array<{ line: string; lineNumber: number }> {
  const cleaned = text.replace(/[\x0b\x1c]/g, "");
  const physical = cleaned.split(/\r\n|\n|\r/);
  const lines: Array<{ line: string; lineNumber: number }> = [];
  physical.forEach((line, index) => {
    if (line.trim() === "") return;
    lines.push({ line, lineNumber: index + 1 });
  });
  return lines;
}

/** Split input text into messages; a new message starts at every MSH segment. */
export function parseHl7Messages(text: string): { messages: ParsedMessage[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const messages: ParsedMessage[] = [];
  let current: {
    header: MshHeader;
    headerIssues: ValidationIssue[];
    segments: Hl7Segment[];
    startIndex: number;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const segmentCounts: Record<string, number> = {};
    const unhandled: ParsedMessage["unhandled"] = [];
    const messageIssues: ValidationIssue[] = [...current.headerIssues];
    for (const segment of current.segments) {
      segmentCounts[segment.name] = (segmentCounts[segment.name] ?? 0) + 1;
      if (!HANDLED_SEGMENTS.has(segment.name)) {
        unhandled.push({ name: segment.name, lineNumber: segment.lineNumber, raw: segment.raw });
        if (segment.name.startsWith("Z")) {
          messageIssues.push({
            code: "HL7_Z_SEGMENT",
            severity: "warning",
            message: `Z-segment '${segment.name}' is site-defined and was preserved structurally in unmappedFields, not interpreted`,
            location: `message ${messages.length + 1} line ${segment.lineNumber}`,
          });
        } else {
          messageIssues.push({
            code: "HL7_UNHANDLED_SEGMENT",
            severity: "warning",
            message: `Segment '${segment.name}' is not structurally mapped and was preserved in unmappedFields, not interpreted`,
            location: `message ${messages.length + 1} line ${segment.lineNumber}`,
          });
        }
      }
    }
    const version = current.header.version;
    if (version !== "" && !SUPPORTED_HL7_VERSIONS.includes(version)) {
      const shortVersion = /^\d+\.\d+/.exec(version)?.[0] ?? version;
      if (!SUPPORTED_HL7_VERSIONS.some((v) => v === version || v === shortVersion)) {
        messageIssues.push({
          code: "HL7_UNSUPPORTED_VERSION",
          severity: "warning",
          message: `HL7 version '${version}' is outside the supported 2.3-2.9 range; parsed structurally anyway`,
          location: `message ${messages.length + 1}`,
        });
      }
    }
    messages.push({
      index: messages.length,
      header: current.header,
      headerIssues: current.headerIssues,
      segments: current.segments,
      segmentCounts,
      unhandled,
      messageIssues,
    });
    current = null;
  };

  for (const { line, lineNumber } of splitMessageLines(text)) {
    if (line.startsWith("MSH")) {
      flush();
      const { header, issues: headerIssues } = parseMshHeader(line, lineNumber);
      if (!header) {
        issues.push(...headerIssues);
        continue;
      }
      const mshSegment: Hl7Segment = {
        name: "MSH",
        lineNumber,
        raw: line,
        fields: header.fields,
      };
      current = { header, headerIssues, segments: [mshSegment], startIndex: messages.length };
      continue;
    }
    if (!current) {
      issues.push({
        code: "HL7_ORPHAN_SEGMENT",
        severity: "error",
        message: `Segment outside any message (no preceding MSH) was skipped: '${line.slice(0, 24)}'`,
        location: `line ${lineNumber}`,
      });
      continue;
    }
    const { segment, issue } = parseSegmentLine(line, lineNumber, current.header.delimiters);
    if (issue) {
      issues.push(issue);
      continue;
    }
    if (segment) current.segments.push(segment);
  }
  flush();

  if (messages.length === 0 && issues.length === 0) {
    issues.push({
      code: "HL7_MISSING_MSH",
      severity: "error",
      message: "Input contains no MSH segment, so no HL7 v2 message could be parsed",
    });
  }
  return { messages, issues };
}

function firstSegmentOf(message: ParsedMessage, name: string): Hl7Segment | undefined {
  return message.segments.find((segment) => segment.name === name);
}

interface BuiltPatient {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  unmappedFields: Record<string, unknown>;
  issues: ValidationIssue[];
}

function buildPatientShape(message: ParsedMessage, delimiters: Hl7Delimiters): BuiltPatient {
  const issues: ValidationIssue[] = [];
  const pid = firstSegmentOf(message, "PID");
  if (!pid) {
    issues.push({
      code: "HL7_MISSING_PID",
      severity: "error",
      message: "ADT message has no PID segment; the Patient envelope carries message metadata only",
      location: `message ${message.index + 1}`,
    });
  }

  const data: Record<string, unknown> = { resourceType: "Patient" };
  const meta: Record<string, unknown> = {};
  const unmapped: Record<string, unknown> = {};

  if (pid) {
    // PID-3: patient identifiers (CX repetitions: id^^^assigning authority^type).
    const idField = pid.fields[2];
    const identifiers: Array<Record<string, string>> = [];
    for (let rep = 0; rep < (idField?.length ?? 0); rep++) {
      const comps = fieldComponents(idField, delimiters, rep);
      const value = comps[0] ?? "";
      if (value === "") continue;
      const identifier: Record<string, string> = { value };
      if (comps[3]) identifier.system = comps[3];
      if (comps[4]) identifier.type = comps[4];
      identifiers.push(identifier);
    }
    if (identifiers.length > 0) {
      data.identifier = identifiers;
      data.id = identifiers[0].value;
    }

    // PID-5: patient name (XPN repetitions: family^given^middle^suffix^prefix).
    const nameField = pid.fields[4];
    const names: Array<Record<string, unknown>> = [];
    for (let rep = 0; rep < (nameField?.length ?? 0); rep++) {
      const comps = fieldComponents(nameField, delimiters, rep);
      if (comps.every((c) => c === "")) continue;
      const given = comps[1] ?? "";
      const entry: Record<string, unknown> = {};
      if (comps[0]) entry.family = comps[0];
      if (given !== "") entry.given = given.split(delimiters.subcomponent).filter((g) => g !== "");
      if (comps[2]) entry.middle = comps[2];
      if (comps[3]) entry.suffix = comps[3].split(delimiters.subcomponent).filter((s) => s !== "");
      if (comps[4]) entry.prefix = comps[4].split(delimiters.subcomponent).filter((s) => s !== "");
      names.push(entry);
    }
    if (names.length > 0) data.name = names;

    // PID-7: date of birth (HL7 DTM date part, structural only).
    const dobRaw = fieldFirst(pid.fields[6]);
    if (dobRaw !== "") {
      const normalised = normaliseHl7DateTime(dobRaw);
      if (normalised) {
        data.birthDate = normalised.slice(0, 10);
      } else {
        data.birthDate = dobRaw;
        issues.push({
          code: "HL7_UNPARSEABLE_DATETIME",
          severity: "warning",
          message: `PID-7 date of birth '${dobRaw}' is not a valid HL7 datetime; kept verbatim`,
          location: `message ${message.index + 1} line ${pid.lineNumber}`,
          offendingValue: dobRaw,
        });
      }
    }

    // PID-8: administrative sex (HL7 table 0001, structural mapping only).
    const sexRaw = fieldFirst(pid.fields[7]);
    if (sexRaw !== "") {
      meta.adminSexRaw = sexRaw;
      const gender = mapAdminSex(sexRaw);
      if (gender) {
        data.gender = gender;
      } else {
        issues.push({
          code: "HL7_UNKNOWN_ADMIN_SEX",
          severity: "warning",
          message: `PID-8 administrative sex '${sexRaw}' is not in HL7 table 0001 (M/F/O/U/A/N); gender left unset, raw value kept in metadata`,
          location: `message ${message.index + 1} line ${pid.lineNumber}`,
          offendingValue: sexRaw,
        });
      }
    }

    // PID-11: addresses (XAD repetitions: street^other^city^state^zip^country).
    const addrField = pid.fields[10];
    const addresses: Array<Record<string, unknown>> = [];
    for (let rep = 0; rep < (addrField?.length ?? 0); rep++) {
      const comps = fieldComponents(addrField, delimiters, rep);
      if (comps.every((c) => c === "")) continue;
      const address: Record<string, unknown> = {};
      if (comps[0]) address.line = [comps[0]];
      if (comps[2]) address.city = comps[2];
      if (comps[3]) address.state = comps[3];
      if (comps[4]) address.postalCode = comps[4];
      if (comps[5]) address.country = comps[5];
      addresses.push(address);
    }
    if (addresses.length > 0) data.address = addresses;

    // PID-13/14: telecom (XTN repetitions; first component kept structurally, no system inference).
    const telecom: Array<Record<string, string>> = [];
    for (const fieldIndex of [12, 13]) {
      const telField = pid.fields[fieldIndex];
      for (let rep = 0; rep < (telField?.length ?? 0); rep++) {
        const value = fieldComponents(telField, delimiters, rep)[0] ?? "";
        if (value !== "") telecom.push({ value });
      }
    }
    if (telecom.length > 0) data.telecom = telecom;
  }

  // PV1 is visit context: summarised structurally in metadata, raw kept in unmappedFields.
  const pv1 = firstSegmentOf(message, "PV1");
  if (pv1) {
    const visit: Record<string, string> = {};
    const patientClass = fieldFirst(pv1.fields[1]);
    const location = fieldComponents(pv1.fields[2], delimiters)[0] ?? "";
    const attending = fieldComponents(pv1.fields[6], delimiters)
      .filter((c) => c !== "")
      .join(" ");
    const visitNumber = fieldFirst(pv1.fields[18]);
    if (patientClass !== "") visit.patientClass = patientClass;
    if (location !== "") visit.location = location;
    if (attending !== "") visit.attending = attending;
    if (visitNumber !== "") visit.visitNumber = visitNumber;
    if (Object.keys(visit).length > 0) meta.visit = visit;
    unmapped.pv1 = pv1.raw;
  }

  return { data, metadata: meta, unmappedFields: unmapped, issues };
}

interface ObrGroup {
  obr: Hl7Segment | undefined;
  obx: Hl7Segment[];
}

function groupObrObx(message: ParsedMessage): { groups: ObrGroup[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const groups: ObrGroup[] = [];
  let current: ObrGroup | null = null;
  for (const segment of message.segments) {
    if (segment.name === "OBR") {
      current = { obr: segment, obx: [] };
      groups.push(current);
    } else if (segment.name === "OBX") {
      if (!current) {
        current = { obr: undefined, obx: [] };
        groups.push(current);
        issues.push({
          code: "HL7_OBX_WITHOUT_OBR",
          severity: "warning",
          message:
            "OBX segment appears with no preceding OBR; its observations are grouped without a DiagnosticReport order",
          location: `message ${message.index + 1} line ${segment.lineNumber}`,
        });
      }
      current.obx.push(segment);
    }
  }
  return { groups, issues };
}

function buildCodeableConcept(comps: string[]): Record<string, unknown> {
  const concept: Record<string, unknown> = {};
  const coding: Record<string, string> = {};
  if (comps[0]) coding.code = comps[0];
  if (comps[1]) coding.display = comps[1];
  if (comps[2]) coding.system = comps[2];
  if (Object.keys(coding).length > 0) concept.coding = [coding];
  if (comps[1]) concept.text = comps[1];
  else if (comps[0]) concept.text = comps[0];
  return concept;
}

function buildObservationShape(
  obx: Hl7Segment,
  delimiters: Hl7Delimiters,
  messageIndex: number,
  fallbackEffective: string | undefined,
): { data: Record<string, unknown>; issues: ValidationIssue[]; effective: string | undefined } {
  const issues: ValidationIssue[] = [];
  const location = `message ${messageIndex + 1} line ${obx.lineNumber}`;
  const data: Record<string, unknown> = { resourceType: "Observation" };

  const valueType = fieldFirst(obx.fields[1]);
  if (valueType !== "") data.valueTypeRaw = valueType;
  const codeComps = fieldComponents(obx.fields[2], delimiters);
  if (codeComps.some((c) => c !== "")) data.code = buildCodeableConcept(codeComps);

  // OBX-5: observation value (repetitions joined structurally; never interpreted).
  const valueField = obx.fields[4];
  const repCount = valueField?.length ?? 0;
  const repTexts: string[] = [];
  for (let rep = 0; rep < repCount; rep++) {
    const text = fieldComponents(valueField, delimiters, rep).join(delimiters.component);
    if (text !== "") repTexts.push(text);
  }
  const valueRaw = repTexts.join("\n");
  if (valueType === "NM") {
    const unitComps = fieldComponents(obx.fields[5], delimiters);
    const unit = unitComps[1] || unitComps[0] || "";
    const numeric = Number(valueRaw);
    if (valueRaw !== "" && Number.isFinite(numeric)) {
      data.valueQuantity = unit !== "" ? { value: numeric, unit } : { value: numeric };
    } else if (valueRaw !== "") {
      data.valueQuantity = unit !== "" ? { value: valueRaw, unit } : { value: valueRaw };
      issues.push({
        code: "HL7_NON_NUMERIC_VALUE",
        severity: "warning",
        message: `OBX-5 with value type NM is not numeric ('${valueRaw}'); kept as a string, not interpreted`,
        location,
        offendingValue: valueRaw,
      });
    }
  } else if (valueType === "CWE" || valueType === "CE" || valueType === "CNE" || valueType === "CF") {
    if (valueRaw !== "") {
      const concepts = repTexts.map((text) => {
        const parts = text.split(delimiters.component);
        return buildCodeableConcept(parts);
      });
      data.valueCodeableConcept = concepts.length === 1 ? concepts[0] : concepts;
    }
  } else if (valueType === "DT" || valueType === "TM" || valueType === "DTM") {
    if (valueRaw !== "") {
      const normalised = normaliseHl7DateTime(valueRaw);
      data.valueDateTime = normalised ?? valueRaw;
      if (!normalised) {
        issues.push({
          code: "HL7_UNPARSEABLE_DATETIME",
          severity: "warning",
          message: `OBX-5 datetime '${valueRaw}' is not a valid HL7 datetime; kept verbatim`,
          location,
          offendingValue: valueRaw,
        });
      }
    }
  } else if (valueRaw !== "") {
    data.valueString = valueRaw;
  }
  if (valueRaw !== "") data.valueRaw = valueRaw;

  // OBX-6 units are folded into valueQuantity above; keep the raw form too.
  const unitsRaw = fieldComponents(obx.fields[5], delimiters).join(delimiters.component);
  if (unitsRaw !== "") data.unitsRaw = unitsRaw;

  const rangeRaw = fieldFirst(obx.fields[6]);
  if (rangeRaw !== "") data.referenceRange = [{ text: rangeRaw }];

  // OBX-8: abnormal flags preserved verbatim — never interpreted.
  const flagsField = obx.fields[7];
  const flags: string[] = [];
  for (let rep = 0; rep < (flagsField?.length ?? 0); rep++) {
    const flag = fieldComponents(flagsField, delimiters, rep).join(delimiters.component);
    if (flag !== "") flags.push(flag);
  }
  if (flags.length > 0) data.abnormalFlagsRaw = flags;

  const statusRaw = fieldFirst(obx.fields[10]);
  data.status = mapObservationStatus(statusRaw);
  if (statusRaw !== "") data.statusRaw = statusRaw;

  const effectiveRaw = fieldFirst(obx.fields[13]) || fallbackEffective || "";
  let effective: string | undefined;
  if (effectiveRaw !== "") {
    const normalised = normaliseHl7DateTime(effectiveRaw);
    if (normalised) {
      data.effectiveDateTime = normalised;
      effective = normalised;
    } else {
      data.effectiveDateTime = effectiveRaw;
      effective = effectiveRaw;
      issues.push({
        code: "HL7_UNPARSEABLE_DATETIME",
        severity: "warning",
        message: `OBX-14 observation datetime '${effectiveRaw}' is not a valid HL7 datetime; kept verbatim`,
        location,
        offendingValue: effectiveRaw,
      });
    }
  }
  return { data, issues, effective };
}

function messageDomain(messageCode: string): MedicalDomain {
  if (messageCode === "ADT") return "administrative";
  if (messageCode === "ORU") return "laboratory";
  return "clinical";
}

function messageKind(messageCode: string, triggerEvent: string): "adt" | "oru" | "generic" {
  if (messageCode === "ADT" && (triggerEvent === "" || triggerEvent.startsWith("A"))) return "adt";
  if (messageCode === "ORU" && (triggerEvent === "" || triggerEvent.startsWith("R"))) return "oru";
  return "generic";
}

interface BuiltEnvelope {
  id: string;
  domain: MedicalDomain;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  unmappedFields: Record<string, unknown>;
  issues: ValidationIssue[];
  sourceLocation: string;
}

function buildMessageEnvelopes(message: ParsedMessage): BuiltEnvelope[] {
  const { header, delimiters } = { header: message.header, delimiters: message.header.delimiters };
  const kind = messageKind(header.messageCode, header.triggerEvent);
  const controlId = header.messageControlId || `msg-${message.index}`;
  const baseMetadata: Record<string, unknown> = {
    messageType: header.messageCode !== "" ? `${header.messageCode}^${header.triggerEvent}` : "unknown",
    messageCode: header.messageCode,
    triggerEvent: header.triggerEvent,
    messageStructure: header.messageStructure,
    messageControlId: header.messageControlId,
    hl7Version: header.version,
    sendingApplication: header.sendingApplication,
    sendingFacility: header.sendingFacility,
    separators: {
      field: delimiters.field,
      component: delimiters.component,
      repetition: delimiters.repetition,
      escape: delimiters.escape,
      subcomponent: delimiters.subcomponent,
    },
    segmentCounts: message.segmentCounts,
  };
  if (message.unhandled.length > 0) {
    baseMetadata.unhandledSegments = message.unhandled.map((u) => u.name);
    baseMetadata.hasZSegments = message.unhandled.some((u) => u.name.startsWith("Z"));
  }

  const unhandledRaw = message.unhandled.map((u) => ({ name: u.name, line: u.lineNumber, raw: u.raw }));

  if (kind === "adt") {
    const patient = buildPatientShape(message, delimiters);
    const pid = firstSegmentOf(message, "PID");
    return [
      {
        id: `hl7-${controlId}`,
        domain: "administrative",
        data: patient.data,
        metadata: { ...baseMetadata, ...patient.metadata },
        unmappedFields: {
          ...patient.unmappedFields,
          ...(unhandledRaw.length > 0 ? { unhandledSegments: unhandledRaw } : {}),
        },
        issues: patient.issues,
        sourceLocation: pid
          ? `message ${message.index + 1} line ${pid.lineNumber}`
          : `message ${message.index + 1} line ${message.segments[0]?.lineNumber ?? 1}`,
      },
    ];
  }

  if (kind === "oru") {
    const { groups, issues: groupIssues } = groupObrObx(message);
    const envelopes: BuiltEnvelope[] = [];
    let groupCounter = 0;
    let obsCounter = 0;
    for (const group of groups) {
      const fallbackEffective = group.obr ? fieldFirst(group.obr.fields[6]) : undefined;
      const fallbackNormalised = fallbackEffective
        ? (normaliseHl7DateTime(fallbackEffective) ?? fallbackEffective)
        : undefined;
      const observations: Array<{
        id: string;
        data: Record<string, unknown>;
        issues: ValidationIssue[];
        sourceLocation: string;
        effective: string | undefined;
      }> = [];
      for (const obx of group.obx) {
        const built = buildObservationShape(obx, delimiters, message.index, fallbackEffective);
        const obsId = `hl7-${controlId}-obs-${obsCounter++}`;
        observations.push({
          id: obsId,
          data: built.data,
          issues: built.issues,
          sourceLocation: `message ${message.index + 1} line ${obx.lineNumber}`,
          effective: built.effective ?? fallbackNormalised,
        });
      }
      if (group.obr) {
        const obr = group.obr;
        const obrLocation = `message ${message.index + 1} line ${obr.lineNumber}`;
        const reportIssues: ValidationIssue[] = [];
        const report: Record<string, unknown> = { resourceType: "DiagnosticReport" };
        const statusRaw = fieldFirst(obr.fields[24]);
        report.status = mapResultStatus(statusRaw);
        if (statusRaw !== "") report.statusRaw = statusRaw;
        const codeComps = fieldComponents(obr.fields[3], delimiters);
        if (codeComps.some((c) => c !== "")) report.code = buildCodeableConcept(codeComps);
        const placer = fieldFirst(obr.fields[1]);
        const filler = fieldFirst(obr.fields[2]);
        if (placer !== "") report.placerOrderNumber = placer;
        if (filler !== "") report.fillerOrderNumber = filler;
        if (fallbackEffective !== "") {
          report.effectiveDateTime = fallbackNormalised;
          if (fallbackEffective && !normaliseHl7DateTime(fallbackEffective)) {
            reportIssues.push({
              code: "HL7_UNPARSEABLE_DATETIME",
              severity: "warning",
              message: `OBR-7 observation datetime '${fallbackEffective}' is not a valid HL7 datetime; kept verbatim`,
              location: obrLocation,
              offendingValue: fallbackEffective,
            });
          }
        }
        const orderer = fieldComponents(obr.fields[15], delimiters)
          .filter((c) => c !== "")
          .join(" ");
        if (orderer !== "") report.ordererDisplay = orderer;
        report.result = observations.map((o) => ({ reference: `Observation/${o.id}` }));
        const drId = `hl7-${controlId}-dr-${groupCounter++}`;
        envelopes.push({
          id: drId,
          domain: "laboratory",
          data: report,
          metadata: { ...baseMetadata },
          unmappedFields: unhandledRaw.length > 0 && envelopes.length === 0 ? { unhandledSegments: unhandledRaw } : {},
          issues: [...groupIssues.splice(0, groupIssues.length), ...reportIssues],
          sourceLocation: obrLocation,
        });
      } else {
        // Orphan OBX group: no OBR, so no DiagnosticReport — observations only.
        for (const obs of observations) {
          obs.issues.unshift(...groupIssues.splice(0, groupIssues.length));
        }
      }
      for (const obs of observations) {
        envelopes.push({
          id: obs.id,
          domain: "laboratory",
          data: obs.data,
          metadata: { ...baseMetadata, ...(obs.effective ? { effectiveDateTime: obs.effective } : {}) },
          unmappedFields: {},
          issues: obs.issues,
          sourceLocation: obs.sourceLocation,
        });
      }
    }
    if (envelopes.length === 0) {
      const oruIssues: ValidationIssue[] = [
        ...groupIssues,
        {
          code: "HL7_NO_OBSERVATIONS",
          severity: "warning",
          message: "ORU message contains no OBR or OBX segments; the envelope carries message metadata only",
          location: `message ${message.index + 1}`,
        },
      ];
      return [
        {
          id: `hl7-${controlId}`,
          domain: "laboratory",
          data: { resourceType: "DiagnosticReport", status: "unknown", code: { text: "no observations" } },
          metadata: { ...baseMetadata },
          unmappedFields: unhandledRaw.length > 0 ? { unhandledSegments: unhandledRaw } : {},
          issues: oruIssues,
          sourceLocation: `message ${message.index + 1} line ${message.segments[0]?.lineNumber ?? 1}`,
        },
      ];
    }
    // Attach preserved unhandled segments to the first envelope when none carries them yet.
    if (unhandledRaw.length > 0 && !envelopes.some((e) => Object.keys(e.unmappedFields).length > 0)) {
      envelopes[0].unmappedFields = { unhandledSegments: unhandledRaw };
    }
    return envelopes;
  }

  // Generic structural envelope for message types without a Patient/Observation mapping.
  return [
    {
      id: `hl7-${controlId}`,
      domain: messageDomain(header.messageCode),
      data: {
        kind: "hl7-message",
        messageType: `${header.messageCode}^${header.triggerEvent}`,
        messageStructure: header.messageStructure,
        segmentNames: message.segments.map((s) => s.name),
        rawSegments: message.segments.map((s) => s.raw),
      },
      metadata: { ...baseMetadata },
      unmappedFields: {},
      issues: [
        {
          code: "HL7_UNSUPPORTED_MESSAGE_TYPE",
          severity: "warning",
          message: `Message type '${header.messageCode}^${header.triggerEvent}' has no structural envelope mapping; carried as a generic message envelope`,
          location: `message ${message.index + 1}`,
        },
      ],
      sourceLocation: `message ${message.index + 1} line ${message.segments[0]?.lineNumber ?? 1}`,
    },
  ];
}

export class Hl7v2FormatAdapter implements MedicalFormatAdapter {
  public id = HL7V2_ADAPTER_ID;
  public version = HL7V2_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "hl7v2",
      version: HL7V2_ADAPTER_VERSION,
      description:
        "HL7 v2.3-2.9 metadata adapter: MSH/segment/field/component parsing with escape decoding; ADT^A01 as Patient-shaped and ORU^R01 as Observation/DiagnosticReport-shaped structural envelopes",
      extensions: [".hl7", ".er7"],
      mimeTypes: ["application/hl7-v2"],
      status: "metadata-only",
      limitations: [
        "Structural inspection only: no clinical interpretation is performed (no diagnoses, triage or treatment advice).",
        "ADT^A01 maps structurally to a Patient-shaped envelope; ORU^R01 maps structurally to Observation-shaped envelopes plus one DiagnosticReport-shaped envelope per OBR. All other message types are carried as generic message envelopes.",
        "Coded mappings (administrative sex, result status, observation status) are fixed lookup tables; the raw HL7 value is always retained in envelope metadata.",
        "Z-segments and other unmapped segments are reported via onIssue and preserved in unmappedFields, never interpreted.",
        "Only HL7 v2.3-2.9 is supported; other versions are parsed structurally with an explicit warning.",
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
    if (ext === "hl7" || ext === "er7") return 0.9;
    if (input.mimeType === "application/hl7-v2") return 0.9;
    // Content sniffing is limited to generic text names so a `.csv`, `.json`
    // or `.vcf` file is never claimed by content alone (same rule as FASTA).
    if (ext !== "" && ext !== "txt") return 0;
    const text = input.contentString ?? (input.buffer ? readInputText(input).text : "");
    const first = text.replace(/^[\s\x0b\x1c]*/, "").slice(0, 8);
    if (/^MSH[^A-Za-z0-9]/.test(first)) return 0.85;
    return 0;
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const { text, encoding, warnings } = readInputText(input);
    const { messages, issues } = parseHl7Messages(text);
    const versions = [...new Set(messages.map((m) => m.header.version || "unknown"))];
    const typeCounts: Record<string, number> = {};
    const segmentTotals: Record<string, number> = {};
    const unhandledNames = new Set<string>();
    let envelopeCount = 0;
    const samples: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      const key = `${message.header.messageCode}^${message.header.triggerEvent}`;
      typeCounts[key] = (typeCounts[key] ?? 0) + 1;
      for (const [name, count] of Object.entries(message.segmentCounts)) {
        segmentTotals[name] = (segmentTotals[name] ?? 0) + count;
      }
      for (const u of message.unhandled) unhandledNames.add(u.name);
      const envelopes = buildMessageEnvelopes(message);
      envelopeCount += envelopes.length;
      for (const envelope of envelopes) {
        if (samples.length < 5) samples.push(envelope.data);
      }
    }
    const domain: MedicalDomain =
      messages.length === 0
        ? "unknown"
        : messages.every((m) => m.header.messageCode === "ADT")
          ? "administrative"
          : messages.every((m) => m.header.messageCode === "ORU")
            ? "laboratory"
            : "clinical";

    return {
      format: "hl7v2",
      formatVersion: versions.length === 1 ? versions[0] : versions.join(",") || "unknown",
      domain,
      recordCount: envelopeCount,
      detectedSchema: {
        fields: [
          {
            name: "resourceType",
            type: "string",
            sampleValues: samples.slice(0, 3).map((s) => s.resourceType),
            nullable: false,
          },
          { name: "messageType", type: "string", sampleValues: Object.keys(typeCounts).slice(0, 3), nullable: false },
          { name: "hl7Version", type: "string", sampleValues: versions.slice(0, 3), nullable: false },
          {
            name: "segments",
            type: "string",
            sampleValues: Object.entries(segmentTotals)
              .slice(0, 5)
              .map(([name, count]) => `${name}:${count}`),
            nullable: false,
          },
        ],
      },
      sampleRecords: samples,
      capabilities: this.getManifest().capabilities,
      status: this.getManifest().status,
      warnings: [
        ...warnings,
        `Encoding: ${encoding}`,
        messages.length === 0
          ? "No HL7 v2 messages found"
          : `messages: ${messages.length}, envelopes: ${envelopeCount}`,
        versions.length > 0 ? `HL7 version(s): ${versions.join(", ")}` : "HL7 version: unknown",
        ...Object.entries(typeCounts).map(([type, count]) => `${type}: ${count}`),
        unhandledNames.size > 0
          ? `unmapped segments (preserved, not interpreted): ${[...unhandledNames].sort().join(", ")}`
          : "all segments structurally mapped",
        ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
        ...messages.flatMap((m) => m.messageIssues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`)),
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const { text, encoding, warnings } = readInputText(input);
    for (const warning of warnings) {
      context.onIssue?.({ code: "HL7_DECODING_WARNING", severity: "warning", message: warning });
    }
    if (text.trim() === "") {
      context.onIssue?.({
        code: "HL7_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable text; nothing was parsed",
      });
      return;
    }
    const { messages, issues } = parseHl7Messages(text);
    for (const issue of issues) context.onIssue?.(issue);
    if (messages.length === 0) {
      context.onIssue?.({
        code: "HL7_MISSING_MSH",
        severity: "error",
        message: "Input contains no MSH segment, so no HL7 v2 message could be parsed",
      });
      return;
    }

    const checksum = computeChecksum(input);
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
    let recordIndex = 0;

    for (const message of messages) {
      for (const issue of message.messageIssues) context.onIssue?.({ ...issue, recordIndex });
      const envelopes = buildMessageEnvelopes(message);
      for (const built of envelopes) {
        if (recordIndex >= limit) return;
        for (const issue of built.issues) context.onIssue?.({ ...issue, recordIndex });
        const envelopeIssues: ValidationIssue[] = built.issues.map((issue) => ({ ...issue, recordIndex }));
        yield createCanonicalEnvelope({
          id: built.id,
          domain: built.domain,
          sourceFormat: "hl7v2",
          formatVersion: message.header.version || "unknown",
          content: { kind: "structured", data: built.data },
          importedAt: context.importedAt,
          adapterId: this.id,
          adapterVersion: this.version,
          recordIndex,
          sourceLocation: built.sourceLocation,
          filename: input.filename,
          checksum,
          encoding,
          metadata: {
            ...built.metadata,
            lineNumber: message.segments[0]?.lineNumber ?? 1,
          },
          unmappedFields: built.unmappedFields,
          parseIssues: envelopeIssues.length > 0 ? envelopeIssues : undefined,
        });
        recordIndex++;
      }
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${HL7V2_ADAPTER_ID} ${HL7V2_ADAPTER_VERSION} (structural HL7 v2.3-2.9 inspection only; no clinical interpretation)`,
    };
  }
}
