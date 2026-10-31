import { randomBytes } from "node:crypto";

/**
 * Environment configuration.
 *
 * The API must be safe by default and explicit about degradation:
 *  - no DATABASE_URL  → demo mode (in-memory repositories, clearly reported)
 *  - DATABASE_URL set → MySQL is required and a failure to connect is fatal
 *  - production without a database refuses to start, because a demo instance in
 *    front of real patient data is exactly the failure this platform must not have
 */
export interface ApiConfig {
  host: string;
  port: number;
  nodeEnv: string;
  mode: "demo" | "database";
  database?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
    migrateOnStart: boolean;
  };
  storage: { rootDir: string; maxObjectBytes: number };
  auth: {
    /** Mixed into every API key hash. Never logged. */
    pepper: string;
    bootstrapToken: string;
    defaultTtlDays?: number;
    recordUsage: boolean;
  };
  limits: {
    maxUploadBytes: number;
    maxRequestBodyBytes: number;
    rateLimit: { capacity: number; refillPerSecond: number };
    /** Public workspace provisioning: attempts per client IP per fixed window. */
    bootstrapRateLimit: { attemptsPerWindow: number; windowMs: number };
    maxStoredResultBytes: number;
    maxTracesPerRun: number;
    /** Mapping preview: records per call, serialised response bytes, and input asset bytes. */
    maxPreviewRecords: number;
    maxPreviewBytes: number;
    maxPreviewInputBytes: number;
  };
  queue: { concurrency: number; maxAttempts: number; pollIntervalMs: number; visibilityTimeoutMs: number };
  sseHeartbeatMs: number;
  corsOrigins: string[];
}

/** A bootstrap token is the only credential that can create a workspace. */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 16;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
  return Math.trunc(value);
}

function parseDatabaseUrl(url: string): ApiConfig["database"] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("DATABASE_URL must be a valid mysql:// URL");
  }
  if (!/^mysql:/.test(parsed.protocol)) {
    throw new ConfigError("DATABASE_URL must use the mysql:// scheme");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (!database) throw new ConfigError("DATABASE_URL must include a database name");
  if (!parsed.username) throw new ConfigError("DATABASE_URL must include a user");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    connectionLimit: 10,
    migrateOnStart: true,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const database = env.DATABASE_URL ? parseDatabaseUrl(env.DATABASE_URL) : undefined;

  if (!database && nodeEnv === "production") {
    throw new ConfigError(
      "Refusing to start in production without DATABASE_URL: the in-memory mode loses data on restart " +
        "and must only be used for the offline demo.",
    );
  }

  const pepper = env.HEALTHBRIDGE_KEY_PEPPER ?? (database ? "" : randomBytes(24).toString("base64url"));
  if (!pepper) {
    throw new ConfigError("HEALTHBRIDGE_KEY_PEPPER is required when a database is configured");
  }
  if (pepper.length < 16) {
    throw new ConfigError("HEALTHBRIDGE_KEY_PEPPER must be at least 16 characters");
  }

  const bootstrapToken = env.HEALTHBRIDGE_BOOTSTRAP_TOKEN ?? (database ? "" : randomBytes(18).toString("base64url"));
  if (!bootstrapToken) {
    throw new ConfigError(
      "HEALTHBRIDGE_BOOTSTRAP_TOKEN is required with a database: it is the only way to create the first workspace",
    );
  }
  if (bootstrapToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    throw new ConfigError(
      `HEALTHBRIDGE_BOOTSTRAP_TOKEN must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters: ` +
        "it is the only credential that can create a workspace and a short token is brute-forceable",
    );
  }

  return {
    host: env.HOST ?? "0.0.0.0",
    port: intFromEnv("PORT", 3000, env),
    nodeEnv,
    mode: database ? "database" : "demo",
    database,
    storage: {
      rootDir: env.HEALTHBRIDGE_STORAGE_DIR ?? "./.data/objects",
      maxObjectBytes: intFromEnv("HEALTHBRIDGE_MAX_UPLOAD_BYTES", 64 * 1024 * 1024, env),
    },
    auth: {
      pepper,
      bootstrapToken,
      defaultTtlDays: env.HEALTHBRIDGE_KEY_TTL_DAYS ? intFromEnv("HEALTHBRIDGE_KEY_TTL_DAYS", 0, env) : undefined,
      recordUsage: env.HEALTHBRIDGE_RECORD_KEY_USAGE !== "false",
    },
    limits: {
      maxUploadBytes: intFromEnv("HEALTHBRIDGE_MAX_UPLOAD_BYTES", 64 * 1024 * 1024, env),
      maxRequestBodyBytes: intFromEnv("HEALTHBRIDGE_MAX_BODY_BYTES", 1024 * 1024, env),
      rateLimit: {
        capacity: intFromEnv("HEALTHBRIDGE_RATE_LIMIT_BURST", 120, env),
        refillPerSecond: intFromEnv("HEALTHBRIDGE_RATE_LIMIT_RPS", 20, env),
      },
      bootstrapRateLimit: {
        attemptsPerWindow: intFromEnv("HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT", 10, env),
        windowMs: 15 * 60 * 1000,
      },
      maxStoredResultBytes: intFromEnv("HEALTHBRIDGE_MAX_STORED_RESULT_BYTES", 5 * 1024 * 1024, env),
      maxTracesPerRun: intFromEnv("HEALTHBRIDGE_MAX_TRACES_PER_RUN", 5000, env),
      // Clamped at load so /healthz reports the maximum a client can actually get.
      maxPreviewRecords: Math.min(intFromEnv("HEALTHBRIDGE_MAX_PREVIEW_RECORDS", 25, env), 100),
      maxPreviewBytes: intFromEnv("HEALTHBRIDGE_MAX_PREVIEW_BYTES", 512 * 1024, env),
      maxPreviewInputBytes: intFromEnv("HEALTHBRIDGE_MAX_PREVIEW_INPUT_BYTES", 8 * 1024 * 1024, env),
    },
    queue: {
      concurrency: intFromEnv("HEALTHBRIDGE_QUEUE_CONCURRENCY", 2, env),
      pollIntervalMs: intFromEnv("HEALTHBRIDGE_QUEUE_POLL_MS", 500, env),
      visibilityTimeoutMs: intFromEnv("HEALTHBRIDGE_QUEUE_VISIBILITY_MS", 300_000, env),
      maxAttempts: intFromEnv("HEALTHBRIDGE_QUEUE_MAX_ATTEMPTS", 2, env),
    },
    sseHeartbeatMs: intFromEnv("HEALTHBRIDGE_SSE_HEARTBEAT_MS", 15_000, env),
    corsOrigins: (env.HEALTHBRIDGE_CORS_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

/** Config for tests and the offline demo: deterministic, no filesystem writes outside temp. */
export function loadTestConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      HEALTHBRIDGE_KEY_PEPPER: "test-pepper-at-least-16-chars",
      HEALTHBRIDGE_BOOTSTRAP_TOKEN: "test-bootstrap-token",
      HEALTHBRIDGE_STORAGE_DIR: "",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}
