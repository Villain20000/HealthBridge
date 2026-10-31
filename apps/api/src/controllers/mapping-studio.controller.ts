import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Principal } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import {
  optionalInteger,
  optionalString,
  parseOptionalInteger,
  requireInteger,
  requireObject,
  requireSlug,
  requireString,
} from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/**
 * Mapping studio: draft lifecycle, publish, version diff and bounded preview.
 *
 * Drafts are addressable by catalogue name (the same name mappings are created
 * under) and every write is revision-checked. Previews are read-only and never
 * create a run, so the editor can call them on every change.
 */
@Controller("api/v1/mappings")
export class MappingStudioController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Declared before the parameterised draft routes so `preview` is literal. */
  @RequiresScope("mappings:write")
  @Post("preview")
  @HttpCode(200)
  public async preview(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const spec = requireObject(payload.spec, "spec");
    const assetId = requireString(payload.assetId, "assetId", { max: 100 });
    const maxRecords = optionalInteger(payload.maxRecords, "maxRecords", { min: 1 });
    const adapterId = optionalString(payload.adapterId, "adapterId", { max: 60 });

    return this.ctx.preview.preview(principal, {
      spec,
      assetId,
      maxRecords,
      adapterId,
      requestId: request.requestId,
      ip: request.ip,
    });
  }

  @RequiresScope("mappings:read")
  @Get(":name/draft")
  public async getDraft(@CurrentPrincipal() principal: Principal, @Param("name") name: string) {
    return this.ctx.studio.getDraft(principal, requireSlug(name, "name"));
  }

  @RequiresScope("mappings:write")
  @Put(":name/draft")
  public async saveDraft(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const spec = requireObject(payload.spec, "spec");
    const revision = requireInteger(payload.revision, "revision", { min: 0 });
    const baseVersion = optionalInteger(payload.baseVersion, "baseVersion", { min: 1 });

    return this.ctx.studio.saveDraft(
      principal,
      requireSlug(name, "name"),
      { spec, revision, baseVersion },
      { requestId: request.requestId, ip: request.ip },
    );
  }

  @RequiresScope("mappings:write")
  @Delete(":name/draft")
  @HttpCode(204)
  public async discardDraft(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Query("revision") revisionQuery: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const expectedRevision = parseOptionalInteger(revisionQuery, "revision", 0);
    await this.ctx.studio.discardDraft(principal, requireSlug(name, "name"), expectedRevision, {
      requestId: request.requestId,
      ip: request.ip,
    });
  }

  @RequiresScope("mappings:write")
  @Post(":name/publish")
  @HttpCode(200)
  public async publish(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const revision = requireInteger(payload.revision, "revision", { min: 0 });

    return this.ctx.studio.publish(
      principal,
      requireSlug(name, "name"),
      { revision },
      { requestId: request.requestId, ip: request.ip },
    );
  }

  @RequiresScope("mappings:read")
  @Get(":name/diff")
  public async diff(
    @CurrentPrincipal() principal: Principal,
    @Param("name") name: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.ctx.studio.diff(principal, requireSlug(name, "name"), from, to);
  }
}
