/**
 * DICOM Part-10 metadata adapter — file-meta header + dataset walk.
 *
 * Status is honestly `metadata-only`: the 128-byte preamble + `"DICM"` magic
 * and file-meta group (`0002`) are parsed (transfer syntax UID), then the
 * dataset is walked element by element in explicit VR little-endian, implicit
 * VR little-endian, or the retired explicit VR big-endian (read-only).
 * Nested sequences (`SQ`) are walked to a bounded depth; private tags are
 * preserved by number but never interpreted (values never inlined); pixel
 * data elements are recorded by presence/length only — pixel bytes NEVER enter
 * envelopes, issues or traces. PHI-listed tag values are replaced with a
 * placeholder by default and return only via the documented local-debug
 * option. No pixel transcoding, no DICOMweb (Phase G) and no clinical
 * interpretation are performed here.
 *
 * Explicitly NOT supported (refused with an issue, never a crash):
 * - files without the `"DICM"` magic (missing/preamble-less datasets),
 * - truncated elements (value overruns the available bytes),
 * - the deflated transfer syntax (`1.2.840.10008.1.2.1.99`),
 * - transcoding pixel data or talking DICOMweb (QIDO/WADO/STOW).
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

export const DICOM_ADAPTER_ID = "dicom-adapter";
export const DICOM_ADAPTER_VERSION = "1.0.0";

/** Placeholder substituted for PHI tag values. Tag numbers are always kept. */
export const DICOM_PHI_PLACEHOLDER = "[REDACTED]";

/** Nested sequences are walked to this depth; deeper nesting is reported and skipped. */
export const DICOM_MAX_SEQUENCE_DEPTH = 8;

/** Dataset-wide element budget (nested elements included); exceeding it stops the walk. */
export const DICOM_MAX_ELEMENTS = 20000;

/** Text values longer than this are carried as bounded previews, never in full. */
export const DICOM_MAX_TEXT_CHARS = 4096;

/** Well-known transfer syntax UIDs. */
export const TS_IMPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2";
export const TS_EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
export const TS_EXPLICIT_VR_BIG_ENDIAN_RETIRED = "1.2.840.10008.1.2.2";
export const TS_DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1.99";

const UNDEFINED_LENGTH = 0xffffffff;

/**
 * Default PHI tag policy: values for these tags are replaced with
 * {@link DICOM_PHI_PLACEHOLDER} in envelopes. Tag numbers are preserved so
 * provenance stays auditable. Override with `dicomPhiTags` or extend with
 * `dicomExtraPhiTags` in `ParseContext.options`; return raw values ONLY via
 * the documented local-debug option `dicomIncludePhiForLocalDebug`.
 */
export const DEFAULT_DICOM_PHI_TAGS: Readonly<Record<string, string>> = {
  "0010,0010": "PatientName",
  "0010,0020": "PatientID",
  "0010,0021": "IssuerOfPatientID",
  "0010,1000": "OtherPatientIDs",
  "0010,1001": "OtherPatientNames",
  "0010,1002": "OtherPatientIDsSequence",
  "0010,0030": "PatientBirthDate",
  "0010,0032": "PatientBirthTime",
  "0008,0012": "InstanceCreationDate",
  "0008,0013": "InstanceCreationTime",
  "0008,0020": "StudyDate",
  "0008,0021": "SeriesDate",
  "0008,0022": "AcquisitionDate",
  "0008,0023": "ContentDate",
  "0008,0030": "StudyTime",
  "0008,0031": "SeriesTime",
  "0008,0032": "AcquisitionTime",
  "0008,0033": "ContentTime",
  "0040,0244": "PerformedProcedureStepStartDate",
  "0040,0245": "PerformedProcedureStepStartTime",
};

/** Minimal tag dictionary: name + default VR (used for implicit-VR decoding). */
const DICOM_TAG_DICTIONARY: Readonly<Record<string, { name: string; vr: string }>> = {
  "0002,0000": { name: "FileMetaInformationGroupLength", vr: "UL" },
  "0002,0001": { name: "FileMetaInformationVersion", vr: "OB" },
  "0002,0002": { name: "MediaStorageSOPClassUID", vr: "UI" },
  "0002,0003": { name: "MediaStorageSOPInstanceUID", vr: "UI" },
  "0002,0010": { name: "TransferSyntaxUID", vr: "UI" },
  "0002,0012": { name: "ImplementationClassUID", vr: "UI" },
  "0002,0013": { name: "ImplementationVersionName", vr: "SH" },
  "0002,0016": { name: "SourceApplicationEntityTitle", vr: "AE" },
  "0002,0100": { name: "PrivateInformationCreatorUID", vr: "UI" },
  "0002,0102": { name: "PrivateInformation", vr: "OB" },
  "0008,0005": { name: "SpecificCharacterSet", vr: "CS" },
  "0008,0008": { name: "ImageType", vr: "CS" },
  "0008,0012": { name: "InstanceCreationDate", vr: "DA" },
  "0008,0013": { name: "InstanceCreationTime", vr: "TM" },
  "0008,0014": { name: "InstanceCreatorUID", vr: "UI" },
  "0008,0016": { name: "SOPClassUID", vr: "UI" },
  "0008,0018": { name: "SOPInstanceUID", vr: "UI" },
  "0008,0020": { name: "StudyDate", vr: "DA" },
  "0008,0021": { name: "SeriesDate", vr: "DA" },
  "0008,0022": { name: "AcquisitionDate", vr: "DA" },
  "0008,0023": { name: "ContentDate", vr: "DA" },
  "0008,0030": { name: "StudyTime", vr: "TM" },
  "0008,0031": { name: "SeriesTime", vr: "TM" },
  "0008,0032": { name: "AcquisitionTime", vr: "TM" },
  "0008,0033": { name: "ContentTime", vr: "TM" },
  "0008,0050": { name: "AccessionNumber", vr: "SH" },
  "0008,0060": { name: "Modality", vr: "CS" },
  "0008,0070": { name: "Manufacturer", vr: "LO" },
  "0008,0090": { name: "ReferringPhysicianName", vr: "PN" },
  "0008,1030": { name: "StudyDescription", vr: "LO" },
  "0008,103E": { name: "SeriesDescription", vr: "LO" },
  "0008,1140": { name: "ReferencedImageSequence", vr: "SQ" },
  "0008,1150": { name: "ReferencedSOPClassUID", vr: "UI" },
  "0008,1155": { name: "ReferencedSOPInstanceUID", vr: "UI" },
  "0010,0010": { name: "PatientName", vr: "PN" },
  "0010,0020": { name: "PatientID", vr: "LO" },
  "0010,0021": { name: "IssuerOfPatientID", vr: "LO" },
  "0010,0030": { name: "PatientBirthDate", vr: "DA" },
  "0010,0032": { name: "PatientBirthTime", vr: "TM" },
  "0010,0040": { name: "PatientSex", vr: "CS" },
  "0010,1010": { name: "PatientAge", vr: "AS" },
  "0010,1020": { name: "PatientSize", vr: "DS" },
  "0010,1030": { name: "PatientWeight", vr: "DS" },
  "0010,1000": { name: "OtherPatientIDs", vr: "LO" },
  "0010,1001": { name: "OtherPatientNames", vr: "PN" },
  "0010,1002": { name: "OtherPatientIDsSequence", vr: "SQ" },
  "0018,0050": { name: "SliceThickness", vr: "DS" },
  "0018,0088": { name: "SpacingBetweenSlices", vr: "DS" },
  "0018,1020": { name: "SoftwareVersions", vr: "LO" },
  "0020,000D": { name: "StudyInstanceUID", vr: "UI" },
  "0020,000E": { name: "SeriesInstanceUID", vr: "UI" },
  "0020,0010": { name: "StudyID", vr: "SH" },
  "0020,0011": { name: "SeriesNumber", vr: "IS" },
  "0020,0013": { name: "InstanceNumber", vr: "IS" },
  "0020,0032": { name: "ImagePositionPatient", vr: "DS" },
  "0020,0037": { name: "ImageOrientationPatient", vr: "DS" },
  "0028,0002": { name: "SamplesPerPixel", vr: "US" },
  "0028,0004": { name: "PhotometricInterpretation", vr: "CS" },
  "0028,0010": { name: "Rows", vr: "US" },
  "0028,0011": { name: "Columns", vr: "US" },
  "0028,0030": { name: "PixelSpacing", vr: "DS" },
  "0028,0100": { name: "BitsAllocated", vr: "US" },
  "0028,0101": { name: "BitsStored", vr: "US" },
  "0028,0102": { name: "HighBit", vr: "US" },
  "0028,0103": { name: "PixelRepresentation", vr: "US" },
  "0028,2110": { name: "LossyImageCompression", vr: "CS" },
  "0040,0244": { name: "PerformedProcedureStepStartDate", vr: "DA" },
  "0040,0245": { name: "PerformedProcedureStepStartTime", vr: "TM" },
  "0040,0275": { name: "RequestAttributesSequence", vr: "SQ" },
  "7FE0,0008": { name: "FloatPixelData", vr: "OW" },
  "7FE0,0009": { name: "DoubleFloatPixelData", vr: "OD" },
  "7FE0,0010": { name: "PixelData", vr: "OW" },
};

