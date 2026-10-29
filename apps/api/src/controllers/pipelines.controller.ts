import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import { notFound } from "../common/errors.js";
import {
  optionalRecord,
  parseCursor,
  parseLimit,
  requireObject,
  requireSlug,
  requireString,
} from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/**
 * Pipeline catalogue: a named combination of a mapping and engine options.
 *
 * A pipeline is a convenience for repeatable operations, not a second execution
 * path: it resolves to a mapping id and options, and the run service executes that.
 */
@Controller("api/v1/pipelines")
export class PipelinesController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("pipelines:write")
  @Post()
  public async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const name = requireSlug(payload.name, "name");
    const mappingId = requireString(payload.mappingId, "mappingId");
    const config = optionalRecord(payload.config, "config");

    const mapping = await this.ctx.repos.mappings.findById(principal.workspaceId, mappingId);
    if (!mapping) throw notFound("Mapping");

    const pipeline = await this.ctx.repos.pipelines.create({
      id: `pl_${randomBytes(9).toString("hex")}`,
      workspaceId: principal.workspaceId,
      name,
      mappingId: mapping.id,
      config,
      createdAt: new Date().toISOString(),
      createdBy: principal.apiKeyId,
    });

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "pipeline.created",
      targetType: "pipeline",
      targetId: pipeline.id,
      outcome: "success",
      metadata: { name, mappingId: mapping.id, mappingVersion: mapping.version },
      requestId: request.requestId,
      ip: request.ip,
    });

    return { pipeline };
  }

  @RequiresScope("pipelines:read")
  @Get()
  public async list(
    @CurrentPrincipal() principal: Principal,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.ctx.repos.pipelines.list(principal.workspaceId, {
      limit: parseLimit(limit),
      cursor: parseCursor(cursor),
    });
    return { pipelines: page.items, nextCursor: page.nextCursor };
  }

  @RequiresScope("pipelines:read")
  @Get(":id")
  public async get(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const pipeline = await this.ctx.repos.pipelines.findById(principal.workspaceId, id);
    if (!pipeline) throw notFound("Pipeline");
    const mapping = await this.ctx.repos.mappings.findById(principal.workspaceId, pipeline.mappingId);
    return { pipeline, mapping };
  }
}
