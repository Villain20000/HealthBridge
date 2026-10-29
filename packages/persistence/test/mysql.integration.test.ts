import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  MySqlConnection,
  MySqlJobStore,
  createMySqlRepositories,
  type MySqlConnectionOptions,
  type Repositories,
} from "../src/index.js";
import type { RunRecord } from "../src/domain.js";

/**
 * Live MySQL integration tests.
 *
 * These are skipped unless HEALTHBRIDGE_TEST_MYSQL_URL is set, because a database is an
 * external dependency the default suite must not require. They exist for the things a
 * recording fake cannot prove: real DDL, real NULL semantics on UPDATE, real unique-key
 * races and real charset/length handling.
 *
 *   docker run -d --name hb-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -e MYSQL_DATABASE=healthbridge_test -p 33061:3306 mysql:8.4
 *
 *   HEALTHBRIDGE_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:33061/healthbridge_test \
 *     node scripts/run-tests.mjs "packages/persistence/test/mysql.integration.test.ts"
 */

const RAW_URL = process.env.HEALTHBRIDGE_TEST_MYSQL_URL;
const ENABLED = Boolean(RAW_URL);

function connectionOptions(url: string): MySqlConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    connectionLimit: 4,
  };
}

const workspaceId = "ws_mysql_test";
const otherWorkspaceId = "ws_mysql_other";
const now = () => new Date();

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run_${Math.random().toString(16).slice(2, 18)}`,
    workspaceId,
    mappingId: `mp_test_${overrides.workspaceId ?? workspaceId}`.slice(0, 32),
    assetId: `as_test_${overrides.workspaceId ?? workspaceId}`.slice(0, 32),
    status: "queued",
    engineVersion: "3.2.0",
    recordsProcessed: 0,
    recordsSucceeded: 0,
    recordsFailed: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe(
  "MySQL persistence (live server)",
  { skip: ENABLED ? false : "HEALTHBRIDGE_TEST_MYSQL_URL is not set" },
  () => {
    let connection: MySqlConnection;
    let repos: Repositories;

    before(async () => {
      connection = await MySqlConnection.open(connectionOptions(RAW_URL!));
      repos = await createMySqlRepositories(connection, { migrateOnStart: true });

      for (const id of [workspaceId, otherWorkspaceId]) {
        await connection.execute(
          "INSERT INTO workspaces (id, slug, name, plan, retention_days, created_at) VALUES (?, ?, ?, 'community', 90, NOW(3)) " +
            "ON DUPLICATE KEY UPDATE name = VALUES(name)",
          [id, `slug-${id}`, `Workspace ${id}`],
        );
        // runs.mapping_id / runs.asset_id are foreign keys: the referenced rows must exist.
        await connection.execute(
          "INSERT INTO mappings (id, workspace_id, name, version, spec, spec_checksum, source_format, target_format, created_at) " +
            "VALUES (?, ?, 'fixture', 1, JSON_OBJECT('rules', JSON_ARRAY()), ?, 'csv', 'fhir-r4', NOW(3)) " +
            "ON DUPLICATE KEY UPDATE name = VALUES(name)",
          [`mp_test_${id}`.slice(0, 32), id, `sha256:${"c".repeat(64)}`],
        );
        await connection.execute(
          "INSERT INTO assets (id, workspace_id, storage_key, checksum, filename, content_type, size_bytes, domain, source_format, created_at) " +
            "VALUES (?, ?, ?, ?, 'patients.csv', 'text/csv', 209, 'clinical', 'csv', NOW(3)) " +
            "ON DUPLICATE KEY UPDATE filename = VALUES(filename)",
          [`as_test_${id}`.slice(0, 32), id, `sha256:${"d".repeat(64)}`, `sha256:${"d".repeat(64)}`],
        );
      }
    });

    after(async () => {
      await connection.execute("DELETE FROM run_jobs WHERE workspace_id IN (?, ?)", [workspaceId, otherWorkspaceId]);
      await connection.execute("DELETE FROM runs WHERE workspace_id IN (?, ?)", [workspaceId, otherWorkspaceId]);
      await connection.execute("DELETE FROM audit_events WHERE workspace_id IN (?, ?)", [
        workspaceId,
        otherWorkspaceId,
      ]);
      await connection.execute("DELETE FROM idempotency_keys WHERE workspace_id IN (?, ?)", [
        workspaceId,
        otherWorkspaceId,
      ]);
      await connection.execute("DELETE FROM mappings WHERE workspace_id IN (?, ?)", [workspaceId, otherWorkspaceId]);
      await connection.execute("DELETE FROM assets WHERE workspace_id IN (?, ?)", [workspaceId, otherWorkspaceId]);
      await connection.execute("DELETE FROM workspaces WHERE id IN (?, ?)", [workspaceId, otherWorkspaceId]);
      await connection.close();
    });

    it("should apply every migration once and report the second run as a no-op", async () => {
      const again = await createMySqlRepositories(connection, { migrateOnStart: true });
      assert.equal(again.mode, "mysql");
      const runner = again.migrateRunner;
      const second = await runner.migrate();
      assert.equal(second.applied.length, 0, "re-running migrations must not re-apply anything");
    });

    it("should round-trip a run and keep it invisible to another workspace", async () => {
      const record = run({
        status: "completed",
        recordsProcessed: 3,
        outputChecksum: "sha256:abc",
        summary: { note: "κείμενο" },
      });
      await repos.runs.create(record);

      const mine = await repos.runs.findById(workspaceId, record.id);
      const theirs = await repos.runs.findById(otherWorkspaceId, record.id);

      assert.equal(mine?.id, record.id);
      assert.equal(mine?.recordsProcessed, 3);
      assert.deepEqual(mine?.summary, { note: "κείμενο" }, "utf8mb4 survives the round trip");
      assert.equal(theirs, undefined, "a row from another workspace must be invisible");
    });

    it("should clear idempotency_key to NULL when a failed schedule releases it", async () => {
      // Regression: idempotency_key was missing from the updatable column map, so the
      // release-on-queue-failure fix silently only worked against the memory store.
      const record = run({ idempotencyKey: "mysql-key-1" });
      await repos.runs.create(record);

      const updated = await repos.runs.update(workspaceId, record.id, { status: "failed", idempotencyKey: undefined });
      const reread = await repos.runs.findById(workspaceId, record.id);

      assert.equal(updated?.idempotencyKey, undefined);
      assert.equal(reread?.idempotencyKey, undefined);
      assert.equal(reread?.status, "failed");

      const rows = await connection.query<{ idempotency_key: string | null }>(
        "SELECT idempotency_key FROM runs WHERE workspace_id = ? AND id = ?",
        [workspaceId, record.id],
      );
      assert.equal(rows[0].idempotency_key, null, "the column is actually NULL, not the string 'undefined'");
    });

    it("should return the existing run instead of inserting a duplicate key, and conflict on a different payload", async () => {
      const first = run({ idempotencyKey: "mysql-dup", requestChecksum: `sha256:${"1".repeat(64)}` });
      await repos.runs.create(first);

      const again = await repos.runs.create(
        run({ idempotencyKey: "mysql-dup", requestChecksum: `sha256:${"1".repeat(64)}` }),
      );

      assert.equal(again.created, false);
      assert.equal(again.run.id, first.id);

      await assert.rejects(
        () => repos.runs.create(run({ idempotencyKey: "mysql-dup", requestChecksum: `sha256:${"2".repeat(64)}` })),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
          return true;
        },
      );
    });

    it("should store a 71-character request fingerprint in the idempotency index", async () => {
      const fingerprint = `sha256:${"a".repeat(64)}`;
      await repos.idempotency.save({
        workspaceId,
        key: "mysql-index-1",
        requestChecksum: fingerprint,
        resourceType: "run",
        resourceId: "run_indexed",
        createdAt: now().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const record = await repos.idempotency.get(workspaceId, "mysql-index-1");

      assert.equal(record?.requestChecksum, fingerprint, "CHAR(71) fits the full checksum");
      assert.equal(record?.resourceId, "run_indexed");
    });

    it("should upsert rather than fail when the same key is indexed twice", async () => {
      const base = {
        workspaceId,
        key: "mysql-index-2",
        requestChecksum: `sha256:${"b".repeat(64)}`,
        resourceType: "run",
        createdAt: now().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      await repos.idempotency.save({ ...base, resourceId: "run_first" });
      await repos.idempotency.save({ ...base, resourceId: "run_second" });

      assert.equal((await repos.idempotency.get(workspaceId, "mysql-index-2"))?.resourceId, "run_second");
    });

    it("should page runs with a keyset cursor without repeating or losing rows", async () => {
      for (let index = 0; index < 5; index += 1) {
        await repos.runs.create(run({ createdAt: `2026-02-0${index + 1}T00:00:00.000Z` }));
      }

      const firstPage = await repos.runs.list(workspaceId, { limit: 2 });
      assert.equal(firstPage.items.length, 2);
      assert.ok(firstPage.nextCursor);

      const secondPage = await repos.runs.list(workspaceId, { limit: 2, cursor: firstPage.nextCursor });
      assert.equal(secondPage.items.length, 2);
      const ids = new Set([...firstPage.items, ...secondPage.items].map((entry) => entry.id));
      assert.equal(ids.size, 4, "pages must not overlap");
    });

    it("should append and read audit events for the workspace", async () => {
      await repos.audit.append({
        id: "evt_mysql_1",
        workspaceId,
        action: "run.created",
        targetType: "run",
        targetId: "run_audited",
        outcome: "success",
        metadata: { note: "created" },
      });

      const page = await repos.audit.list(workspaceId, { limit: 10 });

      assert.ok(page.items.some((event) => event.id === "evt_mysql_1"));
    });

    describe("run_jobs (durable queue)", () => {
      const jobStore = () => new MySqlJobStore(connection);

      async function createRun(id: string): Promise<string> {
        const record = run({ id });
        await repos.runs.create(record);
        return record.id;
      }

      it("should claim a job exactly once across concurrent workers", async () => {
        const runId = await createRun(`run_claim_${Date.now()}`);
        const store = jobStore();
        await store.enqueue({ runId, workspaceId });

        const [first, second] = await Promise.all([
          store.claim({ workerId: "worker-a", limit: 5, visibilityTimeoutMs: 60_000 }),
          store.claim({ workerId: "worker-b", limit: 5, visibilityTimeoutMs: 60_000 }),
        ]);

        const claims = [...first, ...second].filter((record) => record.runId === runId);
        assert.equal(claims.length, 1, "SKIP LOCKED must not hand the same job to two workers");
        assert.equal(claims[0].attempts, 1);
        assert.equal((await store.get(runId))?.status, "claimed");
      });

      it("should hand a stalled claim to the next worker once the visibility timeout passes", async () => {
        const runId = await createRun(`run_stale_${Date.now()}`);
        const store = jobStore();
        await store.enqueue({ runId, workspaceId });

        // limit is deliberately larger than one: the suite shares a database with earlier
        // tests, so a single-slot claim could pick a different pending job.
        const first = await store.claim({ workerId: "worker-crashed", limit: 50, visibilityTimeoutMs: 60_000 });
        assert.equal(first.filter((record) => record.runId === runId).length, 1);

        const stillMine = await store.claim({ workerId: "worker-next", limit: 50, visibilityTimeoutMs: 60_000 });
        assert.deepEqual(
          stillMine.filter((record) => record.runId === runId),
          [],
          "a live claim is not stolen",
        );

        // A claim becomes recoverable at the instant its timeout expires (`<=`, not `<`):
        // the timestamps are DATETIME(3), so a 0ms timeout must be immediately stale.
        const recovered = await store.claim({ workerId: "worker-next", limit: 50, visibilityTimeoutMs: 0 });
        const mine = recovered.filter((record) => record.runId === runId);
        assert.equal(mine.length, 1, "an expired claim is recoverable");
        assert.equal((await store.get(runId))?.attempts, 2);
      });

      it("should not offer a job again until its retry backoff has passed", async () => {
        const runId = await createRun(`run_backoff_${Date.now()}`);
        const store = jobStore();
        await store.enqueue({ runId, workspaceId });
        await store.claim({ workerId: "worker-1", limit: 1, visibilityTimeoutMs: 60_000 });
        await store.retry(runId, "deadlock", 60_000);

        const early = await store.claim({ workerId: "worker-2", limit: 50, visibilityTimeoutMs: 0 });
        assert.deepEqual(
          early.filter((record) => record.runId === runId),
          [],
          "backoff is respected",
        );

        const later = await store.claim({
          workerId: "worker-2",
          limit: 50,
          visibilityTimeoutMs: 0,
          now: new Date(Date.now() + 61_000),
        });
        assert.equal(later.filter((record) => record.runId === runId).length, 1);
      });

      it("should stop offering a cancelled or finished job", async () => {
        const cancelled = await createRun(`run_cancel_job_${Date.now()}`);
        const done = await createRun(`run_done_job_${Date.now()}`);
        const store = jobStore();
        await store.enqueue({ runId: cancelled, workspaceId });
        await store.enqueue({ runId: done, workspaceId });

        assert.equal(await store.cancel(cancelled), true);
        await store.finish(done, "done");

        const claimed = await store.claim({ workerId: "worker-x", limit: 50, visibilityTimeoutMs: 0 });
        const ids = claimed.map((record) => record.runId);
        assert.equal(ids.includes(cancelled), false);
        assert.equal(ids.includes(done), false);
        assert.deepEqual(await store.cancelledAmong([cancelled, done]), [cancelled]);
      });

      it("should queue a run once even if enqueue is repeated", async () => {
        const runId = await createRun(`run_idem_job_${Date.now()}`);
        const store = jobStore();
        await store.enqueue({ runId, workspaceId });
        await store.enqueue({ runId, workspaceId });

        const counts = await store.countByStatus();
        assert.ok(counts.pending >= 1);
        const claimed = await store.claim({ workerId: "worker-dedupe", limit: 50, visibilityTimeoutMs: 60_000 });
        assert.equal(claimed.filter((record) => record.runId === runId).length, 1);
      });
    });
  },
);
