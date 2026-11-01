/**
 * HealthBridge OS — read-only MySQL source connector.
 *
 * A `MedicalFormatAdapter` that streams rows from a MySQL server instead of
 * parsing a file. It is deliberately narrower than the file adapters:
 *
 * - Detection is by connection-string shape only (`mysql://…` / `mysqlx://…`
 *   in `InputDescriptor.uri`). File payloads (buffers, content strings,
 *   `.sql` files) are never claimed.
 * - Only read statements run. Every statement passes an allowlist
 *   (`SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` / read-only `WITH … SELECT`)
 *   after comment and string-literal stripping, plus a forbidden-keyword scan
 *   of the full text. Anything else is refused with an explicit issue code
 *   and is never sent to the server.
 * - Credentials arrive via caller options or environment secret refs only.
 *   Passwords never appear in envelopes, issues, warnings, traces or health
 *   details; every outward-facing string passes through redaction.
 * - Rows stream through a cursor (`mysql2` query stream) in chunks and are
 *   never materialised as a whole table. A per-query timeout and a row cap
 *   bound every read; excess rows and expired deadlines are reported as
 *   explicit truncation/timeout issues, never silently dropped.
 *
 * Scope note: `detect()` needs only the input descriptor, so connection and
 * query settings for `inspect()` come from `input.uri` (non-secret parts as
 * URL params, the password via a `passwordEnv` secret ref). `parse()` accepts
 * the same settings plus overrides in `context.options`.
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  MedicalDomain,
  ParseContext,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { createCanonicalEnvelope } from "@healthbridge/core";
import type { MedicalFormatAdapter } from "@healthbridge/core";

export const MYSQL_CONNECTOR_ID = "mysql-connector";
export const MYSQL_CONNECTOR_VERSION = "1.0.0";
export const MYSQL_CONNECTOR_FORMAT = "mysql";

/** Default per-query deadline when the caller does not set one. */
export const MYSQL_DEFAULT_TIMEOUT_MS = 30_000;
/** Default row cap when neither options nor `maxRecords` set one. */
export const MYSQL_DEFAULT_MAX_ROWS = 1_000;
/** Absolute upper bound for the row cap; larger requests are clamped. */
export const MYSQL_HARD_MAX_ROWS = 100_000;
/** Rows buffered by the driver stream between the server and the adapter. */
export const MYSQL_STREAM_HIGH_WATER_MARK = 100;
/** Sample rows returned by `inspect()` (read leading rows, never the table). */
export const MYSQL_INSPECT_SAMPLE_ROWS = 5;

export type MySqlStatementKind = "SELECT" | "SHOW" | "DESCRIBE" | "EXPLAIN" | "WITH";

/** Stable issue/error codes emitted by this connector. */
export const MYSQL_ISSUE_CODES = {
  configMissing: "MYSQL_CONFIG_MISSING",
  invalidOption: "MYSQL_INVALID_OPTION",
  writeRefused: "MYSQL_WRITE_REFUSED",
  multipleStatementsRefused: "MYSQL_MULTIPLE_STATEMENTS_REFUSED",
  connectionFailed: "MYSQL_CONNECTION_FAILED",
  queryFailed: "MYSQL_QUERY_FAILED",
  queryTimeout: "MYSQL_QUERY_TIMEOUT",
  rowCapTruncated: "MYSQL_ROW_CAP_TRUNCATED",
} as const;

export class MySqlConnectorError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MySqlConnectorError";
    this.code = code;
  }
}

const READ_STATEMENTS: readonly string[] = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"];

/**
 * Keywords that must never appear in a connector statement. The scan runs on
 * text with comments and string literals erased, and it errs on the side of
 * refusal: a false refusal is a support ticket, a false allow is a write.
 */
const FORBIDDEN_KEYWORDS: readonly string[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "LOAD",
  "HANDLER",
  "CALL",
  "EXECUTE",
  "INTO",
  "OUTFILE",
  "DUMPFILE",
  "SET",
  "START",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "USE",
  "LOCK",
  "UNLOCK",
  "KILL",
  "SHUTDOWN",
  "INSTALL",
  "UNINSTALL",
  "PURGE",
  "RESET",
  "FLUSH",
];

