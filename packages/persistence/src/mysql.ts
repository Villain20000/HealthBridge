import {
  AssetRecord,
  AssetRepository,
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
  PlatformAuditEvent,
  PlatformAuditRepository,
  RETENTION_BATCH_LIMIT,
  Repositories,
  RunRecord,
  RunRepository,
  RunStatus,
  RunTraceRecord,
  TERMINAL_RUN_STATUSES,
  Workspace,
  WorkspacePurgeRecord,
  WorkspacePurgeRepository,
  WorkspaceRepository,
  normalisePage,
} from "./domain.js";
import { MySqlApiKeyStore } from "./api-keys.mysql.js";
import { MigrationRunner, toSqlDate } from "./migrations.js";
import { SqlConnection, SqlExecutor } from "./sql.js";

/**
 * MySQL implementations.
 *
 * Rules every statement in this file follows:
 *  1. Tenant-scoped reads and writes always carry `workspace_id = ?` as a bound
 *     parameter — never string-interpolated, never optional.
 *  2. Pagination is keyset-based (`created_at`, `id`), so deep pages stay O(log n)
 *     and inserts never shift a page.
 *  3. Values are always bound (`?`); the only interpolated text is a column name
 *     from a fixed whitelist.
 */

function parseJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromSqlDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")).toISOString();
}

function isDuplicateKey(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number };
  return candidate?.code === "ER_DUP_ENTRY" || candidate?.errno === 1062;
}

function assertExpectedRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new PersistenceError("INVALID_ARGUMENT", "expectedRevision must be a non-negative integer.");
  }
}

function pageParams(request: PageRequest & { status?: RunStatus }): {
  limit: number;
  cursor?: { createdAt: string; id: string };
} {
  return normalisePage(request);
}

function buildPage<T extends { createdAt: string; id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id }), "utf-8").toString("base64url")
        : undefined,
  };
}

const WORKSPACE_COLUMNS = "id, slug, name, plan, retention_days, created_at, created_by, deleted_at";
const ASSET_COLUMNS =
  "id, workspace_id, storage_key, checksum, filename, content_type, size_bytes, domain, source_format, metadata, created_at, created_by";
const MAPPING_COLUMNS =
  "id, workspace_id, name, version, spec, spec_checksum, source_format, target_format, target_resource_type, created_at, created_by";
const MAPPING_DRAFT_COLUMNS =
  "workspace_id, name, spec, spec_checksum, revision, base_version, created_at, updated_at, updated_by";
const PIPELINE_COLUMNS = "id, workspace_id, name, mapping_id, config, created_at, created_by";
const RUN_COLUMNS =
  "id, workspace_id, mapping_id, pipeline_id, asset_id, status, idempotency_key, request_checksum, engine_version, " +
  "adapter_id, adapter_version, records_processed, records_succeeded, records_failed, input_checksum, output_checksum, " +
  "coverage, validation, summary, result, error, options, progress, created_at, started_at, finished_at, cancelled_at, created_by";

const RUN_UPDATABLE: Record<string, string> = {
  status: "status",
  idempotencyKey: "idempotency_key",
  adapterId: "adapter_id",
  adapterVersion: "adapter_version",
  recordsProcessed: "records_processed",
  recordsSucceeded: "records_succeeded",
  recordsFailed: "records_failed",
  inputChecksum: "input_checksum",
  outputChecksum: "output_checksum",
  coverage: "coverage",
  validation: "validation",
  summary: "summary",
  result: "result",
  error: "error",
  options: "options",
  progress: "progress",
  startedAt: "started_at",
  finishedAt: "finished_at",
  cancelledAt: "cancelled_at",
};

const JSON_RUN_FIELDS = new Set(["coverage", "validation", "summary", "result", "error", "options", "progress"]);
const DATE_RUN_FIELDS = new Set(["startedAt", "finishedAt", "cancelledAt"]);

export class MySqlWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async create(workspace: Workspace): Promise<Workspace> {
    try {
      await this.db.execute(`INSERT INTO workspaces (${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        workspace.id,
        workspace.slug,
        workspace.name,
        workspace.plan,
        workspace.retentionDays,
        toSqlDate(new Date(workspace.createdAt)),
        workspace.createdBy ?? null,
        workspace.deletedAt ? toSqlDate(new Date(workspace.deletedAt)) : null,
      ]);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new PersistenceError("CONFLICT", `Workspace slug '${workspace.slug}' is already taken.`);
      }
      throw error;
    }
    return workspace;
  }

  public async findById(id: string): Promise<Workspace | undefined> {
    const rows = await this.db.query(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? mapWorkspace(rows[0]) : undefined;
  }

  public async findBySlug(slug: string): Promise<Workspace | undefined> {
    const rows = await this.db.query(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE slug = ? AND deleted_at IS NULL`,
      [slug],
    );
    return rows[0] ? mapWorkspace(rows[0]) : undefined;
  }

