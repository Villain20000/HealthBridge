import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PersistenceError,
  createMemoryRepositories,
  decodeCursor,
  encodeCursor,
  type AssetRecord,
  type MappingRecord,
  type Repositories,
  type RunRecord,
  type Workspace,
} from "@healthbridge/persistence";

const ws1: Workspace = {
  id: "ws_1",
  slug: "acme",
  name: "Acme Hospital",
  plan: "community",
  retentionDays: 90,
  createdAt: "2024-01-01T00:00:00.000Z",
};

const ws2: Workspace = {
  id: "ws_2",
  slug: "globex",
  name: "Globex Labs",
  plan: "community",
  retentionDays: 30,
  createdAt: "2024-01-02T00:00:00.000Z",
};

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "as_1",
    workspaceId: "ws_1",
    storageKey: "sha256/aa/" + "a".repeat(64),
    checksum: "sha256:" + "a".repeat(64),
    filename: "patients.csv",
    contentType: "text/csv",
    sizeBytes: 120,
    domain: "clinical",
    sourceFormat: "csv",
    createdAt: "2024-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function mapping(overrides: Partial<MappingRecord> = {}): Omit<MappingRecord, "version"> & { version?: number } {
  return {
    id: "mp_1",
    workspaceId: "ws_1",
    name: "patient",
    spec: { rules: [] },
    specChecksum: "sha256:" + "b".repeat(64),
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    targetResourceType: "Patient",
    createdAt: "2024-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_1",
    workspaceId: "ws_1",
    mappingId: "mp_1",
    status: "queued",
    engineVersion: "3.2.0",
    recordsProcessed: 0,
    recordsSucceeded: 0,
    recordsFailed: 0,
    createdAt: "2024-03-01T00:00:00.000Z",
    ...overrides,
  };
}

let repos: Repositories;

async function seeded(): Promise<Repositories> {
  repos = createMemoryRepositories();
  await repos.workspaces.create(ws1);
  await repos.workspaces.create(ws2);
  return repos;
}

describe("memory repositories: tenant isolation", () => {
  test("workspace slugs are unique, ids are unique", async () => {
    const r = await seeded();
    await assert.rejects(
      () => r.workspaces.create({ ...ws1, id: "ws_3" }),
      (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal((error as PersistenceError).code, "CONFLICT");
        return true;
      },
    );
  });

  test("a record from another workspace is invisible, not forbidden", async () => {
    const r = await seeded();
    await r.assets.create(asset());
    assert.ok(await r.assets.findById("ws_1", "as_1"));
    assert.equal(await r.assets.findById("ws_2", "as_1"), undefined);
    assert.equal(await r.assets.delete("ws_2", "as_1"), false);
    assert.ok(await r.assets.findById("ws_1", "as_1"), "foreign delete must not remove the record");

    await r.mappings.create(mapping());
    assert.equal(await r.mappings.findById("ws_2", "mp_1"), undefined);
    assert.deepEqual(await r.mappings.versions("ws_2", "patient"), []);

    await r.runs.create(run());
    assert.equal(await r.runs.findById("ws_2", "run_1"), undefined);
    assert.equal(await r.runs.update("ws_2", "run_1", { status: "running" }), undefined);

    const listed = await r.runs.list("ws_2");
    assert.equal(listed.items.length, 0);
  });

  test("traces cannot be written for a run owned by another workspace", async () => {
    const r = await seeded();
    await r.runs.create(run());
    await assert.rejects(
      () =>
        r.runs.appendTraces("ws_2", "run_1", [
          {
            seq: 0,
            stage: "parse",
            stepName: "Parse",
            status: "success",
            payload: {},
            createdAt: "2024-03-01T00:00:01.000Z",
          },
        ]),
      (error: unknown) => (error as PersistenceError).code === "NOT_FOUND",
    );
    await assert.rejects(
      () => r.runs.listTraces("ws_2", "run_1"),
      (error: unknown) => (error as PersistenceError).code === "NOT_FOUND",
    );
  });
});

