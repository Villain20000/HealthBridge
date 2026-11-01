/**
 * `@healthbridge/client` — typed REST client for the HealthBridge OS API (v1).
 *
 * One method per documented endpoint (see `docs/api.md`; the machine contract
 * is `docs/openapi.json`). Runtime-dependency free: it only needs a global
 * `fetch` (Node 22+, browsers, edge runtimes). Response DTOs are hand-mirrored
 * from `apps/web/src/app/core/api-types.ts` and checked against the live API
 * by `test/client.test.ts`.
 *
 * Auth: every endpoint except `/healthz`, `/version`, `/formats` and
 * `POST /workspaces` needs an API key (`x-api-key`). Workspace provisioning
 * needs the operator-held bootstrap token (`x-bootstrap-token`) instead.
 */

export type RunStatus =
  "queued" | "running" | "cancelling" | "cancelled" | "completed" | "completed_with_warnings" | "failed";

export interface HealthLimits {
  maxUploadBytes: number;
  maxRequestBodyBytes: number;
  maxStoredResultBytes: number;
  maxTracesPerRun: number;
  rateLimit: { burst: number; refillPerSecond: number };
  queue: { concurrency: number; maxAttempts: number };
}

export interface Health {
  status: "ok";
  mode: "demo" | "database";
  nodeEnv: string;
  persistence: string;
  storage: string;
  queue: { active: number; queued: number; mode: "durable" | "process" };
  limits: HealthLimits;
  startedAt: string;
  uptimeSeconds: number;
}

