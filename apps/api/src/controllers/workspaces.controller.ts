import { Body, Controller, Delete, Get, Headers, Inject, Post, Req } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ApiError } from "../common/errors.js";
import { CurrentPrincipal, PublicRoute, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import type { Principal } from "@healthbridge/auth";
import { requireBootstrapToken, requireObject, requireSlug, requireString } from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/**
 * Workspace provisioning.
 *
 * The first workspace is created with an operator-held bootstrap token. That token
 * is platform-level, not tenant-level: it cannot read data, and it is the only way
 * to add a tenant. Rotate it after setup (documented in SECURITY.md).
 */
@Controller("api/v1/workspaces")
export class WorkspacesController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @PublicRoute()
  @Post()
  public async create(
    @Headers("x-bootstrap-token") bootstrapToken: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    // Public route: the auth guard returns before its rate limiter, so every
    // attempt (successful or not) is counted here per client IP.
    const decision = this.ctx.bootstrapLimiter.consume(request.ip ?? "unknown");
    if (!decision.allowed) {
      throw new ApiError("RATE_LIMITED", "Too many workspace bootstrap attempts from this address.", {
        details: { retryAfterSeconds: decision.retryAfterSeconds },
        headers: {
          "retry-after": String(decision.retryAfterSeconds),
          "x-ratelimit-limit": String(decision.limit),
          "x-ratelimit-remaining": "0",
        },
      });
    }

    requireBootstrapToken(bootstrapToken, this.ctx.config.auth.bootstrapToken);
    const payload = requireObject(body);
    const name = requireString(payload.name, "name", { max: 200 });
    const slug = requireSlug(payload.slug, "slug");
    const plan = payload.plan === undefined ? "community" : requireString(payload.plan, "plan", { max: 32 });

    const workspace = {
      id: `ws_${randomBytes(9).toString("hex")}`,
      slug,
      name,
      plan,
      retentionDays: 90,
      createdAt: new Date().toISOString(),
      createdBy: "bootstrap",
    };

    const created = await this.ctx.repos.workspaces.create(workspace);

    // An owner key is returned exactly once; only its hash is stored.
    const issued = await this.ctx.apiKeys.issue({
      workspaceId: created.id,
      name: "bootstrap owner key",
      role: "owner",
      createdBy: "bootstrap",
    });

    await this.ctx.audit.record({
      workspaceId: created.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: created.id,
      outcome: "success",
      metadata: { slug, plan },
      requestId: request.requestId,
      ip: request.ip,
    });

    return {
      workspace: created,
      apiKey: {
        key: issued.key,
        id: issued.record.id,
        role: issued.record.role,
        scopes: issued.record.scopes,
        note: "Store this key now: it cannot be retrieved again.",
      },
    };
  }

  @RequiresScope("runs:read")
  @Get("current")
  public async current(@CurrentPrincipal() principal: Principal) {
    const workspace = await this.ctx.repos.workspaces.findById(principal.workspaceId);
    if (!workspace) throw new ApiError("NOT_FOUND", "Workspace not found.");
    return {
      workspace,
      key: { id: principal.apiKeyId, name: principal.keyName, role: principal.role, scopes: principal.scopes },
    };
  }

  @RequiresScope("workspaces:admin")
  @Delete("current")
  public async remove(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const payload = requireObject(body);
    return this.ctx.retention.requestWorkspaceDeletion({
      principal,
      confirm: payload.confirm,
      requestId: request.requestId,
      ip: request.ip,
    });
  }
}
