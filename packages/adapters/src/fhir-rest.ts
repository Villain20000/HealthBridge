/**
 * FHIR REST client adapter — read-only FHIR R4 search over Node built-ins.
 *
 * Status is honestly `metadata-only`: resources fetched from a FHIR REST
 * endpoint are carried structurally (Bundle entries via the same structural
 * path as the file adapter — `entry[].resource`, single resources by
 * `resourceType`), with checksum + provenance on every envelope. No clinical
 * interpretation is performed here, and no mapping to FHIR is claimed
 * (`transformToFHIR` is false) because no transform-via-mapping path has been
 * proven end to end for this adapter.
 *
 * Read-only by construction: only HTTP GET is ever issued (no POST, PUT,
 * PATCH or DELETE). `node:http` / `node:https` are used directly — no new
 * dependencies. `inspect()` performs no network requests at all; it only
 * describes the URL shape with query values redacted.
 *
 * Security / privacy contract (PLAN section 3, ROADMAP Phase E):
 * - SSRF allowlist: `allowedHosts` is REQUIRED and default-deny. A request
 *   whose host is not explicitly listed is refused before any socket opens.
 * - Only `http:` and `https:` are allowed; every other scheme is refused.
 * - Loopback / private hosts (`localhost`, `127/8`, `10/8`, `172.16/12`,
 *   `192.168/16`, `169.254/16`, `::1`, ULA/link-local IPv6, …) are refused
 *   UNLESS explicitly present in `allowedHosts`, in which case the fetch
 *   proceeds and a `FHIR_REST_PRIVATE_HOST_ALLOWED` warning is reported via
 *   `ParseContext.onIssue` (the logged warning).
 * - Redirects are never followed (refused with an explicit issue).
 * - Responses are bounded (`FHIR_REST_MAX_RESPONSE_BYTES`) and requests time
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

export const FHIR_REST_ADAPTER_ID = "fhir-rest-adapter";
export const FHIR_REST_ADAPTER_VERSION = "1.0.0";
export const FHIR_REST_FORMAT = "fhir-rest";
/** FHIR version label carried in envelopes and inspections (structural only). */
export const FHIR_REST_FHIR_VERSION = "4.0.1";

/** Default request timeout (ms) when `timeoutMs` is not configured. */
export const FHIR_REST_DEFAULT_TIMEOUT_MS = 8000;
/** Hard upper bound for `timeoutMs` (ms). */
export const FHIR_REST_MAX_TIMEOUT_MS = 120000;
/** Default paging bound: at most this many Bundle pages per parse. */
export const FHIR_REST_DEFAULT_MAX_PAGES = 5;
/** Hard upper bound for `maxPages` (paging is always bounded). */
export const FHIR_REST_MAX_PAGES = 50;
/** A single HTTP response body larger than this is refused (SSRF/size guard). */
export const FHIR_REST_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Upper bound for the number of `_elements` entries accepted from options. */
export const FHIR_REST_MAX_ELEMENTS = 100;

export interface FhirRestOptions {
  /**
   * REQUIRED explicit SSRF allowlist: hostnames or IP literals (lowercase
   * compare, e.g. `["fhir.hospital.example"]` or `["127.0.0.1"]` for a local
   * stub). Empty or missing means default-deny: every request is refused.
   * Listing a loopback/private host is the explicit opt-in that permits it,
   * and produces a `FHIR_REST_PRIVATE_HOST_ALLOWED` warning.
   */
  allowedHosts?: string[];
  /** Request timeout in ms (default 8000, clamped to 1..120000). */
  timeoutMs?: number;
  /** Paging bound: max Bundle pages followed via `link[relation=next]` (default 5, clamped to 1..50). */
  maxPages?: number;
  /** Element names applied as the FHIR `_elements` search parameter when the URL does not set one. */
  elements?: string[];
}

/** Redacted error raised by the fetch helpers; messages never carry query values or bodies. */
export class FhirRestError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FhirRestError";
    this.code = code;
  }
}

