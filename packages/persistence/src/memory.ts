import { InMemoryApiKeyStore } from "@healthbridge/auth";
import {
  AssetRecord,
  AuditEvent,
  AuditRepository,
  IdempotencyRecord,
  IdempotencyStore,
  MappingDraftRecord,
  MappingDraftRepository,
  MappingRecord,
  MappingRepository,
  Page,
  PageRequest,
  PersistenceError,
  PipelineRecord,
  PipelineRepository,
  Repositories,
  RunRecord,
  RunRepository,
  RunStatus,
  RunTraceRecord,
  Workspace,
  WorkspaceRepository,
  isAfterCursor,
  normalisePage,
} from "./domain.js";

/**
 * In-memory repositories.
 *
 * They are not a toy: they implement the same contracts, tenant scoping and
 * pagination semantics as the SQL implementations, and the API uses them for the
 * offline demo mode. They are not durable, so they are never used when a
 * database is configured.
 */

function paginate<T extends { createdAt: string; id: string }>(items: T[], request: PageRequest = {}): Page<T> {
  const { limit, cursor } = normalisePage(request);
  const ordered = [...items].sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  const filtered = cursor ? ordered.filter((item) => isAfterCursor(item, cursor)) : ordered;
  const page = filtered.slice(0, limit);
  const next = filtered.length > limit ? page[page.length - 1] : undefined;
  return { items: page, nextCursor: next ? encode(next) : undefined };
}

function encode(item: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id }), "utf-8").toString("base64url");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertExpectedRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new PersistenceError("INVALID_ARGUMENT", "expectedRevision must be a non-negative integer.");
  }
}

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly items = new Map<string, Workspace>();

  public async create(workspace: Workspace): Promise<Workspace> {
    for (const existing of this.items.values()) {
      if (existing.slug === workspace.slug) {
        throw new PersistenceError("CONFLICT", `Workspace slug '${workspace.slug}' is already taken.`);
      }
    }
    if (this.items.has(workspace.id)) throw new PersistenceError("CONFLICT", `Workspace ${workspace.id} exists.`);
    this.items.set(workspace.id, clone(workspace));
    return clone(workspace);
  }

  public async findById(id: string): Promise<Workspace | undefined> {
    const found = this.items.get(id);
    return found && !found.deletedAt ? clone(found) : undefined;
  }

  public async findBySlug(slug: string): Promise<Workspace | undefined> {
    for (const item of this.items.values()) if (item.slug === slug && !item.deletedAt) return clone(item);
    return undefined;
  }

  public async list(request: PageRequest = {}): Promise<Page<Workspace>> {
    return paginate(
      [...this.items.values()].filter((item) => !item.deletedAt),
      request,
    );
  }
}

export class InMemoryAssetRepository {
  private readonly items = new Map<string, AssetRecord>();

  public async create(asset: AssetRecord): Promise<AssetRecord> {
    if (this.items.has(asset.id)) throw new PersistenceError("CONFLICT", `Asset ${asset.id} exists.`);
    this.items.set(asset.id, clone(asset));
    return clone(asset);
  }

  public async findById(workspaceId: string, id: string): Promise<AssetRecord | undefined> {
    const found = this.items.get(id);
    return found && found.workspaceId === workspaceId ? clone(found) : undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<AssetRecord>> {
    const scoped = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    const page = paginate(scoped, request);
    return { items: page.items.map(clone), nextCursor: page.nextCursor };
  }

  public async delete(workspaceId: string, id: string): Promise<boolean> {
    const found = this.items.get(id);
    if (!found || found.workspaceId !== workspaceId) return false;
    this.items.delete(id);
    return true;
  }
}

export class InMemoryMappingRepository implements MappingRepository {
  private readonly items = new Map<string, MappingRecord>();

  public async create(mapping: Omit<MappingRecord, "version"> & { version?: number }): Promise<MappingRecord> {
    const siblings = [...this.items.values()].filter(
      (item) => item.workspaceId === mapping.workspaceId && item.name === mapping.name,
    );
    const version = mapping.version ?? Math.max(0, ...siblings.map((item) => item.version)) + 1;
    if (siblings.some((item) => item.version === version)) {
      throw new PersistenceError("CONFLICT", `Mapping '${mapping.name}' already has version ${version}.`);
    }
    const record: MappingRecord = { ...mapping, version };
    this.items.set(record.id, clone(record));
    return clone(record);
  }

