import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from "@nestjs/common";
import type { Principal, Role } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import { ApiError, notFound } from "../common/errors.js";
import { optionalString, requireObject, requireString } from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

const ROLES: Role[] = ["owner", "editor", "viewer", "service"];

/**
 * API key management. A key is only ever visible at creation/rotation time; every
 * other response carries the prefix and metadata so operators can identify a key
 * without being able to use it.
 */
@Controller("api/v1/keys")
export class KeysController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("workspaces:admin")
  @Post()
  public async issue(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    const name = requireString(payload.name, "name", { max: 200 });
    const role = (payload.role === undefined ? "viewer" : requireString(payload.role, "role")) as Role;
    if (!ROLES.includes(role)) throw new ApiError("VALIDATION_FAILED", `role must be one of: ${ROLES.join(", ")}.`);

    const expiresAt = optionalString(payload.expiresAt, "expiresAt");
    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      throw new ApiError("VALIDATION_FAILED", "'expiresAt' must be an ISO-8601 timestamp.");
    }

    let issued;
    try {
      issued = await this.ctx.apiKeys.issue({
        workspaceId: principal.workspaceId,
        name,
        role,
        scopes: payload.scopes as never,
        expiresAt,
        createdBy: principal.apiKeyId,
      });
    } catch (error) {
      throw new ApiError("VALIDATION_FAILED", (error as Error).message);
    }

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "key.issued",
      targetType: "api_key",
      targetId: issued.record.id,
      outcome: "success",
      metadata: { role, scopes: issued.record.scopes, expiresAt },
      requestId: request.requestId,
      ip: request.ip,
    });

    return {
      key: issued.key,
      apiKey: this.ctx.apiKeys.summarise(issued.record),
      note: "Store this key now: it cannot be retrieved again.",
    };
  }

  @RequiresScope("workspaces:admin")
  @Get()
  public async list(@CurrentPrincipal() principal: Principal) {
    return { keys: await this.ctx.apiKeys.list(principal.workspaceId) };
  }

  @RequiresScope("workspaces:admin")
  @Delete(":id")
  public async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const revoked = await this.ctx.apiKeys.revoke(id, principal.workspaceId);
    if (!revoked) throw notFound("API key");

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "key.revoked",
      targetType: "api_key",
      targetId: id,
      outcome: "success",
      requestId: request.requestId,
      ip: request.ip,
    });

    return { revoked: true, id };
  }

  @RequiresScope("workspaces:admin")
  @Post(":id/rotate")
  public async rotate(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const rotated = await this.ctx.apiKeys.rotate(id, principal.workspaceId);
    if (!rotated) throw notFound("API key");

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "key.rotated",
      targetType: "api_key",
      targetId: rotated.record.id,
      outcome: "success",
      metadata: { rotatedFrom: id },
      requestId: request.requestId,
      ip: request.ip,
    });

    return { key: rotated.key, apiKey: this.ctx.apiKeys.summarise(rotated.record), revoked: id };
  }
}