/** Common FHIR resource types recognised in REST URL paths (last-segment match). */
const FHIR_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Account",
  "ActivityDefinition",
  "AllergyIntolerance",
  "Appointment",
  "AuditEvent",
  "Basic",
  "Binary",
  "Bundle",
  "CapabilityStatement",
  "CarePlan",
  "CareTeam",
  "Claim",
  "Condition",
  "Consent",
  "Coverage",
  "Device",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "EpisodeOfCare",
  "FamilyMemberHistory",
  "Flag",
  "Goal",
  "Group",
  "HealthcareService",
  "ImagingStudy",
  "Immunization",
  "Library",
  "List",
  "Location",
  "Measure",
  "MeasureReport",
  "Medication",
  "MedicationAdministration",
  "MedicationDispense",
  "MedicationRequest",
  "MedicationStatement",
  "Observation",
  "Organization",
  "OrganizationAffiliation",
  "Patient",
  "PlanDefinition",
  "Practitioner",
  "PractitionerRole",
  "Procedure",
  "Provenance",
  "Questionnaire",
  "QuestionnaireResponse",
  "RelatedPerson",
  "RequestGroup",
  "RiskAssessment",
  "Schedule",
  "ServiceRequest",
  "Slot",
  "Specimen",
  "Task",
  "ValueSet",
]);

/**
 * Render a URL for logs/errors with every query value removed. The host and
 * path stay (operators need to know what was contacted); the query becomes
 * `?<query redacted>` and the fragment is dropped.
 */
export function redactUrlForLog(urlString: string): string {
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
export function normalizeAllowedHosts(raw: unknown): string[] {
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
export function isPrivateHostLiteral(hostname: string): boolean {
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
export async function isPrivateHost(hostname: string): Promise<boolean> {
  if (isPrivateHostLiteral(hostname)) return true;
  try {
    const addresses = await dnsLookup(hostname, { all: true });
    return addresses.some((entry) => isPrivateHostLiteral(entry.address));
  } catch {
    return false;
  }
}

export function clampTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return FHIR_REST_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), FHIR_REST_MAX_TIMEOUT_MS);
}

export function clampMaxPages(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return FHIR_REST_DEFAULT_MAX_PAGES;
  return Math.min(Math.floor(raw), FHIR_REST_MAX_PAGES);
}

export function normalizeElements(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
    if (out.length >= FHIR_REST_MAX_ELEMENTS) break;
  }
  return out;
}

/**
 * Enforce the SSRF policy for one request URL. Returns the parsed URL;
 * throws a redacted {@link FhirRestError} for unparseable URLs, non-http(s)
 * schemes, or hosts outside the explicit allowlist (default-deny).
 */
export function assertAllowedUrl(urlString: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new FhirRestError("FHIR_REST_INVALID_URL", "Refused FHIR request: URL is unparseable (value redacted)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FhirRestError(
      "FHIR_REST_SCHEME_BLOCKED",
      `Refused FHIR request to ${redactUrlForLog(urlString)}: only http and https are allowed (default-deny; query redacted)`,
    );
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new FhirRestError(
      "FHIR_REST_ALLOWLIST_REFUSED",
      `Refused FHIR request to ${redactUrlForLog(urlString)}: host is not in the explicit allowedHosts list (default-deny; query redacted)`,
    );
  }
  return url;
}

/** Append `_elements` from options when the URL does not already set one. */
function withElements(raw: string, elements: string[]): string {
  if (elements.length === 0) return raw;
  const url = new URL(raw); // throws for bad URLs; caller maps to FHIR_REST_INVALID_URL
  if (!url.searchParams.has("_elements")) url.searchParams.set("_elements", elements.join(","));
  return url.toString();
}

