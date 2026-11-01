import { randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import type { Repositories, Workspace } from "@healthbridge/persistence";
import { RETENTION_BATCH_LIMIT, TERMINAL_RUN_STATUSES } from "@healthbridge/persistence";
import type { StorageDriver } from "@healthbridge/storage";
import type { ApiConfig } from "../config.js";
import { ApiError, notFound, validationFailed } from "../common/errors.js";
import type { AuditService } from "./audit.service.js";

/**
 * Deletion and retention policy.
 *
 * Three ways data leaves the system, all of them explicit:
 *  - a run is deleted by a request (terminal runs only, so cancel is the way to
 *    stop a live one), which also frees its idempotency key;
 *  - an asset is deleted by a request once no run references it;
 *  - a workspace is soft-deleted on request, its keys revoked, and hard-purged
 *    by the sweeper after a grace period.
 *
 * Blobs are content-addressed and shared across tenants, so an object is only
 * removed after a global reference check — deleting one workspace's asset must
 * never blank another workspace's identical file.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionServiceDeps {
  repos: Repositories;
  storage: StorageDriver;
  audit: AuditService;
  config: ApiConfig;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface DeleteAssetInput {
  principal: Principal;
  assetId: string;
  requestId?: string;
  ip?: string;
}

export interface DeleteAssetResult {
  deleted: true;
  assetId: string;
  blobDeleted: boolean;
}

export interface DeleteRunInput {
  principal: Principal;
  runId: string;
  requestId?: string;
  ip?: string;
}

export interface DeleteRunResult {
  deleted: true;
  runId: string;
  idempotencyKeysFreed: number;
}

export interface DeleteWorkspaceInput {
  principal: Principal;
  confirm: unknown;
  requestId?: string;
  ip?: string;
}

export interface DeleteWorkspaceResult {
  deleted: true;
  workspaceId: string;
  workspaceSlug: string;
  purgeScheduledAt: string;
  keysRevoked: number;
}

export interface SweepResult {
  at: string;
  workspacesPurged: number;
  runsDeleted: number;
  assetsDeleted: number;
  blobsDeleted: number;
}

export class RetentionService {
  private readonly repos: Repositories;
  private readonly storage: StorageDriver;
  private readonly audit: AuditService;
  private readonly config: ApiConfig;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly idFactory: () => string;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: RetentionServiceDeps) {
    this.repos = deps.repos;
    this.storage = deps.storage;
    this.audit = deps.audit;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.idFactory = () => `aud_${randomBytes(9).toString("hex")}`;
  }

  public async deleteAsset(input: DeleteAssetInput): Promise<DeleteAssetResult> {
    const { principal } = input;
    const asset = await this.repos.assets.findById(principal.workspaceId, input.assetId);
    if (!asset) throw notFound("Asset");

    const references = await this.repos.runs.countByAsset(principal.workspaceId, asset.id);
    if (references > 0) {
      throw new ApiError(
        "CONFLICT",
        `Asset is referenced by ${references} run(s). Delete those runs first, then the asset.`,
        { details: { assetId: asset.id, runCount: references } },
      );
    }

    if (!(await this.repos.assets.delete(principal.workspaceId, asset.id))) throw notFound("Asset");
    const blobDeleted = await this.releaseBlob(asset.storageKey);

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "asset.deleted",
      targetType: "asset",
      targetId: asset.id,
      outcome: "success",
      metadata: { checksum: asset.checksum, sizeBytes: asset.sizeBytes, blobDeleted },
      requestId: input.requestId,
      ip: input.ip,
    });

    return { deleted: true, assetId: asset.id, blobDeleted };
  }

  public async deleteRun(input: DeleteRunInput): Promise<DeleteRunResult> {
    const { principal } = input;
    const run = await this.repos.runs.findById(principal.workspaceId, input.runId);
    if (!run) throw notFound("Run");

    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new ApiError(
        "RUN_NOT_TERMINAL",
        `Run is '${run.status}'. Only terminal runs can be deleted; cancel it first.`,
        { details: { runId: run.id, status: run.status } },
      );
    }

    // The run row, its traces and queued jobs go together; the idempotency
    // record is removed so the client's key becomes usable again instead of
    // pointing at a run that no longer exists.
    if (!(await this.repos.runs.delete(principal.workspaceId, run.id))) throw notFound("Run");
    const idempotencyKeysFreed = await this.repos.idempotency.deleteByResource(principal.workspaceId, "run", run.id);

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "run.deleted",
      targetType: "run",
      targetId: run.id,
      outcome: "success",
      metadata: { status: run.status, mappingId: run.mappingId, idempotencyKeysFreed },
      requestId: input.requestId,
      ip: input.ip,
    });

    return { deleted: true, runId: run.id, idempotencyKeysFreed };
  }

  public async requestWorkspaceDeletion(input: DeleteWorkspaceInput): Promise<DeleteWorkspaceResult> {
    const { principal } = input;
    const workspace = await this.repos.workspaces.findById(principal.workspaceId);
    if (!workspace) throw notFound("Workspace");

    const confirm = typeof input.confirm === "string" ? input.confirm.trim() : "";
    if (confirm !== workspace.slug) {
      throw validationFailed(`Send { "confirm": "${workspace.slug}" } to schedule deletion of this workspace.`);
    }

    const requestedAt = this.now();
    const purgeAt = new Date(requestedAt.getTime() + this.config.retention.workspaceGraceDays * DAY_MS);
    if (!(await this.repos.workspaces.softDelete(workspace.id, requestedAt.toISOString()))) {
      throw new ApiError("CONFLICT", "This workspace is already scheduled for deletion.");
    }

    const keysRevoked = await this.repos.apiKeys.revokeAll(workspace.id, requestedAt.toISOString());
    await this.repos.workspacePurges.schedule({
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      scheduledAt: purgeAt.toISOString(),
      requestedAt: requestedAt.toISOString(),
      requestedBy: principal.apiKeyId,
    });

    await this.audit.record({
      workspaceId: workspace.id,
      actorKeyId: principal.apiKeyId,
      action: "workspace.deletion_requested",
      targetType: "workspace",
      targetId: workspace.id,
      outcome: "success",
      metadata: { slug: workspace.slug, purgeScheduledAt: purgeAt.toISOString(), keysRevoked },
      requestId: input.requestId,
      ip: input.ip,
    });
    // The tenant audit trail is purged with the workspace, so the platform
    // trail must independently remember that the deletion was requested.
    await this.recordPlatform({
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      actorKeyId: principal.apiKeyId,
      action: "workspace.deletion_requested",
      targetType: "workspace",
      targetId: workspace.id,
      outcome: "success",
      metadata: { purgeScheduledAt: purgeAt.toISOString(), keysRevoked },
    });

    return {
      deleted: true,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      purgeScheduledAt: purgeAt.toISOString(),
      keysRevoked,
    };
  }

  /**
   * Applies retention policy once. Incremental and idempotent: progress is
   * bounded per workspace and per batch, so calling it twice is safe and a
   * large backlog drains over successive sweeps.
   */
  public async sweep(): Promise<SweepResult> {
    const at = this.now();
    const result: SweepResult = {
      at: at.toISOString(),
      workspacesPurged: 0,
      runsDeleted: 0,
      assetsDeleted: 0,
      blobsDeleted: 0,
    };

    const due = await this.repos.workspacePurges.listDue(at.toISOString());
    for (const purge of due) {
      try {
        const keys = await this.repos.workspacePurges.purge(purge.workspaceId);
        let blobsDeleted = 0;
        for (const key of keys) {
          if (await this.releaseBlob(key)) blobsDeleted++;
        }
        result.workspacesPurged++;
        result.blobsDeleted += blobsDeleted;
        await this.recordPlatform({
          workspaceId: purge.workspaceId,
          workspaceSlug: purge.workspaceSlug,
          action: "workspace.purged",
          targetType: "workspace",
          targetId: purge.workspaceId,
          outcome: "success",
          metadata: { blobsDeleted, scheduledAt: purge.scheduledAt },
        });
      } catch (error) {
        this.log(`retention: purge of workspace ${purge.workspaceId} failed: ${(error as Error).message}`);
      }
    }

    for (const workspace of await this.listAllWorkspaces()) {
      if (workspace.retentionDays <= 0) continue;
      const cutoff = new Date(at.getTime() - workspace.retentionDays * DAY_MS).toISOString();
      try {
        const runsDeleted = await this.deleteExpiredRuns(workspace.id, cutoff);
        const { assetsDeleted, blobsDeleted } = await this.deleteExpiredAssets(workspace.id, cutoff);

        result.runsDeleted += runsDeleted;
        result.assetsDeleted += assetsDeleted;
        result.blobsDeleted += blobsDeleted;

        if (runsDeleted > 0 || assetsDeleted > 0) {
          await this.audit.record({
            workspaceId: workspace.id,
            action: "retention.swept",
            targetType: "workspace",
            targetId: workspace.id,
            outcome: "success",
            metadata: { runsDeleted, assetsDeleted, blobsDeleted, cutoff, retentionDays: workspace.retentionDays },
          });
        }
      } catch (error) {
        // One tenant must not stop the sweep for everyone else.
        this.log(`retention: sweep of workspace ${workspace.id} failed: ${(error as Error).message}`);
      }
    }

    return result;
  }

  /** Starts the in-process scheduler. Interval 0 leaves retention manual. */
  public start(): void {
    if (this.timer || this.config.retention.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.log(`retention: scheduled sweep failed: ${(error as Error).message}`);
      });
    }, this.config.retention.sweepIntervalMs);
    // Never keep the process alive just to run retention.
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async deleteExpiredRuns(workspaceId: string, cutoff: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      const batch = await this.repos.runs.listExpired(workspaceId, cutoff, RETENTION_BATCH_LIMIT);
      if (batch.length === 0) return deleted;
      let removedInBatch = 0;
      for (const run of batch) {
        if (await this.repos.runs.delete(workspaceId, run.id)) {
          removedInBatch++;
          deleted++;
          await this.repos.idempotency.deleteByResource(workspaceId, "run", run.id);
        }
      }
      // A full batch with nothing removed means another process is racing it;
      // stop rather than spin.
      if (removedInBatch === 0 || batch.length < RETENTION_BATCH_LIMIT) return deleted;
    }
  }

  private async deleteExpiredAssets(
    workspaceId: string,
    cutoff: string,
  ): Promise<{ assetsDeleted: number; blobsDeleted: number }> {
    let assetsDeleted = 0;
    let blobsDeleted = 0;
    for (;;) {
      const batch = await this.repos.assets.listExpired(workspaceId, cutoff, RETENTION_BATCH_LIMIT);
      if (batch.length === 0) return { assetsDeleted, blobsDeleted };
      let removedInBatch = 0;
      for (const asset of batch) {
        // An old asset may still feed a run inside the window; deleting it would
        // blank that run's provenance.
        if ((await this.repos.runs.countByAsset(workspaceId, asset.id)) > 0) continue;
        if (!(await this.repos.assets.delete(workspaceId, asset.id))) continue;
        removedInBatch++;
        assetsDeleted++;
        if (await this.releaseBlob(asset.storageKey)) blobsDeleted++;
      }
      if (removedInBatch === 0 || batch.length < RETENTION_BATCH_LIMIT) return { assetsDeleted, blobsDeleted };
    }
  }

  /** Deletes the object only when no asset in any workspace still references its key. */
  private async releaseBlob(storageKey: string): Promise<boolean> {
    if (await this.repos.assets.storageKeyInUse(storageKey)) return false;
    try {
      return await this.storage.delete(storageKey);
    } catch (error) {
      this.log(`retention: failed to delete blob ${storageKey}: ${(error as Error).message}`);
      return false;
    }
  }

  private async listAllWorkspaces(): Promise<Workspace[]> {
    const items: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repos.workspaces.list({ limit: 100, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  private async recordPlatform(
    event: Omit<Parameters<Repositories["platformAudit"]["append"]>[0], "id" | "createdAt">,
  ): Promise<void> {
    try {
      await this.repos.platformAudit.append({
        id: this.idFactory(),
        createdAt: this.now().toISOString(),
        ...event,
      });
    } catch (error) {
      // Best-effort like the tenant audit trail: losing the record must not
      // resurrect a deleted workspace, but it is logged loudly.
      this.log(`retention: platform audit write failed for ${event.action}: ${(error as Error).message}`);
    }
  }
}
