import { randomBytes } from "node:crypto";
import type { Repositories } from "@healthbridge/persistence";

/**
 * Audit trail.
 *
 * Writing an audit event must never break the request that produced it, but a
 * silent failure is also unacceptable: failures are logged with the action and
 * target so an operator can reconcile. Audit records are append-only.
 */

export interface AuditInput {
  workspaceId: string;
  actorKeyId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

export class AuditService {
  constructor(
    private readonly repos: Repositories,
    private readonly options: { now?: () => Date; log?: (message: string) => void } = {},
  ) {}

  public async record(input: AuditInput): Promise<void> {
    const now = this.options.now ?? (() => new Date());
    try {
      await this.repos.audit.append({
        id: `aud_${randomBytes(9).toString("hex")}`,
        createdAt: now().toISOString(),
        ...input,
      });
    } catch (error) {
      this.options.log?.(
        `AUDIT WRITE FAILED action=${input.action} workspace=${input.workspaceId} target=${input.targetId ?? "-"}: ${
          (error as Error).message
        }`,
      );
    }
  }
}
