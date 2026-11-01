/**
 * External FHIR validator client adapter — `$validate` over Node built-ins.
 *
 * Status is honestly `metadata-only`: this adapter carries FHIR resources
 * structurally (verbatim, with checksum + provenance on every envelope) and
 * reports what an EXTERNAL validator says about them. No clinical
 * interpretation happens here, and no mapping to FHIR is claimed
 * (`transformToFHIR` is false).
 *
 * Documented validate protocol: the configured endpoint is the FHIR
 * `$validate` operation URL (if it does not already end in `/$validate`,
 * that suffix is appended). The resource is POSTed as `application/fhir+json`
 * and the response MUST be a FHIR `OperationOutcome`; its issues are mapped to
 * {@link ValidationIssue} entries (`EXTERNAL_<code>`, diagnostics preserved,
 * first `expression` kept as `path`).
 *
 * Never auto-selected: `score()` is always 0, so the registry never routes a
 * payload here on its own — invoke this adapter explicitly. When no endpoint
 * is configured (neither the `endpoint` option nor
 * `HEALTHBRIDGE_FHIR_VALIDATOR_URL`), every validation reports
 * `skipped-with-reason` and `parse()` yields no envelopes: an unvalidated
 * resource is never reported as valid (no false pass).
 *
 * Security / privacy contract (mirrors `fhir-rest.ts`, PLAN section 3):
 * - SSRF allowlist: `allowedHosts` is REQUIRED and default-deny. A request
 *   whose host is not explicitly listed is refused before any socket opens.
 * - Only `http:` and `https:` are allowed; every other scheme is refused.
 * - Loopback / private hosts are refused UNLESS explicitly allowlisted, in
 *   which case the fetch proceeds and a
 *   `FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED` warning is reported via
 *   `ParseContext.onIssue`.
 * - Redirects are never followed (refused with an explicit issue).
 * - Responses are bounded (`FHIR_VALIDATOR_MAX_RESPONSE_BYTES`) and requests
 *   time out (`timeoutMs`, default 8 s).
 * - NO PHI in logs/errors: every message carries the redacted URL only
 *   (query values replaced with `<query redacted>`), response bodies are
 *   never embedded in errors, and `offendingValue` is never set from request
 *   or response content. `diagnostics` strings produced by the external
 *   validator ARE preserved on mapped issues — they describe the resource the
 *   operator chose to validate.
 */

import http from "node:http";
import https from "node:https";
import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { MedicalFormatAdapter, computeChecksum, createCanonicalEnvelope } from "@healthbridge/core";
import { isPrivateHost, normalizeAllowedHosts, redactUrlForLog } from "./fhir-rest.js";

export const FHIR_VALIDATOR_ADAPTER_ID = "fhir-validator-adapter";
export const FHIR_VALIDATOR_ADAPTER_VERSION = "1.0.0";
export const FHIR_VALIDATOR_FORMAT = "fhir-validator";
/** FHIR version label carried in envelopes and inspections (structural only). */
export const FHIR_VALIDATOR_FHIR_VERSION = "4.0.1";

/** Default request timeout (ms) when `timeoutMs` is not configured. */
export const FHIR_VALIDATOR_DEFAULT_TIMEOUT_MS = 8000;
/** Hard upper bound for `timeoutMs` (ms). */
export const FHIR_VALIDATOR_MAX_TIMEOUT_MS = 120000;
/** A single HTTP response body larger than this is refused (SSRF/size guard). */
export const FHIR_VALIDATOR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Env fallback for the validator endpoint; explicit options always win. */
export const FHIR_VALIDATOR_ENV_URL = "HEALTHBRIDGE_FHIR_VALIDATOR_URL";

export interface FhirValidatorOptions {
  /**
   * The external `$validate` operation URL (e.g.
   * `https://validator.example.org/fhir/$validate`). When it does not already
   * end in `/$validate`, that suffix is appended. Falls back to
   * `HEALTHBRIDGE_FHIR_VALIDATOR_URL`; absent both, validations report
   * skipped-with-reason and never a pass.
   */
  endpoint?: string;
  /**
   * REQUIRED explicit SSRF allowlist: hostnames or IP literals (lowercase
   * compare, e.g. `["validator.internal.example"]`). Empty or missing means
   * default-deny: every request is refused before any socket opens.
   */
  allowedHosts?: string[];
  /** Request timeout in ms (default 8000, clamped to 1..120000). */
  timeoutMs?: number;
}

