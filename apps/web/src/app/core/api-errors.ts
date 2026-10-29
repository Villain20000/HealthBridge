import type { ApiProblem } from "./api-types";

/**
 * Turns whatever the API (or the network) threw into something an operator can act on.
 *
 * Pure and framework-free so it can be unit-tested without a browser: the console shows
 * `code` and `requestId` for every failure, because "Something went wrong" costs the person
 * on the other end a support ticket.
 */

export interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
  code?: string;
  message?: string;
  requestId?: string;
}

const HTTP_FALLBACK: Record<number, { code: string; message: string }> = {
  0: {
    code: "NETWORK_ERROR",
    message: "The API could not be reached. Check the base URL and that the server is running.",
  },
  400: { code: "BAD_REQUEST", message: "The server rejected the request." },
  401: { code: "UNAUTHORIZED", message: "The API key is missing, wrong or revoked." },
  403: { code: "FORBIDDEN", message: "This API key is not allowed to perform that action." },
  404: { code: "NOT_FOUND", message: "That resource does not exist (or belongs to another workspace)." },
  409: { code: "CONFLICT", message: "The resource changed while you were acting on it. Fetch it again." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "The upload is larger than the server accepts." },
  422: { code: "VALIDATION_FAILED", message: "The request was understood but rejected as invalid." },
  429: { code: "RATE_LIMITED", message: "Too many requests. Wait a moment and retry." },
  500: { code: "INTERNAL", message: "The server failed while handling the request." },
  503: { code: "UNAVAILABLE", message: "The server is not able to accept work right now." },
};

export function problemFromStatus(status: number, body: unknown, requestIdHeader?: string): ApiProblem {
  const parsed = (body ?? {}) as ErrorBody;
  const nested = parsed.error;
  const code = nested?.code ?? parsed.code ?? HTTP_FALLBACK[status]?.code ?? `HTTP_${status}`;
  const message =
    nested?.message ?? parsed.message ?? HTTP_FALLBACK[status]?.message ?? `Request failed with status ${status}.`;
  const requestId = nested?.requestId ?? parsed.requestId ?? requestIdHeader ?? undefined;
  return { status, code, message, requestId, details: nested?.details };
}

/** Network failures arrive as status 0 and have no body at all. */
export function problemFromUnknown(error: unknown): ApiProblem {
  const candidate = error as { status?: number; error?: unknown; headers?: { get?(name: string): string | null } };
  const status = typeof candidate?.status === "number" ? candidate.status : 0;
  const requestId = candidate?.headers?.get?.("x-request-id") ?? undefined;
  return problemFromStatus(status, candidate?.error ?? undefined, requestId);
}

export function isUnauthorized(problem: ApiProblem): boolean {
  return problem.status === 401 || problem.code === "UNAUTHORIZED" || problem.code === "MISSING_CREDENTIALS";
}

/** One line for a table cell, the full detail for the error panel. */
export function describeProblem(problem: ApiProblem): string {
  const id = problem.requestId ? ` (request ${problem.requestId})` : "";
  return `${problem.message} [${problem.code}]${id}`;
}

export function isRetryable(problem: ApiProblem): boolean {
  return (
    problem.status === 429 || problem.status === 503 || problem.status === 0 || problem.code === "QUEUE_UNAVAILABLE"
  );
}
