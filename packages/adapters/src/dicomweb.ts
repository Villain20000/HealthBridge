/**
 * DICOMweb client adapter — read-only QIDO-RS / WADO-RS over Node built-ins.
 *
 * Status is honestly `metadata-only`: QIDO-RS search responses and WADO-RS
 * metadata (`application/dicom+json` arrays of DICOM JSON datasets) are carried
 * structurally, one envelope per dataset element, with checksum + provenance
 * on every envelope. WADO-RS instance / frames / bulkdata payloads are NEVER
 * inlined: they yield a single `binary-reference` envelope carrying the
 * request path, media type and byte count only. No pixel rendering,
 * transcoding, clinical interpretation, or DICOMweb notifications are
 * performed here.
 *
 * Read-only by construction: only HTTP GET is ever issued (no POST, PUT,
 * PATCH or DELETE). STOW-RS store intent (via `ParseContext.options`) is
 * explicitly refused with `DICOMWEB_STOW_REFUSED` before any socket opens —
 * never silently stored. `node:http` / `node:https` are used directly — no new
 * dependencies. `inspect()` performs no network requests at all; it only
 * describes the URL shape with query values redacted.
 *
 * Security / privacy contract (PLAN section 3, ROADMAP Phase G):
 * - SSRF allowlist: `allowedHosts` is REQUIRED and default-deny. A request
 *   whose host is not explicitly listed is refused before any socket opens.
 * - Only `http:` and `https:` are allowed; every other scheme is refused.
 * - Loopback / private hosts are refused UNLESS explicitly present in
 *   `allowedHosts`, in which case the fetch proceeds and a
 *   `DICOMWEB_PRIVATE_HOST_ALLOWED` warning is reported via
 *   `ParseContext.onIssue` (the logged warning).
 * - Redirects are never followed (refused with an explicit issue).
 * - Responses are bounded (`DICOMWEB_MAX_RESPONSE_BYTES`) and requests time
 *   out (`timeoutMs`, default 8 s).
 * - NO PHI in logs/errors: every message carries the redacted URL only
 *   (query values replaced with `<query redacted>`), response bodies are
 *   never embedded in errors, and `offendingValue` is never set from request
 *   or response content.
 */

import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";

export const DICOMWEB_ADAPTER_ID = "dicomweb-adapter";
export const DICOMWEB_ADAPTER_VERSION = "1.0.0";
export const DICOMWEB_FORMAT = "dicomweb";
/** DICOM PS3.18 Web Services label carried in envelopes and inspections. */
export const DICOMWEB_FORMAT_VERSION = "PS3.18";

/** Default request timeout (ms) when `timeoutMs` is not configured. */
export const DICOMWEB_DEFAULT_TIMEOUT_MS = 8000;
/** Hard upper bound for `timeoutMs` (ms). */
export const DICOMWEB_MAX_TIMEOUT_MS = 120000;
/** Default paging bound: at most this many QIDO pages per parse. */
export const DICOMWEB_DEFAULT_MAX_PAGES = 5;
/** Hard upper bound for `maxPages` (paging is always bounded). */
export const DICOMWEB_MAX_PAGES = 50;
/** A single HTTP response body larger than this is refused (SSRF/size guard). */
export const DICOMWEB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Default QIDO `limit` when neither the URL nor options set one. */
export const DICOMWEB_DEFAULT_QIDO_LIMIT = 100;
/** Hard upper bound for the QIDO `limit` parameter (paging stays bounded). */
export const DICOMWEB_MAX_QIDO_LIMIT = 1000;
/** Upper bound for the number of `includefield` entries accepted from options. */
export const DICOMWEB_MAX_INCLUDEFIELD = 50;

export interface DicomWebOptions {
  /**
   * REQUIRED explicit SSRF allowlist: hostnames or IP literals (lowercase
   * compare, e.g. `["pacs.hospital.example"]` or `["127.0.0.1"]` for a local
   * stub). Empty or missing means default-deny: every request is refused.
   * Listing a loopback/private host is the explicit opt-in that permits it,
   * and produces a `DICOMWEB_PRIVATE_HOST_ALLOWED` warning.
   */
  allowedHosts?: string[];
  /** Request timeout in ms (default 8000, clamped to 1..120000). */
  timeoutMs?: number;
  /** Paging bound: max QIDO pages followed via limit/offset (default 5, clamped to 1..50). */
  maxPages?: number;
  /** QIDO `limit` page size (default 100, clamped to 1..1000). */
  limit?: number;
  /** QIDO `offset` start index (default 0, clamped to >= 0). */
  offset?: number;
  /** QIDO matching filters applied when the URL does not already set them. */
  modality?: string;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  patientID?: string;
  accessionNumber?: string;
  /** QIDO `includefield` values applied when the URL does not set any. */
  includefield?: string[];
  /** QIDO `fuzzymatching` flag applied when the URL does not set one. */
  fuzzymatching?: boolean;
  /**
   * Generic QIDO filters (`{ Modality: "CT", PatientID: "P1" }`) applied when
   * the URL does not already set the key. Keys must be DICOM keywords
   * (`/^[A-Za-z][A-Za-z0-9]*$/`); other keys are ignored.
   */
  qido?: Record<string, string | string[]>;
  /**
   * Store intent is read-only-gated: setting `stow: true`,
   * `operation: "stow" | "store"`, or `method: "POST" | "PUT" | "PATCH" |
   * "DELETE"` makes `parse()` refuse with `DICOMWEB_STOW_REFUSED` before any
   * socket opens. There is no opt-in that enables storing.
   */
  stow?: boolean;
  operation?: string;
  method?: string;
}

