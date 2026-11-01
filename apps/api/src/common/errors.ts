/**
 * Structured HTTP errors.
 *
 * Every failure leaves the API in the same envelope so clients never have to
 * parse prose:
 *   { error: { code, message, requestId, details? }, statusCode }
 *
 * Codes are stable and documented in docs/api.md. The mapping to HTTP status is
 * one-to-one and lives here so no controller can invent a status.
 */

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "MALFORMED_KEY"
  | "REVOKED_KEY"
  | "EXPIRED_KEY"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DRAFT_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "MAPPING_VALIDATION_FAILED"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_JSON"
  | "CANCELLED"
  | "RUN_NOT_CANCELLABLE"
  | "RUN_NOT_TERMINAL"
  | "QUEUE_UNAVAILABLE"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  MALFORMED_KEY: 400,
  REVOKED_KEY: 401,
  EXPIRED_KEY: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DRAFT_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 422,
  MAPPING_VALIDATION_FAILED: 422,
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_JSON: 400,
  CANCELLED: 409,
  RUN_NOT_CANCELLABLE: 409,
  RUN_NOT_TERMINAL: 409,
  QUEUE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ApiErrorOptions {
  details?: unknown;
  headers?: Record<string, string>;
  /** Internal diagnostics; never sent to clients. */
  cause?: unknown;
}

export class ApiError extends Error {
  public readonly statusCode: number;

  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = STATUS[code] ?? 500;
  }

  public static isApiError(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

export function notFound(what: string): ApiError {
  // Tenant isolation depends on this being indistinguishable from "does not exist".
  return new ApiError("NOT_FOUND", `${what} was not found in this workspace.`);
}

export function validationFailed(message: string, details?: unknown): ApiError {
  return new ApiError("VALIDATION_FAILED", message, details === undefined ? {} : { details });
}