/** Redacted error raised by the validate helpers; messages never carry query values or bodies. */
export class FhirValidatorError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FhirValidatorError";
    this.code = code;
  }
}

/** Verdict of one external validation. `isValid` is meaningful only when `status` is `validated`. */
export interface ExternalValidationResult {
  status: "validated" | "skipped";
  /**
   * True only when the external validator returned an `OperationOutcome`
   * without fatal/error issues. ALWAYS false when `status` is `skipped` —
   * check `status` first; a skip is never a pass.
   */
  isValid: boolean;
  issues: ValidationIssue[];
  /** Present only when `status` is `skipped`: why nothing was validated. */
  reason?: string;
  /** Redacted `$validate` URL that answered, present only when `validated`. */
  endpoint?: string;
}

/**
 * Resolve the validator endpoint: explicit `options.endpoint` wins, then the
 * `HEALTHBRIDGE_FHIR_VALIDATOR_URL` environment variable. Returns undefined
 * when neither is set (the skipped-with-reason state).
 */
export function resolveFhirValidatorEndpoint(options?: FhirValidatorOptions): string | undefined {
  const fromOptions = typeof options?.endpoint === "string" ? options.endpoint.trim() : "";
  if (fromOptions !== "") return fromOptions;
  const fromEnv = (process.env[FHIR_VALIDATOR_ENV_URL] ?? "").trim();
  return fromEnv !== "" ? fromEnv : undefined;
}

/**
 * Resolve the `$validate` operation URL: an endpoint already ending in
 * `/$validate` is used verbatim, otherwise the suffix is appended.
 */
export function resolveValidateUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/$validate") ? trimmed : `${trimmed}/$validate`;
}

export function clampFhirValidatorTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return FHIR_VALIDATOR_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), FHIR_VALIDATOR_MAX_TIMEOUT_MS);
}

/**
 * Enforce the SSRF policy for one validate URL. Returns the parsed URL;
 * throws a redacted {@link FhirValidatorError} for unparseable URLs,
 * non-http(s) schemes, or hosts outside the explicit allowlist
 * (default-deny).
 */
export function assertFhirValidatorAllowedUrl(urlString: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_INVALID_URL",
      "Refused validator request: URL is unparseable (value redacted)",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_SCHEME_BLOCKED",
      `Refused validator request to ${redactUrlForLog(urlString)}: only http and https are allowed (default-deny; query redacted)`,
    );
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_ALLOWLIST_REFUSED",
      `Refused validator request to ${redactUrlForLog(urlString)}: host is not in the explicit allowedHosts list (default-deny; query redacted)`,
    );
  }
  return url;
}

function toIssue(error: unknown): ValidationIssue {
  if (error instanceof FhirValidatorError) {
    return { code: error.code, severity: "error", message: error.message };
  }
  return {
    code: "FHIR_VALIDATOR_REQUEST_FAILED",
    severity: "error",
    message: "Validator request failed unexpectedly (details redacted to protect query values)",
  };
}

/** One bounded POST returning the status code and body text. All errors are redacted. */
function postToFhirValidator(
  urlString: string,
  body: string,
  timeoutMs: number,
): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(urlString);
    } catch {
      reject(
        new FhirValidatorError(
          "FHIR_VALIDATOR_INVALID_URL",
          "Refused validator request: URL is unparseable (value redacted)",
        ),
      );
      return;
    }
    const redacted = redactUrlForLog(urlString);
    const payload = Buffer.from(body, "utf-8");
    let req: http.ClientRequest;
    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > FHIR_VALIDATOR_MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(
            new FhirValidatorError(
              "FHIR_VALIDATOR_RESPONSE_TOO_LARGE",
              `Refused oversized validator response from ${redacted} (limit ${FHIR_VALIDATOR_MAX_RESPONSE_BYTES} bytes; body and query redacted)`,
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
        reject(
          new FhirValidatorError(
            "FHIR_VALIDATOR_REQUEST_FAILED",
            `Validator request failed for ${redacted} (query redacted)`,
          ),
        );
      });
    };
    const requestOptions = {
      method: "POST",
      headers: {
        Accept: "application/fhir+json",
        "Content-Type": "application/fhir+json",
        "Content-Length": payload.length,
        "User-Agent": "HealthBridge-FHIR-Validator/1.0",
      },
    };
    try {
      req =
        target.protocol === "https:"
          ? https.request(target, requestOptions, onResponse)
          : http.request(target, requestOptions, onResponse);
    } catch {
      reject(
        new FhirValidatorError(
          "FHIR_VALIDATOR_REQUEST_FAILED",
          `Validator request failed for ${redacted} (query redacted)`,
        ),
      );
      return;
    }
    req.on("error", (error: unknown) => {
      if (error instanceof FhirValidatorError) reject(error);
      else
        reject(
          new FhirValidatorError(
            "FHIR_VALIDATOR_REQUEST_FAILED",
            `Validator request failed for ${redacted} (query redacted)`,
          ),
        );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(
        new FhirValidatorError(
          "FHIR_VALIDATOR_TIMEOUT",
          `Validator request timed out after ${timeoutMs} ms for ${redacted} (query redacted)`,
        ),
      );
    });
    req.on("timeout", () => {
      // `setTimeout` handler above performs the destroy + reject; this keeps
      // the socket from lingering if the runtime emits `timeout` first.
      req.destroy();
    });
    req.end(payload);
  });
}

