import { createHash } from "node:crypto";
import type { SqlConnection, SqlExecutor } from "./sql.js";

/**
 * Schema as an ordered list of statements rather than one big SQL file.
 *
 * Why: statements can be applied inside a transaction, checksummed, and audited
 * one by one, and triggers/procedures that contain semicolons cannot be split
 * reliably. Migration text is compiled into the package so no runtime file
 * copying is required.
 *
 * Tenant model: MySQL has no row-level security, so isolation is enforced in two
 * places — every repository statement filters on `workspace_id`, and child rows
 * that do not carry it (run_traces) are only reachable through a join on the
 * owning run. Both are asserted by tests.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    statements: [
      `CREATE TABLE IF NOT EXISTS workspaces (
        id VARCHAR(32) NOT NULL,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(200) NOT NULL,
        plan VARCHAR(32) NOT NULL DEFAULT 'community',
        retention_days INT NOT NULL DEFAULT 90,
        created_at DATETIME(3) NOT NULL,
        created_by VARCHAR(64) NULL,
        deleted_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_workspaces_slug (slug)
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        role ENUM('owner','editor','viewer','service') NOT NULL,
        scopes JSON NOT NULL,
        prefix VARCHAR(24) NOT NULL,
        secret_hash CHAR(64) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        created_by VARCHAR(64) NULL,
        expires_at DATETIME(3) NULL,
        last_used_at DATETIME(3) NULL,
        revoked_at DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_api_keys_prefix (prefix),
        KEY idx_api_keys_workspace (workspace_id, created_at),
        CONSTRAINT fk_api_keys_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS assets (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        storage_key VARCHAR(96) NOT NULL,
        checksum CHAR(71) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(128) NOT NULL,
        size_bytes BIGINT NOT NULL,
        domain VARCHAR(32) NOT NULL,
        source_format VARCHAR(32) NOT NULL,
        metadata JSON NULL,
        created_at DATETIME(3) NOT NULL,
        created_by VARCHAR(64) NULL,
        PRIMARY KEY (id),
        KEY idx_assets_workspace_created (workspace_id, created_at, id),
        KEY idx_assets_checksum (workspace_id, checksum),
        CONSTRAINT fk_assets_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS mappings (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        version INT NOT NULL,
        spec JSON NOT NULL,
        spec_checksum CHAR(71) NOT NULL,
        source_format VARCHAR(32) NOT NULL,
        target_format VARCHAR(32) NOT NULL,
        target_resource_type VARCHAR(64) NULL,
        created_at DATETIME(3) NOT NULL,
        created_by VARCHAR(64) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_mappings_workspace_name_version (workspace_id, name, version),
        KEY idx_mappings_workspace_created (workspace_id, created_at, id),
        CONSTRAINT fk_mappings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS pipelines (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        mapping_id VARCHAR(32) NOT NULL,
        config JSON NULL,
        created_at DATETIME(3) NOT NULL,
        created_by VARCHAR(64) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pipelines_workspace_name (workspace_id, name),
        CONSTRAINT fk_pipelines_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
        CONSTRAINT fk_pipelines_mapping FOREIGN KEY (mapping_id) REFERENCES mappings (id) ON DELETE RESTRICT
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS runs (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        mapping_id VARCHAR(32) NOT NULL,
        pipeline_id VARCHAR(32) NULL,
        asset_id VARCHAR(32) NULL,
        status ENUM('queued','running','cancelling','cancelled','completed','completed_with_warnings','failed') NOT NULL,
        idempotency_key VARCHAR(128) NULL,
        request_checksum CHAR(71) NULL,
        engine_version VARCHAR(32) NOT NULL,
        adapter_id VARCHAR(64) NULL,
        adapter_version VARCHAR(32) NULL,
        records_processed INT NOT NULL DEFAULT 0,
        records_succeeded INT NOT NULL DEFAULT 0,
        records_failed INT NOT NULL DEFAULT 0,
        input_checksum CHAR(71) NULL,
        output_checksum CHAR(71) NULL,
        coverage JSON NULL,
        validation JSON NULL,
        progress JSON NULL,
        schema_version INT NOT NULL DEFAULT 1,
        summary JSON NULL,
        result JSON NULL,
        error JSON NULL,
        options JSON NULL,
        created_at DATETIME(3) NOT NULL,
        started_at DATETIME(3) NULL,
        finished_at DATETIME(3) NULL,
        cancelled_at DATETIME(3) NULL,
        created_by VARCHAR(64) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_runs_workspace_idempotency (workspace_id, idempotency_key),
        KEY idx_runs_workspace_created (workspace_id, created_at, id),
        KEY idx_runs_workspace_status (workspace_id, status, created_at),
        CONSTRAINT fk_runs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
        CONSTRAINT fk_runs_mapping FOREIGN KEY (mapping_id) REFERENCES mappings (id) ON DELETE RESTRICT,
        CONSTRAINT fk_runs_asset FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE SET NULL
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS run_traces (
        run_id VARCHAR(32) NOT NULL,
        seq INT NOT NULL,
        stage VARCHAR(32) NOT NULL,
        step_name VARCHAR(128) NOT NULL,
        status VARCHAR(24) NOT NULL,
        duration_ms INT NULL,
        payload JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (run_id, seq),
        CONSTRAINT fk_run_traces_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS run_resource_index (
        run_id VARCHAR(32) NOT NULL,
        resource_type VARCHAR(64) NOT NULL,
        resource_id VARCHAR(128) NOT NULL,
        record_index INT NOT NULL,
        PRIMARY KEY (run_id, record_index),
        KEY idx_run_resource_index_type (run_id, resource_type),
        CONSTRAINT fk_run_resource_index_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      `CREATE TABLE IF NOT EXISTS audit_events (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        actor_key_id VARCHAR(32) NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(64) NULL,
        target_id VARCHAR(64) NULL,
        outcome VARCHAR(16) NOT NULL,
        metadata JSON NULL,
        request_id VARCHAR(64) NULL,
        ip VARCHAR(64) NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_audit_workspace_created (workspace_id, created_at, id),
        CONSTRAINT fk_audit_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,
    ],
  },
  {
    version: 2,
    name: "idempotency_keys",
    statements: [
      // Additive and idempotent on purpose: MySQL commits DDL implicitly, so a
      // migration that can only be applied once is a trap for a crashed deploy.
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        workspace_id VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_checksum CHAR(71) NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        resource_id VARCHAR(32) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        PRIMARY KEY (workspace_id, idempotency_key),
        CONSTRAINT fk_idempotency_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,
    ],
  },
  {
    version: 3,
    name: "run_jobs",
    statements: [
      // Durable job queue: one row per scheduled run. `available_at` carries the retry
      // backoff, `claimed_at` the visibility timeout, so a crashed worker's job is
      // re-claimed by whoever polls next instead of disappearing.
      `CREATE TABLE IF NOT EXISTS run_jobs (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        run_id VARCHAR(32) NOT NULL,
        status ENUM('pending','claimed','done','failed','cancelled') NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        available_at DATETIME(3) NOT NULL,
        claimed_by VARCHAR(64) NULL,
        claimed_at DATETIME(3) NULL,
        last_error VARCHAR(500) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_run_jobs_claim (status, available_at, id),
        KEY idx_run_jobs_workspace (workspace_id, status, updated_at),
        CONSTRAINT fk_run_jobs_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,
    ],
  },
  {
    version: 4,
    name: "mapping_drafts",
    statements: [
      // A draft may exist before version 1, so it has no foreign key to `mappings`:
      // only the owning workspace cascades.
      `CREATE TABLE IF NOT EXISTS mapping_drafts (
        workspace_id VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        spec JSON NOT NULL,
        spec_checksum CHAR(71) NOT NULL,
        revision INT NOT NULL,
        base_version INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        updated_by VARCHAR(64) NULL,
        PRIMARY KEY (workspace_id, name),
        CONSTRAINT fk_mapping_drafts_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,
    ],
  },
  {
    version: 5,
    name: "workspace_purges",
    statements: [
      // Deletion is two-phase: the workspace row is soft-deleted immediately (so
      // a mistake has a grace period), and this row records when the hard purge
      // becomes due. The FK only cascades the schedule when the purge itself
      // removes the workspace.
      `CREATE TABLE IF NOT EXISTS workspace_purges (
        workspace_id VARCHAR(32) NOT NULL,
        workspace_slug VARCHAR(64) NOT NULL,
        scheduled_at DATETIME(3) NOT NULL,
        requested_at DATETIME(3) NOT NULL,
        requested_by VARCHAR(64) NULL,
        PRIMARY KEY (workspace_id),
        KEY idx_workspace_purges_due (scheduled_at, workspace_id),
        CONSTRAINT fk_workspace_purges_workspace FOREIGN KEY (workspace_id)
          REFERENCES workspaces (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}`,

      // Deliberately no foreign key: the record of a deletion must outlive the
      // workspace it describes, so tenant deletion cannot erase its own audit.
      `CREATE TABLE IF NOT EXISTS platform_audit_events (
        id VARCHAR(32) NOT NULL,
        workspace_id VARCHAR(32) NOT NULL,
        workspace_slug VARCHAR(64) NULL,
        actor_key_id VARCHAR(32) NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(64) NULL,
        target_id VARCHAR(64) NULL,
        outcome VARCHAR(16) NOT NULL,
        metadata JSON NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_platform_audit_created (created_at, id),
        KEY idx_platform_audit_workspace (workspace_id, created_at, id)
      ) ${TABLE_OPTIONS}`,
    ],
  },
];

export function migrationChecksum(migration: Migration): string {
  const hash = createHash("sha256");
  for (const statement of migration.statements) {
    // Normalise whitespace so reformatting SQL does not look like drift.
    hash.update(statement.replace(/\s+/g, " ").trim());
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

export class MigrationDriftError extends Error {
  constructor(
    public readonly version: number,
    public readonly expected: string,
    public readonly found: string,
  ) {
    super(
      `Migration ${version} changed after it was applied (recorded ${found}, current ${expected}). ` +
        `Applied migrations are immutable: add a new migration instead.`,
    );
    this.name = "MigrationDriftError";
  }
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationPlanEntry {
  migration: Migration;
  state: "pending" | "applied" | "drift";
}

export interface MigrationResult {
  applied: AppliedMigration[];
  alreadyApplied: number;
  durationMs: number;
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT NOT NULL,
  name VARCHAR(128) NOT NULL,
  checksum CHAR(71) NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  duration_ms INT NOT NULL,
  PRIMARY KEY (version)
) ${TABLE_OPTIONS}`;

export interface MigrationRunnerOptions {
  migrations?: Migration[];
  now?: () => Date;
  log?: (message: string) => void;
}

export class MigrationRunner {
  private readonly migrations: Migration[];
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(
    private readonly connection: SqlConnection,
    options: MigrationRunnerOptions = {},
  ) {
    this.migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);

    const versions = new Set<number>();
    for (const migration of this.migrations) {
      if (versions.has(migration.version)) throw new Error(`Duplicate migration version ${migration.version}`);
      versions.add(migration.version);
    }
  }

  public async ensureMigrationsTable(executor: SqlExecutor = this.connection): Promise<void> {
    await executor.execute(MIGRATIONS_TABLE);
  }

  public async applied(): Promise<AppliedMigration[]> {
    await this.ensureMigrationsTable();
    const rows = await this.connection.query<{
      version: number;
      name: string;
      checksum: string;
      applied_at: string;
    }>("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC");

    return rows.map((row) => ({
      version: Number(row.version),
      name: row.name,
      checksum: row.checksum,
      appliedAt: String(row.applied_at),
    }));
  }

  public async plan(): Promise<MigrationPlanEntry[]> {
    const applied = new Map((await this.applied()).map((entry) => [entry.version, entry]));
    return this.migrations.map((migration) => {
      const record = applied.get(migration.version);
      if (!record) return { migration, state: "pending" as const };
      const checksum = migrationChecksum(migration);
      if (record.checksum !== checksum) return { migration, state: "drift" as const };
      return { migration, state: "applied" as const };
    });
  }

  /**
   * Applies pending migrations in order, each in its own transaction.
   *
   * MySQL commits DDL implicitly, so a failed DDL statement cannot be rolled
   * back. Every statement is therefore written to be individually idempotent
   * (`CREATE TABLE IF NOT EXISTS`, additive `ALTER`). The transaction still gives
   * atomicity for the bookkeeping row.
   */
  public async migrate(): Promise<MigrationResult> {
    const start = Date.now();
    await this.ensureMigrationsTable();

    const plan = await this.plan();
    for (const entry of plan) {
      if (entry.state === "drift") {
        const applied = (await this.applied()).find((a) => a.version === entry.migration.version);
        throw new MigrationDriftError(
          entry.migration.version,
          migrationChecksum(entry.migration),
          applied?.checksum ?? "unknown",
        );
      }
    }

    const pending = plan.filter((entry) => entry.state === "pending").map((entry) => entry.migration);
    const appliedNow: AppliedMigration[] = [];

    for (const migration of pending) {
      const checksum = migrationChecksum(migration);
      const startedAt = Date.now();

      await this.connection.transaction(async (tx) => {
        for (const statement of migration.statements) {
          await tx.execute(statement);
        }
        await tx.execute(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?)",
          [migration.version, migration.name, checksum, toSqlDate(this.now()), Date.now() - startedAt],
        );
      });

      const record: AppliedMigration = {
        version: migration.version,
        name: migration.name,
        checksum,
        appliedAt: this.now().toISOString(),
      };
      appliedNow.push(record);
      this.log(`applied migration ${migration.version} (${migration.name}) in ${Date.now() - startedAt}ms`);
    }

    return {
      applied: appliedNow,
      alreadyApplied: plan.filter((entry) => entry.state === "applied").length,
      durationMs: Date.now() - start,
    };
  }
}

export function toSqlDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