const MEDICAL_DOMAINS: readonly string[] = [
  "clinical",
  "laboratory",
  "imaging",
  "genomics",
  "biobanking",
  "research",
  "waveform",
  "document",
  "administrative",
  "public-health",
  "unknown",
];

/**
 * Erase comments (`-- `, `#`, `/ * … * /`) and replace every string or quoted
 * identifier literal with `?`, so gate checks cannot be fooled by text that
 * merely looks like SQL (`'DROP TABLE'` inside a value) or by keywords hidden
 * inside comments. Unterminated block comments swallow the rest of the input,
 * which can only make the gate stricter.
 */
export function eraseCommentsAndLiterals(sql: string): string {
  const input = sql.replace(/^\uFEFF/, "");
  let result = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    const two = input.slice(index, index + 2);
    if (char === "'" || char === '"' || char === "`") {
      result += "?";
      index += 1;
      while (index < input.length) {
        const inner = input[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === char) {
          if (input[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (two === "--") {
      const after = input[index + 2] ?? "";
      if (after === "" || /\s/.test(after)) {
        while (index < input.length && input[index] !== "\n") index += 1;
        result += " ";
        continue;
      }
      result += two;
      index += 2;
      continue;
    }
    if (char === "#") {
      while (index < input.length && input[index] !== "\n") index += 1;
      result += " ";
      continue;
    }
    if (two === "/*") {
      const end = input.indexOf("*/", index + 2);
      if (end === -1) {
        result += " ";
        break;
      }
      index = end + 2;
      result += " ";
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/**
 * Enforce the read-only statement gate. Returns the statement kind for
 * envelope metadata. Throws `MySqlConnectorError` — and the caller must not
 * execute anything when it does — for empty input, stacked statements
 * (`;` beyond a single trailing terminator) and anything outside the
 * allowlist. Never includes the statement text in the error: SQL can carry
 * PHI in its literals.
 */
export function assertReadOnlyStatement(sql: unknown): MySqlStatementKind {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.writeRefused,
      "Refusing empty MySQL statement: only read-only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH queries may run.",
    );
  }
  const scrubbed = eraseCommentsAndLiterals(sql)
    .trim()
    .replace(/[;\s]+$/, "");
  if (scrubbed.includes(";")) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.multipleStatementsRefused,
      "Refusing MySQL source with stacked statements: only a single read-only statement may run.",
    );
  }
  const first = (/^([A-Za-z]+)/.exec(scrubbed)?.[1] ?? "").toUpperCase();
  if (!READ_STATEMENTS.includes(first)) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.writeRefused,
      `Refusing non-read MySQL statement '${first || "?"}': ` +
        "only SELECT, SHOW, DESCRIBE, EXPLAIN and read-only WITH queries may run.",
    );
  }
  const words = new Set((scrubbed.toUpperCase().match(/[A-Z_]+/g) ?? []).map((word) => word));
  const hit = FORBIDDEN_KEYWORDS.find((keyword) => words.has(keyword));
  if (hit) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.writeRefused,
      `Refusing MySQL statement containing forbidden keyword '${hit}': the connector is read-only.`,
    );
  }
  return (first === "DESC" ? "DESCRIBE" : first) as MySqlStatementKind;
}

/**
 * Redact anything that looks like a credential from an outward-facing string
 * (issue messages, warnings, health details). Applied to every error that can
 * leave this module, including errors raised by the driver itself.
 */