const OUTCOME_SEVERITIES: ReadonlySet<string> = new Set(["fatal", "error", "warning", "information"]);

/**
 * Map an external validator `OperationOutcome` to validation issues.
 * Throws {@link FhirValidatorError} (`FHIR_VALIDATOR_UNEXPECTED_PAYLOAD`)
 * when the payload is not an `OperationOutcome` object.
 */
export function parseFhirValidatorOutcome(payload: unknown): { isValid: boolean; issues: ValidationIssue[] } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
      "Validator response is not a JSON object (an OperationOutcome was expected); nothing was validated",
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.resourceType !== "OperationOutcome") {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
      'Validator response has no `resourceType: "OperationOutcome"`; nothing was validated',
    );
  }
  if (record.issue === undefined) return { isValid: true, issues: [] };
  if (!Array.isArray(record.issue)) {
    throw new FhirValidatorError(
      "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
      "Validator OperationOutcome has a non-array `issue` member; nothing was validated",
    );
  }
  const issues: ValidationIssue[] = [];
  for (const entry of record.issue) {
    const candidate = (entry ?? {}) as Record<string, unknown>;
    const rawSeverity = typeof candidate.severity === "string" ? candidate.severity : "warning";
    const severity = (OUTCOME_SEVERITIES.has(rawSeverity) ? rawSeverity : "warning") as ValidationIssue["severity"];
    const rawCode = typeof candidate.code === "string" && candidate.code.trim() !== "" ? candidate.code : "unknown";
    const code = `EXTERNAL_${
      rawCode
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "UNKNOWN"
    }`;
    let message = "External validator reported an issue with no diagnostics";
    if (typeof candidate.diagnostics === "string" && candidate.diagnostics.trim() !== "") {
      message = candidate.diagnostics;
    } else if (
      candidate.details !== null &&
      typeof candidate.details === "object" &&
      typeof (candidate.details as Record<string, unknown>).text === "string" &&
      ((candidate.details as Record<string, unknown>).text as string).trim() !== ""
    ) {
      message = (candidate.details as Record<string, unknown>).text as string;
    }
    const expression = Array.isArray(candidate.expression)
      ? candidate.expression.find((part): part is string => typeof part === "string")
      : undefined;
    issues.push({
      code,
      severity,
      message,
      ...(expression !== undefined ? { path: expression } : {}),
      ruleId: "external-fhir-validator",
    });
  }
  return { isValid: !issues.some((issue) => issue.severity === "fatal" || issue.severity === "error"), issues };
}

/** Reason reported whenever no validator endpoint is configured. */
export function fhirValidatorSkippedReason(): string {
  return (
    `No external FHIR validator configured (set ${FHIR_VALIDATOR_ENV_URL} or the \`endpoint\` option); ` +
    "validation skipped with reason — this is not a pass"
  );
}

/**
 * Validate one FHIR resource against the external `$validate` service.
 * Unconfigured (no endpoint via options or env) resolves — never rejects —
 * to `{ status: "skipped", isValid: false }` with an explicit reason.
 */