/** Redacted error raised by the fetch helpers; messages never carry query values or bodies. */
export class DicomWebError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DicomWebError";
    this.code = code;
  }
}

/**
 * Render a URL for logs/errors with every query value removed. The host and
 * path stay (operators need to know what was contacted); the query becomes
 * `?<query redacted>` and the fragment is dropped.
 */
export function redactDicomWebUrlForLog(urlString: string): string {
  try {
    const url = new URL(urlString);
    const query = url.search !== "" ? "?<query redacted>" : "";
    return `${url.protocol}//${url.host}${url.pathname}${query}`;
  } catch {
    return "unparseable-url";
  }
}

/**
 * Normalise the explicit SSRF allowlist: lowercase hostnames, scheme/path
 * stripped, ports stripped (matching is host-based). Non-string entries are
 * ignored; a non-array input yields the empty (default-deny) list.
 */
export function normalizeDicomWebAllowedHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    let host = entry.trim().toLowerCase();
    if (host === "") continue;
    host = host.replace(/^https?:\/\//, "");
    const slash = host.indexOf("/");
    if (slash !== -1) host = host.slice(0, slash);
    if (host.startsWith("[")) {
      const close = host.indexOf("]");
      if (close === -1) continue;
      host = host.slice(1, close);
    } else {
      const colon = host.lastIndexOf(":");
      if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
    }
    if (host !== "" && !out.includes(host)) out.push(host);
  }
  return out;
}

/** Literal (no-DNS) loopback/private-host test for an already-parsed hostname. */
export function isDicomWebPrivateHostLiteral(hostname: string): boolean {
  const bare = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const host = bare.split("%")[0] ?? "";
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fe80:") || host.startsWith("fec0:")) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/**
 * Loopback/private-host test with a best-effort DNS follow-up: a non-literal
 * hostname that resolves to a private address counts as private. DNS failure
 * is ignored (the fetch itself will then fail with a redacted error); the
 * literal check is the enforcement path, DNS is defence in depth.
 */
export async function isDicomWebPrivateHost(hostname: string): Promise<boolean> {
  if (isDicomWebPrivateHostLiteral(hostname)) return true;
  try {
    const addresses = await dnsLookup(hostname, { all: true });
    return addresses.some((entry) => isDicomWebPrivateHostLiteral(entry.address));
  } catch {
    return false;
  }
}

export function clampDicomWebTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DICOMWEB_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), DICOMWEB_MAX_TIMEOUT_MS);
}

export function clampDicomWebMaxPages(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return DICOMWEB_DEFAULT_MAX_PAGES;
  return Math.min(Math.floor(raw), DICOMWEB_MAX_PAGES);
}

export function clampDicomWebLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return DICOMWEB_DEFAULT_QIDO_LIMIT;
  return Math.min(Math.floor(raw), DICOMWEB_MAX_QIDO_LIMIT);
}

export function clampDicomWebOffset(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

export function normalizeDicomWebIncludeField(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
    if (out.length >= DICOMWEB_MAX_INCLUDEFIELD) break;
  }
  return out;
}

/**
 * Enforce the SSRF policy for one request URL. Returns the parsed URL;
 * throws a redacted {@link DicomWebError} for unparseable URLs, non-http(s)
 * schemes, or hosts outside the explicit allowlist (default-deny).
 */
export function assertDicomWebAllowedUrl(urlString: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new DicomWebError("DICOMWEB_INVALID_URL", "Refused DICOMweb request: URL is unparseable (value redacted)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DicomWebError(
      "DICOMWEB_SCHEME_BLOCKED",
      `Refused DICOMweb request to ${redactDicomWebUrlForLog(urlString)}: only http and https are allowed (default-deny; query redacted)`,
    );
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new DicomWebError(
      "DICOMWEB_ALLOWLIST_REFUSED",
      `Refused DICOMweb request to ${redactDicomWebUrlForLog(urlString)}: host is not in the explicit allowedHosts list (default-deny; query redacted)`,
    );
  }
  return url;
}

/** DICOMweb operation derived from the URL path shape (never from payloads). */
export type DicomWebOperation =
  | "qido-studies"
  | "qido-series"
  | "qido-instances"
  | "wado-metadata"
  | "wado-instance"
  | "wado-frames"
  | "wado-bulkdata"
  | "unknown";

/**
 * Classify a DICOMweb request URL by path shape only. Query values are never
 * inspected. Returns `unknown` for unparseable URLs, non-http(s) schemes, and
 * paths without a `/studies` segment (including STOW-style bare POST targets,
 * which this read-only client never stores to).
 */
export function classifyDicomWebUrl(urlString: string): DicomWebOperation {
  let path: string;
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    path = url.pathname ?? "";
  } catch {
    return "unknown";
  }
  if (!/\/studies(\/|$)/i.test(path)) return "unknown";
  if (/\/metadata\/?$/i.test(path)) return "wado-metadata";
  if (/\/frames(\/|$)/i.test(path)) return "wado-frames";
  if (/\/bulkdata(\/|$)/i.test(path)) return "wado-bulkdata";
  if (/\/instances\/[^/]+/i.test(path)) return "wado-instance";
  if (/\/instances\/?$/i.test(path)) return "qido-instances";
  if (/\/series(\/|$)/i.test(path)) {
    // /studies/{uid}/series/{uid}/instances is an instance search; a bare
    // /studies/{uid}/series is a series search.
    if (/\/instances(\/|$)/i.test(path)) return "qido-instances";
    const segments = path.split("/").filter((s) => s !== "");
    const seriesIdx = segments.findIndex((s) => s.toLowerCase() === "series");
    if (seriesIdx !== -1 && segments.length > seriesIdx + 1) {
      // /series/{uid} without /instances beneath it is still series scope.
      return path.toLowerCase().includes("/instances") ? "qido-instances" : "qido-series";
    }
    return "qido-series";
  }
  return "qido-studies";
}