export function redactConnectionSecrets(text: string): string {
  return text
    .replace(/(\bmysqlx?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, "$1***$3")
    .replace(/([?&]password=)([^&\s;]+)/gi, "$1***")
    .replace(/(\bpassword\b\s*[:=]\s*)(['"]?)[^\s'";,]+/gi, "$1$2***");
}

/** Backtick-escape one identifier part; rejects anything outside `[A-Za-z0-9_]`. */
export function escapeMysqlIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.invalidOption,
      "Refusing MySQL table/database name with unexpected characters: use letters, digits and underscore only.",
    );
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

/** `SELECT *` for one table, honouring an optional database qualifier. */
export function buildTableSelect(table: string, database?: string): string {
  const parts = table.split(".");
  if (parts.length > 2 || parts.some((part) => part === "")) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.invalidOption,
      "Refusing MySQL table reference: expected `table` or `database.table` with plain identifiers.",
    );
  }
  const escaped = parts.map((part) => escapeMysqlIdentifier(part)).join(".");
  if (parts.length === 1 && database) {
    return `SELECT * FROM ${escapeMysqlIdentifier(database)}.${escaped}`;
  }
  return `SELECT * FROM ${escaped}`;
}

export interface MySqlConnectorInputOptions {
  host?: unknown;
  port?: unknown;
  user?: unknown;
  password?: unknown;
  passwordEnv?: unknown;
  database?: unknown;
  connectionString?: unknown;
  sql?: unknown;
  query?: unknown;
  table?: unknown;
  params?: unknown;
  maxRows?: unknown;
  timeoutMs?: unknown;
  domain?: unknown;
}

export interface ResolvedMysqlSource {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  sql: string;
  params: unknown[];
  table?: string;
  maxRows: number;
  maxRowsRequested?: number;
  timeoutMs: number;
  domain: MedicalDomain;
  passwordEnv?: string;
  /** Display-safe origin (`mysql://host:port/database`). Never has credentials. */
  origin: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parsePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const port = Number(value.trim());
    if (port > 0 && port <= 65535) return port;
  }
  return undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function parseDomain(value: unknown): MedicalDomain {
  if (typeof value === "string" && (MEDICAL_DOMAINS as readonly string[]).includes(value)) {
    return value as MedicalDomain;
  }
  return "clinical";
}

interface ParsedConnectionString {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

function parseConnectionString(raw: string): ParsedConnectionString {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      "MySQL connection string is not a valid URL: expected mysql://[user[:password]@]host[:port]/database.",
    );
  }
  if (url.protocol !== "mysql:" && url.protocol !== "mysqlx:") {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      `MySQL connection string must use the mysql:// scheme, got '${url.protocol}'.`,
    );
  }
  const parsed: ParsedConnectionString = {};
  if (url.hostname) parsed.host = url.hostname;
  if (url.port) parsed.port = Number(url.port);
  if (url.username) parsed.user = decodeURIComponent(url.username);
  if (url.password) parsed.password = url.password;
  const database = url.pathname.replace(/^\//, "").split("/")[0];
  if (database) parsed.database = decodeURIComponent(database);
  return parsed;
}

