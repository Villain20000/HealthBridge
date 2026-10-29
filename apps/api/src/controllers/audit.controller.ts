import { Controller, Get, Inject, Query } from "@nestjs/common";
import type { Principal } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope } from "../common/auth.guard.js";
import { parseCursor, parseLimit } from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/** Append-only audit trail, tenant scoped. `audit:read` is owner-only: the trail names actors. */
@Controller("api/v1/audit")
export class AuditController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("audit:read")
  @Get()
  public async list(
    @CurrentPrincipal() principal: Principal,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.ctx.repos.audit.list(principal.workspaceId, {
      limit: parseLimit(limit),
      cursor: parseCursor(cursor),
    });
    return { events: page.items, nextCursor: page.nextCursor };
  }
}