  public async list(request: PageRequest = {}): Promise<Page<Workspace>> {
    const { limit, cursor } = pageParams(request);
    const rows = cursor
      ? await this.db.query(
          `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
           WHERE deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [toSqlDate(new Date(cursor.createdAt)), toSqlDate(new Date(cursor.createdAt)), cursor.id, limit + 1],
        )
      : await this.db.query(
          `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE deleted_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [limit + 1],
        );
    const page = buildPage(rows.map(mapWorkspace), limit);
    return page;
  }

  public async softDelete(id: string, deletedAt: string): Promise<boolean> {
    const result = await this.db.execute(`UPDATE workspaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [
      toSqlDate(new Date(deletedAt)),
      id,
    ]);
    return result.affectedRows > 0;
  }
}

export class MySqlAssetRepository implements AssetRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async create(asset: AssetRecord): Promise<AssetRecord> {
    await this.db.execute(`INSERT INTO assets (${ASSET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      asset.id,
      asset.workspaceId,
      asset.storageKey,
      asset.checksum,
      asset.filename,
      asset.contentType,
      asset.sizeBytes,
      asset.domain,
      asset.sourceFormat,
      json(asset.metadata),
      toSqlDate(new Date(asset.createdAt)),
      asset.createdBy ?? null,
    ]);
    return asset;
  }

  public async findById(workspaceId: string, id: string): Promise<AssetRecord | undefined> {
    const rows = await this.db.query(`SELECT ${ASSET_COLUMNS} FROM assets WHERE workspace_id = ? AND id = ?`, [
      workspaceId,
      id,
    ]);
    return rows[0] ? mapAsset(rows[0]) : undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<AssetRecord>> {
    const { limit, cursor } = pageParams(request);
    const rows = cursor
      ? await this.db.query(
          `SELECT ${ASSET_COLUMNS} FROM assets
           WHERE workspace_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [
            workspaceId,
            toSqlDate(new Date(cursor.createdAt)),
            toSqlDate(new Date(cursor.createdAt)),
            cursor.id,
            limit + 1,
          ],
        )
      : await this.db.query(
          `SELECT ${ASSET_COLUMNS} FROM assets WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [workspaceId, limit + 1],
        );
    return buildPage(rows.map(mapAsset), limit);
  }

  public async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db.execute(`DELETE FROM assets WHERE workspace_id = ? AND id = ?`, [workspaceId, id]);
    return result.affectedRows > 0;
  }

  public async listExpired(
    workspaceId: string,
    createdBefore: string,
    limit = RETENTION_BATCH_LIMIT,
  ): Promise<AssetRecord[]> {
    const rows = await this.db.query(
      `SELECT ${ASSET_COLUMNS} FROM assets
       WHERE workspace_id = ? AND created_at < ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [workspaceId, toSqlDate(new Date(createdBefore)), limit],
    );
    return rows.map(mapAsset);
  }

  public async storageKeyInUse(storageKey: string): Promise<boolean> {
    // Deliberately unscoped: storage is content-addressed across tenants.
    const rows = await this.db.query(`SELECT 1 AS present FROM assets WHERE storage_key = ? LIMIT 1`, [storageKey]);
    return rows.length > 0;
  }
}

export class MySqlMappingRepository implements MappingRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async create(mapping: Omit<MappingRecord, "version"> & { version?: number }): Promise<MappingRecord> {
    const rows = await this.db.query<{ version: number | string }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM mappings WHERE workspace_id = ? AND name = ?`,
      [mapping.workspaceId, mapping.name],
    );
    const version = mapping.version ?? Number(rows[0]?.version ?? 0) + 1;

    try {
      await this.db.execute(`INSERT INTO mappings (${MAPPING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        mapping.id,
        mapping.workspaceId,
        mapping.name,
        version,
        json(mapping.spec),
        mapping.specChecksum,
        mapping.sourceFormat,
        mapping.targetFormat,
        mapping.targetResourceType ?? null,
        toSqlDate(new Date(mapping.createdAt)),
        mapping.createdBy ?? null,
      ]);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new PersistenceError(
          "CONFLICT",
          `Mapping '${mapping.name}' already has version ${version}; retry to create the next version.`,
        );
      }
      throw error;
    }
    return { ...mapping, version };
  }

  public async findById(workspaceId: string, id: string): Promise<MappingRecord | undefined> {
    const rows = await this.db.query(`SELECT ${MAPPING_COLUMNS} FROM mappings WHERE workspace_id = ? AND id = ?`, [
      workspaceId,
      id,
    ]);
    return rows[0] ? mapMapping(rows[0]) : undefined;
  }

  public async findLatestByName(workspaceId: string, name: string): Promise<MappingRecord | undefined> {
    const rows = await this.db.query(
      `SELECT ${MAPPING_COLUMNS} FROM mappings WHERE workspace_id = ? AND name = ?
       ORDER BY version DESC LIMIT 1`,
      [workspaceId, name],
    );
    return rows[0] ? mapMapping(rows[0]) : undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<MappingRecord>> {
    const { limit, cursor } = pageParams(request);
    const rows = cursor
      ? await this.db.query(
          `SELECT ${MAPPING_COLUMNS} FROM mappings m
           WHERE m.workspace_id = ?
             AND m.version = (SELECT MAX(x.version) FROM mappings x WHERE x.workspace_id = m.workspace_id AND x.name = m.name)
             AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
          [
            workspaceId,
            toSqlDate(new Date(cursor.createdAt)),
            toSqlDate(new Date(cursor.createdAt)),
            cursor.id,
            limit + 1,
          ],
        )
      : await this.db.query(
          `SELECT ${MAPPING_COLUMNS} FROM mappings m
           WHERE m.workspace_id = ?
             AND m.version = (SELECT MAX(x.version) FROM mappings x WHERE x.workspace_id = m.workspace_id AND x.name = m.name)
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
          [workspaceId, limit + 1],
        );
    return buildPage(rows.map(mapMapping), limit);
  }

  public async versions(workspaceId: string, name: string): Promise<MappingRecord[]> {
    const rows = await this.db.query(
      `SELECT ${MAPPING_COLUMNS} FROM mappings WHERE workspace_id = ? AND name = ? ORDER BY version DESC`,
      [workspaceId, name],
    );
    return rows.map(mapMapping);
  }
}

export class MySqlMappingDraftRepository implements MappingDraftRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async get(workspaceId: string, name: string): Promise<MappingDraftRecord | undefined> {
    const rows = await this.db.query(
      `SELECT ${MAPPING_DRAFT_COLUMNS} FROM mapping_drafts WHERE workspace_id = ? AND name = ?`,
      [workspaceId, name],
    );
    return rows[0] ? mapMappingDraft(rows[0]) : undefined;
  }

  public async save(
    input: Omit<MappingDraftRecord, "revision">,
    expectedRevision: number,
  ): Promise<MappingDraftRecord> {
    assertExpectedRevision(expectedRevision);

    if (expectedRevision === 0) {
      try {
        await this.db.execute(
          `INSERT INTO mapping_drafts (workspace_id, name, spec, spec_checksum, revision, base_version, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [
            input.workspaceId,
            input.name,
            json(input.spec),
            input.specChecksum,
            input.baseVersion ?? null,
            toSqlDate(new Date(input.createdAt)),
            toSqlDate(new Date(input.updatedAt)),
            input.updatedBy ?? null,
          ],
        );
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new PersistenceError("CONFLICT", `Draft '${input.name}' already exists.`);
        }
        throw error;
      }
      return { ...input, revision: 1 };
    }

    const result = await this.db.execute(
      `UPDATE mapping_drafts SET spec = ?, spec_checksum = ?, revision = revision + 1,
         base_version = ?, updated_at = ?, updated_by = ?
       WHERE workspace_id = ? AND name = ? AND revision = ?`,
      [
        json(input.spec),
        input.specChecksum,
        input.baseVersion ?? null,
        toSqlDate(new Date(input.updatedAt)),
        input.updatedBy ?? null,
        input.workspaceId,
        input.name,
        expectedRevision,
      ],
    );
    if (result.affectedRows === 0) {
      throw new PersistenceError(
        "CONFLICT",
        `Draft '${input.name}' is not at revision ${expectedRevision}; reload and retry.`,
      );
    }

    const stored = await this.get(input.workspaceId, input.name);
    if (!stored) {
      throw new PersistenceError("CONFLICT", `Draft '${input.name}' disappeared while it was being updated.`);
    }
    return stored;
  }

