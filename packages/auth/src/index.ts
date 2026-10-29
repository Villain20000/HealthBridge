import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authentication and authorisation primitives.
 *
 * Design constraints:
 *  - API keys are never stored, logged or returned again: only an HMAC of the
 *    secret (peppered with a server-side secret) and a lookup prefix are kept.
 *  - A key belongs to exactly one workspace. The workspace id in the record — not
 *    a header, query parameter or body — is the tenant boundary used by every
 *    repository call.
 *  - Scopes are explicit; roles are only a shorthand that expands to a scope set.
 *  - Everything here is pure and clock-injectable so auth is fully testable offline.
 */

export type Scope =
  | "runs:read"
  | "runs:write"
  | "assets:read"
  | "assets:write"
  | "mappings:read"
  | "mappings:write"
  | "pipelines:read"
  | "pipelines:write"
  | "audit:read"
  | "workspaces:admin";

export const ALL_SCOPES: readonly Scope[] = [
  "runs:read",
  "runs:write",
  "assets:read",
  "assets:write",
  "mappings:read",
  "mappings:write",
  "pipelines:read",
  "pipelines:write",
  "audit:read",
  "workspaces:admin",
];

export type Role = "owner" | "editor" | "viewer" | "service";

/** Least-privilege expansion. `owner` is the only role that survives loss of admins. */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: ALL_SCOPES,
  editor: [
    "runs:read",
    "runs:write",
    "assets:read",
    "assets:write",
    "mappings:read",
    "mappings:write",
    "pipelines:read",
    "pipelines:write",
  ],
  viewer: ["runs:read", "assets:read", "mappings:read", "pipelines:read"],
  service: ["runs:read", "runs:write", "assets:read", "assets:write"],
};

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  role: Role;
  scopes: Scope[];
  /** Public, indexed lookup prefix of the key (`hb_xxxxxxxxxxxx`). */
  prefix: string;
  /** HMAC-SHA256(pepper, secret) as hex. The secret itself is never stored. */
  secretHash: string;
  createdAt: string;
  createdBy?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** A key as exposed to callers: never contains the hash. */
export interface ApiKeySummary {
  id: string;
  workspaceId: string;
  name: string;
  role: Role;
  scopes: Scope[];
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expired: boolean;
}

export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
  findById(id: string): Promise<ApiKeyRecord | undefined>;
  listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]>;
  save(record: ApiKeyRecord): Promise<void>;
  update(id: string, patch: Partial<ApiKeyRecord>): Promise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  public async findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined> {
    for (const record of this.records.values()) if (record.prefix === prefix) return { ...record };
    return undefined;
  }

  public async findById(id: string): Promise<ApiKeyRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  public async listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => ({ ...record }));
  }

  public async save(record: ApiKeyRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`API key ${record.id} already exists`);
    this.records.set(record.id, { ...record });
  }

  public async update(id: string, patch: Partial<ApiKeyRecord>): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`API key ${id} not found`);
    this.records.set(id, { ...record, ...patch, id: record.id, workspaceId: record.workspaceId });
  }
}

export type AuthFailureCode =
  "MISSING_CREDENTIALS" | "MALFORMED_KEY" | "UNKNOWN_KEY" | "REVOKED_KEY" | "EXPIRED_KEY" | "INSUFFICIENT_SCOPE";

export interface Principal {
  workspaceId: string;
  apiKeyId: string;
  keyName: string;
  role: Role;
  scopes: Scope[];
}

export type AuthResult =
  { ok: true; principal: Principal } | { ok: false; code: AuthFailureCode; message: string; requiredScope?: Scope };

export interface ApiKeyServiceOptions {
  /** Server-side secret mixed into every key hash. Rotating it invalidates all keys. */
  pepper: string;
  store: ApiKeyStore;
  now?: () => Date;
  idFactory?: () => string;
  /** Default lifetime; `undefined` means the key does not expire. */
  defaultTtlDays?: number;
  recordUsage?: boolean;
}

export interface IssueApiKeyInput {
  workspaceId: string;
  name: string;
  role: Role;
  scopes?: Scope[];
  expiresAt?: string;
  createdBy?: string;
}

export interface IssuedApiKey {
  /** The only time the secret exists in plaintext. */
  key: string;
  record: ApiKeyRecord;
}

const KEY_PREFIX = "hb";
const PREFIX_LENGTH = 12;
const SECRET_BYTES = 32;
const KEY_PATTERN = /^hb_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{40,64})$/;

export class ApiKeyService {
  private readonly store: ApiKeyStore;
  private readonly pepper: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly defaultTtlDays?: number;
  private readonly recordUsage: boolean;