/** True for QIDO-RS search operations (the only paged operations). */
export function isDicomWebQidoOperation(op: DicomWebOperation): boolean {
  return op === "qido-studies" || op === "qido-series" || op === "qido-instances";
}

/** True for binary WADO-RS retrievals (bytes never inlined, references only). */
export function isDicomWebBinaryOperation(op: DicomWebOperation): boolean {
  return op === "wado-instance" || op === "wado-frames" || op === "wado-bulkdata";
}

const QIDO_KEYWORD = /^[A-Za-z][A-Za-z0-9]*$/;

export interface QidoSearchRequest {
  /** DICOMweb base URL, e.g. `https://pacs.example/dicomweb`. */
  baseUrl: string;
  level: "studies" | "series" | "instances";
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  filters?: Record<string, string | string[]>;
  limit?: number;
  offset?: number;
  includefield?: string[];
  fuzzymatching?: boolean;
}

/**
 * Build a QIDO-RS search URL from parts (`{base}/studies[/{study}/series[/{series}/instances]]`
 * plus encoded query parameters). Values are percent-encoded by `URL`; callers
 * must still treat the result as sensitive (query values are redacted in
 * every log/error). Throws a redacted {@link DicomWebError} for unparseable
 * base URLs, missing UIDs for series/instance levels, or invalid filter keys.
 */
