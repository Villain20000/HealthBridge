import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MySqlAssetRepository,
  MySqlAuditRepository,
  MySqlIdempotencyStore,
  MySqlMappingDraftRepository,
  MySqlMappingRepository,
  MySqlPipelineRepository,
  MySqlRunRepository,
  MySqlWorkspaceRepository,
  PersistenceError,
  RecordingSqlConnection,
} from "@healthbridge/persistence";

/**
 * These tests exercise the SQL the MySQL repositories generate. They are not a
 * substitute for an integration test against a server (which is gated behind
 * HEALTHBRIDGE_TEST_MYSQL_URL); they are the guard that a query can never lose
 * its tenant filter or start interpolating values.
 */

const workspaceId = "ws_1";
const runId = "run_1";

function placeholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

describe("mysql repositories: tenant scoping", () => {
  test("every asset statement is scoped by workspace_id and fully bound", async () => {
    const db = new RecordingSqlConnection();
    const repo = new MySqlAssetRepository(db);

    await repo.findById(workspaceId, "as_1");
    await repo.list(workspaceId, { limit: 10 });
    await repo.delete(workspaceId, "as_1");

    for (const statement of db.statements) {
      assert.match(statement.sql, /workspace_id = \?/, `unscoped statement: ${statement.sql}`);
      assert.equal(
        placeholders(statement.sql),
        statement.params.length,
        `placeholder/param mismatch: ${statement.sql}`,
      );
      assert.ok(statement.params.includes(workspaceId), "workspace id must be a bound parameter");
      assert.ok(!statement.sql.includes(workspaceId), "workspace id must never be interpolated");
    }
  });

  test("run reads, updates and lists are scoped, and the update whitelist is closed", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({ match: /FROM runs WHERE workspace_id = \? AND id = \?/, rows: [] });
    const repo = new MySqlRunRepository(db);

    await repo.findById(workspaceId, runId);
    await repo.list(workspaceId, { limit: 5, status: "completed" });

    // Attempt to smuggle a sensitive column through the patch object.
    await repo.update(workspaceId, runId, {
      status: "running",
      progress: { stage: "parse", stepName: "Parse", recordsProcessed: 1 },
      // Fields that must be ignored by the whitelist:
      workspaceId: "ws_evil",
      id: "run_evil",
      ...({ secretColumn: "x" } as Record<string, unknown>),
    } as never);

    for (const statement of db.statements.filter((s) => /runs/i.test(s.sql))) {
      assert.match(statement.sql, /workspace_id = \?/, `unscoped run statement: ${statement.sql}`);
      assert.equal(placeholders(statement.sql), statement.params.length);
      assert.ok(!statement.sql.includes("ws_evil"));
      assert.ok(!/secretColumn/i.test(statement.sql), "unknown fields must never reach SQL");
      assert.ok(!/\bid = \?/.test(statement.sql.split("WHERE")[0]), "id must not be written");
    }

    const update = db.statements.find((s) => s.sql.startsWith("UPDATE runs"));
    assert.ok(update);
    assert.match(update!.sql, /SET status = \?, progress = \? /);
    assert.match(update!.sql, /WHERE id = \? AND workspace_id = \?$/);
    assert.equal(update!.params.at(-1), workspaceId);
  });

  test("run status filtering uses a bound parameter, not interpolation", async () => {
    const db = new RecordingSqlConnection();
    const repo = new MySqlRunRepository(db);
    await repo.list(workspaceId, { status: "failed" });
    const select = db.statements.find((s) => s.sql.startsWith("SELECT"));
    assert.ok(select);
    assert.match(select!.sql, /status = \?/);
    assert.ok(select!.params.includes("failed"));
  });

  test("mapping versions are computed per workspace and name", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({ match: /SELECT COALESCE\(MAX\(version\), 0\)/, rows: [{ version: 2 }] });
    const repo = new MySqlMappingRepository(db);

    const created = await repo.create({
      id: "mp_3",
      workspaceId,
      name: "patient",
      spec: { rules: [] },
      specChecksum: "sha256:" + "c".repeat(64),
      sourceFormat: "csv",
      targetFormat: "fhir-r4",
      createdAt: "2024-01-01T00:00:00.000Z",
    });

    assert.equal(created.version, 3);
    const select = db.statements.find((s) => /COALESCE\(MAX\(version\), 0\)/.test(s.sql));
    assert.deepEqual(select!.params, [workspaceId, "patient"]);

    const insert = db.statements.find((s) => s.sql.startsWith("INSERT INTO mappings"));
    assert.ok(insert);
    assert.match(insert!.sql, /workspace_id/);
    assert.equal(placeholders(insert!.sql), insert!.params.length);
  });

  test("mapping draft statements are scoped, optimistic and fully bound", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({
      match: /FROM mapping_drafts WHERE workspace_id = \? AND name = \?/,
      rows: [
        {
          workspace_id: workspaceId,
          name: "patient",
          spec: { rules: [] },
          spec_checksum: `sha256:${"f".repeat(64)}`,
          revision: 2,
          base_version: 1,
          created_at: "2026-05-01 09:00:00.000",
          updated_at: "2026-05-02 09:00:00.000",
          updated_by: "key_editor",
        },
      ],
    });
    const repo = new MySqlMappingDraftRepository(db);
    const input = {
      workspaceId,
      name: "patient",
      spec: { rules: [{ id: "r1" }] },
      specChecksum: `sha256:${"f".repeat(64)}`,
      createdAt: "2026-05-01T09:00:00.000Z",
      updatedAt: "2026-05-01T09:00:00.000Z",
    };

    await repo.get(workspaceId, "patient");
    await repo.save(input, 0);
    await repo.save({ ...input, baseVersion: 2, updatedAt: "2026-05-02T09:00:00.000Z" }, 1);
    await repo.delete(workspaceId, "patient");
    await repo.delete(workspaceId, "patient", 2);

    const statements = db.statementsFor("mapping_drafts");
    assert.equal(statements.length, 6);

    for (const statement of statements) {
      assert.equal(placeholders(statement.sql), statement.params.length, `placeholder mismatch: ${statement.sql}`);
      assert.ok(!statement.sql.includes(workspaceId), "workspace id must never be interpolated");
    }

    const selects = statements.filter((statement) => statement.sql.startsWith("SELECT"));
    assert.equal(selects.length, 2);
    for (const select of selects) {
      assert.match(select.sql, /workspace_id = \? AND name = \?$/);
      assert.deepEqual(select.params, [workspaceId, "patient"]);
    }

    const insert = statements.find((statement) => statement.sql.startsWith("INSERT INTO mapping_drafts"));
    assert.ok(insert);
    assert.match(
      insert!.sql,
      /INSERT INTO mapping_drafts \(workspace_id, name, spec, spec_checksum, revision, base_version, created_at, updated_at, updated_by\)/,
    );
    assert.equal(insert!.params[0], workspaceId, "the insert must persist the tenant");
    assert.equal(insert!.params[4], null, "an absent baseVersion is bound as NULL");

    const update = statements.find((statement) => statement.sql.startsWith("UPDATE mapping_drafts"));
    assert.ok(update);
    assert.match(update!.sql, /revision = revision \+ 1/);
    assert.match(update!.sql, /WHERE workspace_id = \? AND name = \? AND revision = \?$/);
    assert.ok(update!.params.includes(workspaceId));
    assert.equal(update!.params.at(-1), 1, "the expected revision is a bound parameter");

    const deletes = statements.filter((statement) => statement.sql.startsWith("DELETE FROM mapping_drafts"));
    assert.equal(deletes.length, 2);
    assert.match(deletes[0].sql, /WHERE workspace_id = \? AND name = \?$/);
    assert.deepEqual(deletes[0].params, [workspaceId, "patient"]);
    assert.match(deletes[1].sql, /WHERE workspace_id = \? AND name = \? AND revision = \?$/);
    assert.deepEqual(deletes[1].params, [workspaceId, "patient", 2]);

    const before = db.statements.length;
    await assert.rejects(
      () => repo.save(input, 1.5),
      (error: unknown) => (error as PersistenceError).code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      () => repo.delete(workspaceId, "patient", -1),
      (error: unknown) => (error as PersistenceError).code === "INVALID_ARGUMENT",
    );
    assert.equal(db.statements.length, before, "invalid revisions must be rejected before SQL");
  });

  test("duplicate workspace slug is translated into a typed conflict", async () => {
    const db = new RecordingSqlConnection();
    db.execute = async () => {
      throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY", errno: 1062 });
    };
    const repo = new MySqlWorkspaceRepository(db);
    await assert.rejects(
      () =>
        repo.create({
          id: "ws_9",
          slug: "acme",
          name: "Acme",
          plan: "community",
          retentionDays: 90,
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      (error: unknown) => (error as PersistenceError).code === "CONFLICT",
    );
  });

  test("idempotency lookups are scoped and expire", async () => {
    const db = new RecordingSqlConnection();
    const now = () => new Date("2024-06-01T00:00:00.000Z");
    const store = new MySqlIdempotencyStore(db, now);
    await store.get(workspaceId, "abc");

    const select = db.statements[0];
    assert.match(select.sql, /workspace_id = \? AND idempotency_key = \? AND expires_at > \?/);
    assert.deepEqual(select.params, [workspaceId, "abc", "2024-06-01 00:00:00.000"]);
  });

  test("trace reads join through runs so a foreign run id matches nothing", async () => {
    const db = new RecordingSqlConnection();
    const repo = new MySqlRunRepository(db);
    await repo.listTraces(workspaceId, runId);

    const select = db.statements[0];
    assert.match(select.sql, /JOIN runs r ON r\.id = t\.run_id/);
    assert.match(select.sql, /r\.workspace_id = \? AND t\.run_id = \?/);
    assert.deepEqual(select.params, [workspaceId, runId]);
  });

  test("trace writes check ownership before inserting and continue the sequence", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({ match: /SELECT id FROM runs WHERE workspace_id/, rows: [{ id: runId }] });
    db.handlers.push({ match: /COALESCE\(MAX\(seq\)/, rows: [{ next: 4 }] });
    const repo = new MySqlRunRepository(db);

    const written = await repo.appendTraces(workspaceId, runId, [
      {
        seq: 0,
        stage: "parse",
        stepName: "Parse",
        status: "success",
        payload: {},
        createdAt: "2024-01-01T00:00:01.000Z",
      },
      { seq: 0, stage: "map", stepName: "Map", status: "success", payload: {}, createdAt: "2024-01-01T00:00:02.000Z" },
    ]);

    assert.equal(written, 2);
    const inserts = db.statements.filter((s) => s.sql.startsWith("INSERT INTO run_traces"));
    assert.equal(inserts.length, 2);
    assert.deepEqual(
      inserts.map((s) => s.params[1]),
      [4, 5],
    );

    const ownership = db.statements.find((statement) => statement.sql.includes("SELECT id FROM runs"));
    assert.ok(ownership, "ownership must be checked before writing traces");
    assert.match(ownership!.sql, /WHERE workspace_id = \? AND id = \?/);
    assert.equal(db.statements[0].kind, "transaction-start", "trace writes must be atomic");
  });

  test("trace writes are refused when the run belongs to another tenant", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({ match: /SELECT id FROM runs WHERE workspace_id/, rows: [] });
    const repo = new MySqlRunRepository(db);

    await assert.rejects(
      () =>
        repo.appendTraces(workspaceId, "run_foreign", [
          {
            seq: 0,
            stage: "parse",
            stepName: "Parse",
            status: "success",
            payload: {},
            createdAt: "2024-01-01T00:00:01.000Z",
          },
        ]),
      (error: unknown) => (error as PersistenceError).code === "NOT_FOUND",
    );
    assert.ok(!db.statements.some((s) => s.sql.startsWith("INSERT INTO run_traces")));
  });

  test("keyset pagination asks for one extra row and encodes the last seen id", async () => {
    const db = new RecordingSqlConnection();
    db.handlers.push({
      match: /FROM assets/,
      rows: Array.from({ length: 3 }, (_, index) => ({
        id: `as_${index}`,
        workspace_id: workspaceId,
        storage_key: "sha256/aa/" + "a".repeat(64),
        checksum: "sha256:" + "a".repeat(64),
        filename: "f.csv",
        content_type: "text/csv",
        size_bytes: 1,
        domain: "clinical",
        source_format: "csv",
        created_at: `2024-01-0${3 - index} 00:00:00.000`,
      })),
    });
    const repo = new MySqlAssetRepository(db);

    const page = await repo.list(workspaceId, { limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    assert.equal(db.statements[0].params.at(-1), 3, "query must fetch limit + 1");

    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf-8"));
    assert.equal(decoded.id, "as_1");
  });

  test("pipeline and audit statements stay scoped", async () => {
    const db = new RecordingSqlConnection();
    const pipelines = new MySqlPipelineRepository(db);
    const audit = new MySqlAuditRepository(db);

    await pipelines.list(workspaceId, { limit: 5 });
    await audit.list(workspaceId, { limit: 5 });
    await audit.append({ id: "aud_1", workspaceId, action: "run.created", outcome: "success" });

    for (const statement of db.statements) {
      if (statement.sql.trim() === "") continue;
      assert.equal(placeholders(statement.sql), statement.params.length, `placeholder mismatch: ${statement.sql}`);
      // INSERTs carry the tenant in the values; reads filter on it.
      if (statement.sql.startsWith("INSERT")) {
        assert.match(statement.sql, /workspace_id/, `insert must persist the tenant: ${statement.sql}`);
        assert.ok(statement.params.includes(workspaceId), "workspace id must be a bound value");
      } else {
        assert.match(statement.sql, /workspace_id = \?/, `unscoped: ${statement.sql}`);
        assert.ok(statement.params.includes(workspaceId));
      }
    }
  });
});