function uriParams(uri: string | undefined): URLSearchParams | undefined {
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    if (url.protocol !== "mysql:" && url.protocol !== "mysqlx:") return undefined;
    return url.searchParams;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective source from an input descriptor plus caller options.
 * Precedence is options first, then `input.uri` (connection string plus
 * non-secret URL params), then defaults. The password comes from
 * `options.password`, from the environment variable named by
 * `options.passwordEnv` (or the `passwordEnv` URL param), or from the
 * connection string itself — never from anywhere else, and never echoed back
 * in the resolved origin. Throws `MySqlConnectorError`; messages are safe to
 * surface because they never contain the SQL text, params or credentials.
 */
export function resolveMysqlSource(
  input: InputDescriptor,
  options?: Record<string, unknown>,
  maxRecords?: number,
): ResolvedMysqlSource {
  const opts = (options ?? {}) as MySqlConnectorInputOptions;
  const params = uriParams(input.uri);

  const connectionRaw = asNonEmptyString(opts.connectionString) ?? input.uri ?? undefined;
  const fromUrl = connectionRaw ? parseConnectionString(connectionRaw) : {};

  const host = asNonEmptyString(opts.host) ?? fromUrl.host;
  if (!host) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      "MySQL source needs a host: set options.host or use a mysql://host/database connection string.",
    );
  }
  const port = parsePort(opts.port) ?? fromUrl.port ?? 3306;
  if (opts.port !== undefined && parsePort(opts.port) === undefined) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.invalidOption,
      "MySQL option 'port' must be an integer between 1 and 65535.",
    );
  }
  const user = asNonEmptyString(opts.user) ?? fromUrl.user;
  if (!user) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      "MySQL source needs a user: set options.user or include it in the connection string.",
    );
  }
  const database = asNonEmptyString(opts.database) ?? fromUrl.database;
  if (!database) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      "MySQL source needs a database: set options.database or include it in the connection string path.",
    );
  }

  const passwordEnv = asNonEmptyString(opts.passwordEnv) ?? params?.get("passwordEnv") ?? undefined;
  let password = asNonEmptyString(opts.password);
  if (password === undefined && passwordEnv) {
    const fromEnv = process.env[passwordEnv];
    if (fromEnv) password = fromEnv;
  }
  if (password === undefined) password = fromUrl.password;

  const table = asNonEmptyString(opts.table) ?? params?.get("table") ?? undefined;
  const sql =
    asNonEmptyString(opts.sql) ??
    asNonEmptyString(opts.query) ??
    params?.get("query") ??
    params?.get("sql") ??
    (table ? buildTableSelect(table, database) : undefined);
  if (!sql) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.configMissing,
      "MySQL source needs a query: set options.sql (or options.table) or add a ?query= parameter to the connection string.",
    );
  }
  if (
    (opts.sql !== undefined && asNonEmptyString(opts.sql) === undefined) ||
    (opts.query !== undefined && asNonEmptyString(opts.query) === undefined)
  ) {
    throw new MySqlConnectorError(MYSQL_ISSUE_CODES.invalidOption, "MySQL option 'sql' must be a non-empty string.");
  }

  let paramsValues: unknown[] = [];
  if (opts.params !== undefined) {
    if (!Array.isArray(opts.params)) {
      throw new MySqlConnectorError(
        MYSQL_ISSUE_CODES.invalidOption,
        "MySQL option 'params' must be an array of query parameters.",
      );
    }
    paramsValues = opts.params;
  }

  const requested = parsePositiveInt(opts.maxRows) ?? parsePositiveInt(params?.get("maxRows") ?? undefined);
  if (
    (opts.maxRows !== undefined && parsePositiveInt(opts.maxRows) === undefined) ||
    (params?.get("maxRows") !== null &&
      params?.get("maxRows") !== undefined &&
      parsePositiveInt(params.get("maxRows")!) === undefined)
  ) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.invalidOption,
      "MySQL option 'maxRows' must be a positive integer.",
    );
  }
  const maxRecordsCap = typeof maxRecords === "number" && maxRecords > 0 ? Math.floor(maxRecords) : undefined;
  const effectiveRequested = Math.min(requested ?? MYSQL_DEFAULT_MAX_ROWS, maxRecordsCap ?? MYSQL_HARD_MAX_ROWS);
  const maxRows = Math.min(effectiveRequested, MYSQL_HARD_MAX_ROWS);

  const timeoutRaw = opts.timeoutMs ?? params?.get("timeoutMs") ?? undefined;
  const timeoutMs =
    (typeof timeoutRaw === "number" || typeof timeoutRaw === "string") && parsePositiveInt(timeoutRaw) !== undefined
      ? parsePositiveInt(timeoutRaw)!
      : MYSQL_DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined && parsePositiveInt(timeoutRaw) === undefined) {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.invalidOption,
      "MySQL option 'timeoutMs' must be a positive integer of milliseconds.",
    );
  }

  const domain = parseDomain(opts.domain ?? params?.get("domain") ?? undefined);

  return {
    host,
    port,
    user,
    password,
    database,
    sql,
    params: paramsValues,
    table,
    maxRows,
    maxRowsRequested: requested,
    timeoutMs,
    domain,
    passwordEnv,
    origin: `mysql://${host}:${port}/${database}`,
  };
}

/** JSON-safe normalisation of driver values (Buffer/BigInt/Date are not JSON types). */
export function normalizeMysqlValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeMysqlValue(entry));
  if (value !== null && typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = normalizeMysqlValue(entry);
    }
    return record;
  }
  return value;
}