export async function validateResourceWithExternalValidator(
  resource: Record<string, unknown>,
  options?: FhirValidatorOptions,
): Promise<ExternalValidationResult> {
  const endpoint = resolveFhirValidatorEndpoint(options);
  if (!endpoint) {
    const reason = fhirValidatorSkippedReason();
    return {
      status: "skipped",
      isValid: false,
      issues: [{ code: "FHIR_VALIDATOR_SKIPPED", severity: "warning", message: reason }],
      reason,
    };
  }
  const allowedHosts = normalizeAllowedHosts(options?.allowedHosts);
  const timeoutMs = clampFhirValidatorTimeoutMs(options?.timeoutMs);
  const validateUrl = resolveValidateUrl(endpoint);
  let target: URL;
  try {
    target = assertFhirValidatorAllowedUrl(validateUrl, allowedHosts);
  } catch (error) {
    return { status: "validated", isValid: false, issues: [toIssue(error)] };
  }
  // Defence in depth only: the allowlist already permitted this host, so the
  // call proceeds — the notice travels with the result instead.
  const privateHost = await isPrivateHost(target.hostname);
  const redacted = redactUrlForLog(target.toString());
  let statusCode: number;
  let text: string;
  try {
    ({ statusCode, text } = await postToFhirValidator(target.toString(), JSON.stringify(resource), timeoutMs));
  } catch (error) {
    return { status: "validated", isValid: false, endpoint: redacted, issues: [toIssue(error)] };
  }
  return finishValidation(statusCode, text, redacted, privateHost);
}