export interface DicomElement {
  /** Uppercase `GGGG,EEEE` tag key; always present, even when redacted. */
  tag: string;
  name: string;
  /** Value Representation (`SQ`, `PN`, `US`, …; `UN` when unknown, e.g. implicit VR). */
  vr: string;
  /** Value length in bytes; `-1` for undefined-length sequences. */
  length: number;
  /**
   * Decoded value. Text/number VRs decode to scalars (or arrays at
   * multiplicity > 1); `SQ` decodes to an array of items (each an element
   * array). Absent for binary/private/pixel/redacted/empty values — bytes are
   * never inlined.
   */
  value?: string | number | string[] | number[] | DicomElement[][];
  /** True when the value is binary (or unrepresentable): only `length` is kept. */
  binary?: true;
  /** True for odd-group tags: preserved by number, never interpreted. */
  private?: true;
  /** True when the value was replaced with {@link DICOM_PHI_PLACEHOLDER}. */
  redacted?: true;
  /** True when a long text value was cut to a bounded preview. */
  truncated?: true;
  /** True when sequence children were skipped past {@link DICOM_MAX_SEQUENCE_DEPTH}. */
  depthTruncated?: true;
  /** True for zero-length values. */
  empty?: true;
  /** True for pixel/overlay data: presence/length only, never bytes. */
  pixelData?: true;
  /** Pixel payload shape (only when `pixelData` is true). */
  pixel?: { encapsulated: boolean; byteLength: number; fragmentCount?: number };
  /** Item count dropped when a PHI-listed sequence was redacted (audit aid). */
  redactedItems?: number;
}

export interface DicomPixelSummary {
  present: boolean;
  tag?: string;
  byteLength?: number;
  encapsulated?: boolean;
  fragmentCount?: number;
}

export interface DicomFileSummary {
  transferSyntaxUid: string;
  explicitVr: boolean;
  littleEndian: boolean;
  transferSyntaxAssumed: boolean;
  sopClassUid?: string;
  sopInstanceUid?: string;
  modality?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  elementCount: number;
  totalElementCount: number;
  privateTagCount: number;
  sequenceCount: number;
  maxSequenceDepth: number;
  pixel: DicomPixelSummary;
  redactedTags: string[];
  truncated: boolean;
}

