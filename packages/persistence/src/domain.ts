/**
 * Persistence contracts.
 *
 * Every repository method takes a `workspaceId` as its first argument. There is
 * deliberately no "look up by id only" variant: tenant isolation is enforced at
 * the type level so it is impossible to forget, and a record that belongs to
 * another workspace is reported as `NOT_FOUND` rather than `FORBIDDEN` so that
 * identifiers from other tenants cannot be probed.
 */

import type { ApiKeyStore } from "@healthbridge/auth";
import type { RunStatus } from "@healthbridge/shared-types";

export type { RunStatus };

/** Statuses a run can never leave; retention may delete rows in these states. */
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["completed", "completed_with_warnings", "failed", "cancelled"];

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  plan: string;
  retentionDays: number;
  createdAt: string;
  createdBy?: string;
  deletedAt?: string;
}

export interface AssetRecord {
  id: string;
  workspaceId: string;
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

export interface MappingRecord {
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

export interface MappingDraftRecord {
  workspaceId: string;
  name: string;
  spec: unknown;
  specChecksum: string;
  revision: number;
  baseVersion?: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface PipelineRecord {
  id: string;
  workspaceId: string;
  name: string;
  mappingId: string;
  config?: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
}

export interface RunProgress {
  stage: string;
  stepName: string;
  recordsProcessed: number;
  recordsTotal?: number;
  percent?: number;
  message?: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  mappingId: string;
  pipelineId?: string;
  assetId?: string;
  status: RunStatus;
  idempotencyKey?: string;
  requestChecksum?: string;
  engineVersion: string;
  adapterId?: string;
  adapterVersion?: string;
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  inputChecksum?: string;
  outputChecksum?: string;
  coverage?: unknown;
  validation?: unknown;
  summary?: unknown;
  /** Materialised output is stored inline for demo scale; see docs/architecture.md. */
  result?: { resources: unknown[] };
  error?: { code: string; message: string };
  options?: Record<string, unknown>;
  progress?: RunProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  createdBy?: string;
}

export interface RunTraceRecord {
  runId: string;
  seq: number;
  stage: string;
  stepName: string;
  status: string;
  durationMs?: number;
  payload: unknown;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorKeyId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  createdAt: string;
}

export interface IdempotencyRecord {
  workspaceId: string;
  key: string;
  requestChecksum: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  expiresAt: string;
}

export type PersistenceErrorCode = "NOT_FOUND" | "CONFLICT" | "IDEMPOTENCY_CONFLICT" | "INVALID_ARGUMENT";

export class PersistenceError extends Error {
  constructor(
    public readonly code: PersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
/** Upper bound for one retention batch, so a sweep never holds an unbounded result. */
export const RETENTION_BATCH_LIMIT = 500;

interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    return parsed;
  } catch {
    throw new PersistenceError("INVALID_ARGUMENT", "Malformed pagination cursor.");
  }
}

export function normalisePage(request: PageRequest = {}): { limit: number; cursor?: CursorPayload } {
  const limit = request.limit === undefined ? DEFAULT_PAGE_SIZE : Math.trunc(request.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new PersistenceError("INVALID_ARGUMENT", "limit must be a positive integer");
  }
  return {
    limit: Math.min(limit, MAX_PAGE_SIZE),
    cursor: request.cursor ? decodeCursor(request.cursor) : undefined,
  };
}

/** Keyset pagination comparison: newest first, id as tie-breaker. */
export function isAfterCursor(item: { createdAt: string; id: string }, cursor: CursorPayload): boolean {
  if (item.createdAt < cursor.createdAt) return true;
  if (item.createdAt > cursor.createdAt) return false;
  return item.id < cursor.id;
}

export interface WorkspaceRepository {
  create(workspace: Workspace): Promise<Workspace>;
  findById(id: string): Promise<Workspace | undefined>;
  findBySlug(slug: string): Promise<Workspace | undefined>;
  list(request?: PageRequest): Promise<Page<Workspace>>;
  /** Marks the workspace deleted without removing its data; the purge does that later. */
  softDelete(id: string, deletedAt: string): Promise<boolean>;
}

export interface AssetRepository {
  create(asset: AssetRecord): Promise<AssetRecord>;
  findById(workspaceId: string, id: string): Promise<AssetRecord | undefined>;
  list(workspaceId: string, request?: PageRequest): Promise<Page<AssetRecord>>;
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** Assets created before the cutoff, oldest first. Used by retention. */
  listExpired(workspaceId: string, createdBefore: string, limit?: number): Promise<AssetRecord[]>;
  /**
   * Cross-tenant read by design: storage is content-addressed, so identical bytes
   * in two workspaces share one object. Orphan collection must consider every
   * tenant before deleting a blob.
   */
  storageKeyInUse(storageKey: string): Promise<boolean>;
}

export interface MappingRepository {
  /** Creates the next version of a mapping; the same name is never overwritten. */
  create(mapping: Omit<MappingRecord, "version"> & { version?: number }): Promise<MappingRecord>;
  findById(workspaceId: string, id: string): Promise<MappingRecord | undefined>;
  findLatestByName(workspaceId: string, name: string): Promise<MappingRecord | undefined>;
  list(workspaceId: string, request?: PageRequest): Promise<Page<MappingRecord>>;
  versions(workspaceId: string, name: string): Promise<MappingRecord[]>;
}

export interface MappingDraftRepository {
  get(workspaceId: string, name: string): Promise<MappingDraftRecord | undefined>;
  save(input: Omit<MappingDraftRecord, "revision">, expectedRevision: number): Promise<MappingDraftRecord>;
  delete(workspaceId: string, name: string, expectedRevision?: number): Promise<boolean>;
}

export interface PipelineRepository {
  create(pipeline: PipelineRecord): Promise<PipelineRecord>;
  findById(workspaceId: string, id: string): Promise<PipelineRecord | undefined>;
  findByName(workspaceId: string, name: string): Promise<PipelineRecord | undefined>;
  list(workspaceId: string, request?: PageRequest): Promise<Page<PipelineRecord>>;
}

export interface RunRepository {
  create(run: RunRecord): Promise<{ run: RunRecord; created: boolean }>;
  findById(workspaceId: string, id: string): Promise<RunRecord | undefined>;
  findByIdempotencyKey(workspaceId: string, key: string): Promise<RunRecord | undefined>;
  update(workspaceId: string, id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined>;
  list(workspaceId: string, request?: PageRequest & { status?: RunStatus }): Promise<Page<RunRecord>>;
  appendTraces(workspaceId: string, runId: string, traces: Omit<RunTraceRecord, "runId">[]): Promise<number>;
  listTraces(workspaceId: string, runId: string): Promise<RunTraceRecord[]>;
  /** Removes the run and every child row (traces, resource index, jobs). */
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** Terminal runs finished before the cutoff, oldest first. Used by retention. */
  listExpired(workspaceId: string, finishedBefore: string, limit?: number): Promise<RunRecord[]>;
  countByAsset(workspaceId: string, assetId: string): Promise<number>;
}

export interface AuditRepository {
  append(event: Omit<AuditEvent, "createdAt"> & { createdAt?: string }): Promise<AuditEvent>;
  list(workspaceId: string, request?: PageRequest): Promise<Page<AuditEvent>>;
}

export interface IdempotencyStore {
  get(workspaceId: string, key: string): Promise<IdempotencyRecord | undefined>;
  save(record: IdempotencyRecord): Promise<void>;
  /** Frees the keys that indexed a resource that no longer exists. */
  deleteByResource(workspaceId: string, resourceType: string, resourceId: string): Promise<number>;
}

export interface WorkspacePurgeRecord {
  workspaceId: string;
  workspaceSlug: string;
  /** When the workspace may be hard-deleted. */
  scheduledAt: string;
  requestedAt: string;
  requestedBy?: string;
}

export interface WorkspacePurgeRepository {
  schedule(record: WorkspacePurgeRecord): Promise<WorkspacePurgeRecord>;
  find(workspaceId: string): Promise<WorkspacePurgeRecord | undefined>;
  /** Purges due at or before `now`, earliest first. */
  listDue(now: string, limit?: number): Promise<WorkspacePurgeRecord[]>;
  remove(workspaceId: string): Promise<boolean>;
  /**
   * Hard-deletes the workspace and every tenant row. Returns the content-addressed
   * storage keys that were referenced by its assets; the caller deletes an object
   * only after checking it is not shared with another workspace.
   */
  purge(workspaceId: string): Promise<string[]>;
}

/**
 * Platform-level audit that survives workspace deletion. The tenant audit trail
 * cascades with the workspace; records of deletion and purge must not.
 */
export interface PlatformAuditEvent {
  id: string;
  workspaceId: string;
  workspaceSlug?: string;
  actorKeyId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PlatformAuditRepository {
  append(event: PlatformAuditEvent): Promise<PlatformAuditEvent>;
  list(request?: PageRequest & { workspaceId?: string }): Promise<Page<PlatformAuditEvent>>;
}

export interface Repositories {
  readonly mode: "memory" | "mysql";
  workspaces: WorkspaceRepository;
  /** Auth package contract: keys are stored hashed, never in plaintext. */
  apiKeys: ApiKeyStore;
  assets: AssetRepository;
  mappings: MappingRepository;
  mappingDrafts: MappingDraftRepository;
  pipelines: PipelineRepository;
  runs: RunRepository;
  audit: AuditRepository;
  idempotency: IdempotencyStore;
  workspacePurges: WorkspacePurgeRepository;
  platformAudit: PlatformAuditRepository;
  close(): Promise<void>;
}

export function requireRecords(count: number, message: string): void {
  if (count <= 0) throw new PersistenceError("INVALID_ARGUMENT", message);
}