function finishValidation(
  statusCode: number,
  text: string,
  redacted: string,
  privateHost: boolean,
): ExternalValidationResult {
  const privateNotice: ValidationIssue[] = privateHost
    ? [
        {
          code: "FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED",
          severity: "warning",
          message: `Private/loopback validator host explicitly allowlisted; proceeding because it is in allowedHosts (${redacted}; query redacted)`,
        },
      ]
    : [];
  if (statusCode >= 300 && statusCode < 400) {
    return {
      status: "validated",
      isValid: false,
      endpoint: redacted,
      issues: [
        ...privateNotice,
        {
          code: "FHIR_VALIDATOR_REDIRECT_REFUSED",
          severity: "error",
          message: `Validator request to ${redacted} returned HTTP status ${statusCode}; redirects are never followed (body redacted)`,
        },
      ],
    };
  }
  if (statusCode !== 200) {
    return {
      status: "validated",
      isValid: false,
      endpoint: redacted,
      issues: [
        ...privateNotice,
        {
          code: "FHIR_VALIDATOR_HTTP_ERROR",
          severity: "error",
          message: `Validator request failed with HTTP status ${statusCode} for ${redacted} (response body and query redacted)`,
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: "validated",
      isValid: false,
      endpoint: redacted,
      issues: [
        ...privateNotice,
        {
          code: "FHIR_VALIDATOR_INVALID_JSON",
          severity: "error",
          message: `Validator response is not valid JSON for ${redacted} (body redacted)`,
        },
      ],
    };
  }
  try {
    const outcome = parseFhirValidatorOutcome(parsed);
    return {
      status: "validated",
      isValid: outcome.isValid,
      endpoint: redacted,
      issues: [...privateNotice, ...outcome.issues],
    };
  } catch (error) {
    return { status: "validated", isValid: false, endpoint: redacted, issues: [...privateNotice, toIssue(error)] };
  }
}

function readResourceInput(input: InputDescriptor): { resource?: Record<string, unknown>; issue?: ValidationIssue } {
  let text: string | undefined;
  if (typeof input.contentString === "string") {
    text = input.contentString;
  } else if (input.buffer) {
    text = input.buffer.toString("utf-8");
  }
  if (text === undefined || text.trim() === "") {
    return {
      issue: {
        code: "FHIR_VALIDATOR_MISSING_RESOURCE",
        severity: "error",
        message:
          "No FHIR resource to validate (expected InputDescriptor.contentString or buffer with a FHIR JSON resource); nothing was sent",
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      issue: {
        code: "FHIR_VALIDATOR_INVALID_JSON",
        severity: "error",
        message: `Input is not valid JSON: ${(error as Error).message}; nothing was sent`,
      },
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      issue: {
        code: "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
        severity: "error",
        message: "Input is not a FHIR resource object; nothing was sent",
      },
    };
  }
  if (typeof (parsed as Record<string, unknown>).resourceType !== "string") {
    return {
      issue: {
        code: "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
        severity: "error",
        message: "Input has no string `resourceType`; nothing was sent",
      },
    };
  }
  return { resource: parsed as Record<string, unknown> };
}

export class FhirValidatorFormatAdapter implements MedicalFormatAdapter {
  public id = FHIR_VALIDATOR_ADAPTER_ID;
  public version = FHIR_VALIDATOR_ADAPTER_VERSION;

  public getManifest(): CapabilityManifest {
    return {
      format: FHIR_VALIDATOR_FORMAT,
      version: FHIR_VALIDATOR_ADAPTER_VERSION,
      description:
        "External FHIR R4 `$validate` client over Node built-ins: POSTs a resource to a configured validator and maps the OperationOutcome to validation issues",
      extensions: [],
      mimeTypes: ["application/fhir+json"],
      status: "metadata-only",
      limitations: [
        "Never auto-selected: score() is always 0; invoke this adapter explicitly with a configured endpoint.",
        "External service only: nothing is validated locally; without an endpoint every validation reports skipped-with-reason (never a pass).",
        "SSRF allowlist is required (allowedHosts) and default-deny; only http/https; redirects are never followed.",
        "Loopback/private hosts are refused unless explicitly listed in allowedHosts (with a logged warning).",
        "Requests time out (default 8 s); responses are bounded (8 MiB).",
        "Query values are redacted in every message; validator response bodies never appear in errors.",
        "Structural only: the resource is carried verbatim with no clinical interpretation.",
        "FHIR R4 JSON only; the validator's verdict is reported, not re-interpreted.",
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
   * Always 0: an external validator needs an explicit endpoint, so this
   * adapter never claims a payload on its own. Never throws.
   */
  public async score(_input: InputDescriptor): Promise<number> {
    return 0;
  }

  public async detect(_input: InputDescriptor): Promise<boolean> {
    return false;
  }

  /**
   * Network-free: describes the configured endpoint (redacted) or the
   * unconfigured skip state. Never opens a socket, so no allowlist is needed
   * here.
   */
  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const capabilities = this.getManifest().capabilities;
    const status = this.getManifest().status;
    const endpoint = resolveFhirValidatorEndpoint((input as unknown as { options?: FhirValidatorOptions }).options);
    const { resource } = readResourceInput(input);
    const resourceType = resource && typeof resource.resourceType === "string" ? resource.resourceType : "unknown";
    const warnings = [
      endpoint
        ? `POST ${redactUrlForLog(resolveValidateUrl(endpoint))} (query values redacted)`
        : fhirValidatorSkippedReason(),
      `resourceType: ${resourceType}`,
      "inspect() performs no network requests; parse() POSTs to the configured endpoint with an explicit allowedHosts list and timeouts",
    ];
    return {
      format: FHIR_VALIDATOR_FORMAT,
      formatVersion: FHIR_VALIDATOR_FHIR_VERSION,
      domain: "clinical",
      recordCount: resource ? 1 : 0,
      detectedSchema:
        resource !== undefined
          ? {
              fields: [
                { name: "resourceType", type: "string", sampleValues: [resourceType], nullable: false },
                {
                  name: "resourceId",
                  type: "string",
                  sampleValues: [typeof resource.id === "string" ? resource.id : ""],
                  nullable: typeof resource.id !== "string",
                },
              ],
            }
          : undefined,
      sampleRecords: [],
      capabilities,
      status,
      warnings,
    };
  }

  /**
   * Validate the input resource against the external `$validate` service and
   * yield it as one structural envelope annotated with the verdict. When no
   * endpoint is configured (or the request is refused/fails), yields no
   * envelopes and reports the outcome via `onIssue` — a skip is never
   * presented as a pass.
   */
  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    const options = (context.options ?? {}) as Partial<FhirValidatorOptions> & Record<string, unknown>;
    const endpoint = resolveFhirValidatorEndpoint(options);

    const { resource, issue } = readResourceInput(input);
    if (!resource) {
      context.onIssue?.(issue as ValidationIssue);
      return;
    }

    if (!endpoint) {
      const reason = fhirValidatorSkippedReason();
      context.onIssue?.({ code: "FHIR_VALIDATOR_SKIPPED", severity: "warning", message: reason });
      return;
    }

    const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
    const timeoutMs = clampFhirValidatorTimeoutMs(options.timeoutMs);
    const validateUrl = resolveValidateUrl(endpoint);

    let target: URL;
    try {
      target = assertFhirValidatorAllowedUrl(validateUrl, allowedHosts);
    } catch (error) {
      context.onIssue?.({ ...toIssue(error), recordIndex: 0 });
      return;
    }
    if (await isPrivateHost(target.hostname)) {
      context.onIssue?.({
        code: "FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED",
        severity: "warning",
        message: `Private/loopback validator host explicitly allowlisted; proceeding because it is in allowedHosts (${redactUrlForLog(target.toString())}; query redacted)`,
        recordIndex: 0,
      });
    }

    const redacted = redactUrlForLog(target.toString());
    let statusCode: number;
    let body: string;
    try {
      ({ statusCode, text: body } = await postToFhirValidator(target.toString(), JSON.stringify(resource), timeoutMs));
    } catch (error) {
      context.onIssue?.({ ...toIssue(error), recordIndex: 0 });
      return;
    }
    if (statusCode >= 300 && statusCode < 400) {
      context.onIssue?.({
        code: "FHIR_VALIDATOR_REDIRECT_REFUSED",
        severity: "error",
        message: `Validator request to ${redacted} returned HTTP status ${statusCode}; redirects are never followed (body and query redacted)`,
        recordIndex: 0,
      });
      return;
    }
    if (statusCode !== 200) {
      context.onIssue?.({
        code: "FHIR_VALIDATOR_HTTP_ERROR",
        severity: "error",
        message: `Validator request failed with HTTP status ${statusCode} for ${redacted} (response body and query redacted)`,
        recordIndex: 0,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      context.onIssue?.({
        code: "FHIR_VALIDATOR_INVALID_JSON",
        severity: "error",
        message: `Validator response is not valid JSON for ${redacted} (body redacted)`,
        recordIndex: 0,
      });
      return;
    }
    let outcome: { isValid: boolean; issues: ValidationIssue[] };
    try {
      outcome = parseFhirValidatorOutcome(parsed);
    } catch (error) {
      context.onIssue?.({ ...toIssue(error), recordIndex: 0 });
      return;
    }
    for (const validationIssue of outcome.issues) {
      context.onIssue?.({ ...validationIssue, recordIndex: 0 });
    }
    const resourceType = typeof resource.resourceType === "string" ? resource.resourceType : "unknown";
    const checksum = computeChecksum(input);
    yield createCanonicalEnvelope({
      id: typeof resource.id === "string" && resource.id !== "" ? resource.id : "fhir-validator-0",
      domain: "clinical",
      sourceFormat: FHIR_VALIDATOR_FORMAT,
      formatVersion: FHIR_VALIDATOR_FHIR_VERSION,
      content: { kind: "structured", data: resource },
      importedAt: context.importedAt,
      adapterId: this.id,
      adapterVersion: this.version,
      recordIndex: 0,
      sourceLocation: "input resource",
      filename: input.filename,
      checksum,
      encoding: "utf-8",
      metadata: {
        resourceType,
        validated: outcome.isValid,
        validatorHost: target.hostname,
        issueCount: outcome.issues.length,
      },
    });
  }

  /**
   * Self-check that never throws, never opens a socket and never leaks
   * endpoint details. Without an endpoint it reports ready-but-idle (parse
   * then reports skipped-with-reason per call).
   */
  public async health(): Promise<{ ok: boolean; details: string }> {
    const raw = process.env[FHIR_VALIDATOR_ENV_URL];
    if (!raw || raw.trim() === "") {
      return {
        ok: true,
        details: `fhir-validator ready; no validator endpoint configured (set ${FHIR_VALIDATOR_ENV_URL} for live validation; unconfigured validations report skipped-with-reason)`,
      };
    }
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return {
        ok: false,
        details: `fhir-validator misconfigured: ${FHIR_VALIDATOR_ENV_URL} is not a valid URL (value redacted)`,
      };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        details: `fhir-validator misconfigured: ${FHIR_VALIDATOR_ENV_URL} must use http or https (scheme redacted)`,
      };
    }
    return {
      ok: true,
      details: `${FHIR_VALIDATOR_ADAPTER_ID} ${FHIR_VALIDATOR_ADAPTER_VERSION} ready (endpoint ${redactUrlForLog(resolveValidateUrl(raw.trim()))}; SSRF allowlist still required per call)`,
    };
  }
}
