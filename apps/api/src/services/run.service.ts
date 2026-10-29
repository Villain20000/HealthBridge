import { createHash, randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import type { AssetRecord, MappingRecord, Page, Repositories, RunRecord, RunStatus } from "@healthbridge/persistence";
import { ENGINE_VERSION } from "@healthbridge/shared-types";
import type { ApiConfig } from "../config.js";
import { ApiError, notFound, validationFailed } from "../common/errors.js";
import type { RunQueue } from "../jobs/run-queue.js";
import type { AuditService } from "./audit.service.js";

/**
 * Run lifecycle: create (idempotent), list, read, cancel, replay.
 *
 * A run row is written *before* it is queued, so a crash can never produce a run
 * that produced output but has no record. Conversely, a queued run that never
 * started is visible as `queued` rather than vanishing.
 */

export interface CreateRunInput {
  principal: Principal;
  mappingId?: string;
  mappingName?: string;
  assetId: string;
  pipelineId?: string;
  options?: Record<string, unknown>;
  idempotencyKey?: string;
  requestId?: string;
  ip?: string;
}

export interface CreateRunResult {
  run: RunRecord;
  created: boolean;
}

export interface RunServiceDeps {
  repos: Repositories;
  queue: RunQueue;
  audit: AuditService;
  config: ApiConfig;
  now?: () => Date;
  idFactory?: () => string;
}

export class RunService {
  private readonly repos: Repositories;
  private readonly queue: RunQueue;
  private readonly audit: AuditService;
  private readonly config: ApiConfig;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(deps: RunServiceDeps) {
    this.repos = deps.repos;
    this.queue = deps.queue;
    this.audit = deps.audit;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => `run_${randomBytes(9).toString("hex")}`);
  }

  public async create(input: CreateRunInput): Promise<CreateRunResult> {
    const { principal } = input;
    if (!input.assetId) throw validationFailed("assetId is required.");
    if (!input.mappingId && !input.mappingName) {
      throw validationFailed("Either mappingId or mappingName is required.");
    }

    const options = sanitiseOptions(input.options);

    // Identity of the request as submitted, computed without touching the database:
    // it stays comparable after the referenced asset or mapping has been deleted.
    const requestFingerprint = this.requestChecksum({
      assetId: input.assetId,
      mapping: input.mappingId ?? `name:${input.mappingName}`,
      pipelineId: input.pipelineId,
      options,
    });

    // The key index records what the *request* was, so a retry is recognised without
    // resolving (and therefore without requiring) the asset or mapping it names.
    const keyRecord = input.idempotencyKey
      ? await this.repos.idempotency.get(principal.workspaceId, input.idempotencyKey)
      : undefined;
    if (keyRecord) {
      const stored = await this.repos.runs.findById(principal.workspaceId, keyRecord.resourceId);

      // No run behind the record means retention removed it; the key is free again.
      if (stored) {
        if (keyRecord.requestChecksum === requestFingerprint) return { run: stored, created: false };

        // Same key, different request shape. It may still be the same request written
        // differently (mappingName then, mappingId now), so verify against resolved ids
        // before refusing; a dependency that no longer exists cannot prove either way.
        const resolved = await this.resolveDependencies(input, true);
        const checksum = this.requestChecksum({
          mappingId: resolved.mapping.id,
          assetId: resolved.asset.id,
          pipelineId: input.pipelineId,
          options,
        });
        if (stored.requestChecksum === checksum) return { run: stored, created: false };
        throw idempotencyConflict();
      }
    }

    if (!keyRecord && input.idempotencyKey) {
      // Keys accepted before the index existed only have the run row. Compare the
      // request structurally (no dependency lookups) and backfill the index.
      const legacy = await this.repos.runs.findByIdempotencyKey(principal.workspaceId, input.idempotencyKey);
      if (legacy) {
        if (!(await this.legacyRequestMatches(legacy, input, options))) throw idempotencyConflict();
        await this.rememberKey(principal, input.idempotencyKey, requestFingerprint, legacy.id);
        return { run: legacy, created: false };
      }
    }

    const dependencies = await this.resolveDependencies(input, false);
    const requestChecksum = this.requestChecksum({
      mappingId: dependencies.mapping.id,
      assetId: dependencies.asset.id,
      pipelineId: input.pipelineId,
      options,
    });

    const run: RunRecord = {
      id: this.idFactory(),
      workspaceId: principal.workspaceId,
      mappingId: dependencies.mapping.id,
      pipelineId: input.pipelineId,
      assetId: dependencies.asset.id,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      requestChecksum,
      engineVersion: ENGINE_VERSION,
      adapterId: dependencies.asset.sourceFormat,
      recordsProcessed: 0,
      recordsSucceeded: 0,
      recordsFailed: 0,
      options,
      createdAt: this.now().toISOString(),
      createdBy: principal.apiKeyId,
    };

    const { run: stored, created } = await this.repos.runs.create(run);

    if (created) {
      try {
        await this.queue.enqueue({ runId: stored.id, workspaceId: stored.workspaceId });
      } catch (error) {
        throw await this.releaseFailedSchedule(principal, stored, error, input);
      }
      if (input.idempotencyKey) {
        await this.rememberKey(principal, input.idempotencyKey, requestFingerprint, stored.id);
      }
      await this.audit.record({
        workspaceId: principal.workspaceId,
        actorKeyId: principal.apiKeyId,
        action: "run.created",
        targetType: "run",
        targetId: stored.id,
        outcome: "success",
        metadata: {
          mappingId: dependencies.mapping.id,
          assetId: dependencies.asset.id,
          idempotencyKey: input.idempotencyKey,
        },
        requestId: input.requestId,
        ip: input.ip,
      });
    } else {
      await this.audit.record({
        workspaceId: principal.workspaceId,
        actorKeyId: principal.apiKeyId,
        action: "run.create-raced",
        targetType: "run",
        targetId: stored.id,
        outcome: "success",
        metadata: { idempotencyKey: input.idempotencyKey },
        requestId: input.requestId,
        ip: input.ip,
      });
    }

    return { run: stored, created };
  }

  /**
   * Resolves the asset/mapping/pipeline a request refers to.
   *
   * When an Idempotency-Key is already on record, a missing dependency is not a 404:
   * either the key belongs to the run we already matched (handled by the caller) or
   * it is being reused for a different request, which is a conflict.
   */
  /**
   * Decides whether a request matches a run created before the key index existed.
   *
   * Only what the run row already holds is compared: asset id, mapping id, pipeline id
   * and options. The mapping is checked by id when the client sent one; a name-based
   * retry is resolved when the mapping still exists and refused when it does not,
   * because an unresolvable name cannot be shown to mean the same mapping — accepting
   * it would attribute a run to rules that may never have produced it.
   */
  private async legacyRequestMatches(
    run: RunRecord,
    input: CreateRunInput,
    options: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    if ((run.assetId ?? undefined) !== input.assetId) return false;
    if ((run.pipelineId ?? undefined) !== (input.pipelineId ?? undefined)) return false;
    if (canonicalJson(run.options ?? null) !== canonicalJson(options ?? null)) return false;

    if (input.mappingId) return run.mappingId === input.mappingId;
    if (input.mappingName) {
      const resolved = await this.repos.mappings.findLatestByName(input.principal.workspaceId, input.mappingName);
      return resolved ? run.mappingId === resolved.id : false;
    }
    return false;
  }

  private async resolveDependencies(
    input: CreateRunInput,
    hasExistingRun: boolean,
  ): Promise<{ asset: AssetRecord; mapping: MappingRecord }> {
    const workspaceId = input.principal.workspaceId;
    try {
      const asset = await this.repos.assets.findById(workspaceId, input.assetId);
      if (!asset) throw notFound("Asset");

      const mapping = input.mappingId
        ? await this.repos.mappings.findById(workspaceId, input.mappingId)
        : await this.repos.mappings.findLatestByName(workspaceId, input.mappingName!);
      if (!mapping) throw notFound("Mapping");

      if (input.pipelineId) {
        const pipeline = await this.repos.pipelines.findById(workspaceId, input.pipelineId);
        if (!pipeline) throw notFound("Pipeline");
      }

      return { asset, mapping };
    } catch (error) {
      if (hasExistingRun && ApiError.isApiError(error) && error.code === "NOT_FOUND") throw idempotencyConflict();
      throw error;
    }
  }

  public async get(workspaceId: string, runId: string): Promise<RunRecord> {
    const run = await this.repos.runs.findById(workspaceId, runId);
    if (!run) throw notFound("Run");
    return run;
  }

  public async list(
    workspaceId: string,
    request: { cursor?: string; limit?: number; status?: RunStatus },
  ): Promise<Page<RunRecord>> {
    return this.repos.runs.list(workspaceId, request);
  }

  public async cancel(
    principal: Principal,
    runId: string,
    context: { requestId?: string; ip?: string } = {},
  ): Promise<RunRecord> {
    const run = await this.get(principal.workspaceId, runId);

    if (isTerminal(run.status)) {
      throw new ApiError("RUN_NOT_CANCELLABLE", `Run is already ${run.status}.`);
    }

    const accepted = this.queue.cancel(runId);
    const updated = await this.repos.runs.update(principal.workspaceId, runId, {
      status: accepted ? "cancelling" : "cancelled",
      cancelledAt: accepted ? run.cancelledAt : this.now().toISOString(),
      finishedAt: accepted ? run.finishedAt : this.now().toISOString(),
    });

    if (!updated) {
      // The row moved between the read and the write. Reporting the pre-read status
      // would tell the client "accepted" for a run that no longer looks like that.
      const current = await this.repos.runs.findById(principal.workspaceId, runId);
      await this.audit.record({
        workspaceId: principal.workspaceId,
        actorKeyId: principal.apiKeyId,
        action: "run.cancelled",
        targetType: "run",
        targetId: runId,
        outcome: "failure",
        metadata: {
          queueAccepted: accepted,
          previousStatus: run.status,
          reason: current ? "row-changed" : "row-deleted",
        },
        requestId: context.requestId,
        ip: context.ip,
      });
      if (!current) throw notFound("Run");
      throw new ApiError(
        "CONFLICT",
        `The run changed while it was being cancelled (now ${current.status}). Fetch it again.`,
      );
    }

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "run.cancelled",
      targetType: "run",
      targetId: runId,
      outcome: "success",
      metadata: { queueAccepted: accepted, previousStatus: run.status },
      requestId: context.requestId,
      ip: context.ip,
    });

    return updated ?? run;
  }

  /** Re-executes a finished run with the same input, mapping and options as a new run. */
  public async replay(
    principal: Principal,
    runId: string,
    context: { requestId?: string; ip?: string } = {},
  ): Promise<CreateRunResult> {
    const original = await this.get(principal.workspaceId, runId);
    if (!original.assetId) throw validationFailed("This run has no input asset to replay.");

    const created = await this.create({
      principal,
      assetId: original.assetId,
      mappingId: original.mappingId,
      pipelineId: original.pipelineId,
      options: original.options,
      requestId: context.requestId,
      ip: context.ip,
    });

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "run.replayed",
      targetType: "run",
      targetId: created.run.id,
      outcome: "success",
      metadata: { replayedFrom: runId },
      requestId: context.requestId,
      ip: context.ip,
    });

    return created;
  }

  public async resources(
    workspaceId: string,
    runId: string,
  ): Promise<{ resources: unknown[]; omitted: boolean; bytes?: number }> {
    const run = await this.get(workspaceId, runId);
    const summary = run.summary as { resourcesOmitted?: boolean; resourcesBytes?: number } | undefined;
    if (!run.result) {
      return { resources: [], omitted: summary?.resourcesOmitted ?? true, bytes: summary?.resourcesBytes };
    }
    return { resources: run.result.resources, omitted: false, bytes: summary?.resourcesBytes };
  }

  public async traces(workspaceId: string, runId: string): Promise<unknown[]> {
    await this.get(workspaceId, runId);
    return this.repos.runs.listTraces(workspaceId, runId);
  }

  public async issues(workspaceId: string, runId: string): Promise<{ issues: unknown[]; rejected: unknown[] }> {
    const run = await this.get(workspaceId, runId);
    const summary = (run.summary ?? {}) as { issues?: unknown[]; rejectedRecords?: unknown[] };
    const validation = (run.validation ?? {}) as { issues?: unknown[] };
    return {
      issues: summary.issues ?? validation.issues ?? [],
      rejected: summary.rejectedRecords ?? [],
    };
  }

  /**
   * Records what the request was, keyed by Idempotency-Key.
   *
   * Written only after the run was accepted (never when scheduling failed), so a
   * failed attempt leaves the key reusable. A write failure is not fatal: the runs
   * table still enforces key uniqueness, which degrades to the pre-index behaviour.
   * `expiresAt` is bookkeeping for retention; key ownership is decided by the run row
   * (which disappears with its retention window, making the key reusable again).
   */
  private async rememberKey(principal: Principal, key: string, fingerprint: string, runId: string): Promise<void> {
    try {
      await this.repos.idempotency.save({
        workspaceId: principal.workspaceId,
        key,
        requestChecksum: fingerprint,
        resourceType: "run",
        resourceId: runId,
        createdAt: this.now().toISOString(),
        expiresAt: new Date(this.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch {
      // Best effort; uniqueness is still guaranteed by runs.idempotency_key.
    }
  }

  /**
   * A run that was written but never handed to a worker must not masquerade as
   * `queued`: nothing would ever pick it up, and an idempotent retry would keep
   * returning that ghost. The row is marked failed (honest history), the
   * Idempotency-Key is released (nothing ran, so the same request may be retried)
   * and the caller gets a 503 instead of a success.
   */
  private async releaseFailedSchedule(
    principal: Principal,
    run: RunRecord,
    error: unknown,
    input: CreateRunInput,
  ): Promise<ApiError> {
    const message = error instanceof Error ? error.message : String(error);

    try {
      await this.repos.runs.update(principal.workspaceId, run.id, {
        status: "failed",
        error: { code: "QUEUE_UNAVAILABLE", message },
        finishedAt: this.now().toISOString(),
        idempotencyKey: undefined,
      });
    } catch {
      // The audit event below still records the attempt even if the repair write fails.
    }

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "run.queue-failed",
      targetType: "run",
      targetId: run.id,
      outcome: "failure",
      metadata: { error: message, idempotencyKey: input.idempotencyKey },
      requestId: input.requestId,
      ip: input.ip,
    });

    return new ApiError(
      "QUEUE_UNAVAILABLE",
      "The run was recorded but could not be scheduled. Retry with the same Idempotency-Key.",
      { cause: error, details: { runId: run.id } },
    );
  }

  private requestChecksum(payload: Record<string, unknown>): string {
    // Canonical JSON: keys sorted at every level, so two payloads that differ only
    // in key order are recognised as the same request, while a nested option change
    // (e.g. maxRecords) is never collapsed into the same checksum.
    return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
  }
}

const ALLOWED_OPTIONS = new Set(["maxRecords", "importedAt", "adapterId", "pipelineVersion"]);

function idempotencyConflict(): ApiError {
  return new ApiError(
    "IDEMPOTENCY_CONFLICT",
    "This Idempotency-Key was already used for a different request. Use a new key.",
  );
}

function sanitiseOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!ALLOWED_OPTIONS.has(key)) {
      throw validationFailed(`Unknown run option '${key}'. Allowed: ${[...ALLOWED_OPTIONS].join(", ")}.`);
    }
    clean[key] = value;
  }

  if (
    clean.maxRecords !== undefined &&
    (typeof clean.maxRecords !== "number" || !Number.isFinite(clean.maxRecords) || clean.maxRecords <= 0)
  ) {
    throw validationFailed("options.maxRecords must be a positive finite number.");
  }
  if (clean.importedAt !== undefined && Number.isNaN(new Date(String(clean.importedAt)).getTime())) {
    throw validationFailed("options.importedAt must be an ISO-8601 timestamp.");
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" || status === "completed_with_warnings" || status === "failed" || status === "cancelled"
  );
}

/** Deterministic JSON for checksums: sorted keys, arrays preserved in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}