export interface VersionInfo {
  engine: string;
  traceProtocol: string;
  api: string;
  node: string;
  persistence: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  plan: string;
  retentionDays: number;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer" | "service";
  scopes: string[];
  prefix: string;
  createdAt: string;
  createdBy?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface Asset {
  id: string;
  checksum: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  domain: string;
  sourceFormat: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Adapter inspect/schema summary for one stored asset. */
export interface AssetSchema {
  assetId: string;
  /** Detected format, or the stored `sourceFormat` when no adapter accepts the bytes. */
  format: string;
  formatVersion?: string;
  domain: string;
  /** False + null schema when no registered adapter accepts the asset. */
  supported: boolean;
  adapterId?: string;
  recordCount?: number;
  confidence?: number;
  /** Detected field summary; null when unsupported. */
  schema: { fields: Array<{ name: string; type: string }> } | null;
  warnings?: string[];
}

export interface Mapping {
  id: string;
  name: string;
  version: number;
  spec: unknown;
  specChecksum: string;
  sourceFormat: string;
  targetFormat: string;
  targetResourceType?: string;
  createdAt: string;
}

export interface Pipeline {
  id: string;
  name: string;
  mappingId: string;
  config?: Record<string, unknown>;
  createdAt: string;
}

export interface Run {
  id: string;
  mappingId: string;
  pipelineId?: string;
  assetId: string;
  status: RunStatus;
  engineVersion: string;
  adapterId?: string;
  adapterVersion?: string;
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  createdAt: string;
  finishedAt?: string;
  error?: { code?: string; message?: string } | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  outcome: "success" | "failure";
  targetType: string;
  targetId: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface RunResourcesResponse {
  resources: unknown[];
  omitted?: boolean;
  bytes?: number;
  note?: string;
}

export interface RunIssuesResponse {
  issues: unknown[];
  rejected: unknown[];
}

export interface RunTracesResponse {
  traces: unknown[];
  count: number;
}

export interface CreatedWorkspace {
  workspace: Workspace;
  apiKey: { id: string; key: string; prefix: string };
}

export interface CreatedKey {
  key: string;
  apiKey: ApiKeyRecord;
  note?: string;
  revoked?: string;
}

/** The API's shared failure envelope (`docs/api.md` § Errors). */
export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
  statusCode: number;
}

export class HealthBridgeApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(status: number, body: Partial<ApiErrorBody["error"]> & { code: string; message: string }) {
    super(body.message);
    this.name = "HealthBridgeApiError";
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

export interface HealthBridgeClientConfig {
  /** Origin serving the API, e.g. `http://localhost:3000`. `/api/v1` is appended. */
  baseUrl: string;
  /** Sent as `x-api-key` on every call that needs workspace auth. */
  apiKey?: string;
  /** Sent as `x-bootstrap-token` by `createWorkspace` when no per-call token is given. */
  bootstrapToken?: string;
  /** Override for tests and edge runtimes; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Default idempotency key header for run creation when the caller passes none. */
  idempotencyKey?: string;
}

type QueryValue = string | number | boolean | undefined;

function appendQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

const IDEMPOTENCY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class HealthBridgeClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly bootstrapToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly idempotencyKey?: string;

  constructor(config: HealthBridgeClientConfig) {
    if (!config.baseUrl) throw new Error("HealthBridgeClient needs a baseUrl.");
    this.base = `${config.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.apiKey = config.apiKey;
    this.bootstrapToken = config.bootstrapToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.idempotencyKey = config.idempotencyKey;
  }

  public get baseUrl(): string {
    return this.base;
  }

  /** Event-stream URL for one run; open it with `fetch` + `Accept: text/event-stream`. */
  public runEventsUrl(id: string): string {
    return `${this.base}/runs/${encodeURIComponent(id)}/events`;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      raw?: Uint8Array | ArrayBuffer;
      contentType?: string;
      bootstrapToken?: string;
      idempotencyKey?: string;
      apiKey?: string;
    } = {},
  ): Promise<T> {
    const url = `${this.base}${appendQuery(path, options.query ?? {})}`;
    const headers: Record<string, string> = {};
    const key = options.apiKey ?? this.apiKey;
    if (key) headers["x-api-key"] = key;
    const bootstrap = options.bootstrapToken ?? this.bootstrapToken;
    if (bootstrap && path === "/workspaces" && method === "POST") headers["x-bootstrap-token"] = bootstrap;
    const idempotency = options.idempotencyKey ?? this.idempotencyKey;
    if (idempotency && IDEMPOTENCY_METHODS.has(method)) headers["idempotency-key"] = idempotency;

    let body: BodyInit | undefined;
    if (options.raw !== undefined) {
      body = options.raw as BodyInit;
      headers["content-type"] = options.contentType ?? "application/octet-stream";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    const response = await this.fetchImpl(url, { method, headers, body });
    const text = await response.text();
    if (!response.ok) {
      let parsed: Partial<ApiErrorBody> = {};
      try {
        parsed = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : {};
      } catch {
        // Non-JSON failure (proxy, load balancer): keep the status and raw text.
      }
      throw new HealthBridgeApiError(response.status, {
        code: parsed.error?.code ?? "INTERNAL",
        message: parsed.error?.message ?? text ?? `Request failed with status ${response.status}`,
        requestId: parsed.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
        details: parsed.error?.details,
      });
    }
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  // ---- health / meta (public) ----

  public health(): Promise<Health> {
    return this.request<Health>("GET", "/healthz");
  }

  public version(): Promise<VersionInfo> {
    return this.request<VersionInfo>("GET", "/version");
  }

  public formats(): Promise<{ formats: unknown[] }> {
    return this.request("GET", "/formats");
  }

  // ---- workspaces / keys ----

  public createWorkspace(
    input: { name: string; slug: string; plan?: string },
    bootstrapToken?: string,
  ): Promise<CreatedWorkspace> {
    return this.request("POST", "/workspaces", { body: input, bootstrapToken });
  }

  public currentWorkspace(): Promise<{ workspace: Workspace; key?: ApiKeyRecord }> {
    return this.request("GET", "/workspaces/current");
  }

  public listKeys(): Promise<{ keys: ApiKeyRecord[] }> {
    return this.request("GET", "/keys");
  }

  public createKey(input: { name: string; role?: string; scopes?: string[]; expiresAt?: string }): Promise<CreatedKey> {
    return this.request("POST", "/keys", { body: input });
  }

  public rotateKey(id: string): Promise<CreatedKey> {
    return this.request("POST", `/keys/${encodeURIComponent(id)}/rotate`, { body: {} });
  }

  public revokeKey(id: string): Promise<{ revoked: boolean; id: string }> {
    return this.request("DELETE", `/keys/${encodeURIComponent(id)}`);
  }

  // ---- assets ----

  public async uploadAsset(
    bytes: Uint8Array | ArrayBuffer,
    options: { filename?: string; contentType?: string; domain?: string; format?: string } = {},
  ): Promise<Asset> {
    const response = await this.request<{ asset: Asset }>("POST", "/assets", {
      query: { filename: options.filename, domain: options.domain, format: options.format },
      raw: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      contentType: options.contentType,
    });
    return response.asset;
  }

  public listAssets(options: { limit?: number; cursor?: string } = {}): Promise<Page<Asset>> {
    return this.request<{ assets: Asset[]; nextCursor?: string }>("GET", "/assets", {
      query: { limit: options.limit, cursor: options.cursor },
    }).then(({ assets, nextCursor }) => ({ items: assets, nextCursor }));
  }

  public async getAsset(id: string): Promise<Asset> {
    const response = await this.request<{ asset: Asset }>("GET", `/assets/${encodeURIComponent(id)}`);
    return response.asset;
  }

  public async getAssetSchema(id: string): Promise<AssetSchema> {
    return this.request<AssetSchema>("GET", `/assets/${encodeURIComponent(id)}/schema`);
  }

  public async downloadAsset(id: string): Promise<{ bytes: Uint8Array; checksum: string | null }> {
    const url = `${this.base}/assets/${encodeURIComponent(id)}/content`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const response = await this.fetchImpl(url, { method: "GET", headers });
    if (!response.ok) {
      const text = await response.text();
      let parsed: Partial<ApiErrorBody> = {};
      try {
        parsed = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : {};
      } catch {
        // Keep the status and raw text.
      }
      throw new HealthBridgeApiError(response.status, {
        code: parsed.error?.code ?? "INTERNAL",
        message: parsed.error?.message ?? text ?? `Download failed with status ${response.status}`,
        requestId: parsed.error?.requestId ?? undefined,
      });
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      checksum: response.headers.get("x-checksum"),
    };
  }

  // ---- mappings ----

  public async createMapping(input: {
    name: string;
    spec: unknown;
    sourceFormat?: string;
    targetFormat?: string;
    targetResourceType?: string;
  }): Promise<Mapping> {
    const response = await this.request<{ mapping: Mapping }>("POST", "/mappings", { body: input });
    return response.mapping;
  }

  public listMappings(options: { limit?: number; cursor?: string } = {}): Promise<Page<Mapping>> {
    return this.request<{ mappings: Mapping[]; nextCursor?: string }>("GET", "/mappings", {
      query: { limit: options.limit, cursor: options.cursor },
    }).then(({ mappings, nextCursor }) => ({ items: mappings, nextCursor }));
  }

  public async getMapping(id: string): Promise<Mapping> {
    const response = await this.request<{ mapping: Mapping }>("GET", `/mappings/${encodeURIComponent(id)}`);
    return response.mapping;
  }

  public listMappingVersions(name: string): Promise<{ name: string; versions: Mapping[] }> {
    return this.request("GET", `/mappings/${encodeURIComponent(name)}/versions`);
  }

  // ---- pipelines ----

  public async createPipeline(input: {
    name: string;
    mappingId: string;
    config?: Record<string, unknown>;
  }): Promise<Pipeline> {
    const response = await this.request<{ pipeline: Pipeline }>("POST", "/pipelines", { body: input });
    return response.pipeline;
  }

  public listPipelines(options: { limit?: number; cursor?: string } = {}): Promise<Page<Pipeline>> {
    return this.request<{ pipelines: Pipeline[]; nextCursor?: string }>("GET", "/pipelines", {
      query: { limit: options.limit, cursor: options.cursor },
    }).then(({ pipelines, nextCursor }) => ({ items: pipelines, nextCursor }));
  }

  public async getPipeline(id: string): Promise<{ pipeline: Pipeline; mapping: Mapping }> {
    return this.request("GET", `/pipelines/${encodeURIComponent(id)}`);
  }

  // ---- runs ----

  public createRun(
    input: {
      assetId: string;
      mappingId?: string;
      mappingName?: string;
      pipelineId?: string;
      options?: { maxRecords?: number; importedAt?: string; adapterId?: string; pipelineVersion?: string };
    },
    idempotencyKey?: string,
  ): Promise<{ run: Run; created: boolean; links: Record<string, string> }> {
    return this.request("POST", "/runs", { body: input, idempotencyKey });
  }

  public listRuns(options: { limit?: number; cursor?: string; status?: RunStatus } = {}): Promise<Page<Run>> {
    return this.request<{ runs: Run[]; nextCursor?: string }>("GET", "/runs", {
      query: { limit: options.limit, cursor: options.cursor, status: options.status },
    }).then(({ runs, nextCursor }) => ({ items: runs, nextCursor }));
  }

  public async getRun(id: string): Promise<Run> {
    const response = await this.request<{ run: Run }>("GET", `/runs/${encodeURIComponent(id)}`);
    return response.run;
  }

  public getRunResources(id: string): Promise<RunResourcesResponse> {
    return this.request("GET", `/runs/${encodeURIComponent(id)}/resources`);
  }

  public getRunIssues(id: string): Promise<RunIssuesResponse> {
    return this.request("GET", `/runs/${encodeURIComponent(id)}/issues`);
  }

  public getRunTraces(id: string): Promise<RunTracesResponse> {
    return this.request("GET", `/runs/${encodeURIComponent(id)}/traces`);
  }

  public getRunBundle(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/runs/${encodeURIComponent(id)}/bundle`);
  }

  public async cancelRun(id: string): Promise<Run> {
    const response = await this.request<{ run: Run }>("POST", `/runs/${encodeURIComponent(id)}/cancel`, {
      body: {},
    });
    return response.run;
  }

  public replayRun(id: string): Promise<{ run: Run; created: boolean; replayedFrom: string }> {
    return this.request("POST", `/runs/${encodeURIComponent(id)}/replay`, { body: {} });
  }

  // ---- audit ----

  public listAudit(options: { limit?: number; cursor?: string } = {}): Promise<Page<AuditEvent>> {
    return this.request<{ events: AuditEvent[]; nextCursor?: string }>("GET", "/audit", {
      query: { limit: options.limit, cursor: options.cursor },
    }).then(({ events, nextCursor }) => ({ items: events, nextCursor }));
  }
}