/** Deterministic JSON with sorted keys, so row checksums are stable. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

/** SHA-256 over the normalised row; the checksum fingerprints content, like file adapters. */
export function checksumMysqlRow(row: Record<string, unknown>): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(normalizeMysqlValue(row)))
    .digest("hex")}`;
}

/** SHA-256 over normalised statement whitespace; stored instead of the SQL text. */
export function checksumStatement(sql: string): string {
  const normalised = sql
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `sha256:${createHash("sha256").update(normalised, "utf-8").digest("hex")}`;
}

function coerceRow(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value: normalizeMysqlValue(value) };
}

/** Minimal driver surface the connector needs; fakes implement this in tests. */
export interface MySqlRowSource {
  rows(sql: string, params?: unknown[]): AsyncIterable<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface MySqlConnectConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  connectTimeoutMs: number;
}

export type MySqlConnectFn = (config: MySqlConnectConfig) => Promise<MySqlRowSource>;

interface Mysql2CallbackConnection {
  connect(callback: (error: Error | null) => void): void;
  query(sql: string, values: unknown[]): { stream(options?: { highWaterMark?: number }): Readable };
  end(callback?: () => void): void;
  destroy(): void;
}

/**
 * Default driver backend: one `mysql2` connection with a cursor stream, so
 * rows flow in `highWaterMark` chunks instead of being materialised. The
 * driver is imported lazily so unit tests with a fake never touch it.
 */
export async function connectWithMysql2(config: MySqlConnectConfig): Promise<MySqlRowSource> {
  let mysql: typeof import("mysql2");
  try {
    mysql = await import("mysql2");
  } catch {
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.connectionFailed,
      "MySQL driver 'mysql2' is not installed: add the pinned mysql2 dependency before using the connector.",
    );
  }
  const connection = mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: Math.min(Math.max(config.connectTimeoutMs, 1_000), 10_000),
  }) as unknown as Mysql2CallbackConnection;
  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    connection.destroy();
    throw new MySqlConnectorError(
      MYSQL_ISSUE_CODES.connectionFailed,
      `MySQL connection failed: ${redactConnectionSecrets((error as Error).message).slice(0, 200)}`,
    );
  }
  return {
    rows(sql: string, params?: unknown[]): AsyncIterable<Record<string, unknown>> {
      const nodeStream = connection.query(sql, params ?? []).stream({ highWaterMark: MYSQL_STREAM_HIGH_WATER_MARK });
      return nodeStream as unknown as AsyncIterable<Record<string, unknown>>;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        const guard = setTimeout(() => {
          try {
            connection.destroy();
          } catch {
            // Destroy is best-effort; finish in any case.
          }
          finish();
        }, 2_000);
        try {
          connection.end(() => {
            clearTimeout(guard);
            finish();
          });
        } catch {
          clearTimeout(guard);
          try {
            connection.destroy();
          } catch {
            // Destroy is best-effort; finish in any case.
          }
          finish();
        }
      });
    },
  };
}

function toIssue(error: unknown, fallbackSeverity: ValidationIssue["severity"]): ValidationIssue {
  if (error instanceof MySqlConnectorError) {
    return { code: error.code, severity: fallbackSeverity, message: error.message };
  }
  return {
    code: MYSQL_ISSUE_CODES.queryFailed,
    severity: fallbackSeverity,
    message: `MySQL connector failed: ${redactConnectionSecrets((error as Error).message).slice(0, 200)}`,
  };
}

/**
 * Issues for the connect phase. Driver errors never carry `MySqlConnectorError`
 * codes, so anything unexpected here is a connection failure — reported with a
 * sanitised message, never the raw driver text.
 */
function connectIssue(error: unknown): ValidationIssue {
  if (error instanceof MySqlConnectorError) {
    return { code: error.code, severity: "fatal", message: error.message };
  }
  return {
    code: MYSQL_ISSUE_CODES.connectionFailed,
    severity: "fatal",
    message: `MySQL connection failed: ${redactConnectionSecrets((error as Error).message).slice(0, 200)}`,
  };
}

interface RowReadResult {
  rows: Record<string, unknown>[];
  timedOut: boolean;
}

/**
 * Release a row iterator without blocking the caller. `return()` on an async
 * iterator parked inside an unsettled `await` never settles, so awaiting it
 * would hang the timeout and truncation paths; detaching with a no-op catch
 * frees driver-backed iterators (stream destroy) while letting parked fakes
 * stay parked without holding the event loop.
 */
function releaseIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const pending = iterator.return?.();
    (pending as Promise<unknown> | undefined)?.catch?.(() => undefined);
  } catch {
    // A release failure must never mask the result being returned.
  }
}

/**
 * Read up to `limit + 1` rows so the caller can tell "exactly at the cap"
 * from "truncated": the extra row is evidence, never yielded. Races the
 * iterator against a deadline; on expiry the iterator is released and the
 * caller reports `MYSQL_QUERY_TIMEOUT`.
 */
async function readRows(
  iterable: AsyncIterable<Record<string, unknown>>,
  limit: number,
  timeoutMs: number,
): Promise<RowReadResult> {
  const rows: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hb-timeout">((resolve) => {
    timer = setTimeout(() => resolve("hb-timeout"), timeoutMs);
  });
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (rows.length <= limit) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next === "hb-timeout") {
        releaseIterator(iterator);
        return { rows, timedOut: true };
      }
      if (next.done) return { rows, timedOut: false };
      rows.push(coerceRow(next.value));
    }
    releaseIterator(iterator);
    return { rows, timedOut: false };
  } catch (error) {
    // Releasing a failed iterator must not mask the original error.
    releaseIterator(iterator);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read-only MySQL source connector. Construct with an injected `connect`
 * factory in tests; the default backend uses the pinned `mysql2` driver.
 */
export class MySqlSourceConnectorAdapter implements MedicalFormatAdapter {
  public readonly id = MYSQL_CONNECTOR_ID;
  public readonly version = MYSQL_CONNECTOR_VERSION;

  private readonly connect: MySqlConnectFn;

  constructor(deps?: { connect?: MySqlConnectFn }) {
    this.connect = deps?.connect ?? connectWithMysql2;
  }

  public getManifest(): CapabilityManifest {
    return {
      format: MYSQL_CONNECTOR_FORMAT,
      version: MYSQL_CONNECTOR_VERSION,
      description:
        "Read-only MySQL source connector (allowlisted SELECT/SHOW/DESCRIBE/EXPLAIN, chunked cursor streaming)",
      extensions: [],
      mimeTypes: [],
      status: "partial",
      limitations: [
        "Read-only: only SELECT, SHOW, DESCRIBE, EXPLAIN and read-only WITH queries run; everything else is refused before execution.",
        "Requires a reachable MySQL server; credentials come from caller options or environment secret refs and are never stored in envelopes, issues or traces.",
        "Rows stream in chunks with a per-query timeout and row cap; excess rows surface as MYSQL_ROW_CAP_TRUNCATED instead of being silently dropped.",
        "No clinical semantics are inferred; rows are mapped structurally. Not clinically validated.",
      ],
      capabilities: {
        register: true,
        parseMetadata: true,
        parseStructured: true,
        preview: true,
        transformMetadataToFHIR: true,
        transformToFHIR: true,
        validateFormat: "adapter-required",
        exportOriginal: false,
      },
    };
  }

  public async detect(input: InputDescriptor): Promise<boolean> {
    return (await this.score(input)) >= 0.5;
  }

  /**
   * Claims only `mysql://` / `mysqlx://` connection-string URIs. File
   * payloads — buffers, content strings, filenames, extensions — never score
   * above zero, and scoring never throws.
   */
  public async score(input: InputDescriptor): Promise<number> {
    try {
      if (!input.uri) return 0;
      const url = new URL(input.uri);
      if (url.protocol === "mysql:" || url.protocol === "mysqlx:") return 0.85;
      return 0;
    } catch {
      return 0;
    }
  }

  public async inspect(input: InputDescriptor): Promise<InspectionResult> {
    const manifest = this.getManifest();
    let resolved: ResolvedMysqlSource;
    try {
      resolved = resolveMysqlSource(input);
    } catch (error) {
      const issue = toIssue(error, "fatal");
      return {
        format: MYSQL_CONNECTOR_FORMAT,
        domain: "unknown",
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: [`${issue.code}: ${issue.message}`],
      };
    }
    let kind: MySqlStatementKind;
    try {
      kind = assertReadOnlyStatement(resolved.sql);
    } catch (error) {
      const issue = toIssue(error, "fatal");
      return {
        format: MYSQL_CONNECTOR_FORMAT,
        domain: resolved.domain,
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: [`${issue.code}: ${issue.message}`],
      };
    }

    let source: MySqlRowSource | undefined;
    try {
      source = await this.connect({
        host: resolved.host,
        port: resolved.port,
        user: resolved.user,
        password: resolved.password,
        database: resolved.database,
        connectTimeoutMs: resolved.timeoutMs,
      });
    } catch (error) {
      const issue = connectIssue(error);
      return {
        format: MYSQL_CONNECTOR_FORMAT,
        domain: resolved.domain,
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: [`${issue.code}: ${issue.message}`],
      };
    }

    try {
      const { rows, timedOut } = await readRows(
        source.rows(resolved.sql, resolved.params),
        MYSQL_INSPECT_SAMPLE_ROWS,
        resolved.timeoutMs,
      );
      if (timedOut) {
        return {
          format: MYSQL_CONNECTOR_FORMAT,
          domain: resolved.domain,
          capabilities: manifest.capabilities,
          status: manifest.status,
          warnings: [
            `${MYSQL_ISSUE_CODES.queryTimeout}: inspection read exceeded ${resolved.timeoutMs}ms and was cancelled.`,
          ],
        };
      }
      const sample = rows.slice(0, MYSQL_INSPECT_SAMPLE_ROWS);
      const fieldNames = Array.from(new Set(sample.flatMap((row) => Object.keys(row))));
      return {
        format: MYSQL_CONNECTOR_FORMAT,
        domain: resolved.domain,
        detectedSchema: {
          fields: fieldNames.map((name) => ({
            name,
            type: inferFieldType(sample.map((row) => row[name])),
            sampleValues: sample.slice(0, 3).map((row) => normalizeMysqlValue(row[name])),
            nullable: sample.some((row) => row[name] === null || row[name] === undefined),
          })),
        },
        sampleRecords: sample.map((row) => normalizeMysqlValue(row) as Record<string, unknown>),
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: [
          `Statement kind: ${kind}; origin: ${resolved.origin}.`,
          `Inspection reads at most ${MYSQL_INSPECT_SAMPLE_ROWS} leading rows; recordCount is omitted because counting would scan the source.`,
          `Parse applies a ${resolved.maxRows}-row cap and a ${resolved.timeoutMs}ms per-query timeout.`,
        ],
      };
    } catch (error) {
      const issue = toIssue(error, "error");
      return {
        format: MYSQL_CONNECTOR_FORMAT,
        domain: resolved.domain,
        capabilities: manifest.capabilities,
        status: manifest.status,
        warnings: [`${issue.code}: ${issue.message}`],
      };
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  public async *parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope> {
    let resolved: ResolvedMysqlSource;
    try {
      resolved = resolveMysqlSource(input, context.options, context.maxRecords);
    } catch (error) {
      context.onIssue?.(toIssue(error, "fatal"));
      return;
    }
    let kind: MySqlStatementKind;
    try {
      kind = assertReadOnlyStatement(resolved.sql);
    } catch (error) {
      context.onIssue?.(toIssue(error, "fatal"));
      return;
    }

    let source: MySqlRowSource | undefined;
    try {
      source = await this.connect({
        host: resolved.host,
        port: resolved.port,
        user: resolved.user,
        password: resolved.password,
        database: resolved.database,
        connectTimeoutMs: resolved.timeoutMs,
      });
    } catch (error) {
      context.onIssue?.(connectIssue(error));
      return;
    }

    const queryChecksum = checksumStatement(resolved.sql);
    const columns: string[] = [];
    let index = 0;
    let truncated: boolean;
    let timedOut = false;
    try {
      const { rows, timedOut: expired } = await readRows(
        source.rows(resolved.sql, resolved.params),
        resolved.maxRows,
        resolved.timeoutMs,
      );
      timedOut = expired;
      truncated = !timedOut && rows.length > resolved.maxRows;
      const visible = rows.slice(0, resolved.maxRows);
      for (const row of visible) {
        for (const key of Object.keys(row)) {
          if (!columns.includes(key)) columns.push(key);
        }
      }
      for (const row of visible) {
        const normalised = normalizeMysqlValue(row) as Record<string, unknown>;
        const envelope = createCanonicalEnvelope({
          id: `mysql-rec-${index}`,
          domain: resolved.domain,
          sourceFormat: MYSQL_CONNECTOR_FORMAT,
          content: { kind: "structured", data: normalised },
          importedAt: context.importedAt,
          adapterId: this.id,
          adapterVersion: this.version,
          recordIndex: index,
          sourceLocation: `row ${index + 1}`,
          filename: input.filename,
          checksum: checksumMysqlRow(row),
          encoding: "utf-8",
          metadata: {
            origin: resolved.origin,
            statementKind: kind,
            queryChecksum,
            columns,
            rowNumber: index + 1,
            maxRows: resolved.maxRows,
            table: resolved.table,
          },
        });
        index += 1;
        yield envelope;
      }
    } catch (error) {
      if (!timedOut) context.onIssue?.(toIssue(error, "error"));
      return;
    } finally {
      await source.close().catch(() => undefined);
    }
    if (timedOut) {
      context.onIssue?.({
        code: MYSQL_ISSUE_CODES.queryTimeout,
        severity: "error",
        message: `MySQL query exceeded the ${resolved.timeoutMs}ms deadline and was cancelled; rows already yielded are kept.`,
        advice: "Narrow the query (add WHERE/LIMIT) or raise 'timeoutMs'.",
      });
    } else if (truncated) {
      context.onIssue?.({
        code: MYSQL_ISSUE_CODES.rowCapTruncated,
        severity: "warning",
        message: `Row cap of ${resolved.maxRows} reached; remaining rows were not read.`,
        advice: "Page the query (LIMIT/OFFSET or a keyset predicate) or raise 'maxRows'.",
      });
    }
  }

  /**
   * Self-check that never throws and never leaks credentials. Without a
   * `HEALTHBRIDGE_MYSQL_URL` default connection it reports ready-but-idle;
   * with one it probes `SELECT 1` on a short deadline.
   */
  public async health(): Promise<{ ok: boolean; details: string }> {
    const raw = process.env.HEALTHBRIDGE_MYSQL_URL;
    if (!raw) {
      return {
        ok: true,
        details:
          "mysql-connector ready; no default connection configured (set HEALTHBRIDGE_MYSQL_URL for the live probe)",
      };
    }
    let parsed: ParsedConnectionString;
    try {
      parsed = parseConnectionString(raw);
    } catch {
      return {
        ok: false,
        details: "mysql-connector misconfigured: HEALTHBRIDGE_MYSQL_URL is not a valid mysql:// URL",
      };
    }
    if (!parsed.user || !parsed.database || !parsed.host) {
      return {
        ok: false,
        details: "mysql-connector misconfigured: HEALTHBRIDGE_MYSQL_URL needs user, host and database",
      };
    }
    let source: MySqlRowSource | undefined;
    try {
      source = await connectWithMysql2({
        host: parsed.host,
        port: parsed.port ?? 3306,
        user: parsed.user,
        password: parsed.password,
        database: parsed.database,
        connectTimeoutMs: 5_000,
      });
      const { timedOut } = await readRows(source.rows("SELECT 1 AS ok", []), 1, 5_000);
      if (timedOut) {
        return {
          ok: false,
          details: `mysql-connector probe timed out against mysql://${parsed.host}/${parsed.database}`,
        };
      }
      return {
        ok: true,
        details: `mysql-connector probe SELECT 1 succeeded against mysql://${parsed.host}/${parsed.database}`,
      };
    } catch (error) {
      return {
        ok: false,
        details: `mysql-connector probe failed: ${redactConnectionSecrets((error as Error).message).slice(0, 200)}`,
      };
    } finally {
      await source?.close().catch(() => undefined);
    }
  }
}

function inferFieldType(values: unknown[]): string {
  const sample = values.filter((value) => value !== "" && value !== undefined && value !== null);
  if (sample.length === 0) return "string";
  if (sample.every((value) => typeof value === "number" && Number.isInteger(value))) return "integer";
  if (sample.every((value) => typeof value === "number")) return "number";
  if (sample.every((value) => typeof value === "boolean")) return "boolean";
  if (
    sample.every((value) => value instanceof Date || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)))
  ) {
    return "datetime";
  }
  return "string";
}
