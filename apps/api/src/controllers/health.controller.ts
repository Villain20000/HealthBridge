import { Controller, Get, Inject } from "@nestjs/common";
import { ENGINE_VERSION, TRACE_PROTOCOL_VERSION } from "@healthbridge/shared-types";
import { PublicRoute } from "../common/auth.guard.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

@Controller("api/v1")
export class HealthController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /**
   * Liveness. Public on purpose: a health check that needs credentials is not a
   * health check. It reports the persistence mode so a demo instance can never be
   * mistaken for a durable deployment.
   */
  @PublicRoute()
  @Get("healthz")
  public healthz() {
    return {
      status: "ok",
      mode: this.ctx.config.mode,
      nodeEnv: this.ctx.config.nodeEnv,
      persistence: this.ctx.config.mode === "database" ? "mysql" : "in-memory (demo)",
      storage: this.ctx.storage.name,
      queue: {
        active: this.ctx.queue.active,
        queued: this.ctx.queue.queued,
        // "durable" means work is in the database and survives this process.
        mode: this.ctx.queue.durable ? "durable" : "process",
      },
      // Limits are part of the contract: a client must be able to state the real maximum
      // upload size instead of hard-coding one that drifts from the server.
      limits: {
        maxUploadBytes: this.ctx.config.storage.maxObjectBytes,
        maxRequestBodyBytes: this.ctx.config.limits.maxRequestBodyBytes,
        maxStoredResultBytes: this.ctx.config.limits.maxStoredResultBytes,
        maxTracesPerRun: this.ctx.config.limits.maxTracesPerRun,
        rateLimit: {
          burst: this.ctx.config.limits.rateLimit.capacity,
          refillPerSecond: this.ctx.config.limits.rateLimit.refillPerSecond,
        },
        queue: {
          concurrency: this.ctx.config.queue.concurrency,
          maxAttempts: this.ctx.config.queue.maxAttempts,
        },
      },
      startedAt: this.ctx.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @PublicRoute()
  @Get("version")
  public version() {
    return {
      engine: ENGINE_VERSION,
      traceProtocol: TRACE_PROTOCOL_VERSION,
      api: "1",
      node: process.version,
      persistence: this.ctx.repos.mode,
    };
  }

  /** Capability manifest of the adapter registry (no patient data involved). */
  @PublicRoute()
  @Get("formats")
  public async formats() {
    const bridge = await import("@healthbridge/sdk");
    const sdk = new bridge.HealthBridge({ keepRunsInMemory: false });
    return { formats: sdk.listFormats() };
  }
}