  public async delete(workspaceId: string, name: string, expectedRevision?: number): Promise<boolean> {
    if (expectedRevision !== undefined) assertExpectedRevision(expectedRevision);

    const result =
      expectedRevision === undefined
        ? await this.db.execute(`DELETE FROM mapping_drafts WHERE workspace_id = ? AND name = ?`, [workspaceId, name])
        : await this.db.execute(`DELETE FROM mapping_drafts WHERE workspace_id = ? AND name = ? AND revision = ?`, [
            workspaceId,
            name,
            expectedRevision,
          ]);
    return result.affectedRows > 0;
  }
}

export class MySqlPipelineRepository implements PipelineRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async create(pipeline: PipelineRecord): Promise<PipelineRecord> {
    try {
      await this.db.execute(`INSERT INTO pipelines (${PIPELINE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        pipeline.id,
        pipeline.workspaceId,
        pipeline.name,
        pipeline.mappingId,
        json(pipeline.config),
        toSqlDate(new Date(pipeline.createdAt)),
        pipeline.createdBy ?? null,
      ]);
    } catch (error) {
      if (isDuplicateKey(error)) throw new PersistenceError("CONFLICT", `Pipeline '${pipeline.name}' already exists.`);
      throw error;
    }
    return pipeline;
  }

  public async findById(workspaceId: string, id: string): Promise<PipelineRecord | undefined> {
    const rows = await this.db.query(`SELECT ${PIPELINE_COLUMNS} FROM pipelines WHERE workspace_id = ? AND id = ?`, [
      workspaceId,
      id,
    ]);
    return rows[0] ? mapPipeline(rows[0]) : undefined;
  }

  public async findByName(workspaceId: string, name: string): Promise<PipelineRecord | undefined> {
    const rows = await this.db.query(`SELECT ${PIPELINE_COLUMNS} FROM pipelines WHERE workspace_id = ? AND name = ?`, [
      workspaceId,
      name,
    ]);
    return rows[0] ? mapPipeline(rows[0]) : undefined;
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<PipelineRecord>> {
    const { limit, cursor } = pageParams(request);
    const rows = cursor
      ? await this.db.query(
          `SELECT ${PIPELINE_COLUMNS} FROM pipelines
           WHERE workspace_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [
            workspaceId,
            toSqlDate(new Date(cursor.createdAt)),
            toSqlDate(new Date(cursor.createdAt)),
            cursor.id,
            limit + 1,
          ],
        )
      : await this.db.query(
          `SELECT ${PIPELINE_COLUMNS} FROM pipelines WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [workspaceId, limit + 1],
        );
    return buildPage(rows.map(mapPipeline), limit);
  }
}

export class MySqlRunRepository implements RunRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async create(run: RunRecord): Promise<{ run: RunRecord; created: boolean }> {
    const values = [
      run.id,
      run.workspaceId,
      run.mappingId,
      run.pipelineId ?? null,
      run.assetId ?? null,
      run.status,
      run.idempotencyKey ?? null,
      run.requestChecksum ?? null,
      run.engineVersion,
      run.adapterId ?? null,
      run.adapterVersion ?? null,
      run.recordsProcessed,
      run.recordsSucceeded,
      run.recordsFailed,
      run.inputChecksum ?? null,
      run.outputChecksum ?? null,
      json(run.coverage),
      json(run.validation),
      json(run.summary),
      json(run.result),
      json(run.error),
      json(run.options),
      json(run.progress),
      toSqlDate(new Date(run.createdAt)),
      run.startedAt ? toSqlDate(new Date(run.startedAt)) : null,
      run.finishedAt ? toSqlDate(new Date(run.finishedAt)) : null,
      run.cancelledAt ? toSqlDate(new Date(run.cancelledAt)) : null,
      run.createdBy ?? null,
    ];

    try {
      await this.db.execute(`INSERT INTO runs (${RUN_COLUMNS}) VALUES (${values.map(() => "?").join(", ")})`, values);
      return { run, created: true };
    } catch (error) {
      if (!isDuplicateKey(error) || !run.idempotencyKey) throw error;

      const existing = await this.findByIdempotencyKey(run.workspaceId, run.idempotencyKey);
      if (!existing) throw error;
      if (existing.requestChecksum && run.requestChecksum && existing.requestChecksum !== run.requestChecksum) {
        throw new PersistenceError(
          "IDEMPOTENCY_CONFLICT",
          "The Idempotency-Key was already used with a different request payload.",
        );
      }
      return { run: existing, created: false };
    }
  }

  public async findById(workspaceId: string, id: string): Promise<RunRecord | undefined> {
    const rows = await this.db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ? AND id = ?`, [
      workspaceId,
      id,
    ]);
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  public async findByIdempotencyKey(workspaceId: string, key: string): Promise<RunRecord | undefined> {
    const rows = await this.db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE workspace_id = ? AND idempotency_key = ?`, [
      workspaceId,
      key,
    ]);
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  public async delete(workspaceId: string, id: string): Promise<boolean> {
    // Traces, resource-index rows and queued jobs cascade from the run.
    const result = await this.db.execute(`DELETE FROM runs WHERE workspace_id = ? AND id = ?`, [workspaceId, id]);
    return result.affectedRows > 0;
  }

  public async listExpired(
    workspaceId: string,
    finishedBefore: string,
    limit = RETENTION_BATCH_LIMIT,
  ): Promise<RunRecord[]> {
    const terminal = TERMINAL_RUN_STATUSES.map(() => "?").join(", ");
    const rows = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM runs
       WHERE workspace_id = ? AND status IN (${terminal})
         AND COALESCE(finished_at, cancelled_at, created_at) < ?
       ORDER BY COALESCE(finished_at, cancelled_at, created_at) ASC, id ASC
       LIMIT ?`,
      [workspaceId, ...TERMINAL_RUN_STATUSES, toSqlDate(new Date(finishedBefore)), limit],
    );
    return rows.map(mapRun);
  }

