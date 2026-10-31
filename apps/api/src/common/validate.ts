import { ApiError, validationFailed } from "./errors.js";

/**
 * Request validation helpers.
 *
 * Hand-written instead of a schema library on purpose: the API accepts a small,
 * fixed set of shapes, and explicit checks keep error messages stable and testable
 * without runtime metadata reflection.
 */

export function requireObject(value: unknown, what = "request body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationFailed(`The ${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, options: { max?: number; min?: number } = {}): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw validationFailed(`'${field}' is required and must be a non-empty string.`);
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (trimmed.length < min || trimmed.length > max) {
    throw validationFailed(`'${field}' must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

export function optionalString(value: unknown, field: string, options: { max?: number } = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, options);
}

export function requireSlug(value: unknown, field: string): string {
  const slug = requireString(value, field, { max: 60 }).toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) {
    throw validationFailed(`'${field}' must contain only lowercase letters, digits and hyphens.`);
  }
  return slug;
}

export function requireInteger(value: unknown, field: string, options: { min?: number } = {}): number {
  const min = options.min ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw validationFailed(`'${field}' must be an integer >= ${min}.`);
  }
  return value;
}

export function optionalInteger(value: unknown, field: string, options: { min?: number } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInteger(value, field, options);
}

/** Query-string form: `undefined` and `""` mean "not supplied". */
export function parseOptionalInteger(value: unknown, field: string, min: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = typeof value === "string" ? Number(value) : value;
  return requireInteger(numeric, field, { min });
}

export function parseLimit(value: unknown, fallback = 25, max = 100): number {
  if (value === undefined || value === "") return fallback;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) throw validationFailed("'limit' must be a positive integer.");
  return Math.min(Math.trunc(limit), max);
}

export function parseCursor(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512) throw validationFailed("'cursor' is malformed.");
  return value;
}

export function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw validationFailed(`'${field}' must be an object.`);
  return value as Record<string, unknown>;
}

export function requireStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw validationFailed(`'${field}' must be an array of strings.`);
  }
  return value as string[];
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

export function requireBootstrapToken(provided: string | undefined, expected: string): void {
  if (!provided || !constantTimeEquals(provided, expected)) {
    throw new ApiError("UNAUTHENTICATED", "A valid bootstrap token is required to create a workspace.", {
      details: { header: "x-bootstrap-token" },
    });
  }
}
