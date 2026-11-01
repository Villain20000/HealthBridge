import type { InputDescriptor, RunCheckpoint, TransformationResult } from "@healthbridge/shared-types";
import { TransformationPipeline, type ChunkedExecuteOutcome } from "@healthbridge/transformation-engine";
import type { MappingDefinition } from "@healthbridge/mapping-engine";
import type { Repositories, RunRecord } from "@healthbridge/persistence";
import type { StorageDriver } from "@healthbridge/storage";
import type { ApiConfig } from "../config.js";
import type { JobExecutor, ProgressReport, RunJob } from "./run-queue.js";

/**
 * Executes one queued run end to end and records everything the API can report.
 *
 * Cancellation is cooperative: the engine checks the abort signal at stage
 * boundaries, so an in-flight record is finished before the run is marked
 * cancelled. That is stated in the API docs rather than implied by a 202.
 */

export type RunOutcomeStatus = "completed" | "completed_with_warnings" | "failed" | "cancelled";

/**
 * In-memory live-run handles for cooperative pause/resume.
 *
 * Demo-mode semantics (documented, not implied): these handles live in this
 * process only. A pause request is observed by the worker running the job at
 * its next chunk boundary; the worker then persists a {@link RunCheckpoint}
 * on the run row and holds its queue slot with status `running` and
 * `progress.stage: "paused"` until resume (or cancellation) arrives. A
 * restart loses the handles — the persisted checkpoint stays on the row for
 * observability, but v1 does not restore it across restarts or replicas (see
 * `docs/live-execution.md`: no distributed checkpointing in v1).
 * Static replay paths never consult these handles and are never labelled live.
 */
export interface LiveRunHandle {
  pauseRequested: boolean;
  checkpoint?: RunCheckpoint;
  updatedAt: string;
}

export const liveRunHandles = new Map<string, LiveRunHandle>();

/** Records per transform chunk: one checkpoint (and one pause/cancel check) each. */
export const LIVE_CHUNK_SIZE = 25;

export function requestLivePause(runId: string): void {
  const existing = liveRunHandles.get(runId);
  if (existing) {
    existing.pauseRequested = true;
    existing.updatedAt = new Date().toISOString();
  } else {
    liveRunHandles.set(runId, { pauseRequested: true, updatedAt: new Date().toISOString() });
  }
}

/** Clears a pause request. Returns false when this process holds no handle. */
export function requestLiveResume(runId: string): boolean {
  const existing = liveRunHandles.get(runId);
  if (!existing) return false;
  existing.pauseRequested = false;
  existing.updatedAt = new Date().toISOString();
  return true;
}

export function readLiveCheckpoint(runId: string): RunCheckpoint | undefined {
  return liveRunHandles.get(runId)?.checkpoint;
}

export function dropLiveHandle(runId: string): void {
  liveRunHandles.delete(runId);
}

/** True once the worker has observed a pause request and persisted it. */
export function isPausedProgress(run: { progress?: { stage?: string } | null }): boolean {
  return (run.progress as { stage?: string } | null | undefined)?.stage === "paused";
}

export interface RunWorkerDeps {
  repos: Repositories;
  storage: StorageDriver;
  config: ApiConfig;
  now?: () => Date;
  log?: (message: string) => void;
}

