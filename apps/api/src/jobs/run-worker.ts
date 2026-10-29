import { HealthBridge, HealthBridgeError } from "@healthbridge/sdk";
import type { InputDescriptor, TransformationResult } from "@healthbridge/shared-types";
import type { MappingDefinition } from "@healthbridge/mapping-engine";
import type { Repositories, RunRecord } from "@healthbridge/persistence";
import type { StorageDriver } from "@healthbridge/storage";
import type { ApiConfig } from "../config.js";
import type { JobExecutor, RunJob } from "./run-queue.js";

/**
 * Executes one queued run end to end and records everything the API can report.
 *
 * Cancellation is cooperative: the engine checks the abort signal at stage
 * boundaries, so an in-flight record is finished before the run is marked
 * cancelled. That is stated in the API docs rather than implied by a 202.
 */

export type RunOutcomeStatus = "completed" | "completed_with_warnings" | "failed" | "cancelled";

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
  const bridge = new HealthBridge({ keepRunsInMemory: false });

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

    let result: TransformationResult;
    try {
      result = await bridge.transform({
        input,
        mapping: mappingDefinition,
        signal,
        importedAt,
        runId: run.id,
        maxRecords: typeof run.options?.maxRecords === "number" ? (run.options.maxRecords as number) : undefined,
      });
    } catch (error) {
      if (error instanceof HealthBridgeError && error.code === "CANCELLED") {
        await markCancelled(repos, run, now);
        return { status: "cancelled" };
      }
      const code = error instanceof HealthBridgeError ? error.code : "TRANSFORMATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await fail(repos, run, code, message, now);
      // A data problem is not retryable; surface it as a completed job with a failed run.
      return { status: "completed" };
    }

    if (signal.aborted) {
      await markCancelled(repos, run, now);
      return { status: "cancelled" };
    }

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

async function markCancelled(repos: Repositories, run: RunRecord, now: () => Date): Promise<void> {
  await repos.runs.update(run.workspaceId, run.id, {
    status: "cancelled",
    cancelledAt: now().toISOString(),
    finishedAt: now().toISOString(),
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
  await repos.runs.update(run.workspaceId, run.id, {
    status: "failed",
    error: { code, message },
    finishedAt: now().toISOString(),
    progress: { stage: "failed", stepName: "Failed", recordsProcessed: run.recordsProcessed },
  });
}
