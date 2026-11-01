import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MIGRATIONS,
  MigrationDriftError,
  MigrationRunner,
  migrationChecksum,
  type SqlConnection,
  type SqlExecutor,
} from "@healthbridge/persistence";

/**
 * Minimal stand-in for a database that understands only the statements the
 * migration runner issues. It intentionally does not execute DDL: it lets the
 * runner's ordering, idempotency and drift detection be tested without a server.
 */
class FakeMigrationDb implements SqlConnection {
  public readonly dialect = "recording" as const;
  public readonly ddl: string[] = [];
  public readonly applied: Array<{ version: number; name: string; checksum: string; applied_at: string }> = [];
  public readonly transactions: string[] = [];
  public failOnStatement?: RegExp;
  private readonly now = () => "2024-01-01 00:00:00.000";

  public async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    if (/FROM schema_migrations/i.test(sql)) {
      return [...this.applied].sort((a, b) => a.version - b.version) as unknown as T[];
    }
    return [] as unknown as T[];
  }

  public async execute(sql: string, params: unknown[] = []): Promise<{ affectedRows: number }> {
    if (this.failOnStatement && this.failOnStatement.test(sql)) {
      throw new Error(`simulated failure: ${sql.slice(0, 40)}`);
    }
    if (/INSERT INTO schema_migrations/i.test(sql)) {
      this.applied.push({
        version: Number(params[0]),
        name: String(params[1]),
        checksum: String(params[2]),
        applied_at: String(params[3]),
      });
      return { affectedRows: 1 };
    }
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { affectedRows: 0 };
    this.ddl.push(sql);
    return { affectedRows: 1 };
  }

  public async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactions.push("start");
    const result = await fn(this);
    this.transactions.push("commit");
    return result;
  }

  public async close(): Promise<void> {
    /* noop */
  }

  public get nowString(): string {
    return this.now();
  }
}

describe("migrations", () => {
  test("are ordered, uniquely versioned and carry a stable checksum", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    assert.deepEqual(
      versions,
      [...versions].sort((a, b) => a - b),
    );
    assert.equal(new Set(versions).size, versions.length);

    for (const migration of MIGRATIONS) {
      assert.ok(migration.statements.length > 0);
      assert.match(migrationChecksum(migration), /^sha256:[0-9a-f]{64}$/);
      // Whitespace changes must not look like drift.
      const reformatted = {
        ...migration,
        statements: migration.statements.map((s) => `  ${s.replace(/\n/g, "\n  ")}  `),
      };
      assert.equal(migrationChecksum(reformatted), migrationChecksum(migration));
    }
  });

  test("apply every pending migration once, in order", async () => {
    const db = new FakeMigrationDb();
    const runner = new MigrationRunner(db);

    const result = await runner.migrate();
    assert.equal(result.applied.length, MIGRATIONS.length);
    assert.deepEqual(
      db.applied.map((entry) => entry.version),
      MIGRATIONS.map((migration) => migration.version),
    );
    assert.equal(db.transactions.filter((t) => t === "commit").length, MIGRATIONS.length);

    // Every DDL statement ran, and the bookkeeping row was written per migration.
    assert.equal(
      db.ddl.length,
      MIGRATIONS.reduce((sum, migration) => sum + migration.statements.length, 0),
    );

    // Second run is a no-op.
    const again = await runner.migrate();
    assert.equal(again.applied.length, 0);
    assert.equal(again.alreadyApplied, MIGRATIONS.length);
    assert.equal(
      db.ddl.length,
      MIGRATIONS.reduce((sum, migration) => sum + migration.statements.length, 0),
    );
  });

  test("refuses to run when an applied migration has been edited (drift)", async () => {
    const db = new FakeMigrationDb();
    db.applied.push({
      version: 1,
      name: "init",
      checksum: "sha256:" + "0".repeat(64),
      applied_at: "2024-01-01 00:00:00.000",
    });

    const runner = new MigrationRunner(db);
    await assert.rejects(
      () => runner.migrate(),
      (error: unknown) => {
        assert.ok(error instanceof MigrationDriftError);
        assert.equal((error as MigrationDriftError).version, 1);
        return true;
      },
    );

    const plan = await runner.plan();
    assert.equal(plan[0].state, "drift");
    assert.equal(plan[1].state, "pending");
  });

  test("a failed statement aborts that migration and is not recorded as applied", async () => {
    const db = new FakeMigrationDb();
    db.failOnStatement = /CREATE TABLE IF NOT EXISTS pipelines/;

    await assert.rejects(() => new MigrationRunner(db).migrate(), /simulated failure/);
    assert.deepEqual(
      db.applied.map((entry) => entry.version),
      [],
    );
  });

  test("rejects duplicate versions in a migration set", () => {
    assert.throws(
      () =>
        new MigrationRunner(new FakeMigrationDb(), {
          migrations: [
            { version: 1, name: "a", statements: ["SELECT 1"] },
            { version: 1, name: "b", statements: ["SELECT 2"] },
          ],
        }),
      /Duplicate migration version/,
    );
  });
});