  public async countByAsset(workspaceId: string, assetId: string): Promise<number> {
    const rows = await this.db.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ? AND asset_id = ?`,
      [workspaceId, assetId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  public async update(workspaceId: string, id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const [field, column] of Object.entries(RUN_UPDATABLE)) {
      if (!(field in patch)) continue;
      const value = (patch as Record<string, unknown>)[field];
      assignments.push(`${column} = ?`);
      if (value === undefined || value === null) params.push(null);
      else if (JSON_RUN_FIELDS.has(field)) params.push(json(value));
      else if (DATE_RUN_FIELDS.has(field)) params.push(toSqlDate(new Date(String(value))));
      else params.push(value);
    }

    if (assignments.length === 0) return this.findById(workspaceId, id);

    params.push(id, workspaceId);
    const result = await this.db.execute(
      `UPDATE runs SET ${assignments.join(", ")} WHERE id = ? AND workspace_id = ?`,
      params,
    );
    if (result.affectedRows === 0) return undefined;
    return this.findById(workspaceId, id);
  }

  public async list(workspaceId: string, request: PageRequest & { status?: RunStatus } = {}): Promise<Page<RunRecord>> {
    const { limit, cursor } = pageParams(request);
    const filters = ["workspace_id = ?"];
    const params: unknown[] = [workspaceId];

    if (request.status) {
      filters.push("status = ?");
      params.push(request.status);
    }
    if (cursor) {
      filters.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(toSqlDate(new Date(cursor.createdAt)), toSqlDate(new Date(cursor.createdAt)), cursor.id);
    }

    const rows = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    return buildPage(rows.map(mapRun), limit);
  }

  public async appendTraces(
    workspaceId: string,
    runId: string,
    traces: Omit<RunTraceRecord, "runId">[],
  ): Promise<number> {
    if (traces.length === 0) return 0;

    return this.db instanceof Object && "transaction" in (this.db as object)
      ? (this.db as SqlConnection).transaction((tx) => this.insertTraces(tx, workspaceId, runId, traces))
      : this.insertTraces(this.db, workspaceId, runId, traces);
  }

  private async insertTraces(
    tx: SqlExecutor,
    workspaceId: string,
    runId: string,
    traces: Omit<RunTraceRecord, "runId">[],
  ): Promise<number> {
    // Ownership is checked before writing: an unknown or foreign run id must not
    // create orphan trace rows.
    const owned = await tx.query<{ id: string }>(`SELECT id FROM runs WHERE workspace_id = ? AND id = ?`, [
      workspaceId,
      runId,
    ]);
    if (owned.length === 0) throw new PersistenceError("NOT_FOUND", `Run ${runId} not found in this workspace.`);

    const seqRows = await tx.query<{ next: number | string }>(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_traces WHERE run_id = ?`,
      [runId],
    );
    let seq = Number(seqRows[0]?.next ?? 0);

