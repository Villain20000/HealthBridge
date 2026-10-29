/**
 * Response DTOs as the API actually returns them (see docs/api.md).
 *
 * Where a browser-safe package already owns the type it is imported type-only, so the
 * console and the server cannot drift silently and nothing runtime-loadable leaks into the
 * bundle: `import type` is erased at build time.
 *
 * The record types (runs, assets, mappings, keys, workspaces) live in
 * `@healthbridge/persistence`, which is Node-only (mysql2), so they are mirrored here by
 * hand and checked by the contract tests in `apps/web/test`.
 */

export type {
  ValidationIssue,
  IssueSeverity,
  TraceEvent,
  TraceStage,
  CoverageReport,
  RejectedRecord,
} from "@healthbridge/shared-types";

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
  workspaceId: string;
  workspace_id?: string;
  storageKey: string;
  checksum: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  domain: string;
  sourceFormat: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
}

export interface Mapping {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  spec: unknown;
  specChecksum: string;
  sourceFormat: string;
  targetFormat: string;
  targetResourceType?: string;
  createdAt: string;
  createdBy?: string;
}

export interface Pipeline {
  id: string;
  workspaceId: string;
  name: string;
  mappingId: string;
  /** Engine options applied to every run of this pipeline. */
  config?: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
}

export interface Run {
  id: string;
  workspaceId: string;
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
  inputChecksum?: string;
  outputChecksum?: string;
  coverage?: Record<string, unknown>;
  validation?: { isValid?: boolean; issueCounts?: Record<string, number> };
  summary?: Record<string, unknown>;
  error?: { code?: string; message?: string } | null;
  options?: Record<string, unknown>;
  progress?: {
    stage?: string;
    stepName?: string;
    message?: string;
    percent?: number;
    recordsProcessed?: number;
    recordsTotal?: number;
  } | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  createdBy?: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorKeyId?: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ResourceItem {
  resourceType: string;
  id?: string;
  data?: unknown;
}

export interface RunResourcesResponse {
  resources: ResourceItem[];
  omitted?: boolean;
  bytes?: number;
  note?: string;
}

export interface RunIssuesResponse {
  /** Validation problems across the run. */
  issues: import("@healthbridge/shared-types").ValidationIssue[];
  /** Records the engine refused to emit at all (fatal issues). */
  rejected: unknown[];
}

/**
 * A stored trace row (as `GET /runs/:id/traces` returns it). The payload is the redacted
 * protocol event; `TraceEvent` describes its inner shape.
 */
export interface StoredTrace {
  seq: number;
  runId?: string;
  stage: string;
  stepName?: string;
  status?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface RunTracesResponse {
  traces: StoredTrace[];
  count: number;
}

export interface CreatedWorkspace {
  workspace: Workspace;
  apiKey: { id: string; key: string; prefix: string };
}

/**
 * `POST /keys` and `POST /keys/:id/rotate` return the secret once in `key`, next to the
 * record itself in `apiKey`. The secret is never returned again.
 */
export interface CreatedKey {
  key: string;
  apiKey: ApiKeyRecord;
  note?: string;
  revoked?: string;
}

/** What every failing API call becomes, so the UI never shows a raw HttpErrorResponse. */
export interface ApiProblem {
  status: number;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

/**
 * Collection envelopes, exactly as the controllers return them.
 * `nextCursor` is omitted when the page is the last one.
 */
export interface RunsPage {
  runs: Run[];
  nextCursor?: string;
}

export interface AssetsPage {
  assets: Asset[];
  nextCursor?: string;
}

export interface MappingsPage {
  mappings: Mapping[];
  nextCursor?: string;
}

export interface PipelinesPage {
  pipelines: Pipeline[];
  nextCursor?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor?: string;
}

export interface KeysResponse {
  keys: ApiKeyRecord[];
}

export interface WorkspaceResponse {
  workspace: Workspace;
  key?: ApiKeyRecord;
}
