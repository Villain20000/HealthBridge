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