    for (const trace of traces) {
      await tx.execute(
        `INSERT INTO run_traces (run_id, seq, stage, step_name, status, duration_ms, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          seq++,
          trace.stage,
          trace.stepName,
          trace.status,
          trace.durationMs ?? null,
          json(trace.payload),
          toSqlDate(new Date(trace.createdAt)),
        ],
      );
    }
    return traces.length;
  }

  public async listTraces(workspaceId: string, runId: string): Promise<RunTraceRecord[]> {
    // Tenant scoping goes through the join: run_traces has no workspace column,
    // so a foreign run id simply matches nothing.
    const rows = await this.db.query(
      `SELECT t.run_id, t.seq, t.stage, t.step_name, t.status, t.duration_ms, t.payload, t.created_at
       FROM run_traces t
       JOIN runs r ON r.id = t.run_id
       WHERE r.workspace_id = ? AND t.run_id = ?
       ORDER BY t.seq ASC`,
      [workspaceId, runId],
    );
    return rows.map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq),
      stage: String(row.stage),
      stepName: String(row.step_name),
      status: String(row.status),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
      payload: parseJson(row.payload),
      createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    }));
  }
}

export class MySqlAuditRepository implements AuditRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async append(event: Omit<AuditEvent, "createdAt"> & { createdAt?: string }): Promise<AuditEvent> {
    const createdAt = event.createdAt ?? new Date().toISOString();
    await this.db.execute(
      `INSERT INTO audit_events (id, workspace_id, actor_key_id, action, target_type, target_id, outcome, metadata, request_id, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.workspaceId,
        event.actorKeyId ?? null,
        event.action,
        event.targetType ?? null,
        event.targetId ?? null,
        event.outcome,
        json(event.metadata),
        event.requestId ?? null,
        event.ip ?? null,
        toSqlDate(new Date(createdAt)),
      ],
    );
    return { ...event, createdAt };
  }