  public async findById(workspaceId: string, id: string): Promise<MappingRecord | undefined> {
    const found = this.items.get(id);
    return found && found.workspaceId === workspaceId ? clone(found) : undefined;
  }

  public async findLatestByName(workspaceId: string, name: string): Promise<MappingRecord | undefined> {
    const matches = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && item.name === name)
      .sort((a, b) => b.version - a.version);
    return matches[0] ? clone(matches[0]) : undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<MappingRecord>> {
    const latest = new Map<string, MappingRecord>();
    for (const item of this.items.values()) {
      if (item.workspaceId !== workspaceId) continue;
      const seen = latest.get(item.name);
      if (!seen || item.version > seen.version) latest.set(item.name, item);
    }
    const page = paginate([...latest.values()], request);
    return { items: page.items.map(clone), nextCursor: page.nextCursor };
  }

  public async versions(workspaceId: string, name: string): Promise<MappingRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && item.name === name)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }
}

export class InMemoryMappingDraftRepository implements MappingDraftRepository {
  private readonly items = new Map<string, MappingDraftRecord>();

  private keyOf(workspaceId: string, name: string): string {
    return `${workspaceId}\u0000${name}`;
  }

  public async get(workspaceId: string, name: string): Promise<MappingDraftRecord | undefined> {
    const found = this.items.get(this.keyOf(workspaceId, name));
    return found ? clone(found) : undefined;
  }

  public async save(
    input: Omit<MappingDraftRecord, "revision">,
    expectedRevision: number,
  ): Promise<MappingDraftRecord> {
    assertExpectedRevision(expectedRevision);
    const key = this.keyOf(input.workspaceId, input.name);
    const existing = this.items.get(key);

    if (expectedRevision === 0) {
      if (existing) throw new PersistenceError("CONFLICT", `Draft '${input.name}' already exists.`);
      const record: MappingDraftRecord = { ...clone(input), revision: 1 };
      this.items.set(key, record);
      return clone(record);
    }

    if (!existing || existing.revision !== expectedRevision) {
      throw new PersistenceError(
        "CONFLICT",
        `Draft '${input.name}' is at revision ${existing?.revision ?? "none"}, expected ${expectedRevision}.`,
      );
    }

    const record: MappingDraftRecord = {
      ...clone(input),
      revision: expectedRevision + 1,
      createdAt: existing.createdAt,
    };
    this.items.set(key, record);
    return clone(record);
  }

  public async delete(workspaceId: string, name: string, expectedRevision?: number): Promise<boolean> {
    if (expectedRevision !== undefined) assertExpectedRevision(expectedRevision);
    const key = this.keyOf(workspaceId, name);
    const existing = this.items.get(key);
    if (!existing) return false;
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) return false;
    this.items.delete(key);
    return true;
  }
}

export class InMemoryPipelineRepository implements PipelineRepository {
  private readonly items = new Map<string, PipelineRecord>();

  public async create(pipeline: PipelineRecord): Promise<PipelineRecord> {
    for (const existing of this.items.values()) {
      if (existing.workspaceId === pipeline.workspaceId && existing.name === pipeline.name) {
        throw new PersistenceError("CONFLICT", `Pipeline '${pipeline.name}' already exists.`);
      }
    }
    this.items.set(pipeline.id, clone(pipeline));
    return clone(pipeline);
  }

  public async findById(workspaceId: string, id: string): Promise<PipelineRecord | undefined> {
    const found = this.items.get(id);
    return found && found.workspaceId === workspaceId ? clone(found) : undefined;
  }

  public async findByName(workspaceId: string, name: string): Promise<PipelineRecord | undefined> {
    for (const item of this.items.values()) {
      if (item.workspaceId === workspaceId && item.name === name) return clone(item);
    }
    return undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<PipelineRecord>> {
    const scoped = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    const page = paginate(scoped, request);
    return { items: page.items.map(clone), nextCursor: page.nextCursor };
  }
}

export class InMemoryRunRepository implements RunRepository {
  private readonly items = new Map<string, RunRecord>();
  private readonly traces = new Map<string, RunTraceRecord[]>();

