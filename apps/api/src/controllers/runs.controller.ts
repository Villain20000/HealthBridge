import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, Sse } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import type { Principal } from "@healthbridge/auth";
import type { RunStatus } from "@healthbridge/persistence";
import { ENGINE_VERSION, TRACE_PROTOCOL_VERSION } from "@healthbridge/shared-types";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import { validationFailed } from "../common/errors.js";
import { optionalRecord, parseCursor, parseLimit, requireObject, requireString } from "../common/validate.js";
import { isTerminal } from "../services/run.service.js";
import type { RunEvent } from "../jobs/run-queue.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

const STATUSES: RunStatus[] = [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "completed_with_warnings",
  "failed",
];

/**
 * Runs: creation is 202 + a run resource, never a synchronous transform.
 *
 * The queue is in-process (see docs/api.md for the consequences), but the API
 * contract is the async one, so moving to a shared broker later is not a breaking
 * change for clients.
 */
@Controller("api/v1/runs")
export class RunsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("runs:write")
  @Post()
  @HttpCode(202)
  public async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const payload = requireObject(body);
    const result = await this.ctx.runs.create({
      principal,
      assetId: requireString(payload.assetId, "assetId"),
      mappingId: payload.mappingId === undefined ? undefined : requireString(payload.mappingId, "mappingId"),
      mappingName: payload.mappingName === undefined ? undefined : requireString(payload.mappingName, "mappingName"),
      pipelineId: payload.pipelineId === undefined ? undefined : requireString(payload.pipelineId, "pipelineId"),
      options: optionalRecord(payload.options, "options"),
      idempotencyKey: idempotencyKey?.trim() || undefined,
      requestId: request.requestId,
      ip: request.ip,
    });

    return {
      run: result.run,
      created: result.created,
      links: {
        self: `/api/v1/runs/${result.run.id}`,
        events: `/api/v1/runs/${result.run.id}/events`,
        traces: `/api/v1/runs/${result.run.id}/traces`,
        resources: `/api/v1/runs/${result.run.id}/resources`,
        bundle: `/api/v1/runs/${result.run.id}/bundle`,
      },
    };
  }

  @RequiresScope("runs:read")
  @Get()
  public async list(
    @CurrentPrincipal() principal: Principal,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    if (status !== undefined && !STATUSES.includes(status as RunStatus)) {
      throw validationFailed(`'status' must be one of: ${STATUSES.join(", ")}.`);
    }

    const page = await this.ctx.runs.list(principal.workspaceId, {
      status: status as RunStatus | undefined,
      limit: parseLimit(limit),
      cursor: parseCursor(cursor),
    });

    return { runs: page.items.map(toRunSummary), nextCursor: page.nextCursor };
  }

  @RequiresScope("runs:read")
  @Get(":id")
  public async get(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const run = await this.ctx.runs.get(principal.workspaceId, id);
    return { run };
  }

  @RequiresScope("runs:read")
  @Get(":id/resources")
  public async resources(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const result = await this.ctx.runs.resources(principal.workspaceId, id);
    return {
      resources: result.resources,
      omitted: result.omitted,
      bytes: result.bytes,
      note: result.omitted
        ? "Output exceeded the stored-result limit; re-run with maxRecords to materialise a subset."
        : undefined,
    };
  }

  @RequiresScope("runs:read")
  @Get(":id/issues")
  public async issues(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    return this.ctx.runs.issues(principal.workspaceId, id);
  }

  @RequiresScope("runs:read")
  @Get(":id/traces")
  public async traces(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const traces = await this.ctx.runs.traces(principal.workspaceId, id);
    return { traces, count: traces.length };
  }

  /**
   * A self-describing descriptor that never embeds payload bytes — safe to attach
   * to a ticket and replay against the same input.
   */
  @RequiresScope("runs:read")
  @Get(":id/bundle")
  public async bundle(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const run = await this.ctx.runs.get(principal.workspaceId, id);
    const mapping = await this.ctx.repos.mappings.findById(principal.workspaceId, run.mappingId);
    const asset = run.assetId ? await this.ctx.repos.assets.findById(principal.workspaceId, run.assetId) : undefined;
    const summary = (run.summary ?? {}) as Record<string, unknown>;

    return {
      bundleVersion: "1",
      source: "healthbridge-api",
      apiVersion: "1",
      runId: run.id,
      createdAt: run.createdAt,
      engineVersion: run.engineVersion ?? ENGINE_VERSION,
      traceProtocolVersion: TRACE_PROTOCOL_VERSION,
      pipelineVersion: String(summary.pipelineVersion ?? run.engineVersion ?? ENGINE_VERSION),
      input: {
        id: run.assetId,
        filename: asset?.filename,
        sizeBytes: asset?.sizeBytes,
        checksum: run.inputChecksum,
      },
      adapter: run.adapterId ? { id: run.adapterId, version: run.adapterVersion ?? "unknown" } : undefined,
      mapping: mapping?.spec,
      mappingRef: mapping
        ? { id: mapping.id, name: mapping.name, version: mapping.version, checksum: mapping.specChecksum }
        : undefined,
      options: run.options,
      expected: {
        status: run.status,
        recordsProcessed: run.recordsProcessed,
        recordsSucceeded: run.recordsSucceeded,
        recordsFailed: run.recordsFailed,
        outputChecksum: run.outputChecksum,
        validationValid: ((run.validation ?? {}) as { isValid?: boolean }).isValid ?? false,
      },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    };
  }

  @RequiresScope("runs:write")
  @Post(":id/cancel")
  @HttpCode(202)
  public async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const run = await this.ctx.runs.cancel(principal, id, { requestId: request.requestId, ip: request.ip });
    return { run, note: "Cancellation is cooperative: an in-flight record is finished before the run stops." };
  }

  @RequiresScope("runs:write")
  @Post(":id/replay")
  @HttpCode(202)
  public async replay(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.ctx.runs.replay(principal, id, { requestId: request.requestId, ip: request.ip });
    return { run: result.run, created: result.created, replayedFrom: id };
  }

  /**
   * Server-sent events for one run.
   *
   * The stream sends the current snapshot first, so a client that connects late
   * (or reconnects) is never blind, then forwards queue events and closes on a
   * terminal state. A heartbeat keeps proxies from timing the connection out.
   */
  @RequiresScope("runs:read")
  @Sse(":id/events")
  @Header("cache-control", "no-cache, no-transform")
  public events(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Observable<MessageEvent> {
    const ctx = this.ctx;
    const heartbeatMs = ctx.config.sseHeartbeatMs;

    return new Observable<MessageEvent>((subscriber) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let unsubscribe = () => undefined as void;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        subscriber.complete();
      };

      const pump = (event: RunEvent) => {
        if (finished) return;
        subscriber.next({ type: event.type, data: { ...event } } as MessageEvent);
        if (event.type === "done" || event.type === "error" || event.type === "cancelled") finish();
      };

      // Subscribe before the snapshot read so an event can never slip in between.
      unsubscribe = ctx.queue.subscribe(id, pump);

      ctx.runs
        .get(principal.workspaceId, id)
        .then((run) => {
          if (finished) return;
          subscriber.next({ type: "snapshot", data: { run } } as MessageEvent);
          if (isTerminal(run.status) && !ctx.queue.isQueuedOrRunning(id)) {
            // A late subscriber still gets a terminal event, so a client can rely
            // on "snapshot → … → terminal" instead of inventing a fallback.
            const type = run.status === "cancelled" ? "cancelled" : run.status === "failed" ? "error" : "done";
            subscriber.next({
              type,
              data: { runId: id, type, at: new Date().toISOString(), payload: { status: run.status } },
            } as MessageEvent);
            finish();
            return;
          }
          heartbeat = setInterval(() => {
            if (finished) return;
            subscriber.next({ type: "ping", data: { at: new Date().toISOString() } } as MessageEvent);
          }, heartbeatMs);
          heartbeat.unref?.();
        })
        .catch((error: unknown) => {
          finished = true;
          clearInterval(heartbeat);
          unsubscribe();
          subscriber.error(error);
        });

      return () => {
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
      };
    });
  }
}

function toRunSummary(run: {
  id: string;
  status: string;
  mappingId: string;
  assetId?: string;
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  createdAt: string;
  finishedAt?: string;
  progress?: unknown;
  error?: unknown;
}) {
  return {
    id: run.id,
    status: run.status,
    mappingId: run.mappingId,
    assetId: run.assetId,
    recordsProcessed: run.recordsProcessed,
    recordsSucceeded: run.recordsSucceeded,
    recordsFailed: run.recordsFailed,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    progress: run.progress,
    error: run.error,
  };
}