  public async list(workspaceId: string, request: PageRequest = {}): Promise<Page<AuditEvent>> {
    const { limit, cursor } = pageParams(request);
    const rows = cursor
      ? await this.db.query(
          `SELECT id, workspace_id, actor_key_id, action, target_type, target_id, outcome, metadata, request_id, ip, created_at
           FROM audit_events
           WHERE workspace_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [
            workspaceId,
            toSqlDate(new Date(cursor.createdAt)),
            toSqlDate(new Date(cursor.createdAt)),
            cursor.id,
            limit + 1,
          ],
        )
      : await this.db.query(
          `SELECT id, workspace_id, actor_key_id, action, target_type, target_id, outcome, metadata, request_id, ip, created_at
           FROM audit_events WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [workspaceId, limit + 1],
        );

    return buildPage(
      rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        actorKeyId: row.actor_key_id ? String(row.actor_key_id) : undefined,
        action: String(row.action),
        targetType: row.target_type ? String(row.target_type) : undefined,
        targetId: row.target_id ? String(row.target_id) : undefined,
        outcome: String(row.outcome) as AuditEvent["outcome"],
        metadata: parseJson(row.metadata),
        requestId: row.request_id ? String(row.request_id) : undefined,
        ip: row.ip ? String(row.ip) : undefined,
        createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
      })),
      limit,
    );
  }
}