  public async create(run: RunRecord): Promise<{ run: RunRecord; created: boolean }> {
    if (run.idempotencyKey) {
      for (const existing of this.items.values()) {
        if (existing.workspaceId === run.workspaceId && existing.idempotencyKey === run.idempotencyKey) {
          if (existing.requestChecksum && run.requestChecksum && existing.requestChecksum !== run.requestChecksum) {
            throw new PersistenceError(
              "IDEMPOTENCY_CONFLICT",
              "The Idempotency-Key was already used with a different request payload.",
            );
          }
          return { run: clone(existing), created: false };
        }
      }
    }
    this.items.set(run.id, clone(run));
    return { run: clone(run), created: true };
  }

  public async findById(workspaceId: string, id: string): Promise<RunRecord | undefined> {
    const found = this.items.get(id);
    return found && found.workspaceId === workspaceId ? clone(found) : undefined;
  }

  public async findByIdempotencyKey(workspaceId: string, key: string): Promise<RunRecord | undefined> {
    for (const item of this.items.values()) {
      if (item.workspaceId === workspaceId && item.idempotencyKey === key) return clone(item);
    }
    return undefined;
  }

  public async update(workspaceId: string, id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const found = this.items.get(id);
    if (!found || found.workspaceId !== workspaceId) return undefined;
    const next: RunRecord = { ...found, ...patch, id: found.id, workspaceId: found.workspaceId };
    this.items.set(id, next);
    return clone(next);
  }

  public async list(workspaceId: string, request: PageRequest & { status?: RunStatus } = {}): Promise<Page<RunRecord>> {
    const scoped = [...this.items.values()].filter(
      (item) => item.workspaceId === workspaceId && (request.status ? item.status === request.status : true),
    );
    const page = paginate(scoped, request);
    return { items: page.items.map(clone), nextCursor: page.nextCursor };
  }

  public async appendTraces(
    workspaceId: string,
    runId: string,
    traces: Omit<RunTraceRecord, "runId">[],
  ): Promise<number> {
    const run = this.items.get(runId);
    if (!run || run.workspaceId !== workspaceId) {
      throw new PersistenceError("NOT_FOUND", `Run ${runId} not found in this workspace.`);
    }
    const existing = this.traces.get(runId) ?? [];
    const nextSeq = existing.length === 0 ? 0 : Math.max(...existing.map((trace) => trace.seq)) + 1;
    const appended = traces.map((trace, index) => ({
      ...clone(trace),
      runId,
      seq: nextSeq + index,
    }));
    this.traces.set(runId, [...existing, ...appended]);
    return appended.length;
  }

  public async listTraces(workspaceId: string, runId: string): Promise<RunTraceRecord[]> {
    const run = this.items.get(runId);
    if (!run || run.workspaceId !== workspaceId) {
      throw new PersistenceError("NOT_FOUND", `Run ${runId} not found in this workspace.`);
    }
    return (this.traces.get(runId) ?? []).map(clone).sort((a, b) => a.seq - b.seq);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly items = new Map<string, AuditEvent>();

  public async append(event: Omit<AuditEvent, "createdAt"> & { createdAt?: string }): Promise<AuditEvent> {
    const record: AuditEvent = { ...event, createdAt: event.createdAt ?? new Date().toISOString() };
    this.items.set(record.id, clone(record));
    return clone(record);
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<AuditEvent>> {
    const scoped = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    const page = paginate(scoped, request);
    return { items: page.items.map(clone), nextCursor: page.nextCursor };
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly items = new Map<string, IdempotencyRecord>();

  private keyOf(workspaceId: string, key: string): string {
    return `${workspaceId}::${key}`;
  }

  public async get(workspaceId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const found = this.items.get(this.keyOf(workspaceId, key));
    if (!found) return undefined;
    if (new Date(found.expiresAt).getTime() <= Date.now()) {
      this.items.delete(this.keyOf(workspaceId, key));
      return undefined;
    }
    return clone(found);
  }

  public async save(record: IdempotencyRecord): Promise<void> {
    this.items.set(this.keyOf(record.workspaceId, record.key), clone(record));
  }
}

export function createMemoryRepositories(): Repositories {
  return {
    mode: "memory",
    workspaces: new InMemoryWorkspaceRepository(),
    apiKeys: new InMemoryApiKeyStore(),
    assets: new InMemoryAssetRepository(),
    mappings: new InMemoryMappingRepository(),
    mappingDrafts: new InMemoryMappingDraftRepository(),
    pipelines: new InMemoryPipelineRepository(),
    runs: new InMemoryRunRepository(),
    audit: new InMemoryAuditRepository(),
    idempotency: new InMemoryIdempotencyStore(),
    close: async () => undefined,
  };
}