export function createRunWorker(deps: RunWorkerDeps): JobExecutor {
  const { repos, storage, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const pipeline = new TransformationPipeline();

  return async function execute(
    job: RunJob,
    context,
  ): Promise<{ status: RunOutcomeStatus; result?: TransformationResult }> {
    const { signal, report } = context;
    const run = await repos.runs.findById(job.workspaceId, job.runId);
    if (!run) throw Object.assign(new Error(`Run ${job.runId} disappeared before execution`), { code: "NOT_FOUND" });

    if (run.status === "cancelled") {
      return { status: "cancelled" };
    }

    if (signal.aborted) {
      await markCancelled(repos, run, now);
      return { status: "cancelled" };
    }

    report({ stage: "load", stepName: "Load input and mapping", percent: 5 });
    const mapping = await repos.mappings.findById(run.workspaceId, run.mappingId);
    if (!mapping) {
      await fail(repos, run, "MAPPING_NOT_FOUND", "The mapping referenced by this run no longer exists.", now);
      return { status: "completed" };
    }

    const mappingDefinition = toMappingDefinition(mapping.spec);
    if (!mappingDefinition) {
      await fail(repos, run, "MAPPING_INVALID", "The stored mapping is not a valid mapping definition.", now);
      return { status: "completed" };
    }

    const asset = run.assetId ? await repos.assets.findById(run.workspaceId, run.assetId) : undefined;
    if (!asset) {
      await fail(repos, run, "ASSET_NOT_FOUND", "The asset referenced by this run no longer exists.", now);
      return { status: "completed" };
    }

    let bytes: Buffer;
    try {
      bytes = (await storage.get(asset.storageKey)).bytes;
    } catch (error) {
      await fail(
        repos,
        run,
        "ASSET_UNREADABLE",
        `The stored object could not be read (${(error as Error).message}).`,
        now,
      );
      return { status: "completed" };
    }

    await repos.runs.update(run.workspaceId, run.id, {
      status: "running",
      startedAt: now().toISOString(),
      adapterId: asset.sourceFormat,
    });
    report({ stage: "transform", stepName: "Transform records", percent: 20 });

    const input: InputDescriptor = {
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.contentType,
      buffer: bytes,
      sizeBytes: asset.sizeBytes,
    };

    const importedAt = typeof run.options?.importedAt === "string" ? (run.options.importedAt as string) : undefined;

    // Live chunk loop: transform in bounded chunks with persisted checkpoints.
    // A pause request stops the run after its current chunk and HOLDS this job
    // slot (the run keeps status `running` with `progress.stage: "paused"` and
    // keeps its checkpoint); cancellation aborts it and drops the checkpoint.
    if (!liveRunHandles.has(run.id)) {
      liveRunHandles.set(run.id, { pauseRequested: false, updatedAt: now().toISOString() });
    }

    let outcome: ChunkedExecuteOutcome;
    try {
      outcome = await pipeline.executeChunked({
        input,
        mapping: mappingDefinition,
        importedAt,
        runId: run.id,
        maxRecords: typeof run.options?.maxRecords === "number" ? (run.options.maxRecords as number) : undefined,
        chunkSize: LIVE_CHUNK_SIZE,
        signal,
        shouldPause: () => liveRunHandles.get(run.id)?.pauseRequested === true,
        onCheckpoint: async (checkpoint) => {
          const handle = liveRunHandles.get(run.id);
          if (handle) handle.checkpoint = checkpoint;
          await persistCheckpoint(repos, run, checkpoint, report, log);
          // Cooperative scheduling point: demo mode runs the worker and the
          // HTTP handlers on one event loop, so yield a macrotask turn per
          // chunk — otherwise a pause/resume POST could never land mid-run.
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (liveRunHandles.get(run.id)?.pauseRequested === true && !signal.aborted) {
            // The request may have landed after the write above; mark paused
            // now so the row shows the state the worker is actually in.
            await persistCheckpoint(repos, run, checkpoint, report, log);
            // Blocking pause: the checkpoint is persisted and this slot is
            // held. Resume continues the loop; abort ends it as cancelled.
            while (liveRunHandles.get(run.id)?.pauseRequested === true && !signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!signal.aborted) {
              await repos.runs.update(run.workspaceId, run.id, {
                progress: {
                  stage: "mapping",
                  stepName: "Transform records (resumed)",
                  recordsProcessed: checkpoint.recordsProcessed,
                },
              });
              report({
                stage: "transform",
                stepName: "Transform records (resumed)",
                percent: 20,
                recordsProcessed: checkpoint.recordsProcessed,
              });
            }
          }
        },
      });
    } catch (error) {
      dropLiveHandle(run.id);
      const code = (error as { code?: string })?.code ?? "TRANSFORMATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await fail(repos, run, code, message, now);
      // A data problem is not retryable; surface it as a completed job with a failed run.
      return { status: "completed" };
    }

    if (outcome.status === "cancelled" || signal.aborted) {
      await markCancelled(repos, run, now);
      return { status: "cancelled" };
    }

    // `paused` cannot escape the loop above: onCheckpoint blocks until resume
    // or abort. Reaching here paused means the contract broke; fail loudly
    // rather than persisting a half-run as complete.
    if (outcome.status === "paused" || !outcome.result) {
      dropLiveHandle(run.id);
      await fail(repos, run, "TRANSFORMATION_FAILED", "The run stopped mid-transform without completing.", now);
      return { status: "completed" };
    }

    const result: TransformationResult = outcome.result;
    dropLiveHandle(run.id);

    report({ stage: "persist", stepName: "Persist results", percent: 85 });

    const resources = result.output as unknown[];
    const resultBytes = Buffer.byteLength(JSON.stringify(resources), "utf-8");
    const storeResources = resultBytes <= config.limits.maxStoredResultBytes;

    await repos.runs.update(run.workspaceId, run.id, {
      status: result.status,
      adapterId: result.adapterId,
      adapterVersion: result.adapterVersion,
      recordsProcessed: result.recordsProcessed,
      recordsSucceeded: result.recordsSucceeded,
      recordsFailed: result.recordsFailed,
      inputChecksum: result.inputChecksum,
      outputChecksum: result.outputChecksum,
      coverage: result.coverage,
      validation: result.validation,
      summary: {
        dataLoss: result.dataLoss,
        rejectedRecords: result.rejectedRecords,
        issues: result.validation.issues,
        durationMs: result.durationMs,
        importedAt: result.importedAt,
        sourceFormat: result.sourceFormat,
        targetFormat: result.targetFormat,
        targetResourceType: result.targetResourceType,
        engineVersion: result.engineVersion,
        resourcesOmitted: !storeResources,
        resourcesBytes: resultBytes,
      },
      result: storeResources ? { resources } : undefined,
      progress: {
        stage: "done",
        stepName: "Completed",
        recordsProcessed: result.recordsProcessed,
        recordsTotal: result.recordsProcessed,
        percent: 100,
      },
      finishedAt: now().toISOString(),
    });

    if (result.traces.length > 0) {
      const traces = result.traces.slice(0, config.limits.maxTracesPerRun).map((trace) => ({
        seq: 0,
        stage: String(trace.stage ?? "unknown"),
        stepName: trace.stepName,
        status: trace.status,
        durationMs: trace.durationMs,
        payload: trace,
        createdAt: trace.timestamp ?? now().toISOString(),
      }));
      try {
        await repos.runs.appendTraces(run.workspaceId, run.id, traces);
      } catch (error) {
        // Traces are diagnostics: losing them must not fail a run that produced data.
        log(`failed to persist ${traces.length} traces for run ${run.id}: ${(error as Error).message}`);
      }
    }

    return { status: result.status };
  };
}

function toMappingDefinition(spec: unknown): MappingDefinition | undefined {
  const candidate = spec as MappingDefinition | undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  if (!Array.isArray((candidate as { rules?: unknown }).rules)) return undefined;
  return candidate;
}

/**
 * Persists one chunk checkpoint on the run row (the "cursor" from the live
 * design): `summary.checkpoint` carries the resume cursor plus checksums,
 * `progress` carries the live position. A pause request flips the progress
 * stage to `paused` while the status stays `running` — pause is not cancel.
 */
async function persistCheckpoint(
  repos: Repositories,
  run: RunRecord,
  checkpoint: RunCheckpoint,
  report: (progress: ProgressReport) => void,
  log: (message: string) => void,
): Promise<void> {
  const paused = liveRunHandles.get(run.id)?.pauseRequested === true;
  try {
    const current = await repos.runs.findById(run.workspaceId, run.id);
    const prevSummary = (current?.summary ?? {}) as Record<string, unknown>;
    await repos.runs.update(run.workspaceId, run.id, {
      recordsProcessed: checkpoint.recordsProcessed,
      progress: {
        stage: paused ? "paused" : "mapping",
        stepName: paused ? "Paused" : "Transform records",
        recordsProcessed: checkpoint.recordsProcessed,
        recordsTotal: checkpoint.recordsTotal,
        percent: 20,
      },
      summary: { ...prevSummary, checkpoint },
    });
  } catch (error) {
    // Checkpoint writes are observability: losing one must not fail the run.
    log(`failed to persist checkpoint for run ${run.id}: ${(error as Error).message}`);
  }
  report({
    stage: paused ? "paused" : "transform",
    stepName: paused ? "Paused" : "Transform records",
    percent: 20,
    recordsProcessed: checkpoint.recordsProcessed,
  });
}

async function markCancelled(repos: Repositories, run: RunRecord, now: () => Date): Promise<void> {
  // Cancel is not pause: the checkpoint is dropped and the handle released.
  dropLiveHandle(run.id);
  const current = await repos.runs.findById(run.workspaceId, run.id).catch(() => undefined);
  const summary = { ...((current?.summary ?? run.summary ?? {}) as Record<string, unknown>) };
  delete summary.checkpoint;
  await repos.runs.update(run.workspaceId, run.id, {
    status: "cancelled",
    cancelledAt: now().toISOString(),
    finishedAt: now().toISOString(),
    summary,
    progress: { stage: "cancelled", stepName: "Cancelled", recordsProcessed: run.recordsProcessed },
  });
}

async function fail(
  repos: Repositories,
  run: RunRecord,
  code: string,
  message: string,
  now: () => Date,
): Promise<void> {
  // A failed run is not resumable either: its checkpoint is dropped with it.
  dropLiveHandle(run.id);
  const current = await repos.runs.findById(run.workspaceId, run.id).catch(() => undefined);
  const summary = { ...((current?.summary ?? run.summary ?? {}) as Record<string, unknown>) };
  delete summary.checkpoint;
  await repos.runs.update(run.workspaceId, run.id, {
    status: "failed",
    error: { code, message },
    finishedAt: now().toISOString(),
    summary,
    progress: { stage: "failed", stepName: "Failed", recordsProcessed: run.recordsProcessed },
  });
}
