import { Body, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import { notFound, validationFailed } from "../common/errors.js";
import { mappingSpecChecksum } from "../common/mapping-spec.js";
import { optionalString, parseCursor, parseLimit, requireObject, requireSlug } from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/**
 * Mapping catalogue.
 *
 * Versions are immutable: posting the same name again creates version n+1, and a
 * run always references a mapping *id*, so editing a mapping can never silently
 * change what an old run did.
 */
@Controller("api/v1/mappings")
export class MappingsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("mappings:write")
  @Post()
  public async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const name = requireSlug(payload.name, "name");
    const spec = requireObject(payload.spec, "spec");
    if (!Array.isArray(spec.rules)) throw validationFailed("'spec.rules' must be an array.");

    const checksum = mappingSpecChecksum(spec);
    const mapping = await this.ctx.repos.mappings.create({
      id: `mp_${randomBytes(9).toString("hex")}`,
      workspaceId: principal.workspaceId,
      name,
      spec,
      specChecksum: checksum,
      sourceFormat: optionalString(payload.sourceFormat, "sourceFormat", { max: 60 }) ?? "auto",
      targetFormat: optionalString(payload.targetFormat, "targetFormat", { max: 60 }) ?? "fhir-r4",
      targetResourceType: optionalString(payload.targetResourceType, "targetResourceType", { max: 60 }),
      createdAt: new Date().toISOString(),
      createdBy: principal.apiKeyId,
    });

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "mapping.created",
      targetType: "mapping",
      targetId: mapping.id,
      outcome: "success",
      metadata: { name, version: mapping.version, specChecksum: checksum },
      requestId: request.requestId,
      ip: request.ip,
    });

    return { mapping };
  }

  @RequiresScope("mappings:read")
  @Get()
  public async list(
    @CurrentPrincipal() principal: Principal,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.ctx.repos.mappings.list(principal.workspaceId, {
      limit: parseLimit(limit),
      cursor: parseCursor(cursor),
    });
    return { mappings: page.items, nextCursor: page.nextCursor };
  }

  /** Declared before `:id` so `:name/versions` is never captured as an id. */
  @RequiresScope("mappings:read")
  @Get(":name/versions")
  public async versions(@CurrentPrincipal() principal: Principal, @Param("name") name: string) {
    const versions = await this.ctx.repos.mappings.versions(principal.workspaceId, name);
    if (versions.length === 0) throw notFound("Mapping");
    return { name, versions };
  }

  @RequiresScope("mappings:read")
  @Get(":id")
  public async get(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const mapping = await this.ctx.repos.mappings.findById(principal.workspaceId, id);
    if (!mapping) throw notFound("Mapping");
    return { mapping };
  }
}
