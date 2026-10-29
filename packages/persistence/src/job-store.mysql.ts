import type { SqlConnection, SqlExecutor } from "./sql.js";
import { toSqlDate } from "./migrations.js";

/**
 * Durable job queue backed by MySQL.
 *
 * Why MySQL rather than Redis/BullMQ: the deployment already requires a database and
 * nothing else, and the failure mode that matters — "the API restarted, so the queued
 * run vanished" — is solved by a table. Adding a broker would add a second stateful
 * service to keep alive for the same guarantee.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` (MySQL 8.0+), so two replicas polling at the
 * same moment cannot take the same job. A worker that dies mid-run leaves a `claimed`
 * row; once `claimed_at` is older than the visibility timeout the next claim takes it
 * over, which is what makes restarts safe rather than merely survivable.
 */

export type JobStatus = "pending" | "claimed" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  workspaceId: string;
  runId: string;
  status: JobStatus;
  attempts: number;
  availableAt: string;
  claimedBy?: string;
  claimedAt?: string;
  lastError?: string;
}

export interface EnqueueJobInput {
  runId: string;
  workspaceId: string;
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  /** How long a claim stays valid before another worker may take the job over. */
  visibilityTimeoutMs: number;
  now?: Date;
}

export interface JobStore {
  enqueue(job: EnqueueJobInput): Promise<void>;
  claim(options: ClaimOptions): Promise<JobRecord[]>;
  finish(runId: string, outcome: "done" | "failed" | "cancelled", error?: string): Promise<void>;
  retry(runId: string, error: string, delayMs: number): Promise<void>;
  cancel(runId: string): Promise<boolean>;
  /** Run ids among `runIds` whose job was cancelled — used to abort local work. */
  cancelledAmong(runIds: string[]): Promise<string[]>;
  get(runId: string): Promise<JobRecord | undefined>;
  countByStatus(): Promise<Record<JobStatus, number>>;
}

const COLUMNS = "id, workspace_id, run_id, status, attempts, available_at, claimed_by, claimed_at, last_error";

function toRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: String(row.run_id),
    status: String(row.status) as JobStatus,
    attempts: Number(row.attempts ?? 0),
    availableAt: new Date(row.available_at as string | Date).toISOString(),
    claimedBy: row.claimed_by ? String(row.claimed_by) : undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string | Date).toISOString() : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
  };
}

export class MySqlJobStore implements JobStore {
  constructor(
    private readonly db: SqlConnection,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async enqueue(job: EnqueueJobInput): Promise<void> {
    const at = toSqlDate(this.now());
    // Keyed by run id, so a duplicate enqueue (retry of the same request, replayed
    // boot) cannot queue the work twice; an existing row keeps its state.
    await this.db.execute(
      `INSERT INTO run_jobs (id, workspace_id, run_id, status, attempts, available_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
      [job.runId, job.workspaceId, job.runId, at, at, at],
    );
  }

  public async claim(options: ClaimOptions): Promise<JobRecord[]> {
    const limit = Math.max(1, Math.floor(options.limit));
    if (limit === 0) return [];
    const now = options.now ?? this.now();
    const at = toSqlDate(now);
    const staleBefore = toSqlDate(new Date(now.getTime() - Math.max(0, options.visibilityTimeoutMs)));

    return this.db.transaction(async (tx: SqlExecutor) => {
      // `claimed` rows whose owner went quiet are claimable again; that is the
      // entire crash-recovery story.
      const candidates = await tx.query<{ id: string }>(
        `SELECT id FROM run_jobs
          WHERE available_at <= ?
            AND status IN ('pending','claimed')
            AND (status = 'pending' OR claimed_at IS NULL OR claimed_at <= ?)
          ORDER BY available_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [at, staleBefore, limit],
      );
      if (candidates.length === 0) return [];
      const ids = candidates.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(", ");
      await tx.execute(
        `UPDATE run_jobs
            SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id IN (${placeholders})`,
        [options.workerId, at, at, ...ids],
      );
      const rows = await tx.query(`SELECT ${COLUMNS} FROM run_jobs WHERE id IN (${placeholders})`, ids);
      return rows.map(toRecord);
    });
  }

  public async finish(runId: string, outcome: "done" | "failed" | "cancelled", error?: string): Promise<void> {
    const at = toSqlDate(this.now());
    await this.db.execute(
      `UPDATE run_jobs SET status = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
        WHERE id = ?`,
      [outcome, error ? error.slice(0, 500) : null, at, runId],
    );
  }

  public async retry(runId: string, error: string, delayMs: number): Promise<void> {
    const now = this.now();
    await this.db.execute(
      `UPDATE run_jobs
          SET status = 'pending', available_at = ?, claimed_by = NULL, claimed_at = NULL,
              last_error = ?, updated_at = ?
        WHERE id = ?`,
      [toSqlDate(new Date(now.getTime() + Math.max(0, delayMs))), error.slice(0, 500), toSqlDate(now), runId],
    );
  }

  public async cancel(runId: string): Promise<boolean> {
    const at = toSqlDate(this.now());
    const result = await this.db.execute(
      `UPDATE run_jobs SET status = 'cancelled', claimed_by = NULL, claimed_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending','claimed')`,
      [at, runId],
    );
    return result.affectedRows > 0;
  }

  public async cancelledAmong(runIds: string[]): Promise<string[]> {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM run_jobs WHERE status = 'cancelled' AND id IN (${placeholders})`,
      runIds,
    );
    return rows.map((row) => String(row.id));
  }

  public async get(runId: string): Promise<JobRecord | undefined> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM run_jobs WHERE id = ?`, [runId]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  public async countByStatus(): Promise<Record<JobStatus, number>> {
    const rows = await this.db.query<{ status: string; total: number }>(
      "SELECT status, COUNT(*) AS total FROM run_jobs GROUP BY status",
    );
    const counts: Record<JobStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      const status = String(row.status) as JobStatus;
      if (status in counts) counts[status] = Number(row.total);
    }
    return counts;
  }
}