export class MySqlIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async get(workspaceId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const rows = await this.db.query(
      `SELECT workspace_id, idempotency_key, request_checksum, resource_type, resource_id, created_at, expires_at
       FROM idempotency_keys WHERE workspace_id = ? AND idempotency_key = ? AND expires_at > ?`,
      [workspaceId, key, toSqlDate(this.now())],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      workspaceId: String(row.workspace_id),
      key: String(row.idempotency_key),
      requestChecksum: String(row.request_checksum),
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
      expiresAt: fromSqlDate(row.expires_at) ?? new Date().toISOString(),
    };
  }

  public async save(record: IdempotencyRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO idempotency_keys (workspace_id, idempotency_key, request_checksum, resource_type, resource_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE request_checksum = VALUES(request_checksum), resource_type = VALUES(resource_type),
         resource_id = VALUES(resource_id), created_at = VALUES(created_at), expires_at = VALUES(expires_at)`,
      [
        record.workspaceId,
        record.key,
        record.requestChecksum,
        record.resourceType,
        record.resourceId,
        toSqlDate(new Date(record.createdAt)),
        toSqlDate(new Date(record.expiresAt)),
      ],
    );
  }

  public async deleteByResource(workspaceId: string, resourceType: string, resourceId: string): Promise<number> {
    // Deleting the run must free its key: a tombstone for a resource that no
    // longer exists would otherwise answer 422 forever.
    const result = await this.db.execute(
      `DELETE FROM idempotency_keys WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`,
      [workspaceId, resourceType, resourceId],
    );
    return result.affectedRows;
  }
}

export class MySqlWorkspacePurgeRepository implements WorkspacePurgeRepository {
  constructor(private readonly db: SqlConnection) {}

  public async schedule(record: WorkspacePurgeRecord): Promise<WorkspacePurgeRecord> {
    await this.db.execute(
      `INSERT INTO workspace_purges (workspace_id, workspace_slug, scheduled_at, requested_at, requested_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE workspace_slug = VALUES(workspace_slug), scheduled_at = VALUES(scheduled_at),
         requested_at = VALUES(requested_at), requested_by = VALUES(requested_by)`,
      [
        record.workspaceId,
        record.workspaceSlug,
        toSqlDate(new Date(record.scheduledAt)),
        toSqlDate(new Date(record.requestedAt)),
        record.requestedBy ?? null,
      ],
    );
    return record;
  }

  public async find(workspaceId: string): Promise<WorkspacePurgeRecord | undefined> {
    const rows = await this.db.query(
      `SELECT workspace_id, workspace_slug, scheduled_at, requested_at, requested_by
       FROM workspace_purges WHERE workspace_id = ?`,
      [workspaceId],
    );
    return rows[0] ? mapWorkspacePurge(rows[0]) : undefined;
  }

  public async listDue(now: string, limit = RETENTION_BATCH_LIMIT): Promise<WorkspacePurgeRecord[]> {
    const rows = await this.db.query(
      `SELECT workspace_id, workspace_slug, scheduled_at, requested_at, requested_by
       FROM workspace_purges WHERE scheduled_at <= ?
       ORDER BY scheduled_at ASC, workspace_id ASC LIMIT ?`,
      [toSqlDate(new Date(now)), limit],
    );
    return rows.map(mapWorkspacePurge);
  }

  public async remove(workspaceId: string): Promise<boolean> {
    const result = await this.db.execute(`DELETE FROM workspace_purges WHERE workspace_id = ?`, [workspaceId]);
    return result.affectedRows > 0;
  }

  public async purge(workspaceId: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      // Collected inside the transaction so the keys reported are the ones that
      // were actually referenced when the tenant rows disappeared.
      const rows = await tx.query<{ storage_key: string }>(`SELECT storage_key FROM assets WHERE workspace_id = ?`, [
        workspaceId,
      ]);
      const keys = [...new Set(rows.map((row) => String(row.storage_key)))];

      // Explicit deletes rather than trusting ON DELETE CASCADE: child rows
      // without a workspace column (traces, resource index, jobs) only cascade
      // through runs, and this keeps the purge correct if a FK changes.
      await tx.execute(`DELETE FROM run_jobs WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM idempotency_keys WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM runs WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM pipelines WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM mapping_drafts WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM audit_events WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM assets WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM mappings WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM api_keys WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM workspace_purges WHERE workspace_id = ?`, [workspaceId]);
      await tx.execute(`DELETE FROM workspaces WHERE id = ?`, [workspaceId]);
      return keys;
    });
  }
}

export class MySqlPlatformAuditRepository implements PlatformAuditRepository {
  constructor(private readonly db: SqlExecutor) {}

  public async append(event: PlatformAuditEvent): Promise<PlatformAuditEvent> {
    await this.db.execute(
      `INSERT INTO platform_audit_events
         (id, workspace_id, workspace_slug, actor_key_id, action, target_type, target_id, outcome, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.workspaceId,
        event.workspaceSlug ?? null,
        event.actorKeyId ?? null,
        event.action,
        event.targetType ?? null,
        event.targetId ?? null,
        event.outcome,
        json(event.metadata),
        toSqlDate(new Date(event.createdAt)),
      ],
    );
    return event;
  }

  public async list(request: PageRequest & { workspaceId?: string } = {}): Promise<Page<PlatformAuditEvent>> {
    const { limit, cursor } = pageParams(request);
    const filters: string[] = [];
    const params: unknown[] = [];

    if (request.workspaceId) {
      filters.push("workspace_id = ?");
      params.push(request.workspaceId);
    }
    if (cursor) {
      filters.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(toSqlDate(new Date(cursor.createdAt)), toSqlDate(new Date(cursor.createdAt)), cursor.id);
    }

    const rows = await this.db.query(
      `SELECT id, workspace_id, workspace_slug, actor_key_id, action, target_type, target_id, outcome, metadata, created_at
       FROM platform_audit_events ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit + 1],
    );

    return buildPage(
      rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        workspaceSlug: row.workspace_slug ? String(row.workspace_slug) : undefined,
        actorKeyId: row.actor_key_id ? String(row.actor_key_id) : undefined,
        action: String(row.action),
        targetType: row.target_type ? String(row.target_type) : undefined,
        targetId: row.target_id ? String(row.target_id) : undefined,
        outcome: String(row.outcome) as PlatformAuditEvent["outcome"],
        metadata: parseJson(row.metadata),
        createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
      })),
      limit,
    );
  }
}

function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    plan: String(row.plan),
    retentionDays: Number(row.retention_days),
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    deletedAt: fromSqlDate(row.deleted_at),
  };
}

function mapWorkspacePurge(row: Record<string, unknown>): WorkspacePurgeRecord {
  return {
    workspaceId: String(row.workspace_id),
    workspaceSlug: String(row.workspace_slug),
    scheduledAt: fromSqlDate(row.scheduled_at) ?? new Date().toISOString(),
    requestedAt: fromSqlDate(row.requested_at) ?? new Date().toISOString(),
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
  };
}

function mapAsset(row: Record<string, unknown>): AssetRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    storageKey: String(row.storage_key),
    checksum: String(row.checksum),
    filename: String(row.filename),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    domain: String(row.domain),
    sourceFormat: String(row.source_format),
    metadata: parseJson(row.metadata),
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
  };
}

function mapMapping(row: Record<string, unknown>): MappingRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    version: Number(row.version),
    spec: parseJson(row.spec),
    specChecksum: String(row.spec_checksum),
    sourceFormat: String(row.source_format),
    targetFormat: String(row.target_format),
    targetResourceType: row.target_resource_type ? String(row.target_resource_type) : undefined,
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
  };
}

function mapMappingDraft(row: Record<string, unknown>): MappingDraftRecord {
  return {
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    spec: parseJson(row.spec),
    specChecksum: String(row.spec_checksum),
    revision: Number(row.revision),
    baseVersion: row.base_version === null || row.base_version === undefined ? undefined : Number(row.base_version),
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    updatedAt: fromSqlDate(row.updated_at) ?? new Date().toISOString(),
    updatedBy: row.updated_by ? String(row.updated_by) : undefined,
  };
}

function mapPipeline(row: Record<string, unknown>): PipelineRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    mappingId: String(row.mapping_id),
    config: parseJson(row.config),
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ? String(row.created_by) : undefined,
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    mappingId: String(row.mapping_id),
    pipelineId: row.pipeline_id ? String(row.pipeline_id) : undefined,
    assetId: row.asset_id ? String(row.asset_id) : undefined,
    status: String(row.status) as RunStatus,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    requestChecksum: row.request_checksum ? String(row.request_checksum) : undefined,
    engineVersion: String(row.engine_version),
    adapterId: row.adapter_id ? String(row.adapter_id) : undefined,
    adapterVersion: row.adapter_version ? String(row.adapter_version) : undefined,
    recordsProcessed: Number(row.records_processed),
    recordsSucceeded: Number(row.records_succeeded),
    recordsFailed: Number(row.records_failed),
    inputChecksum: row.input_checksum ? String(row.input_checksum) : undefined,
    outputChecksum: row.output_checksum ? String(row.output_checksum) : undefined,
    coverage: parseJson(row.coverage),
    validation: parseJson(row.validation),
    summary: parseJson(row.summary),
    result: parseJson(row.result),
    error: parseJson(row.error),
    options: parseJson(row.options),
    progress: parseJson(row.progress),
    createdAt: fromSqlDate(row.created_at) ?? new Date().toISOString(),
    startedAt: fromSqlDate(row.started_at),
    finishedAt: fromSqlDate(row.finished_at),
    cancelledAt: fromSqlDate(row.cancelled_at),
    createdBy: row.created_by ? String(row.created_by) : undefined,
  };
}

export interface MySqlRepositoriesOptions {
  /** Runs pending migrations before the API starts serving traffic. */
  migrateOnStart?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

export async function createMySqlRepositories(
  connection: SqlConnection,
  options: MySqlRepositoriesOptions = {},
): Promise<Repositories & { migrateRunner: MigrationRunner }> {
  const migrateRunner = new MigrationRunner(connection, { log: options.log });

  if (options.migrateOnStart) {
    const result = await migrateRunner.migrate();
    options.log?.(`migrations: ${result.applied.length} applied, ${result.alreadyApplied} already present`);
  }

  return {
    mode: "mysql",
    workspaces: new MySqlWorkspaceRepository(connection),
    apiKeys: new MySqlApiKeyStore(connection),
    assets: new MySqlAssetRepository(connection),
    mappings: new MySqlMappingRepository(connection),
    mappingDrafts: new MySqlMappingDraftRepository(connection),
    pipelines: new MySqlPipelineRepository(connection),
    runs: new MySqlRunRepository(connection),
    audit: new MySqlAuditRepository(connection),
    idempotency: new MySqlIdempotencyStore(connection, options.now),
    workspacePurges: new MySqlWorkspacePurgeRepository(connection),
    platformAudit: new MySqlPlatformAuditRepository(connection),
    migrateRunner,
    close: async () => {
      await connection.close();
    },
  };
}