/** `GGGG,EEEE` uppercase tag key. */
export function formatTag(group: number, element: number): string {
  return `${group.toString(16).toUpperCase().padStart(4, "0")},${element.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Parse a `GGGG,EEEE` key back to numbers; `null` for malformed keys. */
export function parseTagKey(key: string): { group: number; element: number } | null {
  const match = /^([0-9A-Fa-f]{4}),([0-9A-Fa-f]{4})$/.exec(key.trim());
  if (!match) return null;
  return { group: parseInt(match[1], 16), element: parseInt(match[2], 16) };
}

/** Odd group numbers are private tags: preserved by number, never interpreted. */
export function isPrivateTag(group: number): boolean {
  return group % 2 === 1;
}

/**
 * Pixel-carrying elements: any `7FE0` element (native or encapsulated pixel
 * data, float variants) plus repeating-group overlay data (`60xx,3000`).
 * Presence/length only — bytes never enter envelopes, issues or traces.
 */
export function isPixelDataTag(group: number, element: number): boolean {
  if (group === 0x7fe0) return true;
  if ((group & 0xff00) === 0x6000 && element === 0x3000) return true;
  return false;
}

export interface TransferSyntaxInfo {
  uid: string;
  explicit: boolean;
  littleEndian: boolean;
  deflated: boolean;
  /** True when the UID was missing/unknown and a fallback was assumed (reported). */
  assumed: boolean;
}

/** Map a transfer syntax UID to decode settings. Never throws. */
export function resolveTransferSyntax(uid: string | undefined): TransferSyntaxInfo {
  if (uid === undefined || uid === "") {
    return { uid: "unknown", explicit: false, littleEndian: true, deflated: false, assumed: true };
  }
  if (uid === TS_IMPLICIT_VR_LITTLE_ENDIAN) {
    return { uid, explicit: false, littleEndian: true, deflated: false, assumed: false };
  }
  if (uid === TS_EXPLICIT_VR_LITTLE_ENDIAN) {
    return { uid, explicit: true, littleEndian: true, deflated: false, assumed: false };
  }
  if (uid === TS_EXPLICIT_VR_BIG_ENDIAN_RETIRED) {
    return { uid, explicit: true, littleEndian: false, deflated: false, assumed: false };
  }
  if (uid === TS_DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN) {
    return { uid, explicit: true, littleEndian: true, deflated: true, assumed: false };
  }
  if (uid.startsWith("1.2.840.10008.1.2")) {
    // Encapsulated (JPEG/RLE/…) syntaxes: dataset stays explicit VR little-endian.
    return { uid, explicit: true, littleEndian: true, deflated: false, assumed: false };
  }
  return { uid, explicit: true, littleEndian: true, deflated: false, assumed: true };
}

function fileExtension(input: InputDescriptor): string {
  if (input.extension) return input.extension.replace(/^\./, "").toLowerCase();
  const name = input.filename ?? input.uri ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function toBuffer(input: InputDescriptor): Buffer | undefined {
  if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
  if (input.contentString !== undefined) return Buffer.from(input.contentString, "latin1");
  return undefined;
}

/** True when bytes carry the 128-byte preamble followed by `"DICM"`. */
export function hasDicomMagic(data: Buffer): boolean {
  return data.length >= 132 && data[128] === 0x44 && data[129] === 0x49 && data[130] === 0x43 && data[131] === 0x4d;
}

// ---------------------------------------------------------------------------
// Dataset walk (explicit/implicit VR little-endian, retired explicit big-endian)
// ---------------------------------------------------------------------------

/** VRs encoded with 2 reserved bytes + a 32-bit length in explicit VR. */
const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UR", "UT", "UN"]);

/** VRs whose bytes are never inlined — only `length` is kept. */
const BINARY_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "UN"]);

/** Text VRs carrying one scalar per backslash-separated component. */
const MULTI_TEXT_VRS = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "PN", "SH", "TM", "UI", "UC"]);

/** Text VRs where a backslash is literal data, never a multiplicity separator. */
const SINGLE_TEXT_VRS = new Set(["LT", "ST", "UT", "UR"]);

const NUMERIC_VRS = new Set(["US", "SS", "UL", "SL", "FL", "FD"]);

interface ElementHeader {
  group: number;
  element: number;
  tag: string;
  /** Undefined for implicit-VR and item/delimitation tags. */
  vr: string | undefined;
  length: number;
  headerSize: number;
  itemTag: boolean;
}

interface WalkState {
  issues: ValidationIssue[];
  elementsUsed: number;
  phiTags: Set<string>;
  includePhiForLocalDebug: boolean;
  sequenceCount: number;
  maxDepthSeen: number;
  redactedTags: string[];
}

function pushIssue(
  state: WalkState,
  code: string,
  severity: ValidationIssue["severity"],
  message: string,
  location?: string,
): void {
  // NOTE: values (potential PHI) are never interpolated into issue messages or
  // offendingValue — only tag numbers and byte counts, which are safe.
  state.issues.push({ code, severity, message, location });
}

function takeBudget(state: WalkState, location: string): boolean {
  if (state.elementsUsed >= DICOM_MAX_ELEMENTS) {
    pushIssue(
      state,
      "DICOM_ELEMENT_BUDGET_EXCEEDED",
      "error",
      `Element budget of ${DICOM_MAX_ELEMENTS} exceeded; the walk stopped here and the envelope is partial`,
      location,
    );
    return false;
  }
  state.elementsUsed++;
  return true;
}

function readHeader(
  buf: Buffer,
  offset: number,
  syntax: TransferSyntaxInfo,
): { header: ElementHeader } | { truncatedAt: number } {
  const le = syntax.littleEndian;
  if (offset + 8 > buf.length) return { truncatedAt: offset };
  const group = le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  const element = le ? buf.readUInt16LE(offset + 2) : buf.readUInt16BE(offset + 2);
  const tag = formatTag(group, element);
  const itemTag = group === 0xfffe;
  if (itemTag || !syntax.explicit) {
    // Item/delimitation tags and implicit VR: group, element, 32-bit length.
    const length = le ? buf.readUInt32LE(offset + 4) : buf.readUInt32BE(offset + 4);
    return { header: { group, element, tag, vr: undefined, length, headerSize: 8, itemTag } };
  }
  const vr = buf.toString("ascii", offset + 4, offset + 6);
  if (LONG_VRS.has(vr)) {
    if (offset + 12 > buf.length) return { truncatedAt: offset };
    const length = le ? buf.readUInt32LE(offset + 8) : buf.readUInt32BE(offset + 8);
    return { header: { group, element, tag, vr, length, headerSize: 12, itemTag } };
  }
  const length = le ? buf.readUInt16LE(offset + 6) : buf.readUInt16BE(offset + 6);
  return { header: { group, element, tag, vr, length, headerSize: 8, itemTag } };
}

function decodeText(raw: Buffer): string {
  return raw.toString("latin1").replace(/[ \0]+$/, "");
}

function decodeNumbers(buf: Buffer, start: number, end: number, vr: string, le: boolean): number[] {
  const out: number[] = [];
  const step = vr === "US" || vr === "SS" ? 2 : vr === "UL" || vr === "SL" || vr === "FL" ? 4 : 8;
  for (let p = start; p + step <= end; p += step) {
    if (vr === "US") out.push(le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
    else if (vr === "SS") out.push(le ? buf.readInt16LE(p) : buf.readInt16BE(p));
    else if (vr === "UL") out.push(le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
    else if (vr === "SL") out.push(le ? buf.readInt32LE(p) : buf.readInt32BE(p));
    else if (vr === "FL") out.push(le ? buf.readFloatLE(p) : buf.readFloatBE(p));
    else out.push(le ? buf.readDoubleLE(p) : buf.readDoubleBE(p));
  }
  return out;
}

function scalarOrArray<T>(values: T[]): T | T[] {
  return values.length === 1 ? values[0] : values;
}

/**
 * Skip an undefined-length element generically (no VR knowledge required):
 * every nested undefined-length element opens a level, every sequence
 * delimitation closes one. Returns the first offset past the matching
 * delimitation, or `null` when the bytes run out first.
 */
function skipUndefinedElement(buf: Buffer, pos: number, syntax: TransferSyntaxInfo): number | null {
  let depth = 1;
  while (depth > 0) {
    const parsed = readHeader(buf, pos, syntax);
    if (!("header" in parsed)) return null;
    const { header } = parsed;
    if (header.itemTag) {
      if (header.element === 0xe0dd) {
        // Sequence delimitation: 8-byte header + (usually zero) length bytes.
        if (header.length !== 0 && header.length !== UNDEFINED_LENGTH) {
          if (pos + 8 + header.length > buf.length) return null;
          pos += 8 + header.length;
        } else {
          pos += 8;
        }
        depth--;
        continue;
      }
      // Item / item-delimitation: skip a defined length, consume the header otherwise.
      if (header.length !== UNDEFINED_LENGTH) {
        if (pos + 8 + header.length > buf.length) return null;
        pos += 8 + header.length;
      } else {
        pos += 8;
      }
      continue;
    }
    if (header.length === UNDEFINED_LENGTH) {
      pos += header.headerSize;
      depth++;
    } else {
      if (pos + header.headerSize + header.length > buf.length) return null;
      pos += header.headerSize + header.length;
    }
  }
  return pos;
}

/** Result of parsing one element value: the element plus the next offset. */
interface ParsedElement {
  element: DicomElement;
  next: number;
}

function makeSkeleton(header: ElementHeader, vr: string, name: string, extra?: Partial<DicomElement>): DicomElement {
  return {
    tag: header.tag,
    name,
    vr,
    length: header.length === UNDEFINED_LENGTH ? -1 : header.length,
    ...extra,
  };
}

function applyPhiPolicy(state: WalkState, element: DicomElement, location: string, droppedItems?: number): void {
  if (!state.phiTags.has(element.tag) || state.includePhiForLocalDebug) return;
  element.value = DICOM_PHI_PLACEHOLDER;
  element.redacted = true;
  delete element.binary;
  delete element.truncated;
  delete element.empty;
  if (droppedItems !== undefined) element.redactedItems = droppedItems;
  if (!state.redactedTags.includes(element.tag)) state.redactedTags.push(element.tag);
  void location;
}

function parseTextValue(
  buf: Buffer,
  start: number,
  length: number,
  vr: string,
): { value: string | string[]; truncated: boolean } {
  const bounded = Math.min(length, DICOM_MAX_TEXT_CHARS);
  const text = decodeText(buf.subarray(start, start + bounded));
  const truncated = length > DICOM_MAX_TEXT_CHARS;
  if (MULTI_TEXT_VRS.has(vr)) {
    const parts = text.split("\\");
    return { value: parts.length === 1 ? parts[0] : parts, truncated };
  }
  return { value: text, truncated };
}

function parseSequence(
  buf: Buffer,
  header: ElementHeader,
  valueStart: number,
  syntax: TransferSyntaxInfo,
  depth: number,
  state: WalkState,
  location: string,
): ParsedElement {
  const skeleton = makeSkeleton(header, "SQ", dictionaryNameOf(header.tag, "Sequence"), {
    value: [] as DicomElement[][],
  });
  state.sequenceCount++;
  if (depth > state.maxDepthSeen) state.maxDepthSeen = depth;

  if (depth > DICOM_MAX_SEQUENCE_DEPTH) {
    pushIssue(
      state,
      "DICOM_SEQUENCE_DEPTH_EXCEEDED",
      "warning",
      `Sequence ${header.tag} exceeds the bounded walk depth of ${DICOM_MAX_SEQUENCE_DEPTH}; children skipped, presence kept`,
      location,
    );
    skeleton.depthTruncated = true;
    skeleton.value = [];
    let next: number | null;
    if (header.length === UNDEFINED_LENGTH) {
      next = skipUndefinedElement(buf, valueStart, syntax);
    } else if (valueStart + header.length > buf.length) {
      next = null;
    } else {
      next = valueStart + header.length;
    }
    if (next === null) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_ELEMENT",
        "error",
        `Sequence ${header.tag} overruns the available bytes; the walk stopped here`,
        location,
      );
      return { element: skeleton, next: buf.length };
    }
    return { element: skeleton, next };
  }

  const items: DicomElement[][] = [];
  let pos = valueStart;
  const defined = header.length !== UNDEFINED_LENGTH;
  const end = defined ? valueStart + header.length : buf.length;
  if (defined && end > buf.length) {
    pushIssue(
      state,
      "DICOM_TRUNCATED_ELEMENT",
      "error",
      `Sequence ${header.tag} declares ${header.length} byte(s) but only ${buf.length - valueStart} remain; the walk stopped here`,
      location,
    );
    skeleton.length = buf.length - valueStart;
    return { element: skeleton, next: buf.length };
  }

  for (;;) {
    if (defined ? pos >= end : pos >= buf.length) break;
    const parsed = readHeader(buf, pos, syntax);
    if (!("header" in parsed)) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_ELEMENT",
        "error",
        `Sequence ${header.tag} ends mid-header at byte ${parsed.truncatedAt}; the walk stopped here`,
        location,
      );
      return { element: skeleton, next: buf.length };
    }
    const itemHeader = parsed.header;
    if (itemHeader.itemTag && itemHeader.element === 0xe0dd) {
      pos += 8; // sequence delimitation
      break;
    }
    if (!itemHeader.itemTag || itemHeader.element !== 0xe000) {
      pushIssue(
        state,
        "DICOM_UNEXPECTED_TAG",
        "warning",
        `Sequence ${header.tag} expected an item tag but found ${itemHeader.tag}; the sequence was closed here`,
        location,
      );
      break;
    }
    const itemStart = pos + 8;
    if (itemHeader.length === UNDEFINED_LENGTH) {
      const walked = parseElements(buf, itemStart, undefined, syntax, depth + 1, state, location, 0xe00d);
      items.push(walked.elements);
      pos = walked.next;
      if (walked.stopped) return { element: { ...skeleton, value: items }, next: pos };
    } else {
      if (itemStart + itemHeader.length > buf.length) {
        pushIssue(
          state,
          "DICOM_TRUNCATED_ELEMENT",
          "error",
          `Item of sequence ${header.tag} declares ${itemHeader.length} byte(s) but the file ends first; the walk stopped here`,
          location,
        );
        return { element: { ...skeleton, value: items }, next: buf.length };
      }
      const walked = parseElements(buf, itemStart, itemStart + itemHeader.length, syntax, depth + 1, state, location);
      items.push(walked.elements);
      pos = itemStart + itemHeader.length;
      if (walked.stopped) return { element: { ...skeleton, value: items }, next: pos };
    }
  }

  skeleton.value = items;
  if (!defined) skeleton.length = -1;
  return { element: skeleton, next: pos };
}

function dictionaryNameOf(tag: string, fallback: string): string {
  return DICOM_TAG_DICTIONARY[tag]?.name ?? fallback;
}

/**
 * Decode a defined-length, non-sequence value. Callers guarantee
 * `valueStart + header.length <= buf.length`.
 */
function decodeElementValue(
  buf: Buffer,
  header: ElementHeader,
  valueStart: number,
  syntax: TransferSyntaxInfo,
  effectiveVr: string | undefined,
  name: string,
): DicomElement {
  const vr = effectiveVr ?? "UN";
  const element = makeSkeleton(header, vr, name);
  if (header.length === 0) {
    element.empty = true;
  } else if (isPrivateTag(header.group)) {
    // Private tags are preserved by number only — values are never inlined.
    element.binary = true;
    element.private = true;
  } else if (effectiveVr !== undefined && BINARY_VRS.has(effectiveVr)) {
    // A declared binary VR (explicit `OB`/`OW`/`UN`/…, or the dictionary VR in
    // implicit datasets): length only, bytes never inlined.
    element.binary = true;
  } else if (vr === "AT") {
    const tags: string[] = [];
    for (let p = valueStart; p + 4 <= valueStart + header.length; p += 4) {
      const g = syntax.littleEndian ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
      const e = syntax.littleEndian ? buf.readUInt16LE(p + 2) : buf.readUInt16BE(p + 2);
      tags.push(formatTag(g, e));
    }
    element.value = scalarOrArray(tags);
  } else if (NUMERIC_VRS.has(vr)) {
    const numbers = decodeNumbers(buf, valueStart, valueStart + header.length, vr, syntax.littleEndian);
    element.value = scalarOrArray(numbers);
  } else if (MULTI_TEXT_VRS.has(vr) || SINGLE_TEXT_VRS.has(vr)) {
    const { value, truncated } = parseTextValue(buf, valueStart, header.length, vr);
    element.value = value;
    if (truncated) element.truncated = true;
  } else {
    // Unknown VR (explicit garbage like `ZZ`, or implicit VR with no
    // dictionary entry): inline only plain ASCII, otherwise length only.
    const raw = buf.subarray(valueStart, valueStart + header.length);
    const printable = raw.length > 0 && raw.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126));
    if (printable && raw.length <= DICOM_MAX_TEXT_CHARS) {
      element.value = decodeText(raw);
    } else {
      element.binary = true;
    }
  }
  return element;
}

/**
 * Parse elements in `[start, end)` (`end === undefined` walks until the
 * `terminator` delimitation tag or the end of the buffer: `0xE0DD` at sequence
 * level, `0xE00D` inside an undefined-length item). Never throws: truncation
 * and budget exhaustion are reported and stop the walk via `stopped`.
 */
function parseElements(
  buf: Buffer,
  start: number,
  end: number | undefined,
  syntax: TransferSyntaxInfo,
  depth: number,
  state: WalkState,
  location: string,
  terminator: 0xe0dd | 0xe00d = 0xe0dd,
): { elements: DicomElement[]; next: number; stopped: boolean } {
  const elements: DicomElement[] = [];
  let pos = start;
  const limit = end ?? buf.length;

  for (;;) {
    if (pos >= limit) return { elements, next: pos, stopped: false };
    if (pos >= buf.length) {
      if (end === undefined) return { elements, next: pos, stopped: false };
      pushIssue(
        state,
        "DICOM_TRUNCATED_ELEMENT",
        "error",
        `Dataset ends mid-element at byte ${pos}; the walk stopped here`,
        location,
      );
      return { elements, next: pos, stopped: true };
    }
    const parsed = readHeader(buf, pos, syntax);
    if (!("header" in parsed)) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_ELEMENT",
        "error",
        `Element header at byte ${parsed.truncatedAt} overruns the available bytes; the walk stopped here`,
        location,
      );
      return { elements, next: buf.length, stopped: true };
    }
    const header = parsed.header;

    // A delimitation tag closes an undefined-length walk owned by the caller. A
    // stray sequence delimitation inside an item walk also closes it (graceful
    // recovery from malformed nesting); a stray item delimitation at sequence
    // level is reported and skipped below.
    if (
      header.itemTag &&
      (header.element === terminator || (terminator === 0xe00d && header.element === 0xe0dd)) &&
      end === undefined
    ) {
      return { elements, next: pos + 8, stopped: false };
    }
    if (header.itemTag) {
      pushIssue(
        state,
        "DICOM_UNEXPECTED_TAG",
        "warning",
        `Item tag ${header.tag} appears outside any sequence; skipped by length`,
        location,
      );
      if (header.length === UNDEFINED_LENGTH) {
        const skipped = skipUndefinedElement(buf, pos + 8, syntax);
        if (skipped === null) {
          pushIssue(
            state,
            "DICOM_TRUNCATED_ELEMENT",
            "error",
            `Item ${header.tag} overruns the available bytes; the walk stopped here`,
            location,
          );
          return { elements, next: buf.length, stopped: true };
        }
        pos = skipped;
      } else {
        if (pos + 8 + header.length > buf.length) {
          pushIssue(
            state,
            "DICOM_TRUNCATED_ELEMENT",
            "error",
            `Item ${header.tag} declares ${header.length} byte(s) but the file ends first; the walk stopped here`,
            location,
          );
          return { elements, next: buf.length, stopped: true };
        }
        pos += 8 + header.length;
      }
      continue;
    }

    if (!takeBudget(state, location)) {
      return { elements, next: pos, stopped: true };
    }

    const valueStart = pos + header.headerSize;
    const dict = DICOM_TAG_DICTIONARY[header.tag];
    const effectiveVr = header.vr ?? dict?.vr ?? (isPrivateTag(header.group) ? "UN" : undefined);
    const name = dict?.name ?? (isPrivateTag(header.group) ? "PrivateTag" : "Unknown");

    // Pixel/overlay data: presence + length only. Bytes are never inlined.
    if (isPixelDataTag(header.group, header.element)) {
      if (header.length === UNDEFINED_LENGTH) {
        const fragments = walkEncapsulated(buf, valueStart, syntax);
        if (fragments === null) {
          pushIssue(
            state,
            "DICOM_TRUNCATED_ELEMENT",
            "error",
            `Encapsulated pixel data ${header.tag} overruns the available bytes; the walk stopped here`,
            location,
          );
          return { elements, next: buf.length, stopped: true };
        }
        const element = makeSkeleton(header, effectiveVr ?? "OW", name, {
          pixelData: true,
          pixel: {
            encapsulated: true,
            byteLength: fragments.totalBytes,
            fragmentCount: fragments.fragmentCount,
          },
        });
        elements.push(element);
        pos = fragments.next;
        continue;
      }
      if (valueStart + header.length > buf.length) {
        pushIssue(
          state,
          "DICOM_TRUNCATED_ELEMENT",
          "error",
          `Pixel data ${header.tag} declares ${header.length} byte(s) but the file ends first; the walk stopped here`,
          location,
        );
        return { elements, next: buf.length, stopped: true };
      }
      elements.push(
        makeSkeleton(header, effectiveVr ?? "OW", name, {
          pixelData: true,
          pixel: { encapsulated: false, byteLength: header.length },
        }),
      );
      pos = valueStart + header.length;
      continue;
    }

    // Sequences recurse (bounded depth); other undefined lengths are skipped blindly.
    if (effectiveVr === "SQ") {
      const seq = parseSequence(buf, header, valueStart, syntax, depth + 1, state, location);
      const items = Array.isArray(seq.element.value) ? (seq.element.value as DicomElement[][]).length : 0;
      applyPhiPolicy(state, seq.element, location, items);
      elements.push(seq.element);
      pos = seq.next;
      continue;
    }
    if (header.length === UNDEFINED_LENGTH) {
      // Undefined-length non-sequence (e.g. encapsulated `OB`): skip, keep the span.
      const skipped = skipUndefinedElement(buf, valueStart, syntax);
      if (skipped === null) {
        pushIssue(
          state,
          "DICOM_TRUNCATED_ELEMENT",
          "error",
          `Element ${header.tag} overruns the available bytes; the walk stopped here`,
          location,
        );
        return { elements, next: buf.length, stopped: true };
      }
      const element = makeSkeleton(header, effectiveVr ?? "UN", name, { binary: true });
      element.length = skipped - valueStart;
      applyPhiPolicy(state, element, location);
      elements.push(element);
      pos = skipped;
      continue;
    }

    if (valueStart + header.length > buf.length) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_ELEMENT",
        "error",
        `Element ${header.tag} declares ${header.length} byte(s) but only ${buf.length - valueStart} remain; the walk stopped here`,
        location,
      );
      return { elements, next: buf.length, stopped: true };
    }

    const element = decodeElementValue(buf, header, valueStart, syntax, effectiveVr, name);
    applyPhiPolicy(state, element, location);
    elements.push(element);
    pos = valueStart + header.length;
  }
}

/**
 * Walk encapsulated (undefined-length) pixel data: skip the basic-offset-table
 * item and every fragment, counting fragments and bytes. Never retains bytes.
 */
function walkEncapsulated(
  buf: Buffer,
  valueStart: number,
  syntax: TransferSyntaxInfo,
): { next: number; totalBytes: number; fragmentCount: number } | null {
  let pos = valueStart;
  let totalBytes = 0;
  let fragmentCount = 0;
  let seenTable = false;
  for (;;) {
    const parsed = readHeader(buf, pos, syntax);
    if (!("header" in parsed)) return null;
    const header = parsed.header;
    if (header.itemTag && header.element === 0xe0dd) return { next: pos + 8, totalBytes, fragmentCount };
    if (!header.itemTag || header.element !== 0xe000) return null;
    if (header.length === UNDEFINED_LENGTH) return null;
    if (pos + 8 + header.length > buf.length) return null;
    if (!seenTable) {
      seenTable = true; // basic offset table: structural, never counted as a fragment
    } else {
      fragmentCount++;
      totalBytes += header.length;
    }
    pos += 8 + header.length;
  }
}

// ---------------------------------------------------------------------------
// File-level parse
// ---------------------------------------------------------------------------

export interface DicomParseOptions {
  dicomPhiTags?: unknown;
  dicomExtraPhiTags?: unknown;
  dicomIncludePhiForLocalDebug?: unknown;
}

function normaliseTagKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = parseTagKey(raw);
  return parsed ? formatTag(parsed.group, parsed.element) : null;
}

function phiTagSetFromOptions(options: Record<string, unknown> | undefined): Set<string> {
  const override = options?.["dicomPhiTags"];
  if (Array.isArray(override)) {
    const set = new Set<string>();
    for (const raw of override) {
      const key = normaliseTagKey(raw);
      if (key) set.add(key);
    }
    return set;
  }
  const set = new Set<string>(Object.keys(DEFAULT_DICOM_PHI_TAGS));
  const extra = options?.["dicomExtraPhiTags"];
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      const key = normaliseTagKey(raw);
      if (key) set.add(key);
    }
  }
  return set;
}

/**
 * LOCAL-DEBUG ONLY: when `dicomIncludePhiForLocalDebug === true`, PHI-listed
 * values are carried verbatim instead of redacted. Never enable in production,
 * services or shared traces — envelopes then contain patient identifiers.
 */
function phiAllowedForLocalDebug(options: Record<string, unknown> | undefined): boolean {
  return options?.["dicomIncludePhiForLocalDebug"] === true;
}

export interface ParsedDicomFile {
  fileMeta: DicomElement[];
  transferSyntaxUid: string | undefined;
  syntax: TransferSyntaxInfo;
  elements: DicomElement[];
  summary: DicomFileSummary;
  issues: ValidationIssue[];
  /** True when truncation or budget exhaustion cut the walk short. */
  truncated: boolean;
}

function firstTextValue(elements: DicomElement[], tag: string): string | undefined {
  const found = elements.find((e) => e.tag === tag);
  return typeof found?.value === "string" ? found.value : undefined;
}

function countPrivate(elements: DicomElement[]): number {
  let count = 0;
  for (const element of elements) {
    if (element.private) count++;
    if (Array.isArray(element.value) && element.vr === "SQ") {
      for (const item of element.value as DicomElement[][]) count += countPrivate(item);
    }
  }
  return count;
}

function findPixel(elements: DicomElement[]): DicomElement | undefined {
  for (const element of elements) {
    if (element.pixelData) return element;
    if (Array.isArray(element.value) && element.vr === "SQ") {
      for (const item of element.value as DicomElement[][]) {
        const nested = findPixel(item);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

/**
 * Parse a full Part-10 file (preamble + file meta + dataset). Returns
 * `refused` for missing magic / deflated syntax; truncation and budget
 * exhaustion still yield a partial file with `truncated: true`. Never throws.
 */
export function parseDicomBytes(
  buf: Buffer,
  rawOptions?: Record<string, unknown>,
): { refused: true; code: string; message: string } | ({ refused: false } & ParsedDicomFile) {
  const state: WalkState = {
    issues: [],
    elementsUsed: 0,
    phiTags: phiTagSetFromOptions(rawOptions),
    includePhiForLocalDebug: phiAllowedForLocalDebug(rawOptions),
    sequenceCount: 0,
    maxDepthSeen: 0,
    redactedTags: [],
  };

  const metaSyntax: TransferSyntaxInfo = {
    uid: "file-meta-implicit",
    explicit: true,
    littleEndian: true,
    deflated: false,
    assumed: false,
  };

  // File meta (group 0002, always explicit VR little-endian).
  const fileMeta: DicomElement[] = [];
  let pos = 132;
  let metaTruncated = false;
  for (;;) {
    if (pos >= buf.length) break;
    const parsed = readHeader(buf, pos, metaSyntax);
    if (!("header" in parsed)) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_FILE_META",
        "error",
        `File-meta header at byte ${parsed.truncatedAt} overruns the available bytes`,
        "file-meta",
      );
      metaTruncated = true;
      pos = buf.length;
      break;
    }
    const header = parsed.header;
    if (header.group !== 0x0002) break; // dataset starts here
    if (header.itemTag) {
      pushIssue(
        state,
        "DICOM_UNEXPECTED_TAG",
        "warning",
        `Item tag ${header.tag} inside file meta; skipped`,
        "file-meta",
      );
      pos += 8;
      continue;
    }
    if (!takeBudget(state, "file-meta")) break;
    const valueStart = pos + header.headerSize;
    if (header.length !== UNDEFINED_LENGTH && valueStart + header.length > buf.length) {
      pushIssue(
        state,
        "DICOM_TRUNCATED_FILE_META",
        "error",
        `File-meta element ${header.tag} declares ${header.length} byte(s) but the file ends first`,
        "file-meta",
      );
      metaTruncated = true;
      pos = buf.length;
      break;
    }
    if (header.length === UNDEFINED_LENGTH) {
      pushIssue(
        state,
        "DICOM_UNEXPECTED_TAG",
        "warning",
        `File-meta element ${header.tag} uses undefined length; skipped without storing`,
        "file-meta",
      );
      const skipped = skipUndefinedElement(buf, valueStart, metaSyntax);
      if (skipped === null) {
        pushIssue(
          state,
          "DICOM_TRUNCATED_FILE_META",
          "error",
          `File-meta element ${header.tag} overruns the available bytes`,
          "file-meta",
        );
        metaTruncated = true;
        pos = buf.length;
        break;
      }
      pos = skipped;
      continue;
    }
    const dict = DICOM_TAG_DICTIONARY[header.tag];
    const element = decodeElementValue(
      buf,
      header,
      valueStart,
      metaSyntax,
      header.vr ?? dict?.vr,
      dict?.name ?? "Unknown",
    );
    fileMeta.push(element);
    pos = valueStart + header.length;
  }

  const transferSyntaxUid = firstTextValue(fileMeta, "0002,0010");
  const syntax = resolveTransferSyntax(transferSyntaxUid);
  if (transferSyntaxUid === undefined) {
    pushIssue(
      state,
      "DICOM_MISSING_TRANSFER_SYNTAX",
      "warning",
      "File meta carries no transfer syntax UID (0002,0010); assuming implicit VR little-endian",
      "file-meta",
    );
  } else if (syntax.assumed) {
    pushIssue(
      state,
      "DICOM_UNKNOWN_TRANSFER_SYNTAX",
      "warning",
      "File meta carries an unrecognised transfer syntax UID; assuming explicit VR little-endian",
      "file-meta",
    );
  }
  if (syntax.deflated) {
    return {
      refused: true,
      code: "DICOM_DEFLATED_TRANSFER_SYNTAX_REFUSED",
      message:
        "Deflated transfer syntax (1.2.840.10008.1.2.1.99) is refused: the dataset cannot be walked without inflating it, and silent decompression is out of scope for a metadata adapter",
    };
  }

  const walked = parseElements(buf, pos, buf.length, syntax, 0, state, "dataset");
  const truncated = metaTruncated || walked.stopped;

  const pixelElement = findPixel(walked.elements);
  const summary: DicomFileSummary = {
    transferSyntaxUid: transferSyntaxUid ?? "unknown",
    explicitVr: syntax.explicit,
    littleEndian: syntax.littleEndian,
    transferSyntaxAssumed: syntax.assumed,
    sopClassUid: firstTextValue(walked.elements, "0008,0016") ?? firstTextValue(fileMeta, "0002,0002"),
    sopInstanceUid: firstTextValue(walked.elements, "0008,0018") ?? firstTextValue(fileMeta, "0002,0003"),
    modality: firstTextValue(walked.elements, "0008,0060"),
    studyInstanceUid: firstTextValue(walked.elements, "0020,000D"),
    seriesInstanceUid: firstTextValue(walked.elements, "0020,000E"),
    elementCount: walked.elements.length,
    totalElementCount: state.elementsUsed,
    privateTagCount: countPrivate(walked.elements),
    sequenceCount: state.sequenceCount,
    maxSequenceDepth: state.maxDepthSeen,
    pixel: pixelElement
      ? {
          present: true,
          tag: pixelElement.tag,
          byteLength: pixelElement.pixel?.byteLength,
          encapsulated: pixelElement.pixel?.encapsulated,
          fragmentCount: pixelElement.pixel?.fragmentCount,
        }
      : { present: false },
    redactedTags: [...state.redactedTags],
    truncated,
  };

  return {
    refused: false,
    fileMeta,
    transferSyntaxUid,
    syntax,
    elements: walked.elements,
    summary,
    issues: state.issues,
    truncated,
  };
}

function describeSyntax(syntax: TransferSyntaxInfo): string {
  if (syntax.uid === "unknown") return "unknown (assumed implicit VR little-endian)";
  const vr = syntax.explicit ? "explicit VR" : "implicit VR";
  const order = syntax.littleEndian ? "little-endian" : "big-endian (retired, read-only)";
  return `${syntax.uid} (${vr} ${order})${syntax.assumed ? ", assumed" : ""}`;
}

function safeSample(element: DicomElement): string {
  if (element.redacted) return DICOM_PHI_PLACEHOLDER;
  if (element.pixelData) {
    const bytes = element.pixel?.byteLength ?? element.length;
    return `<pixel data, ${bytes} byte(s) — never inlined>`;
  }
  if (element.depthTruncated) return `<sequence truncated past depth ${DICOM_MAX_SEQUENCE_DEPTH}>`;
  if (element.binary) return `<binary, ${element.length} byte(s)>`;
  if (element.empty) return "<empty>";
  if (Array.isArray(element.value) && element.vr === "SQ") {
    return `<sequence of ${(element.value as DicomElement[][]).length} item(s)>`;
  }
  const text = String(element.value);
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

export class DicomFormatAdapter implements MedicalFormatAdapter {
  public id = DICOM_ADAPTER_ID;
  public version = DICOM_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: "dicom",
      version: DICOM_ADAPTER_VERSION,
      description:
        "DICOM Part-10 metadata adapter: file-meta header, transfer syntax and dataset tag walk with PHI redaction",
      extensions: [".dcm", ".dicom"],
      mimeTypes: ["application/dicom"],
      status: "metadata-only",
      limitations: [
        "Metadata only: file-meta header, dataset tags, counts and checksums — pixel bytes are never inlined, exported or transcoded.",
        "No DICOMweb (QIDO/WADO/STOW): Phase G — this adapter reads Part-10 files only.",
        "No clinical interpretation is performed; values are carried structurally with PHI redacted by default.",
        "Deflated transfer syntax is refused with an explicit issue (no silent decompression).",
        "Explicit VR big-endian (retired) is parsed read-only; implicit VR is always little-endian.",
        "Nested sequences are walked to a bounded depth; deeper nesting is reported and skipped, never silently dropped.",
        "Private tags are preserved by number only — never interpreted, values never inlined.",
        "Legacy preamble-less datasets (no 128-byte preamble + DICM magic) are refused with an explicit issue.",
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
      const buf = toBuffer(input);
      if (buf !== undefined) {
        if (hasDicomMagic(buf)) return 0.95;
        // Long enough to carry a preamble but no magic: content contradicts any DICOM claim.
        if (buf.length >= 132) return 0;
      }
      const ext = fileExtension(input);
      if (ext === "dcm" || ext === "dicom") return 0.9;
      if (input.mimeType === "application/dicom") return 0.9;
      // Short/empty buffers cannot contradict the claim yet; without an
      // extension or magic there is no DICOM evidence at all.
      return 0;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const capabilities = this.getManifest().capabilities;
    const status = this.getManifest().status;
    try {
      const buf = toBuffer(input);
      if (buf === undefined || buf.length === 0) {
        return {
          format: "dicom",
          domain: "imaging",
          recordCount: 0,
          capabilities,
          status,
          warnings: ["Input has no readable bytes; nothing was inspected"],
        };
      }
      if (!hasDicomMagic(buf)) {
        return {
          format: "dicom",
          domain: "imaging",
          recordCount: 0,
          capabilities,
          status,
          warnings: [
            buf.length < 132
              ? `Only ${buf.length} byte(s): no 128-byte preamble + DICM magic present`
              : "No DICM magic at byte 128: not a Part-10 file (preamble-less datasets are refused)",
          ],
        };
      }
      const parsed = parseDicomBytes(buf, undefined);
      if (parsed.refused) {
        return {
          format: "dicom",
          formatVersion: "deflated-refused",
          domain: "imaging",
          recordCount: 0,
          capabilities,
          status,
          warnings: [`${parsed.code}: ${parsed.message}`],
        };
      }
      const { summary, elements, issues } = parsed;
      return {
        format: "dicom",
        formatVersion: summary.transferSyntaxUid,
        domain: "imaging",
        recordCount: 1,
        detectedSchema: {
          fields: elements.map((element) => ({
            name: `${element.tag} ${element.name}`,
            type: element.vr,
            sampleValues: [safeSample(element)],
            nullable: false,
          })),
        },
        sampleRecords: [summaryRecord(summary)],
        capabilities,
        status,
        warnings: [
          `Transfer syntax: ${describeSyntax(parsed.syntax)}`,
          ...(summary.sopClassUid ? [`SOP Class: ${summary.sopClassUid}`] : []),
          ...(summary.modality ? [`Modality: ${summary.modality}`] : []),
          `Elements: ${summary.elementCount} top-level (${summary.totalElementCount} total incl. nested), ${summary.privateTagCount} private`,
          `Sequences: ${summary.sequenceCount} (max depth ${summary.maxSequenceDepth})`,
          summary.pixel.present
            ? `Pixel data: present (${summary.pixel.tag}, ${summary.pixel.byteLength ?? "?"} byte(s), encapsulated: ${summary.pixel.encapsulated === true ? "yes" : "no"}) — bytes never inlined`
            : "Pixel data: absent",
          summary.redactedTags.length > 0
            ? `PHI redaction: ${summary.redactedTags.length} tag(s) replaced with ${DICOM_PHI_PLACEHOLDER} (${summary.redactedTags.join(", ")})`
            : "PHI redaction: no listed PHI tags present",
          ...(summary.truncated ? ["Walk truncated: the envelope is partial (see issues)"] : []),
          ...issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
        ],
      };
    } catch (error) {
      return {
        format: "dicom",
        domain: "imaging",
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
      buf = toBuffer(input);
    } catch (error) {
      emit({
        code: "DICOM_PARSE_FAILED",
        severity: "fatal",
        message: `Input bytes could not be read: ${(error as Error).message}`,
      });
      return;
    }
    if (buf === undefined || buf.length === 0) {
      emit({
        code: "DICOM_EMPTY_INPUT",
        severity: "error",
        message: "Input has no readable bytes; nothing was parsed",
      });
      return;
    }
    if (!hasDicomMagic(buf)) {
      emit({
        code: "DICOM_MISSING_MAGIC",
        severity: "error",
        message:
          buf.length < 132
            ? `Only ${buf.length} byte(s): no 128-byte preamble + DICM magic present, so the transfer syntax is unknown and nothing was parsed`
            : "No DICM magic at byte 128: not a Part-10 file, so the transfer syntax is unknown and nothing was parsed (preamble-less datasets are refused)",
      });
      return;
    }

    let parsed: ReturnType<typeof parseDicomBytes>;
    try {
      parsed = parseDicomBytes(buf, (context.options ?? {}) as Record<string, unknown>);
    } catch (error) {
      emit({
        code: "DICOM_PARSE_FAILED",
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

    const debug = phiAllowedForLocalDebug((context.options ?? {}) as Record<string, unknown>);
    const { summary } = parsed;
    const checksum = computeChecksum(input);
    const recordIssues: ValidationIssue[] = [...parsed.issues];

    yield createCanonicalEnvelope({
      id: summary.sopInstanceUid ?? `dicom-dataset-0`,
      domain: "imaging",
      sourceFormat: "dicom",
      formatVersion: summary.transferSyntaxUid,
      content: {
        kind: "structured",
        data: {
          fileMeta: parsed.fileMeta as unknown as Record<string, unknown>,
          transferSyntax: {
            uid: parsed.syntax.uid,
            explicitVr: parsed.syntax.explicit,
            littleEndian: parsed.syntax.littleEndian,
            assumed: parsed.syntax.assumed,
          },
          elements: parsed.elements as unknown as Record<string, unknown>,
          counts: {
            topLevel: summary.elementCount,
            total: summary.totalElementCount,
            private: summary.privateTagCount,
            sequences: summary.sequenceCount,
            maxDepth: summary.maxSequenceDepth,
          },
          pixelData: summary.pixel as unknown as Record<string, unknown>,
          phiRedaction: {
            applied: !debug,
            mode: debug ? "included-local-debug" : "placeholder",
            placeholder: debug ? null : DICOM_PHI_PLACEHOLDER,
            redactedTags: summary.redactedTags,
          },
        },
      },
      importedAt: context.importedAt,
      adapterId: this.id,
      adapterVersion: this.version,
      recordIndex: 0,
      sourceLocation: "dataset",
      filename: input.filename,
      checksum,
      encoding: "dicom-binary",
      metadata: {
        transferSyntaxUid: summary.transferSyntaxUid,
        sopClassUid: summary.sopClassUid,
        sopInstanceUid: summary.sopInstanceUid,
        modality: summary.modality,
        studyInstanceUid: summary.studyInstanceUid,
        seriesInstanceUid: summary.seriesInstanceUid,
        elementCount: summary.elementCount,
        totalElementCount: summary.totalElementCount,
        privateTagCount: summary.privateTagCount,
        sequenceCount: summary.sequenceCount,
        maxSequenceDepth: summary.maxSequenceDepth,
        hasPixelData: summary.pixel.present,
        pixelByteLength: summary.pixel.byteLength,
        pixelEncapsulated: summary.pixel.encapsulated,
        pixelFragmentCount: summary.pixel.fragmentCount,
        phiRedactedTags: summary.redactedTags,
        phiPlaceholder: debug ? null : DICOM_PHI_PLACEHOLDER,
        truncated: summary.truncated,
        fileMetaElementCount: parsed.fileMeta.length,
      },
      parseIssues: recordIssues,
    });
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${DICOM_ADAPTER_ID} ${DICOM_ADAPTER_VERSION} (Part-10 metadata only; pixels never inlined, no DICOMweb, no clinical interpretation)`,
    };
  }
}

function summaryRecord(summary: DicomFileSummary): Record<string, unknown> {
  return {
    transferSyntaxUid: summary.transferSyntaxUid,
    explicitVr: summary.explicitVr,
    littleEndian: summary.littleEndian,
    sopClassUid: summary.sopClassUid,
    modality: summary.modality,
    studyInstanceUid: summary.studyInstanceUid,
    seriesInstanceUid: summary.seriesInstanceUid,
    elementCount: summary.elementCount,
    totalElementCount: summary.totalElementCount,
    privateTagCount: summary.privateTagCount,
    sequenceCount: summary.sequenceCount,
    maxSequenceDepth: summary.maxSequenceDepth,
    hasPixelData: summary.pixel.present,
    pixelByteLength: summary.pixel.byteLength,
    redactedTags: summary.redactedTags,
  };
}