describe("schema (DDL) invariants", () => {
  const allSql = MIGRATIONS.flatMap((migration) => migration.statements).join("\n");

  test("uses InnoDB and utf8mb4 everywhere", () => {
    const tables = allSql.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? [];
    assert.ok(tables.length >= 8);
    for (const statement of MIGRATIONS.flatMap((migration) => migration.statements)) {
      if (statement.startsWith("CREATE TABLE")) {
        assert.match(statement, /ENGINE=InnoDB/);
        assert.match(statement, /utf8mb4/);
      }
    }
  });

  test("every tenant-owned table is scoped by workspace_id", () => {
    const tenantTables = [
      "api_keys",
      "assets",
      "mappings",
      "mapping_drafts",
      "pipelines",
      "runs",
      "audit_events",
      "idempotency_keys",
    ];
    for (const table of tenantTables) {
      const statement = MIGRATIONS.flatMap((migration) => migration.statements).find((sql) =>
        sql.includes(`CREATE TABLE IF NOT EXISTS ${table} `),
      );
      assert.ok(statement, `${table} must be created`);
      assert.match(statement!, /workspace_id VARCHAR\(32\) NOT NULL/, `${table} must carry workspace_id`);
      assert.match(
        statement!,
        /FOREIGN KEY \(workspace_id\) REFERENCES workspaces \(id\)/,
        `${table} must reference its workspace`,
      );
    }
  });

  test("migration 5 schedules purges and keeps a platform audit that outlives tenants", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 5);
    assert.ok(migration, "migration 5 must exist");
    assert.equal(migration!.name, "workspace_purges");

    const ddl = migration!.statements.join("\n");
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS workspace_purges/);
    assert.match(ddl, /PRIMARY KEY \(workspace_id\)/);
    assert.match(ddl, /KEY idx_workspace_purges_due \(scheduled_at, workspace_id\)/);
    assert.match(
      ddl,
      /fk_workspace_purges_workspace FOREIGN KEY \(workspace_id\)\s+REFERENCES workspaces \(id\) ON DELETE CASCADE/,
    );

    const platform = migration!.statements.find((sql) => sql.includes("CREATE TABLE IF NOT EXISTS platform_audit_events"));
    assert.ok(platform, "platform_audit_events must be created");
    assert.match(platform!, /KEY idx_platform_audit_created \(created_at, id\)/);
    assert.doesNotMatch(platform!, /REFERENCES/, "platform audit must survive the workspace it describes");
  });

  test("mapping drafts are keyed per workspace and name without a mapping foreign key", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 4);
    assert.ok(migration, "migration 4 must exist");
    assert.equal(migration!.name, "mapping_drafts");

    const ddl = migration!.statements.join("\n");
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS mapping_drafts/);
    assert.match(ddl, /PRIMARY KEY \(workspace_id, name\)/);
    assert.match(ddl, /spec_checksum CHAR\(71\)/);
    assert.match(ddl, /revision INT NOT NULL/);
    assert.match(
      ddl,
      /fk_mapping_drafts_workspace FOREIGN KEY \(workspace_id\)\s+REFERENCES workspaces \(id\) ON DELETE CASCADE/,
    );
    assert.doesNotMatch(ddl, /REFERENCES mappings/, "a draft may predate version 1, so it must not reference mappings");
  });

  test("runs are uniquely idempotent per workspace", () => {
    const runs = MIGRATIONS.flatMap((m) => m.statements).find((sql) =>
      sql.includes("CREATE TABLE IF NOT EXISTS runs "),
    )!;
    assert.match(runs, /UNIQUE KEY uq_runs_workspace_idempotency \(workspace_id, idempotency_key\)/);
    assert.match(runs, /KEY idx_runs_workspace_created \(workspace_id, created_at, id\)/);
  });

  test("child tables cascade with their parents instead of leaking orphans", () => {
    const sql = MIGRATIONS.flatMap((m) => m.statements).join("\n");
    assert.match(sql, /fk_run_traces_run FOREIGN KEY \(run_id\) REFERENCES runs \(id\) ON DELETE CASCADE/);
    assert.match(sql, /fk_audit_workspace FOREIGN KEY \(workspace_id\) REFERENCES workspaces \(id\) ON DELETE CASCADE/);
  });

  test("migrations are additive and idempotent (no destructive or one-shot DDL)", () => {
    const sql = MIGRATIONS.flatMap((m) => m.statements).join("\n");
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    // ALTER ... ADD COLUMN without IF NOT EXISTS fails on a re-run after a crash,
    // which is exactly the failure mode MySQL's implicit DDL commit creates.
    const alters = MIGRATIONS.flatMap((m) => m.statements).filter((s) => /^ALTER TABLE/i.test(s));
    for (const alter of alters) assert.match(alter, /IF NOT EXISTS/i);
  });
});