/** One bounded GET returning the status code and body text. All errors are redacted. */
function fetchJsonOnce(urlString: string, timeoutMs: number): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(urlString);
    } catch {
      reject(new FhirRestError("FHIR_REST_INVALID_URL", "Refused FHIR request: URL is unparseable (value redacted)"));
      return;
    }
    const redacted = redactUrlForLog(urlString);
    let req: http.ClientRequest;
    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > FHIR_REST_MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(
            new FhirRestError(
              "FHIR_REST_RESPONSE_TOO_LARGE",
              `Refused oversized response from ${redacted} (limit ${FHIR_REST_MAX_RESPONSE_BYTES} bytes; body and query redacted)`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") });
      });
      res.on("error", () => {
        reject(new FhirRestError("FHIR_REST_REQUEST_FAILED", `FHIR request failed for ${redacted} (query redacted)`));
      });
    };
    const options = {
      method: "GET",
      headers: { Accept: "application/fhir+json", "User-Agent": "HealthBridge-FHIR-REST/1.0" },
    };
    try {
      req =
        target.protocol === "https:"
          ? https.request(target, options, onResponse)
          : http.request(target, options, onResponse);
    } catch {
      reject(new FhirRestError("FHIR_REST_REQUEST_FAILED", `FHIR request failed for ${redacted} (query redacted)`));
      return;
    }
    req.on("error", (error: unknown) => {
      if (error instanceof FhirRestError) reject(error);
      else
        reject(new FhirRestError("FHIR_REST_REQUEST_FAILED", `FHIR request failed for ${redacted} (query redacted)`));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(
        new FhirRestError(
          "FHIR_REST_TIMEOUT",
          `FHIR request timed out after ${timeoutMs} ms for ${redacted} (query redacted)`,
        ),
      );
    });
    req.end();
  });
}

function toIssue(error: unknown): ValidationIssue {
  if (error instanceof FhirRestError) {
    return { code: error.code, severity: "error", message: error.message };
  }
  return {
    code: "FHIR_REST_REQUEST_FAILED",
    severity: "error",
    message: "FHIR request failed unexpectedly (details redacted to protect query values)",
  };
}

export interface ExtractedFhirResources {
  resources: Array<Record<string, unknown>>;
  issues: ValidationIssue[];
  nextLink?: string;
}

/**
 * Structural Bundle/resource split — the same path as the file adapter
 * (`FhirJsonFormatAdapter`): Bundle `entry[].resource` entries, entries
 * without a resource reported as `BUNDLE_ENTRY_WITHOUT_RESOURCE`, a single
 * resource accepted by `resourceType`, anything else reported (never thrown).
 */
export function extractFhirResources(payload: unknown): ExtractedFhirResources {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      resources: [],
      issues: [
        {
          code: "FHIR_REST_UNEXPECTED_PAYLOAD",
          severity: "error",
          message: "FHIR response is not a JSON object (Bundle or resource expected); nothing was parsed",
        },
      ],
    };
  }
  const record = payload as Record<string, unknown>;
  if (record.resourceType === "Bundle") {
    const resources: Array<Record<string, unknown>> = [];
    const issues: ValidationIssue[] = [];
    const entries = Array.isArray(record.entry) ? record.entry : [];
    for (const entry of entries) {
      const resource = (entry as Record<string, unknown> | null | undefined)?.resource;
      if (resource !== null && typeof resource === "object" && !Array.isArray(resource)) {
        resources.push(resource as Record<string, unknown>);
      } else {
        issues.push({
          code: "BUNDLE_ENTRY_WITHOUT_RESOURCE",
          severity: "warning",
          message: "A Bundle entry has no `resource` and was skipped",
        });
      }
    }
    let nextLink: string | undefined;
    if (Array.isArray(record.link)) {
      for (const link of record.link) {
        const candidate = link as Record<string, unknown> | null | undefined;
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          candidate.relation === "next" &&
          typeof candidate.url === "string" &&
          candidate.url !== ""
        ) {
          nextLink = candidate.url;
          break;
        }
      }
    }
    return { resources, issues, nextLink };
  }
  if (typeof record.resourceType === "string") return { resources: [record], issues: [] };
  return {
    resources: [],
    issues: [
      {
        code: "FHIR_REST_UNEXPECTED_PAYLOAD",
        severity: "error",
        message: "FHIR response has no `resourceType`; nothing was parsed",
      },
    ],
  };
}