describe("memory repositories: pagination", () => {
  test("is stable, newest first, and terminates", async () => {
    const r = await seeded();
    for (let i = 0; i < 7; i++) {
      await r.assets.create(
        asset({
          id: `as_${i}`,
          checksum: `sha256:${String(i).repeat(64)}`,
          createdAt: `2024-02-0${(i % 9) + 1}T00:00:0${i}.000Z`,
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: { items: { id: string }[]; nextCursor?: string } = await r.assets.list("ws_1", { limit: 3, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages < 10, "pagination must terminate");
    } while (cursor);

    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    const timestamps = await Promise.all(seen.map(async (id) => (await r.assets.findById("ws_1", id))!.createdAt));
    assert.deepEqual(timestamps, [...timestamps].sort().reverse(), "results must be newest first");
  });

  test("rejects malformed cursors and non-positive limits", async () => {
    const r = await seeded();
    await assert.rejects(
      () => r.assets.list("ws_1", { cursor: "not-a-cursor" }),
      (error: unknown) => {
        assert.equal((error as PersistenceError).code, "INVALID_ARGUMENT");
        return true;
      },
    );
    await assert.rejects(() => r.assets.list("ws_1", { limit: 0 }), /positive integer/);
  });

  test("cursors survive a round trip", () => {
    const cursor = encodeCursor("2024-01-01T00:00:00.000Z", "run_42");
    assert.deepEqual(decodeCursor(cursor), { createdAt: "2024-01-01T00:00:00.000Z", id: "run_42" });
  });
});

describe("memory repositories: runs and idempotency", () => {
  test("the same Idempotency-Key returns the original run", async () => {
    const r = await seeded();
    const first = await r.runs.create(run({ idempotencyKey: "abc", requestChecksum: "sha256:" + "1".repeat(64) }));
    assert.equal(first.created, true);

    const second = await r.runs.create(
      run({ id: "run_2", idempotencyKey: "abc", requestChecksum: "sha256:" + "1".repeat(64) }),
    );
    assert.equal(second.created, false);
    assert.equal(second.run.id, "run_1");
  });

  test("reusing a key with a different payload is a conflict, not a silent replay", async () => {
    const r = await seeded();
    await r.runs.create(run({ idempotencyKey: "abc", requestChecksum: "sha256:" + "1".repeat(64) }));
    await assert.rejects(
      () => r.runs.create(run({ id: "run_2", idempotencyKey: "abc", requestChecksum: "sha256:" + "2".repeat(64) })),
      (error: unknown) => (error as PersistenceError).code === "IDEMPOTENCY_CONFLICT",
    );
  });

  test("keys are scoped per workspace", async () => {
    const r = await seeded();
    await r.runs.create(run({ idempotencyKey: "shared" }));
    const other = await r.runs.create(run({ id: "run_other", workspaceId: "ws_2", idempotencyKey: "shared" }));
    assert.equal(other.created, true, "the same key must be usable by another tenant");
  });

  test("filters by status and patches only known fields", async () => {
    const r = await seeded();
    await r.runs.create(run({ id: "run_a", status: "queued" }));
    await r.runs.create(run({ id: "run_b", status: "completed", createdAt: "2024-03-02T00:00:00.000Z" }));

    const completed = await r.runs.list("ws_1", { status: "completed" });
    assert.deepEqual(
      completed.items.map((item) => item.id),
      ["run_b"],
    );

    const updated = await r.runs.update("ws_1", "run_a", { status: "running", startedAt: "2024-03-01T00:00:05.000Z" });
    assert.equal(updated?.status, "running");
    assert.equal(updated?.id, "run_a");
    assert.equal(updated?.workspaceId, "ws_1");
  });

  test("traces are appended with monotonic sequence numbers", async () => {
    const r = await seeded();
    await r.runs.create(run());
    await r.runs.appendTraces("ws_1", "run_1", [
      {
        seq: 0,
        stage: "parse",
        stepName: "Parse",
        status: "success",
        payload: { a: 1 },
        createdAt: "2024-03-01T00:00:01.000Z",
      },
    ]);
    await r.runs.appendTraces("ws_1", "run_1", [
      {
        seq: 0,
        stage: "map",
        stepName: "Map",
        status: "success",
        payload: { b: 2 },
        createdAt: "2024-03-01T00:00:02.000Z",
      },
    ]);

    const traces = await r.runs.listTraces("ws_1", "run_1");
    assert.deepEqual(
      traces.map((trace) => trace.seq),
      [0, 1],
    );
    assert.deepEqual(
      traces.map((trace) => trace.stage),
      ["parse", "map"],
    );
  });
});

describe("memory repositories: mappings are versioned, never overwritten", () => {
  test("each create produces the next version", async () => {
    const r = await seeded();
    const v1 = await r.mappings.create(mapping({ id: "mp_v1" }));
    const v2 = await r.mappings.create(mapping({ id: "mp_v2", createdAt: "2024-02-02T00:00:00.000Z" }));
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);

    const latest = await r.mappings.findLatestByName("ws_1", "patient");
    assert.equal(latest?.id, "mp_v2");
    assert.deepEqual(
      (await r.mappings.versions("ws_1", "patient")).map((m) => m.version),
      [2, 1],
    );

    const list = await r.mappings.list("ws_1");
    assert.equal(list.items.length, 1, "list exposes only the latest version per name");
    assert.equal(list.items[0].version, 2);
  });

  test("an explicit version that already exists is a conflict", async () => {
    const r = await seeded();
    await r.mappings.create(mapping({ id: "mp_v1", version: 1 }));
    await assert.rejects(() => r.mappings.create(mapping({ id: "mp_v1b", version: 1 })), /already has version 1/);
  });

  test("the same mapping name in another workspace starts at version 1", async () => {
    const r = await seeded();
    await r.mappings.create(mapping());
    const other = await r.mappings.create(mapping({ id: "mp_other", workspaceId: "ws_2" }));
    assert.equal(other.version, 1);
  });
});

describe("memory repositories: audit trail", () => {
  test("records append-only events, newest first, scoped by workspace", async () => {
    const r = await seeded();
    await r.audit.append({
      id: "aud_1",
      workspaceId: "ws_1",
      action: "run.created",
      outcome: "success",
      targetType: "run",
      targetId: "run_1",
      createdAt: "2024-03-01T00:00:01.000Z",
    });
    await r.audit.append({
      id: "aud_2",
      workspaceId: "ws_1",
      action: "run.read",
      outcome: "success",
      createdAt: "2024-03-01T00:00:02.000Z",
    });
    await r.audit.append({ id: "aud_3", workspaceId: "ws_2", action: "run.created", outcome: "success" });

    const list = await r.audit.list("ws_1");
    assert.deepEqual(
      list.items.map((event) => event.id),
      ["aud_2", "aud_1"],
    );
    assert.equal((await r.audit.list("ws_2")).items.length, 1);
  });
});

describe("memory repositories: deletion and retention", () => {
  test("deleting a run removes its traces and cannot touch another tenant", async () => {
    const r = await seeded();
    await r.runs.create(run({ id: "run_del", status: "completed", finishedAt: "2024-03-01T01:00:00.000Z" }));
    await r.runs.appendTraces("ws_1", "run_del", [
      {
        seq: 0,
        stage: "parse",
        stepName: "Parse",
        status: "success",
        payload: {},
        createdAt: "2024-03-01T01:00:01.000Z",
      },
    ]);

    assert.equal(await r.runs.delete("ws_2", "run_del"), false, "a foreign run id must be invisible");
    assert.ok(await r.runs.findById("ws_1", "run_del"));

    assert.equal(await r.runs.delete("ws_1", "run_del"), true);
    assert.equal(await r.runs.findById("ws_1", "run_del"), undefined);
    assert.equal(await r.runs.delete("ws_1", "run_del"), false, "deleting twice reports no row");
    await assert.rejects(
      () => r.runs.listTraces("ws_1", "run_del"),
      (error: unknown) => (error as PersistenceError).code === "NOT_FOUND",
    );
  });

  test("deleting a run frees its idempotency index entries", async () => {
    const r = await seeded();
    await r.runs.create(run({ id: "run_key", status: "completed", idempotencyKey: "key-del" }));
    await r.idempotency.save({
      workspaceId: "ws_1",
      key: "key-del",
      requestChecksum: "sha256:" + "1".repeat(64),
      resourceType: "run",
      resourceId: "run_key",
      createdAt: "2024-03-01T00:00:00.000Z",
      expiresAt: "2025-03-01T00:00:00.000Z",
    });

    assert.equal(await r.idempotency.deleteByResource("ws_2", "run", "run_key"), 0);
    assert.equal(await r.idempotency.deleteByResource("ws_1", "run", "run_key"), 1);
    assert.equal(await r.idempotency.get("ws_1", "key-del"), undefined);

    // The key is reusable once the run row is gone: idempotency is uniqueness,
    // not a permanent tombstone.
    await r.runs.delete("ws_1", "run_key");
    const replacement = await r.runs.create(run({ id: "run_replacement", idempotencyKey: "key-del" }));
    assert.equal(replacement.created, true);
  });

  test("listExpired returns only terminal runs older than the cutoff, oldest first", async () => {
    const r = await seeded();
    await r.runs.create(
      run({
        id: "run_a",
        status: "completed",
        createdAt: "2024-01-01T00:00:00.000Z",
        finishedAt: "2024-01-01T01:00:00.000Z",
      }),
    );
    await r.runs.create(
      run({
        id: "run_b",
        status: "cancelled",
        createdAt: "2024-01-02T00:00:00.000Z",
        cancelledAt: "2024-01-02T01:00:00.000Z",
      }),
    );
    await r.runs.create(
      run({
        id: "run_c",
        status: "failed",
        createdAt: "2024-02-01T00:00:00.000Z",
        finishedAt: "2024-02-01T01:00:00.000Z",
      }),
    );
    await r.runs.create(run({ id: "run_live", status: "running", createdAt: "2023-01-01T00:00:00.000Z" }));
    await r.runs.create(
      run({
        id: "run_young",
        status: "completed",
        createdAt: "2024-03-02T00:00:00.000Z",
        finishedAt: "2024-03-02T01:00:00.000Z",
      }),
    );

    const expired = await r.runs.listExpired("ws_1", "2024-03-01T00:00:00.000Z");
    assert.deepEqual(
      expired.map((entry) => entry.id),
      ["run_a", "run_b", "run_c"],
    );
    assert.deepEqual(await r.runs.listExpired("ws_2", "2024-03-01T00:00:00.000Z"), []);
  });

  test("countByAsset is tenant scoped", async () => {
    const r = await seeded();
    await r.runs.create(run({ id: "run_a", assetId: "as_1" }));
    await r.runs.create(run({ id: "run_b", assetId: "as_1" }));
    await r.runs.create(run({ id: "run_other", workspaceId: "ws_2", assetId: "as_1" }));

    assert.equal(await r.runs.countByAsset("ws_1", "as_1"), 2);
    assert.equal(await r.runs.countByAsset("ws_2", "as_1"), 1);
    assert.equal(await r.runs.countByAsset("ws_2", "as_missing"), 0);
  });

  test("storageKeyInUse is global by design: identical bytes are one content-addressed object", async () => {
    const r = await seeded();
    const key = "sha256/aa/" + "a".repeat(64);
    await r.assets.create(asset({ id: "as_1", storageKey: key }));
    await r.assets.create(asset({ id: "as_2", workspaceId: "ws_2", storageKey: key }));

    assert.equal(await r.assets.storageKeyInUse(key), true);
    await r.assets.delete("ws_1", "as_1");
    assert.equal(await r.assets.storageKeyInUse(key), true, "another workspace still references the bytes");
    await r.assets.delete("ws_2", "as_2");
    assert.equal(await r.assets.storageKeyInUse(key), false);
  });

  test("listExpired lists assets by creation time, oldest first, scoped per workspace", async () => {
    const r = await seeded();
    await r.assets.create(asset({ id: "as_old", createdAt: "2024-01-01T00:00:00.000Z" }));
    await r.assets.create(asset({ id: "as_new", createdAt: "2024-04-01T00:00:00.000Z" }));
    await r.assets.create(
      asset({ id: "as_other", workspaceId: "ws_2", createdAt: "2023-01-01T00:00:00.000Z" }),
    );

    const expired = await r.assets.listExpired("ws_1", "2024-03-01T00:00:00.000Z");
    assert.deepEqual(
      expired.map((entry) => entry.id),
      ["as_old"],
    );
  });
});

describe("memory repositories: workspace lifecycle", () => {
  test("softDelete hides the workspace but keeps its data for the grace period", async () => {
    const r = await seeded();
    await r.assets.create(asset());

    assert.equal(await r.workspaces.softDelete("ws_1", "2024-04-01T00:00:00.000Z"), true);
    assert.equal(await r.workspaces.findById("ws_1"), undefined);
    assert.equal(await r.workspaces.findBySlug("acme"), undefined);
    assert.deepEqual(
      (await r.workspaces.list()).items.map((workspace) => workspace.id),
      ["ws_2"],
    );
    assert.ok(await r.assets.findById("ws_1", "as_1"), "data stays until the purge");
    assert.equal(await r.workspaces.softDelete("ws_missing", "2024-04-01T00:00:00.000Z"), false);
  });

  test("purge removes every tenant row and reports storage keys that may be orphaned", async () => {
    const r = await seeded();
    const sharedKey = "sha256/aa/" + "a".repeat(64);
    await r.assets.create(asset({ id: "as_1", storageKey: sharedKey }));
    await r.assets.create(asset({ id: "as_shared", workspaceId: "ws_2", storageKey: sharedKey }));
    await r.mappings.create(mapping());
    await r.pipelines.create({
      id: "pl_1",
      workspaceId: "ws_1",
      name: "nightly",
      mappingId: "mp_1",
      createdAt: "2024-02-01T00:00:00.000Z",
    });
    await r.runs.create(run({ id: "run_1", assetId: "as_1", status: "completed" }));
    await r.runs.appendTraces("ws_1", "run_1", [
      {
        seq: 0,
        stage: "parse",
        stepName: "Parse",
        status: "success",
        payload: {},
        createdAt: "2024-03-01T00:00:01.000Z",
      },
    ]);
    await r.audit.append({ id: "aud_1", workspaceId: "ws_1", action: "run.created", outcome: "success" });
    await r.idempotency.save({
      workspaceId: "ws_1",
      key: "key-1",
      requestChecksum: "sha256:" + "1".repeat(64),
      resourceType: "run",
      resourceId: "run_1",
      createdAt: "2024-03-01T00:00:00.000Z",
      expiresAt: "2099-03-01T00:00:00.000Z",
    });
    await r.apiKeys.save({
      id: "key_1",
      workspaceId: "ws_1",
      name: "owner",
      role: "owner",
      scopes: ["runs:read"],
      prefix: "hb_testprefix",
      secretHash: "a".repeat(64),
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await r.platformAudit.append({
      id: "pau_1",
      workspaceId: "ws_1",
      workspaceSlug: "acme",
      action: "workspace.deletion_requested",
      outcome: "success",
      createdAt: "2024-04-01T00:00:00.000Z",
    });

    const keys = await r.workspacePurges.purge("ws_1");
    assert.deepEqual(keys, [sharedKey]);

    assert.equal(await r.workspaces.findById("ws_1"), undefined);
    assert.equal(await r.assets.findById("ws_1", "as_1"), undefined);
    assert.equal((await r.mappings.list("ws_1")).items.length, 0);
    assert.equal((await r.pipelines.list("ws_1")).items.length, 0);
    assert.equal((await r.runs.list("ws_1")).items.length, 0);
    assert.equal((await r.audit.list("ws_1")).items.length, 0);
    assert.equal(await r.idempotency.get("ws_1", "key-1"), undefined);
    assert.equal(await r.apiKeys.findById("key_1"), undefined);
    assert.equal((await r.platformAudit.list({ workspaceId: "ws_1" })).items.length, 1, "platform audit survives");
    assert.equal(await r.assets.storageKeyInUse(sharedKey), true, "ws_2 still references the bytes");
    assert.deepEqual(await r.workspacePurges.purge("ws_missing"), [], "purging twice is harmless");
  });

  test("purge schedules are findable, due-ordered and removable", async () => {
    const r = await seeded();
    await r.workspacePurges.schedule({
      workspaceId: "ws_1",
      workspaceSlug: "acme",
      scheduledAt: "2024-04-08T00:00:00.000Z",
      requestedAt: "2024-04-01T00:00:00.000Z",
      requestedBy: "key_1",
    });

    assert.equal((await r.workspacePurges.find("ws_1"))?.workspaceSlug, "acme");
    assert.deepEqual(
      (await r.workspacePurges.listDue("2024-04-07T23:59:59.000Z")).map((entry) => entry.workspaceId),
      [],
    );
    assert.deepEqual(
      (await r.workspacePurges.listDue("2024-04-08T00:00:00.000Z")).map((entry) => entry.workspaceId),
      ["ws_1"],
    );
    assert.equal(await r.workspacePurges.remove("ws_1"), true);
    assert.equal(await r.workspacePurges.find("ws_1"), undefined);
    assert.equal(await r.workspacePurges.remove("ws_1"), false);
  });
});