export function buildQidoSearchUrl(request: QidoSearchRequest): string {
  let base: URL;
  try {
    base = new URL(request.baseUrl);
  } catch {
    throw new DicomWebError("DICOMWEB_INVALID_URL", "Refused QIDO request: base URL is unparseable (value redacted)");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new DicomWebError(
      "DICOMWEB_SCHEME_BLOCKED",
      "Refused QIDO request: only http and https are allowed (default-deny; query redacted)",
    );
  }
  const strip = (s: string): string => s.replace(/\/+$/, "");
  const enc = (s: string): string => encodeURIComponent(s);
  let path = strip(base.toString().replace(/[?#].*$/, ""));
  if (request.level === "studies") {
    path = `${path}/studies`;
  } else if (request.level === "series") {
    if (!request.studyInstanceUID) {
      throw new DicomWebError(
        "DICOMWEB_QIDO_MISSING_UID",
        "Refused QIDO series search: studyInstanceUID is required (value redacted)",
      );
    }
    path = `${path}/studies/${enc(request.studyInstanceUID)}/series`;
  } else if (request.level === "instances") {
    if (!request.studyInstanceUID || !request.seriesInstanceUID) {
      throw new DicomWebError(
        "DICOMWEB_QIDO_MISSING_UID",
        "Refused QIDO instance search: studyInstanceUID and seriesInstanceUID are required (value redacted)",
      );
    }
    path = `${path}/studies/${enc(request.studyInstanceUID)}/series/${enc(request.seriesInstanceUID)}/instances`;
  } else {
    throw new DicomWebError("DICOMWEB_QIDO_BAD_LEVEL", "Refused QIDO request: unknown search level (value redacted)");
  }
  const url = new URL(path);
  // Preserve base query values already present on the base URL path object.
  for (const [k, v] of new URL(request.baseUrl).searchParams) url.searchParams.append(k, v);
  const limit = clampDicomWebLimit(request.limit ?? DICOMWEB_DEFAULT_QIDO_LIMIT);
  const offset = clampDicomWebOffset(request.offset ?? 0);
  url.searchParams.set("limit", String(limit));
  if (offset > 0) url.searchParams.set("offset", String(offset));
  if (request.filters) {
    for (const [key, value] of Object.entries(request.filters)) {
      if (!QIDO_KEYWORD.test(key)) continue;
      if (url.searchParams.has(key)) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string" && v !== "") url.searchParams.append(key, v);
        }
      } else if (typeof value === "string" && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  for (const field of normalizeDicomWebIncludeField(request.includefield)) {
    url.searchParams.append("includefield", field);
  }
  if (request.fuzzymatching !== undefined) {
    url.searchParams.set("fuzzymatching", request.fuzzymatching ? "true" : "false");
  }
  return url.toString();
}

/**
 * Merge `DicomWebOptions` QIDO filters into an existing request URL, setting a
 * parameter only when the URL does not already carry it (explicit URLs win).
 * WADO metadata/binary URLs pass through untouched. Throws a redacted
 * {@link DicomWebError} for unparseable URLs.
 */
export function applyDicomWebQidoOptions(rawUrl: string, options: DicomWebOptions): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DicomWebError("DICOMWEB_INVALID_URL", "Refused DICOMweb request: URL is unparseable (value redacted)");
  }
  const op = classifyDicomWebUrl(rawUrl);
  if (!isDicomWebQidoOperation(op)) return rawUrl;
  const setIfMissing = (key: string, value: string | undefined): void => {
    if (value === undefined || value === "") return;
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  };
  setIfMissing("Modality", options.modality?.trim() || undefined);
  setIfMissing("StudyInstanceUID", options.studyInstanceUID?.trim() || undefined);
  setIfMissing("SeriesInstanceUID", options.seriesInstanceUID?.trim() || undefined);
  setIfMissing("SOPInstanceUID", options.sopInstanceUID?.trim() || undefined);
  setIfMissing("PatientID", options.patientID?.trim() || undefined);
  setIfMissing("AccessionNumber", options.accessionNumber?.trim() || undefined);
  if (options.qido) {
    for (const [key, value] of Object.entries(options.qido)) {
      if (!QIDO_KEYWORD.test(key) || url.searchParams.has(key)) continue;
      if (Array.isArray(value)) {
        let appended = false;
        for (const v of value) {
          if (typeof v === "string" && v !== "") {
            url.searchParams.append(key, v);
            appended = true;
          }
        }
        void appended;
      } else if (typeof value === "string" && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  if (options.limit !== undefined && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", String(clampDicomWebLimit(options.limit)));
  }
  if (options.offset !== undefined && !url.searchParams.has("offset")) {
    const offset = clampDicomWebOffset(options.offset);
    if (offset > 0) url.searchParams.set("offset", String(offset));
  }
  const includefield = normalizeDicomWebIncludeField(options.includefield);
  if (includefield.length > 0 && !url.searchParams.has("includefield")) {
    for (const field of includefield) url.searchParams.append("includefield", field);
  }
  if (options.fuzzymatching !== undefined && !url.searchParams.has("fuzzymatching")) {
    url.searchParams.set("fuzzymatching", options.fuzzymatching ? "true" : "false");
  }
  return url.toString();
}

/** Read the QIDO `limit`/`offset` in effect for one request URL (URL wins, options fill gaps). */
export function dicomWebLimitOffsetFor(urlString: string, options: DicomWebOptions): { limit: number; offset: number } {
  try {
    const url = new URL(urlString);
    const limitRaw = url.searchParams.get("limit");
    const offsetRaw = url.searchParams.get("offset");
    const limit =
      limitRaw !== null
        ? clampDicomWebLimit(Number(limitRaw) || DICOMWEB_DEFAULT_QIDO_LIMIT)
        : clampDicomWebLimit(options.limit ?? DICOMWEB_DEFAULT_QIDO_LIMIT);
    const offset =
      offsetRaw !== null ? clampDicomWebOffset(Number(offsetRaw) || 0) : clampDicomWebOffset(options.offset ?? 0);
    return { limit, offset };
  } catch {
    return {
      limit: clampDicomWebLimit(options.limit ?? DICOMWEB_DEFAULT_QIDO_LIMIT),
      offset: clampDicomWebOffset(options.offset ?? 0),
    };
  }
}

/** Return a copy of the URL with the `offset` parameter set (QIDO paging). */
export function withDicomWebOffset(urlString: string, offset: number): string {
  const url = new URL(urlString); // throws for bad URLs; caller maps to DICOMWEB_INVALID_URL
  url.searchParams.set("offset", String(clampDicomWebOffset(offset)));
  return url.toString();
}

/** Request path without query or fragment (binary-reference URIs strip queries to avoid PHI). */
export function dicomWebPathOnly(urlString: string): string {
  const url = new URL(urlString); // throws for bad URLs; caller maps to DICOMWEB_INVALID_URL
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** Frame numbers requested by a WADO-RS frames URL (`.../frames/1,2`); empty when absent/unparseable. */
export function parseDicomWebFrameList(urlString: string): string[] {
  try {
    const path = new URL(urlString).pathname;
    const match = /\/frames\/([^/?#]+)/i.exec(path);
    if (!match) return [];
    return match[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  } catch {
    return [];
  }
}

/** UIDs recoverable from a WADO/QIDO path (`/studies/{s}[/series/{r}[/instances/{i}]]`); absent segments stay undefined. */
export function uidsFromDicomWebPath(urlString: string): {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
} {
  try {
    const path = new URL(urlString).pathname;
    const study = /\/studies\/([^/]+)/i.exec(path)?.[1];
    const series = /\/series\/([^/]+)/i.exec(path)?.[1];
    const instance = /\/instances\/([^/]+)/i.exec(path)?.[1];
    const clean = (v: string | undefined): string | undefined => {
      if (v === undefined) return undefined;
      try {
        const decoded = decodeURIComponent(v);
        return decoded !== "" ? decoded : undefined;
      } catch {
        return v !== "" ? v : undefined;
      }
    };
    // A trailing `/instances` (QIDO search) yields "instances" as no UID: the
    // regex above only matches when a segment follows, so nothing to filter.
    void instance;
    return {
      ...(study !== undefined ? { studyInstanceUID: clean(study) } : {}),
      ...(series !== undefined ? { seriesInstanceUID: clean(series) } : {}),
      ...(instance !== undefined && instance.toLowerCase() !== "metadata" && instance.toLowerCase() !== "frames"
        ? { sopInstanceUID: clean(instance) }
        : {}),
    };
  } catch {
    return {};
  }
}

/** First string value of a DICOM JSON element (`{ vr, Value: [...] }`); undefined when absent. */
export function dicomJsonFirstValue(dataset: unknown, tag: string): string | undefined {
  if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) return undefined;
  const element = (dataset as Record<string, unknown>)[tag] as Record<string, unknown> | undefined;
  if (element === null || typeof element !== "object" || Array.isArray(element)) return undefined;
  const values = element.Value;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const first = values[0];
  if (typeof first === "string") return first;
  if (typeof first === "number") return String(first);
  return undefined;
}

/** Study/series/instance UIDs + modality carried in envelope metadata (identifiers, never names/dates). */
export function extractDicomWebIdentifiers(dataset: unknown): {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  modality?: string;
} {
  return {
    ...(dicomJsonFirstValue(dataset, "0020000D") !== undefined
      ? { studyInstanceUID: dicomJsonFirstValue(dataset, "0020000D") as string }
      : {}),
    ...(dicomJsonFirstValue(dataset, "0020000E") !== undefined
      ? { seriesInstanceUID: dicomJsonFirstValue(dataset, "0020000E") as string }
      : {}),
    ...(dicomJsonFirstValue(dataset, "00080018") !== undefined
      ? { sopInstanceUID: dicomJsonFirstValue(dataset, "00080018") as string }
      : {}),
    ...(dicomJsonFirstValue(dataset, "00080060") !== undefined
      ? { modality: dicomJsonFirstValue(dataset, "00080060") as string }
      : {}),
  };
}

/**
 * STOW-RS is not supported by this read-only client: this helper always throws
 * `DICOMWEB_STOW_REFUSED` so store intent can never silently succeed. `parse()`
 * calls it before any socket opens when store intent is detected in options.
 */
export function refuseDicomWebStow(): never {
  throw new DicomWebError(
    "DICOMWEB_STOW_REFUSED",
    "Refused STOW-RS store request: this DICOMweb client is read-only (QIDO-RS/WADO-RS only); storing instances is not supported and nothing was sent",
  );
}

/** True when `ParseContext.options` carries STOW-RS store intent (any spelling). */
export function hasDicomWebStoreIntent(options: Record<string, unknown>): boolean {
  if (options.stow === true) return true;
  const operation = typeof options.operation === "string" ? options.operation.trim().toLowerCase() : "";
  if (operation === "stow" || operation === "store" || operation === "stow-rs") return true;
  const method = typeof options.method === "string" ? options.method.trim().toUpperCase() : "";
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** One bounded GET returning status, headers and body bytes. All errors are redacted. */
function fetchDicomWebOnce(
  urlString: string,
  timeoutMs: number,
  accept: string,
): Promise<{ statusCode: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(urlString);
    } catch {
      reject(
        new DicomWebError("DICOMWEB_INVALID_URL", "Refused DICOMweb request: URL is unparseable (value redacted)"),
      );
      return;
    }
    const redacted = redactDicomWebUrlForLog(urlString);
    let req: http.ClientRequest;
    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > DICOMWEB_MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(
            new DicomWebError(
              "DICOMWEB_RESPONSE_TOO_LARGE",
              `Refused oversized response from ${redacted} (limit ${DICOMWEB_MAX_RESPONSE_BYTES} bytes; body and query redacted)`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const contentType = Array.isArray(res.headers["content-type"])
          ? (res.headers["content-type"][0] ?? "")
          : (res.headers["content-type"] ?? "");
        resolve({ statusCode: res.statusCode ?? 0, contentType, body: Buffer.concat(chunks) });
      });
      res.on("error", () => {
        reject(
          new DicomWebError("DICOMWEB_REQUEST_FAILED", `DICOMweb request failed for ${redacted} (query redacted)`),
        );
      });
    };
    const requestOptions = {
      method: "GET",
      headers: { Accept: accept, "User-Agent": "HealthBridge-DICOMweb/1.0" },
    };
    try {
      req =
        target.protocol === "https:"
          ? https.request(target, requestOptions, onResponse)
          : http.request(target, requestOptions, onResponse);
    } catch {
      reject(new DicomWebError("DICOMWEB_REQUEST_FAILED", `DICOMweb request failed for ${redacted} (query redacted)`));
      return;
    }
    req.on("error", (error: unknown) => {
      if (error instanceof DicomWebError) reject(error);
      else
        reject(
          new DicomWebError("DICOMWEB_REQUEST_FAILED", `DICOMweb request failed for ${redacted} (query redacted)`),
        );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(
        new DicomWebError(
          "DICOMWEB_TIMEOUT",
          `DICOMweb request timed out after ${timeoutMs} ms for ${redacted} (query redacted)`,
        ),
      );
    });
    req.end();
  });
}

function toDicomWebIssue(error: unknown): ValidationIssue {
  if (error instanceof DicomWebError) {
    return { code: error.code, severity: "error", message: error.message };
  }
  return {
    code: "DICOMWEB_REQUEST_FAILED",
    severity: "error",
    message: "DICOMweb request failed unexpectedly (details redacted to protect query values)",
  };
}

export class DicomWebAdapter implements MedicalFormatAdapter {
  public id = DICOMWEB_ADAPTER_ID;
  public version = DICOMWEB_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: DICOMWEB_FORMAT,
      version: DICOMWEB_ADAPTER_VERSION,
      description:
        "Read-only DICOMweb PS3.18 client over Node built-ins: QIDO-RS study/series/instance search with bounded limit/offset paging and WADO-RS metadata/instance/frames retrieval behind an explicit SSRF allowlist",
      extensions: [],
      mimeTypes: ["application/dicom+json", "multipart/related", "application/dicom"],
      status: "metadata-only",
      limitations: [
        "Read-only: only HTTP GET is ever issued (no POST, PUT, PATCH or DELETE).",
        "STOW-RS storing is explicitly refused (DICOMWEB_STOW_REFUSED); there is no opt-in that enables it.",
        "URL-driven: the request URL comes from InputDescriptor.uri; file payloads are never claimed.",
        "SSRF allowlist is required (allowedHosts) and default-deny; only http/https; redirects are never followed.",
        "Loopback/private hosts are refused unless explicitly listed in allowedHosts (with a logged warning).",
        "QIDO paging is always bounded (default 5 pages, hard cap 50; limit clamped to 1..1000); responses bounded (8 MiB); requests time out (default 8 s).",
        "Frames and pixel bytes are never inlined: WADO-RS instance/frames/bulkdata yield binary-reference envelopes with byte counts only.",
        "Structural only: DICOM JSON datasets are carried verbatim with no clinical interpretation; no rendering, no transcoding, no DICOMweb notifications.",
        "Query values are redacted in every message; response bodies never appear in errors.",
        "DICOMweb PS3.18 JSON only;DIMSE and non-JSON transfer paths are not declared supported.",
        "Not clinically validated.",
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

  /**
   * URL shape only — file payloads (`contentString`/`buffer`/`filename`/
   * `mimeType`) are NEVER consulted, so a `.dcm` file is never claimed.
   */
  public async score(input: InputDescriptor): Promise<number> {
    const uri = input.uri;
    if (typeof uri !== "string" || uri === "") return 0;
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return 0;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return 0;
    if (!/\/studies(\/|$)/i.test(url.pathname ?? "")) return 0;
    return 0.85;
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  /**
   * Network-free: describes the request URL shape (operation, host, query
   * keys) with every query value redacted. Never opens a socket, so no
   * allowlist is needed here.
   */
  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const capabilities = this.getManifest().capabilities;
    const status = this.getManifest().status;
    const raw = input.uri;
    if (typeof raw !== "string" || raw.trim() === "") {
      return {
        format: DICOMWEB_FORMAT,
        formatVersion: DICOMWEB_FORMAT_VERSION,
        domain: "unknown",
        recordCount: 0,
        capabilities,
        status,
        warnings: ["No DICOMweb request URL set (expected InputDescriptor.uri); nothing was fetched"],
      };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {
        format: DICOMWEB_FORMAT,
        formatVersion: DICOMWEB_FORMAT_VERSION,
        domain: "unknown",
        recordCount: 0,
        capabilities,
        status,
        warnings: ["DICOMweb request URL is unparseable (value redacted); nothing was fetched"],
      };
    }
    const operation = classifyDicomWebUrl(raw);
    const queryKeys = [...new Set([...url.searchParams.keys()])];
    return {
      format: DICOMWEB_FORMAT,
      formatVersion: DICOMWEB_FORMAT_VERSION,
      domain: "imaging",
      detectedSchema: {
        fields: [
          { name: "operation", type: "string", sampleValues: [operation], nullable: false },
          { name: "requestHost", type: "string", sampleValues: [url.hostname], nullable: false },
          { name: "queryKeys", type: "string", sampleValues: queryKeys.slice(0, 5), nullable: queryKeys.length === 0 },
        ],
      },
      sampleRecords: [],
      capabilities,
      status,
      warnings: [
        `GET ${redactDicomWebUrlForLog(raw)} (query values redacted)`,
        `operation: ${operation}`,
        queryKeys.length > 0 ? `query keys: ${queryKeys.join(", ")} (values redacted)` : "no query parameters",
        isDicomWebQidoOperation(operation)
          ? "QIDO-RS search: bounded limit/offset paging applies at parse time"
          : isDicomWebBinaryOperation(operation)
            ? "WADO-RS binary retrieval: parse() records a binary-reference with byte counts only (bytes never inlined)"
            : operation === "wado-metadata"
              ? "WADO-RS metadata: parse() carries DICOM JSON datasets structurally"
              : "URL has no recognised DICOMweb /studies path; parse() will report DICOMWEB_UNKNOWN_OPERATION",
        "STOW-RS storing is refused: this client is read-only and never sends instances",
        "inspect() performs no network requests; parse() fetches with an explicit allowedHosts list, bounded paging and timeouts",
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const options = (context.options ?? {}) as Partial<DicomWebOptions> & Record<string, unknown>;
    const allowedHosts = normalizeDicomWebAllowedHosts(options.allowedHosts);
    const timeoutMs = clampDicomWebTimeoutMs(options.timeoutMs);
    const maxPages = clampDicomWebMaxPages(options.maxPages);

    if (hasDicomWebStoreIntent(options)) {
      try {
        refuseDicomWebStow();
      } catch (error) {
        context.onIssue?.(toDicomWebIssue(error));
      }
      return;
    }

    if (typeof input.uri !== "string" || input.uri.trim() === "") {
      context.onIssue?.({
        code: "DICOMWEB_MISSING_URL",
        severity: "error",
        message: "No DICOMweb request URL set (expected InputDescriptor.uri); nothing was fetched",
      });
      return;
    }

    let startUrl: string;
    try {
      startUrl = applyDicomWebQidoOptions(input.uri, options as DicomWebOptions);
    } catch (error) {
      context.onIssue?.(toDicomWebIssue(error));
      return;
    }

    try {
      assertDicomWebAllowedUrl(startUrl, allowedHosts);
    } catch (error) {
      context.onIssue?.(toDicomWebIssue(error));
      return;
    }

    const operation = classifyDicomWebUrl(startUrl);
    if (operation === "unknown") {
      context.onIssue?.({
        code: "DICOMWEB_UNKNOWN_OPERATION",
        severity: "error",
        message: `Refused DICOMweb request to ${redactDicomWebUrlForLog(startUrl)}: URL has no recognised /studies path for QIDO-RS or WADO-RS (query redacted)`,
      });
      return;
    }

    let privateWarned = false;
    const warnPrivateOnce = async (urlString: string): Promise<void> => {
      if (privateWarned) return;
      privateWarned = true;
      try {
        const host = new URL(urlString).hostname;
        if (await isDicomWebPrivateHost(host)) {
          context.onIssue?.({
            code: "DICOMWEB_PRIVATE_HOST_ALLOWED",
            severity: "warning",
            message: `Private/loopback DICOMweb host explicitly allowlisted; proceeding because it is in allowedHosts (${redactDicomWebUrlForLog(urlString)}; query redacted)`,
          });
        }
      } catch {
        return;
      }
    };

    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
    let recordIndex = 0;

    if (isDicomWebQidoOperation(operation)) {
      const { limit: pageLimit, offset: startOffset } = dicomWebLimitOffsetFor(startUrl, options as DicomWebOptions);
      let fetched = 0;
      let page = 0;
      for (;;) {
        if (page >= maxPages) break;
        if (recordIndex >= limit) return;
        let pageUrl: string;
        try {
          // Offset advances by datasets already consumed so each page is fresh.
          pageUrl = withDicomWebOffset(startUrl, startOffset + fetched);
          // Keep the negotiated page size pinned even if the template drifted.
          const pinned = new URL(pageUrl);
          pinned.searchParams.set("limit", String(pageLimit));
          pageUrl = pinned.toString();
        } catch {
          context.onIssue?.({
            code: "DICOMWEB_INVALID_URL",
            severity: "error",
            message: "Refused DICOMweb next-page URL: URL is unparseable (value redacted)",
            recordIndex,
          });
          return;
        }
        try {
          assertDicomWebAllowedUrl(pageUrl, allowedHosts);
        } catch (error) {
          context.onIssue?.({ ...toDicomWebIssue(error), recordIndex });
          return;
        }
        await warnPrivateOnce(pageUrl);
        const redactedPage = redactDicomWebUrlForLog(pageUrl);
        let statusCode: number;
        let body: Buffer;
        try {
          ({ statusCode, body } = await fetchDicomWebOnce(pageUrl, timeoutMs, "application/dicom+json"));
        } catch (error) {
          context.onIssue?.({ ...toDicomWebIssue(error), recordIndex });
          return;
        }
        if (statusCode >= 300 && statusCode < 400) {
          context.onIssue?.({
            code: "DICOMWEB_REDIRECT_REFUSED",
            severity: "error",
            message: `DICOMweb search to ${redactedPage} returned HTTP status ${statusCode}; redirects are never followed (body and query redacted)`,
            recordIndex,
          });
          return;
        }
        if (statusCode !== 200) {
          context.onIssue?.({
            code: "DICOMWEB_HTTP_ERROR",
            severity: "error",
            message: `DICOMweb search failed with HTTP status ${statusCode} for ${redactedPage} (response body and query redacted)`,
            recordIndex,
          });
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString("utf-8"));
        } catch {
          context.onIssue?.({
            code: "DICOMWEB_INVALID_JSON",
            severity: "error",
            message: `DICOMweb search response is not valid JSON for ${redactedPage} (body and query redacted)`,
            recordIndex,
          });
          return;
        }
        if (!Array.isArray(payload)) {
          context.onIssue?.({
            code: "DICOMWEB_UNEXPECTED_PAYLOAD",
            severity: "error",
            message: `DICOMweb search response is not a JSON array for ${redactedPage} (QIDO-RS/WADO-RS metadata always return an array; body redacted)`,
            recordIndex,
          });
          return;
        }
        const checksum = computeChecksum({ contentString: body.toString("utf-8") });
        let pageHost: string;
        try {
          pageHost = new URL(pageUrl).hostname;
        } catch {
          pageHost = "";
        }
        let consumed = 0;
        for (let index = 0; index < payload.length && recordIndex < limit; index++) {
          const dataset = payload[index];
          if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) {
            context.onIssue?.({
              code: "DICOMWEB_ENTRY_SKIPPED",
              severity: "warning",
              message: `A DICOMweb result entry is not an object and was skipped for ${redactedPage} (body redacted)`,
              recordIndex,
            });
            continue;
          }
          const identifiers = extractDicomWebIdentifiers(dataset);
          const id =
            identifiers.sopInstanceUID ??
            identifiers.seriesInstanceUID ??
            identifiers.studyInstanceUID ??
            `dicomweb-p${page}-e${index}`;
          yield createCanonicalEnvelope({
            id,
            domain: "imaging",
            sourceFormat: DICOMWEB_FORMAT,
            formatVersion: DICOMWEB_FORMAT_VERSION,
            content: { kind: "structured", data: dataset as Record<string, unknown> },
            importedAt: context.importedAt,
            adapterId: this.id,
            adapterVersion: this.version,
            recordIndex,
            sourceLocation: `qido page ${page + 1} entry ${index + 1}`,
            filename: input.filename,
            checksum,
            encoding: "utf-8",
            metadata: {
              operation,
              requestHost: pageHost,
              page: page + 1,
              qidoLimit: pageLimit,
              qidoOffset: startOffset + fetched,
              ...identifiers,
            },
          });
          recordIndex++;
          consumed++;
        }
        fetched += payload.length;
        if (recordIndex >= limit) return;
        page++;
        if (payload.length < pageLimit) {
          // Fewer results than the page size: the server has no more pages.
          return;
        }
        if (payload.length === 0) return;
        if (page >= maxPages) {
          context.onIssue?.({
            code: "DICOMWEB_PAGE_LIMIT",
            severity: "warning",
            message: `Stopped after ${maxPages} page(s) with a full page still present (bounded paging; raise maxPages explicitly to fetch more)`,
            recordIndex,
          });
          return;
        }
        void consumed;
      }
      return;
    }

    if (operation === "wado-metadata") {
      await warnPrivateOnce(startUrl);
      const redacted = redactDicomWebUrlForLog(startUrl);
      let statusCode: number;
      let body: Buffer;
      try {
        assertDicomWebAllowedUrl(startUrl, allowedHosts);
        ({ statusCode, body } = await fetchDicomWebOnce(startUrl, timeoutMs, "application/dicom+json"));
      } catch (error) {
        context.onIssue?.({ ...toDicomWebIssue(error), recordIndex });
        return;
      }
      if (statusCode >= 300 && statusCode < 400) {
        context.onIssue?.({
          code: "DICOMWEB_REDIRECT_REFUSED",
          severity: "error",
          message: `DICOMweb metadata request to ${redacted} returned HTTP status ${statusCode}; redirects are never followed (body and query redacted)`,
          recordIndex,
        });
        return;
      }
      if (statusCode !== 200) {
        context.onIssue?.({
          code: "DICOMWEB_HTTP_ERROR",
          severity: "error",
          message: `DICOMweb metadata request failed with HTTP status ${statusCode} for ${redacted} (response body and query redacted)`,
          recordIndex,
        });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf-8"));
      } catch {
        context.onIssue?.({
          code: "DICOMWEB_INVALID_JSON",
          severity: "error",
          message: `DICOMweb metadata response is not valid JSON for ${redacted} (body and query redacted)`,
          recordIndex,
        });
        return;
      }
      if (!Array.isArray(payload)) {
        context.onIssue?.({
          code: "DICOMWEB_UNEXPECTED_PAYLOAD",
          severity: "error",
          message: `DICOMweb metadata response is not a JSON array for ${redacted} (WADO-RS metadata always returns an array; body redacted)`,
          recordIndex,
        });
        return;
      }
      const checksum = computeChecksum({ contentString: body.toString("utf-8") });
      let host: string;
      try {
        host = new URL(startUrl).hostname;
      } catch {
        host = "";
      }
      for (let index = 0; index < payload.length && recordIndex < limit; index++) {
        const dataset = payload[index];
        if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) {
          context.onIssue?.({
            code: "DICOMWEB_ENTRY_SKIPPED",
            severity: "warning",
            message: `A DICOMweb metadata entry is not an object and was skipped for ${redacted} (body redacted)`,
            recordIndex,
          });
          continue;
        }
        const identifiers = extractDicomWebIdentifiers(dataset);
        const id =
          identifiers.sopInstanceUID ??
          identifiers.seriesInstanceUID ??
          identifiers.studyInstanceUID ??
          `dicomweb-meta-e${index}`;
        yield createCanonicalEnvelope({
          id,
          domain: "imaging",
          sourceFormat: DICOMWEB_FORMAT,
          formatVersion: DICOMWEB_FORMAT_VERSION,
          content: { kind: "structured", data: dataset as Record<string, unknown> },
          importedAt: context.importedAt,
          adapterId: this.id,
          adapterVersion: this.version,
          recordIndex,
          sourceLocation: `metadata entry ${index + 1}`,
          filename: input.filename,
          checksum,
          encoding: "utf-8",
          metadata: {
            operation,
            requestHost: host,
            ...identifiers,
          },
        });
        recordIndex++;
      }
      return;
    }

    // WADO-RS binary retrievals: instance, frames, bulkdata. Bytes are counted
    // and hashed, then discarded — the envelope carries a reference only.
    await warnPrivateOnce(startUrl);
    {
      const redacted = redactDicomWebUrlForLog(startUrl);
      let statusCode: number;
      let contentType: string;
      let body: Buffer;
      try {
        assertDicomWebAllowedUrl(startUrl, allowedHosts);
        ({ statusCode, contentType, body } = await fetchDicomWebOnce(
          startUrl,
          timeoutMs,
          'multipart/related; type="application/dicom"; transfer-syntax=*',
        ));
      } catch (error) {
        context.onIssue?.({ ...toDicomWebIssue(error), recordIndex });
        return;
      }
      if (statusCode >= 300 && statusCode < 400) {
        context.onIssue?.({
          code: "DICOMWEB_REDIRECT_REFUSED",
          severity: "error",
          message: `DICOMweb retrieval to ${redacted} returned HTTP status ${statusCode}; redirects are never followed (body and query redacted)`,
          recordIndex,
        });
        return;
      }
      if (statusCode !== 200) {
        context.onIssue?.({
          code: "DICOMWEB_HTTP_ERROR",
          severity: "error",
          message: `DICOMweb retrieval failed with HTTP status ${statusCode} for ${redacted} (response body and query redacted)`,
          recordIndex,
        });
        return;
      }
      const mediaType = contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
      let pathOnly: string;
      try {
        pathOnly = dicomWebPathOnly(startUrl);
      } catch {
        context.onIssue?.({
          code: "DICOMWEB_INVALID_URL",
          severity: "error",
          message: "Refused DICOMweb retrieval: URL is unparseable (value redacted)",
          recordIndex,
        });
        return;
      }
      let host: string;
      try {
        host = new URL(startUrl).hostname;
      } catch {
        host = "";
      }
      const checksum = computeChecksum({ buffer: body });
      const byteLength = body.length;
      // Discard bytes here: nothing below retains `body` except its length/hash.
      const frameList = operation === "wado-frames" ? parseDicomWebFrameList(startUrl) : [];
      const pathUids = uidsFromDicomWebPath(startUrl);
      const id =
        pathUids.sopInstanceUID ?? pathUids.seriesInstanceUID ?? pathUids.studyInstanceUID ?? "dicomweb-binary-0";
      yield createCanonicalEnvelope({
        id,
        domain: "imaging",
        sourceFormat: DICOMWEB_FORMAT,
        formatVersion: DICOMWEB_FORMAT_VERSION,
        content: { kind: "binary-reference", uri: pathOnly, mediaType, sizeBytes: byteLength },
        importedAt: context.importedAt,
        adapterId: this.id,
        adapterVersion: this.version,
        recordIndex: 0,
        sourceLocation: operation === "wado-frames" ? "frames retrieval" : "instance retrieval",
        filename: input.filename,
        checksum,
        encoding: "dicom-binary",
        metadata: {
          operation,
          requestHost: host,
          byteLength,
          mediaType,
          pixelBytesInlined: false,
          ...(frameList.length > 0 ? { frameList, frameCount: frameList.length } : {}),
          ...pathUids,
        },
      });
      return;
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${DICOMWEB_ADAPTER_ID} ${DICOMWEB_ADAPTER_VERSION} (read-only DICOMweb QIDO-RS/WADO-RS GET client over Node built-ins; allowlist-gated, bounded paging)`,
    };
  }
}