  constructor(options: ApiKeyServiceOptions) {
    if (!options.pepper || options.pepper.length < 16) {
      throw new Error("API key pepper must be at least 16 characters");
    }
    this.store = options.store;
    this.pepper = options.pepper;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `key_${randomBytes(9).toString("hex")}`);
    this.defaultTtlDays = options.defaultTtlDays;
    this.recordUsage = options.recordUsage ?? true;
  }

  public async issue(input: IssueApiKeyInput): Promise<IssuedApiKey> {
    if (!input.workspaceId) throw new Error("workspaceId is required");
    if (!input.name?.trim()) throw new Error("API key name is required");

    const scopes = normaliseScopes(input.role, input.scopes);
    const prefix = randomBytes(9)
      .toString("base64url")
      .replace(/[^A-Za-z0-9]/g, "x")
      .slice(0, PREFIX_LENGTH)
      .padEnd(PREFIX_LENGTH, "x");
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const key = `${KEY_PREFIX}_${prefix}_${secret}`;

    const createdAt = this.now().toISOString();
    const expiresAt =
      input.expiresAt ??
      (this.defaultTtlDays === undefined
        ? undefined
        : new Date(this.now().getTime() + this.defaultTtlDays * 86_400_000).toISOString());

    const record: ApiKeyRecord = {
      id: this.idFactory(),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      role: input.role,
      scopes,
      prefix,
      secretHash: this.hashSecret(secret),
      createdAt,
      createdBy: input.createdBy,
      expiresAt,
    };

    await this.store.save(record);
    // The plaintext key is returned once and never persisted.
    return { key, record };
  }

  /**
   * Verify a raw key. `requiredScope` is checked after the key is proven valid so
   * callers can distinguish 401 (who are you) from 403 (not allowed).
   */
  public async authenticate(rawKey: string | undefined | null, requiredScope?: Scope): Promise<AuthResult> {
    if (!rawKey)
      return { ok: false, code: "MISSING_CREDENTIALS", message: "An API key is required (header: x-api-key)." };

    const match = KEY_PATTERN.exec(rawKey.trim());
    if (!match) return { ok: false, code: "MALFORMED_KEY", message: "The API key format is not recognised." };

    const [, prefix, secret] = match;
    const record = await this.store.findByPrefix(prefix);
    if (!record) return { ok: false, code: "UNKNOWN_KEY", message: "The API key is not valid." };

    if (!this.secretMatches(secret, record.secretHash)) {
      return { ok: false, code: "UNKNOWN_KEY", message: "The API key is not valid." };
    }
    if (record.revokedAt) {
      return { ok: false, code: "REVOKED_KEY", message: "The API key has been revoked." };
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      return { ok: false, code: "EXPIRED_KEY", message: "The API key has expired." };
    }

    const principal: Principal = {
      workspaceId: record.workspaceId,
      apiKeyId: record.id,
      keyName: record.name,
      role: record.role,
      scopes: [...record.scopes],
    };

    if (requiredScope && !principal.scopes.includes(requiredScope)) {
      return {
        ok: false,
        code: "INSUFFICIENT_SCOPE",
        message: `This key lacks the '${requiredScope}' scope.`,
        requiredScope,
      };
    }

    if (this.recordUsage) {
      await this.store.update(record.id, { lastUsedAt: this.now().toISOString() });
    }

    return { ok: true, principal };
  }

  public async revoke(id: string, workspaceId: string): Promise<ApiKeyRecord | undefined> {
    const record = await this.store.findById(id);
    if (!record) return undefined;
    // Tenant isolation: a key from another workspace is indistinguishable from a missing one.
    if (record.workspaceId !== workspaceId) return undefined;
    if (!record.revokedAt) await this.store.update(id, { revokedAt: this.now().toISOString() });
    return { ...record, revokedAt: record.revokedAt ?? this.now().toISOString() };
  }

  public async rotate(
    id: string,
    workspaceId: string,
    options: { name?: string } = {},
  ): Promise<IssuedApiKey | undefined> {
    const existing = await this.store.findById(id);
    if (!existing || existing.workspaceId !== workspaceId || existing.revokedAt) return undefined;

    await this.store.update(id, { revokedAt: this.now().toISOString() });
    return this.issue({
      workspaceId: existing.workspaceId,
      name: options.name ?? existing.name,
      role: existing.role,
      scopes: [...existing.scopes],
      expiresAt: existing.expiresAt,
      createdBy: existing.createdBy,
    });
  }

  public async list(workspaceId: string): Promise<ApiKeySummary[]> {
    const records = await this.store.listByWorkspace(workspaceId);
    return records.map((record) => this.summarise(record));
  }

  public summarise(record: ApiKeyRecord): ApiKeySummary {
    const { secretHash: _secretHash, ...rest } = record;
    return {
      ...rest,
      expired: record.expiresAt ? new Date(record.expiresAt).getTime() <= this.now().getTime() : false,
    };
  }

  public hashSecret(secret: string): string {
    return createHmac("sha256", this.pepper).update(secret).digest("hex");
  }

  private secretMatches(secret: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashSecret(secret), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}

export function normaliseScopes(role: Role, requested?: Scope[]): Scope[] {
  const allowed = new Set<Scope>(ROLE_SCOPES[role]);
  if (!requested || requested.length === 0) return [...allowed];
  const unknown = requested.filter((scope) => !ALL_SCOPES.includes(scope));
  if (unknown.length > 0) throw new Error(`Unknown scope(s): ${unknown.join(", ")}`);
  const forbidden = requested.filter((scope) => !allowed.has(scope));
  if (forbidden.length > 0) {
    throw new Error(`Role '${role}' cannot be granted scope(s): ${forbidden.join(", ")}`);
  }
  return [...new Set(requested)];
}

/**
 * Token-bucket rate limiter, keyed by API key id.
 *
 * In-process by design: with more than one API replica the limit must move to
 * Redis. That is recorded in the capability matrix rather than implied.
 */
export interface RateLimitOptions {
  /** Requests allowed in a burst. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: string;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    if (options.capacity <= 0) throw new Error("capacity must be positive");
    if (options.refillPerSecond <= 0) throw new Error("refillPerSecond must be positive");
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? (() => Date.now());
  }

  public consume(key: string, cost = 1): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    const tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);

    const allowed = tokens >= cost;
    const nextTokens = allowed ? tokens - cost : tokens;
    this.buckets.set(key, { tokens: nextTokens, updatedAt: now });

    const deficit = Math.max(0, cost - nextTokens);
    const retryAfterSeconds = allowed ? 0 : Math.ceil(deficit / this.refillPerSecond);

    return {
      allowed,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(nextTokens)),
      retryAfterSeconds,
      resetAt: new Date(now + retryAfterSeconds * 1000).toISOString(),
    };
  }

  /** Test/maintenance hook; not used in request handling. */
  public reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}
