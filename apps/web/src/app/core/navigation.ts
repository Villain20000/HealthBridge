/**
 * Navigation guards. The connect flow accepts a caller-supplied return URL, so it is treated as
 * hostile input and only same-origin paths survive; slugs are checked with the API's rule so the
 * console never offers a mapping name the server would reject.
 */

const MAX_RETURN_URL_LENGTH = 2048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAPPING_SLUG = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;

export function safeReturnUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_RETURN_URL_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  if (CONTROL_CHARACTER.test(value)) return null;
  const queryStart = value.search(/[?#]/);
  const path = queryStart === -1 ? value : value.slice(0, queryStart);
  return path === "/connect" ? null : value;
}

export function isMappingSlug(name: string): boolean {
  if (typeof name !== "string") return false;
  return MAPPING_SLUG.test(name);
}