/**
 * Retrieve a server capability statement (`GET [base]/metadata`) with the
 * same SSRF/timeout/redaction policy as the adapter. Returns the parsed
 * CapabilityStatement plus any (redacted) warnings, e.g. the private-host
 * notice when a loopback/private base URL was explicitly allowlisted.
 */
export async function fetchCapabilityStatement(
  baseUrl: string,
  options: FhirRestOptions,
): Promise<{ statement: Record<string, unknown>; warnings: string[] }> {
  const warnings: string[] = [];
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  let root: URL;
  try {
    root = new URL(baseUrl);
  } catch {
    throw new FhirRestError(
      "FHIR_REST_INVALID_URL",
      "Refused capability-statement request: base URL is unparseable (value redacted)",
    );
  }
  const withSlash = root.toString().endsWith("/") ? root.toString() : `${root.toString()}/`;
  const target = assertAllowedUrl(new URL("metadata", withSlash).toString(), allowedHosts);
  if (await isPrivateHost(target.hostname)) {
    warnings.push(
      `Private/loopback FHIR host explicitly allowlisted (${target.hostname}); proceeding because it is in allowedHosts`,
    );
  }
  const { statusCode, text } = await fetchJsonOnce(target.toString(), timeoutMs);
  const redacted = redactUrlForLog(target.toString());
  if (statusCode >= 300 && statusCode < 400) {
    throw new FhirRestError(
      "FHIR_REST_REDIRECT_REFUSED",
      `Capability-statement request to ${redacted} returned HTTP status ${statusCode}; redirects are never followed (body redacted)`,
    );
  }
  if (statusCode !== 200) {
    throw new FhirRestError(
      "FHIR_REST_HTTP_ERROR",
      `Capability-statement request failed with HTTP status ${statusCode} for ${redacted} (response body redacted)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FhirRestError(
      "FHIR_REST_INVALID_JSON",
      `Capability-statement response is not valid JSON for ${redacted} (body redacted)`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).resourceType !== "CapabilityStatement"
  ) {
    throw new FhirRestError(
      "FHIR_REST_UNEXPECTED_PAYLOAD",
      `Capability-statement response is not a CapabilityStatement resource for ${redacted} (body redacted)`,
    );
  }
  return { statement: parsed as Record<string, unknown>, warnings };
}

function firstResourceTypeSegment(pathname: string): string {
  for (const segment of pathname.split("/")) {
    if (segment !== "" && FHIR_RESOURCE_TYPES.has(segment)) return segment;
  }
  return "unknown";
}

export class FhirRestFormatAdapter implements MedicalFormatAdapter {
  public id = FHIR_REST_ADAPTER_ID;
  public version = FHIR_REST_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: FHIR_REST_FORMAT,
      version: FHIR_REST_ADAPTER_VERSION,
      description:
        "Read-only FHIR R4 REST client over Node built-ins: resource search with _elements, bounded next-link paging and capability-statement retrieval behind an explicit SSRF allowlist",
      extensions: [],
      mimeTypes: ["application/fhir+json"],
      status: "metadata-only",
      limitations: [
        "Read-only: only HTTP GET is ever issued (no POST, PUT, PATCH or DELETE).",
        "URL-driven: the request URL comes from InputDescriptor.uri; file payloads are never claimed.",
        "SSRF allowlist is required (allowedHosts) and default-deny; only http/https; redirects are never followed.",
        "Loopback/private hosts are refused unless explicitly listed in allowedHosts (with a logged warning).",
        "Paging always bounded (default 5 pages, hard cap 50); responses bounded (8 MiB); requests time out (default 8 s).",
        "Structural only: Bundle entry resources are carried verbatim with no clinical interpretation.",
        "Query values are redacted in every message; response bodies never appear in errors.",
        "FHIR R4 JSON only; NDJSON search responses and FHIR R5/STU3 payloads are not declared supported.",
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
   * `mimeType`) are NEVER consulted, so a `.fhir.json` file is never claimed.
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
    const path = url.pathname ?? "";
    if (/\/metadata\/?$/i.test(path)) return 0.85;
    if (/(^|\/)(fhir|baseR4|baseR5|baseDstu3|baseStu3)(\/|$)/i.test(path)) return 0.85;
    if (path.split("/").some((segment) => segment !== "" && FHIR_RESOURCE_TYPES.has(segment))) return 0.8;
    if (/\/(r4|r5|stu3|dstu2)(\/|$)/i.test(path)) return 0.8;
    return 0;
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  /**
   * Network-free: describes the request URL shape (resource type, host,
   * query keys) with every query value redacted. Never opens a socket, so no
   * allowlist is needed here.
   */
  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const capabilities = this.getManifest().capabilities;
    const status = this.getManifest().status;
    const raw = input.uri;
    if (typeof raw !== "string" || raw.trim() === "") {
      return {
        format: FHIR_REST_FORMAT,
        formatVersion: FHIR_REST_FHIR_VERSION,
        domain: "unknown",
        recordCount: 0,
        capabilities,
        status,
        warnings: ["No FHIR REST request URL set (expected InputDescriptor.uri); nothing was fetched"],
      };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {
        format: FHIR_REST_FORMAT,
        formatVersion: FHIR_REST_FHIR_VERSION,
        domain: "unknown",
        recordCount: 0,
        capabilities,
        status,
        warnings: ["FHIR REST request URL is unparseable (value redacted); nothing was fetched"],
      };
    }
    const resourceType = firstResourceTypeSegment(url.pathname);
    const queryKeys = [...new Set([...url.searchParams.keys()])];
    return {
      format: FHIR_REST_FORMAT,
      formatVersion: FHIR_REST_FHIR_VERSION,
      domain: "clinical",
      detectedSchema: {
        fields: [
          { name: "resourceType", type: "string", sampleValues: [resourceType], nullable: false },
          { name: "requestHost", type: "string", sampleValues: [url.hostname], nullable: false },
          { name: "queryKeys", type: "string", sampleValues: queryKeys.slice(0, 5), nullable: queryKeys.length === 0 },
        ],
      },
      sampleRecords: [],
      capabilities,
      status,
      warnings: [
        `GET ${redactUrlForLog(raw)} (query values redacted)`,
        `resourceType: ${resourceType}`,
        queryKeys.length > 0 ? `query keys: ${queryKeys.join(", ")} (values redacted)` : "no query parameters",
        url.searchParams.has("_elements") ? "_elements filter present in URL" : "no _elements filter in URL",
        "inspect() performs no network requests; parse() fetches with an explicit allowedHosts list, bounded paging and timeouts",
      ],
    };
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const options = (context.options ?? {}) as Partial<FhirRestOptions> & Record<string, unknown>;
    const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
    const timeoutMs = clampTimeoutMs(options.timeoutMs);
    const maxPages = clampMaxPages(options.maxPages);
    const elements = normalizeElements(options.elements ?? options._elements);

    if (typeof input.uri !== "string" || input.uri.trim() === "") {
      context.onIssue?.({
        code: "FHIR_REST_MISSING_URL",
        severity: "error",
        message: "No FHIR REST request URL set (expected InputDescriptor.uri); nothing was fetched",
      });
      return;
    }

    let current: string;
    try {
      current = withElements(input.uri, elements);
    } catch {
      context.onIssue?.({
        code: "FHIR_REST_INVALID_URL",
        severity: "error",
        message: "Refused FHIR request: URL is unparseable (value redacted)",
      });
      return;
    }

    let startUrl: URL;
    try {
      startUrl = assertAllowedUrl(current, allowedHosts);
    } catch (error) {
      context.onIssue?.(toIssue(error));
      return;
    }
    // The fetcher below throws only FhirRestError (redacted by construction).
    void startUrl;

    let privateWarned = false;
    const limit = context.maxRecords ?? Number.MAX_SAFE_INTEGER;
    let recordIndex = 0;
    let page = 0;
    let next: string | undefined = current;

    while (next !== undefined && page < maxPages) {
      let pageUrl: URL;
      try {
        pageUrl = assertAllowedUrl(next, allowedHosts);
      } catch (error) {
        context.onIssue?.({ ...toIssue(error), recordIndex });
        return;
      }
      if (!privateWarned) {
        privateWarned = true;
        if (await isPrivateHost(pageUrl.hostname)) {
          context.onIssue?.({
            code: "FHIR_REST_PRIVATE_HOST_ALLOWED",
            severity: "warning",
            message: `Private/loopback FHIR host explicitly allowlisted; proceeding because it is in allowedHosts (${redactUrlForLog(next)}; query redacted)`,
          });
        }
      }

      const redactedPage = redactUrlForLog(next);
      let statusCode: number;
      let body: string;
      try {
        ({ statusCode, text: body } = await fetchJsonOnce(pageUrl.toString(), timeoutMs));
      } catch (error) {
        context.onIssue?.({ ...toIssue(error), recordIndex });
        return;
      }

      if (statusCode >= 300 && statusCode < 400) {
        context.onIssue?.({
          code: "FHIR_REST_REDIRECT_REFUSED",
          severity: "error",
          message: `FHIR search to ${redactedPage} returned HTTP status ${statusCode}; redirects are never followed (body and query redacted)`,
          recordIndex,
        });
        return;
      }
      if (statusCode !== 200) {
        context.onIssue?.({
          code: "FHIR_REST_HTTP_ERROR",
          severity: "error",
          message: `FHIR search failed with HTTP status ${statusCode} for ${redactedPage} (response body and query redacted)`,
          recordIndex,
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        context.onIssue?.({
          code: "FHIR_REST_INVALID_JSON",
          severity: "error",
          message: `FHIR search response is not valid JSON for ${redactedPage} (body and query redacted)`,
          recordIndex,
        });
        return;
      }

      const { resources, issues, nextLink } = extractFhirResources(payload);
      for (const issue of issues) context.onIssue?.({ ...issue, recordIndex });
      const checksum = computeChecksum({ contentString: body });

      for (let index = 0; index < resources.length && recordIndex < limit; index++) {
        const resource = resources[index] as Record<string, unknown>;
        const resourceType = typeof resource.resourceType === "string" ? resource.resourceType : "unknown";
        yield createCanonicalEnvelope({
          id: typeof resource.id === "string" && resource.id !== "" ? resource.id : `fhir-rest-p${page}-e${index}`,
          domain: "clinical",
          sourceFormat: FHIR_REST_FORMAT,
          formatVersion: FHIR_REST_FHIR_VERSION,
          content: { kind: "structured", data: resource },
          importedAt: context.importedAt,
          adapterId: this.id,
          adapterVersion: this.version,
          recordIndex,
          sourceLocation: `page ${page + 1} entry ${index + 1}`,
          filename: input.filename,
          checksum,
          encoding: "utf-8",
          metadata: {
            resourceType,
            page: page + 1,
            requestHost: pageUrl.hostname,
            ...(elements.length > 0 ? { elements } : {}),
          },
        });
        recordIndex++;
      }
      if (recordIndex >= limit) return;

      page++;
      if (nextLink !== undefined) {
        if (page >= maxPages) {
          context.onIssue?.({
            code: "FHIR_REST_PAGE_LIMIT",
            severity: "warning",
            message: `Stopped after ${maxPages} page(s) with a next link still present (bounded paging; raise maxPages explicitly to fetch more)`,
            recordIndex,
          });
          next = undefined;
        } else {
          try {
            next = new URL(nextLink, pageUrl.toString()).toString();
          } catch {
            context.onIssue?.({
              code: "FHIR_REST_INVALID_URL",
              severity: "error",
              message: "Refused FHIR next-page link: URL is unparseable (value redacted)",
              recordIndex,
            });
            return;
          }
        }
      } else {
        next = undefined;
      }
    }
  }

  public async health(): Promise<{ ok: boolean; details: string }> {
    return {
      ok: true,
      details: `${FHIR_REST_ADAPTER_ID} ${FHIR_REST_ADAPTER_VERSION} (read-only FHIR R4 GET client over Node built-ins; allowlist-gated, bounded paging)`,
    };
  }
}
