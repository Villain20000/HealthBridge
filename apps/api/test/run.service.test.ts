import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Principal } from "@healthbridge/auth";
import { PersistenceError } from "@healthbridge/persistence";
import type { AssetRecord, MappingRecord, PipelineRecord, RunRecord, RunTraceRecord } from "@healthbridge/persistence";
import { ENGINE_VERSION } from "@healthbridge/shared-types";
import { loadTestConfig } from "../src/config.js";
import { ApiError, type ApiErrorCode } from "../src/common/errors.js";
import { RunService, canonicalJson, isTerminal, type CreateRunInput } from "../src/services/run.service.js";
import type { AuditInput } from "../src/services/audit.service.js";
import type { RunJob } from "../src/jobs/run-queue.js";

/**
 * Unit tests for RunService: the run lifecycle behind POST /runs, /cancel and /replay.
 *
 * What is faked (external boundaries only):
 *  - repositories (the database): an in-memory stand-in that records call order
 *  - the run queue (a worker/process boundary): records enqueue/cancel requests
 *  - the audit service (a write-only sink): records events
 *
 * What is real: every rule under test — validation, option sanitising, request
 * checksums, idempotency decisions, ordering guarantees, cancellation rules,
 * replay semantics and the not-found policy that keeps tenants unprobeable.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

const PRINCIPAL: Principal = {
  workspaceId: "ws_test",
  apiKeyId: "key_test",
  keyName: "unit-test-key",
  role: "editor",
  scopes: ["runs:read", "runs:write", "assets:read", "mappings:read"],
};

const ASSET: AssetRecord = {
  id: "as_fixture",
  workspaceId: "ws_test",
  storageKey: "sha256:deadbeef",
  checksum: "sha256:deadbeef",
  filename: "patients.csv",
  contentType: "text/csv",
  sizeBytes: 209,
  domain: "clinical",
  sourceFormat: "csv",
  createdAt: "2025-12-31T00:00:00.000Z",
  createdBy: "key_test",
};

const MAPPING: MappingRecord = {
  id: "mp_fixture",
  workspaceId: "ws_test",
  name: "patient-migration",
  version: 2,
  spec: {
    id: "patient-migration",
    name: "patient-migration",
    version: "2",
    sourceFormat: "csv",
    targetFormat: "fhir-r4",
    rules: [],
  },
  specChecksum: "sha256:mapping",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  createdAt: "2025-12-31T00:00:00.000Z",
};

const PIPELINE: PipelineRecord = {
  id: "pl_fixture",
  workspaceId: "ws_test",
  name: "nightly",
  mappingId: MAPPING.id,
  createdAt: "2025-12-31T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Fakes at the external boundaries
// ---------------------------------------------------------------------------

class FakeRunRepository {
  public readonly rows = new Map<string, RunRecord>();
  public readonly traces = new Map<string, RunTraceRecord[]>();
  public failCreateWith?: Error;

  /** Shared, append-only log so tests can assert cross-boundary ordering. */
  constructor(public readonly calls: string[] = []) {}

  public async create(run: RunRecord): Promise<{ run: RunRecord; created: boolean }> {
    this.calls.push("runs.create");
    if (this.failCreateWith) throw this.failCreateWith;

    if (run.idempotencyKey) {
      const existing = [...this.rows.values()].find(
        (row) => row.workspaceId === run.workspaceId && row.idempotencyKey === run.idempotencyKey,
      );
      if (existing) {
        if (existing.requestChecksum && run.requestChecksum && existing.requestChecksum !== run.requestChecksum) {
          throw new PersistenceError(
            "IDEMPOTENCY_CONFLICT",
            "The Idempotency-Key was already used with a different request payload.",
          );
        }
        return { run: structuredClone(existing), created: false };
      }
    }

    this.rows.set(run.id, structuredClone(run));
    return { run: structuredClone(run), created: true };
  }

  public async findById(workspaceId: string, id: string): Promise<RunRecord | undefined> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? structuredClone(row) : undefined;
  }

  public async findByIdempotencyKey(workspaceId: string, key: string): Promise<RunRecord | undefined> {
    this.calls.push("runs.findByIdempotencyKey");
    const row = [...this.rows.values()].find(
      (entry) => entry.workspaceId === workspaceId && entry.idempotencyKey === key,
    );
    return row ? structuredClone(row) : undefined;
  }

  public async update(workspaceId: string, id: string, patch: Partial<RunRecord>): Promise<RunRecord | undefined> {
    this.calls.push(`runs.update:${String(patch.status)}`);
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId) return undefined;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  public async list(): Promise<{ items: RunRecord[]; nextCursor?: string }> {
    return { items: [] };
  }

  public async appendTraces(): Promise<number> {
    return 0;
  }

  public async listTraces(_workspaceId: string, runId: string): Promise<RunTraceRecord[]> {
    this.calls.push("runs.listTraces");
    return this.traces.get(runId) ?? [];
  }
}

function createHarness(
  overrides: { assets?: AssetRecord[]; mappings?: MappingRecord[]; pipelines?: PipelineRecord[] } = {},
) {
  const calls: string[] = [];
  const runs = new FakeRunRepository(calls);
  const lookupCalls: string[] = [];
  const auditEvents: AuditInput[] = [];
  const enqueued: RunJob[] = [];
  const cancelled: string[] = [];

  const assets = new Map((overrides.assets ?? [ASSET]).map((asset) => [asset.id, asset]));
  const mappings = new Map((overrides.mappings ?? [MAPPING]).map((mapping) => [mapping.id, mapping]));
  const pipelines = new Map((overrides.pipelines ?? [PIPELINE]).map((pipeline) => [pipeline.id, pipeline]));

  const idempotencyRecords = new Map<
    string,
    {
      workspaceId: string;
      key: string;
      requestChecksum: string;
      resourceType: string;
      resourceId: string;
      createdAt: string;
      expiresAt: string;
    }
  >();
  const idempotency = {
    get: async (workspaceId: string, key: string) => {
      lookupCalls.push(`idempotency.get:${key}`);
      const record = idempotencyRecords.get(`${workspaceId}:${key}`);
      return record ? { ...record } : undefined;
    },
    save: async (record: {
      workspaceId: string;
      key: string;
      requestChecksum: string;
      resourceType: string;
      resourceId: string;
      createdAt: string;
      expiresAt: string;
    }) => {
      lookupCalls.push(`idempotency.save:${record.key}`);
      idempotencyRecords.set(`${record.workspaceId}:${record.key}`, { ...record });
    },
  };

  const repos = {
    mode: "memory",
    assets: {
      findById: async (workspaceId: string, id: string) => {
        lookupCalls.push(`assets.findById:${id}`);
        const asset = assets.get(id);
        return asset && asset.workspaceId === workspaceId ? asset : undefined;
      },
      create: async () => assert.fail("assets.create must not be called by RunService"),
      list: async () => ({ items: [] }),
      delete: async () => false,
    },
    mappings: {
      findById: async (workspaceId: string, id: string) => {
        lookupCalls.push(`mappings.findById:${id}`);
        const mapping = mappings.get(id);
        return mapping && mapping.workspaceId === workspaceId ? mapping : undefined;
      },
      findLatestByName: async (workspaceId: string, name: string) => {
        lookupCalls.push(`mappings.findLatestByName:${name}`);
        const matches = [...mappings.values()]
          .filter((mapping) => mapping.workspaceId === workspaceId && mapping.name === name)
          .sort((a, b) => b.version - a.version);
        return matches[0];
      },
      create: async () => assert.fail("mappings.create must not be called by RunService"),
      list: async () => ({ items: [] }),
      versions: async () => [],
    },
    pipelines: {
      findById: async (workspaceId: string, id: string) => {
        lookupCalls.push(`pipelines.findById:${id}`);
        const pipeline = pipelines.get(id);
        return pipeline && pipeline.workspaceId === workspaceId ? pipeline : undefined;
      },
      create: async () => assert.fail("pipelines.create must not be called by RunService"),
      findByName: async () => undefined,
      list: async () => ({ items: [] }),
    },
    runs,
    workspaces: {
      create: async () => assert.fail("unused"),
      findById: async () => undefined,
      findBySlug: async () => undefined,
      list: async () => ({ items: [] }),
    },
    apiKeys: {
      findByPrefix: async () => undefined,
      findById: async () => undefined,
      listByWorkspace: async () => [],
      save: async () => undefined,
      update: async () => undefined,
    },
    audit: {
      append: async (event: AuditInput) => ({ ...event, createdAt: NOW.toISOString() }),
      list: async () => ({ items: [] }),
    },
    idempotency,
    close: async () => undefined,
  };

  const queue = {
    enqueue: (job: RunJob) => {
      calls.push(`queue.enqueue:${job.runId}`);
      enqueued.push(job);
    },
    cancel: (runId: string) => {
      calls.push(`queue.cancel:${runId}`);
      const index = queue.acceptCancel ? 0 : -1;
      if (index === 0) cancelled.push(runId);
      return queue.acceptCancel;
    },
    acceptCancel: true,
  };

  const audit = {
    record: async (event: AuditInput) => {
      calls.push(`audit:${event.action}`);
      auditEvents.push(event);
    },
  };

  let sequence = 0;
  const service = new RunService({
    repos: repos as never,
    queue: queue as never,
    audit: audit as never,
    config: loadTestConfig(),
    now: () => NOW,
    idFactory: () => `run_test_${++sequence}`,
  });

  return {
    service,
    runs,
    queue,
    auditEvents,
    enqueued,
    cancelled,
    calls,
    lookupCalls,
    repos,
    idempotencyRecords,
    resetRecorders(): void {
      calls.length = 0;
      lookupCalls.length = 0;
      auditEvents.length = 0;
      enqueued.length = 0;
      cancelled.length = 0;
    },
  };
}

function baseInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return { principal: PRINCIPAL, assetId: ASSET.id, mappingId: MAPPING.id, ...overrides };
}

/** Asserts that the operation fails with the given ApiError code and returns the error. */
async function expectApiError(operation: () => Promise<unknown>, code: ApiErrorCode): Promise<ApiError> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, received ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ApiError ${code}, but the call resolved successfully`);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("RunService.create — happy path", () => {
  it("should persist the run before enqueueing it, so a crash cannot hide an accepted run", async () => {
    const harness = createHarness();

    const result = await harness.service.create(
      baseInput({ idempotencyKey: "nightly-1", requestId: "req_1", ip: "10.0.0.1" }),
    );

    assert.equal(result.created, true);
    assert.equal(result.run.id, "run_test_1");
    assert.deepEqual(
      harness.calls.filter((call) => call.startsWith("runs.create") || call.startsWith("queue.enqueue")),
      ["runs.create", "queue.enqueue:run_test_1"],
    );
    assert.deepEqual(harness.enqueued, [{ runId: "run_test_1", workspaceId: "ws_test" }]);
  });

  it("should create a queued run with engine version, adapter and zeroed counters", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput());

    assert.equal(run.status, "queued");
    assert.equal(run.workspaceId, PRINCIPAL.workspaceId);
    assert.equal(run.mappingId, MAPPING.id);
    assert.equal(run.assetId, ASSET.id);
    assert.equal(run.engineVersion, ENGINE_VERSION);
    assert.equal(run.adapterId, "csv");
    assert.equal(run.recordsProcessed, 0);
    assert.equal(run.recordsSucceeded, 0);
    assert.equal(run.recordsFailed, 0);
    assert.equal(run.createdBy, PRINCIPAL.apiKeyId);
    assert.equal(run.createdAt, NOW.toISOString());
  });

  it("should record an audit event naming the mapping and the asset", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ requestId: "req_audit", ip: "10.0.0.1" }));

    assert.equal(harness.auditEvents.length, 1);
    const [event] = harness.auditEvents;
    assert.equal(event.action, "run.created");
    assert.equal(event.targetId, run.id);
    assert.equal(event.targetType, "run");
    assert.equal(event.outcome, "success");
    assert.equal(event.workspaceId, PRINCIPAL.workspaceId);
    assert.equal(event.actorKeyId, PRINCIPAL.apiKeyId);
    assert.equal(event.requestId, "req_audit");
    assert.equal(event.ip, "10.0.0.1");
    assert.deepEqual(event.metadata, { mappingId: MAPPING.id, assetId: ASSET.id, idempotencyKey: undefined });
  });

  it("should resolve the latest mapping version when mappingName is supplied instead of mappingId", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ mappingId: undefined, mappingName: "patient-migration" }));

    assert.equal(run.mappingId, MAPPING.id);
    assert.ok(harness.lookupCalls.includes("mappings.findLatestByName:patient-migration"));
  });

  it("should prefer mappingId over mappingName when both are supplied", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ mappingId: MAPPING.id, mappingName: "does-not-exist" }));

    assert.equal(run.mappingId, MAPPING.id);
    assert.ok(!harness.lookupCalls.some((call) => call.startsWith("mappings.findLatestByName")));
  });

  it("should accept an existing pipeline and store its identifier on the run", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ pipelineId: PIPELINE.id }));

    assert.equal(run.pipelineId, PIPELINE.id);
    assert.ok(harness.lookupCalls.includes(`pipelines.findById:${PIPELINE.id}`));
  });

  it("should store sanitised options and leave options undefined when none were sent", async () => {
    const harness = createHarness();

    const withOptions = await harness.service.create(
      baseInput({ options: { maxRecords: 10, importedAt: "2024-01-01T00:00:00.000Z" } }),
    );
    assert.deepEqual(withOptions.run.options, { maxRecords: 10, importedAt: "2024-01-01T00:00:00.000Z" });

    const withoutOptions = await harness.service.create(baseInput());
    assert.equal(withoutOptions.run.options, undefined);

    const withEmptyOptions = await harness.service.create(baseInput({ options: {} }));
    assert.equal(withEmptyOptions.run.options, undefined);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("RunService.create — idempotency", () => {
  it("should return the stored run and enqueue nothing when the same request is submitted twice", async () => {
    const harness = createHarness();
    const input = baseInput({ idempotencyKey: "dup-1", options: { maxRecords: 5 } });

    const first = await harness.service.create(input);
    harness.resetRecorders();
    const second = await harness.service.create(input);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.run.id, first.run.id);
    assert.equal(harness.enqueued.length, 0, "a duplicate submission must never schedule a second execution");
    assert.deepEqual(
      harness.lookupCalls,
      ["idempotency.get:dup-1"],
      "the key index answers without touching assets or mappings",
    );
    assert.deepEqual(harness.runs.calls, [], "nothing is written for a duplicate submission");
  });

  it("should not write an audit event for a repeated submission, because nothing changed", async () => {
    // A retry is the same request, not a second action: auditing every retry would
    // bury real events under client retries.
    const harness = createHarness();
    const input = baseInput({ idempotencyKey: "dup-2" });

    await harness.service.create(input);
    harness.resetRecorders();
    await harness.service.create(input);

    assert.deepEqual(harness.auditEvents, []);
    assert.deepEqual(harness.lookupCalls, ["idempotency.get:dup-2"]);
  });

  it("should reject the same Idempotency-Key with different nested options as an idempotency conflict", async () => {
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "dup-3", options: { maxRecords: 5 } }));

    const error = await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "dup-3", options: { maxRecords: 6 } })),
      "IDEMPOTENCY_CONFLICT",
    );

    assert.equal(error.statusCode, 422);
    assert.match(error.message, /different request/);
  });

  it("should treat a different pipeline as a different request under the same Idempotency-Key", async () => {
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "dup-4" }));

    await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "dup-4", pipelineId: PIPELINE.id })),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("should not consult the idempotency index when no Idempotency-Key is supplied", async () => {
    const harness = createHarness();

    await harness.service.create(baseInput());

    assert.equal(harness.runs.calls.includes("runs.findByIdempotencyKey"), false);
  });

  it("should return the row stored by the repository when it reports the run already existed (race)", async () => {
    const harness = createHarness();
    const original = harness.runs.create.bind(harness.runs);
    harness.runs.create = async (run: RunRecord) => {
      await original({ ...run, id: "run_winner" });
      return { run: { ...run, id: "run_winner" }, created: false };
    };

    const result = await harness.service.create(baseInput({ idempotencyKey: "race-1" }));

    assert.equal(result.created, false);
    assert.equal(result.run.id, "run_winner");
    assert.equal(harness.enqueued.length, 0, "losing the insert race must not schedule a duplicate run");
    assert.deepEqual(
      harness.auditEvents.map((event) => event.action),
      ["run.create-raced"],
    );
  });
});

// ---------------------------------------------------------------------------
// Validation and edge cases
// ---------------------------------------------------------------------------

describe("RunService.create — validation and edge cases", () => {
  it("should reject a missing assetId before touching any repository", async () => {
    const harness = createHarness();

    const missing = await expectApiError(
      () => harness.service.create(baseInput({ assetId: undefined as unknown as string })),
      "VALIDATION_FAILED",
    );
    const empty = await expectApiError(() => harness.service.create(baseInput({ assetId: "" })), "VALIDATION_FAILED");

    assert.match(missing.message, /assetId is required/);
    assert.match(empty.message, /assetId is required/);
    assert.deepEqual(harness.lookupCalls, []);
    assert.deepEqual(harness.calls, []);
  });

  it("should reject a request that names neither mappingId nor mappingName", async () => {
    const harness = createHarness();

    const error = await expectApiError(
      () => harness.service.create(baseInput({ mappingId: undefined, mappingName: undefined })),
      "VALIDATION_FAILED",
    );

    assert.match(error.message, /Either mappingId or mappingName is required/);
    assert.deepEqual(harness.runs.calls, []);
  });

  it("should return the stored run when the asset was deleted after the original request", async () => {
    // The key index records what the request was, so a retry does not depend on the
    // asset (or mapping) still existing.
    const harness = createHarness();
    const first = await harness.service.create(baseInput({ idempotencyKey: "deleted-1" }));
    harness.repos.assets.findById = async () => undefined;

    const retried = await harness.service.create(baseInput({ idempotencyKey: "deleted-1" }));

    assert.equal(retried.created, false);
    assert.equal(retried.run.id, first.run.id);
    assert.equal(harness.enqueued.length, 1);
  });

  it("should return the stored run when the mapping was deleted after the original request", async () => {
    const harness = createHarness();
    const first = await harness.service.create(baseInput({ idempotencyKey: "deleted-2" }));
    harness.repos.mappings.findById = async () => undefined;

    const retried = await harness.service.create(baseInput({ idempotencyKey: "deleted-2" }));

    assert.equal(retried.run.id, first.run.id);
  });

  it("should match a retry that uses mappingId where the original used mappingName", async () => {
    const harness = createHarness();
    const first = await harness.service.create(
      baseInput({ mappingId: undefined, mappingName: "patient-migration", idempotencyKey: "named-1" }),
    );

    const retried = await harness.service.create(baseInput({ mappingId: MAPPING.id, idempotencyKey: "named-1" }));

    assert.equal(retried.created, false);
    assert.equal(retried.run.id, first.run.id);
  });

  it("should reject a key reused for a different asset once the referenced rows are gone", async () => {
    // Fingerprints differ and the dependencies cannot be resolved, so the request
    // cannot be proven equivalent: refuse instead of creating a second run.
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "other-1" }));
    harness.repos.assets.findById = async () => undefined;

    await expectApiError(
      () => harness.service.create(baseInput({ assetId: "as_somewhere_else", idempotencyKey: "other-1" })),
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(harness.enqueued.length, 1);
  });

  it("should fall back to the runs table for keys accepted before the index existed", async () => {
    const harness = createHarness();
    const first = await harness.service.create(baseInput({ idempotencyKey: "legacy-1" }));
    harness.idempotencyRecords.clear();

    const retried = await harness.service.create(baseInput({ idempotencyKey: "legacy-1" }));

    assert.equal(retried.created, false);
    assert.equal(retried.run.id, first.run.id);
    assert.equal(harness.enqueued.length, 1);
  });

  it("should answer a pre-index retry after the asset was deleted, then backfill the index", async () => {
    const harness = createHarness();
    const first = await harness.service.create(baseInput({ idempotencyKey: "legacy-deleted" }));
    harness.idempotencyRecords.clear();
    harness.repos.assets.findById = async () => undefined;

    const retried = await harness.service.create(baseInput({ idempotencyKey: "legacy-deleted" }));

    assert.equal(retried.created, false);
    assert.equal(retried.run.id, first.run.id);
    assert.equal(
      harness.idempotencyRecords.get(`${PRINCIPAL.workspaceId}:legacy-deleted`)?.resourceId,
      first.run.id,
      "the retry upgrades the key to the index so the next one is dependency-free",
    );
  });

  it("should refuse a pre-index key reused for a different asset", async () => {
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "legacy-other" }));
    harness.idempotencyRecords.clear();

    await expectApiError(
      () => harness.service.create(baseInput({ assetId: "as_other", idempotencyKey: "legacy-other" })),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("should refuse a pre-index key reused with different options", async () => {
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "legacy-options" }));
    harness.idempotencyRecords.clear();

    await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "legacy-options", options: { maxRecords: 2 } })),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("should match a pre-index name-based retry while the mapping still resolves", async () => {
    const harness = createHarness();
    const first = await harness.service.create(
      baseInput({ mappingId: undefined, mappingName: "patient-migration", idempotencyKey: "legacy-name" }),
    );
    harness.idempotencyRecords.clear();

    const retried = await harness.service.create(
      baseInput({ mappingId: undefined, mappingName: "patient-migration", idempotencyKey: "legacy-name" }),
    );

    assert.equal(retried.run.id, first.run.id);
  });

  it("should refuse a pre-index name-based retry once the mapping cannot be resolved", async () => {
    // An unresolvable name cannot be shown to mean the same mapping, and returning the
    // stored run would attribute output to rules that may never have produced it.
    const harness = createHarness();
    await harness.service.create(
      baseInput({ mappingId: undefined, mappingName: "patient-migration", idempotencyKey: "legacy-name-gone" }),
    );
    harness.idempotencyRecords.clear();
    harness.repos.mappings.findLatestByName = async () => undefined;

    await expectApiError(
      () =>
        harness.service.create(
          baseInput({ mappingId: undefined, mappingName: "patient-migration", idempotencyKey: "legacy-name-gone" }),
        ),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("should keep returning the run when the key record is past its expiry, because the run owns the key", async () => {
    const harness = createHarness();
    const first = await harness.service.create(baseInput({ idempotencyKey: "past-expiry" }));
    const record = harness.idempotencyRecords.get(`${PRINCIPAL.workspaceId}:past-expiry`);
    assert.ok(record);
    harness.idempotencyRecords.set(`${PRINCIPAL.workspaceId}:past-expiry`, {
      ...record,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const retried = await harness.service.create(baseInput({ idempotencyKey: "past-expiry" }));

    assert.equal(retried.created, false);
    assert.equal(retried.run.id, first.run.id);
  });

  it("should let the key be reused once the original run has been removed by retention", async () => {
    const harness = createHarness();
    await harness.service.create(baseInput({ idempotencyKey: "retained-1" }));
    for (const id of harness.runs.rows.keys()) harness.runs.rows.delete(id);

    const recreated = await harness.service.create(baseInput({ idempotencyKey: "retained-1" }));

    assert.equal(recreated.created, true);
    assert.equal(harness.idempotencyRecords.get(`${PRINCIPAL.workspaceId}:retained-1`)?.resourceId, recreated.run.id);
  });

  it("should treat a whitespace-only assetId as a lookup miss, since trimming belongs to the HTTP layer", async () => {
    const harness = createHarness();

    await expectApiError(() => harness.service.create(baseInput({ assetId: "   " })), "NOT_FOUND");
    assert.ok(harness.lookupCalls.includes("assets.findById:   "));
  });

  it("should reject unknown run options and list the allowed ones", async () => {
    const harness = createHarness();

    const error = await expectApiError(
      () => harness.service.create(baseInput({ options: { maxRecords: 5, deleteEverything: true } })),
      "VALIDATION_FAILED",
    );

    assert.match(error.message, /Unknown run option 'deleteEverything'/);
    assert.match(error.message, /maxRecords/);
    assert.match(error.message, /importedAt/);
    assert.deepEqual(harness.runs.calls, [], "an invalid option must not create a run");
  });

  it("should reject maxRecords values that are not positive numbers", async () => {
    const harness = createHarness();

    for (const value of [0, -1, -0.5, "10", null]) {
      await expectApiError(
        () => harness.service.create(baseInput({ options: { maxRecords: value } })),
        "VALIDATION_FAILED",
      );
    }
    assert.deepEqual(harness.runs.calls, []);
  });

  it("should accept a fractional maxRecords, because the engine decides how to truncate", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ options: { maxRecords: 1.5e-9 } }));

    assert.deepEqual(run.options, { maxRecords: 1.5e-9 });
  });

  it("should reject NaN and Infinity for maxRecords instead of scheduling a run that exports nothing", async () => {
    const harness = createHarness();

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expectApiError(
        () => harness.service.create(baseInput({ options: { maxRecords: value } })),
        "VALIDATION_FAILED",
      );
    }
    assert.deepEqual(harness.runs.calls, []);
  });

  it("should accept maxRecords at the safe-integer boundary", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ options: { maxRecords: Number.MAX_SAFE_INTEGER } }));

    assert.deepEqual(run.options, { maxRecords: Number.MAX_SAFE_INTEGER });
  });

  it("should reject an importedAt that is not a parseable timestamp", async () => {
    const harness = createHarness();

    for (const value of ["not-a-date", "", "2024-13-45T99:99:99Z", "yesterday"]) {
      await expectApiError(
        () => harness.service.create(baseInput({ options: { importedAt: value } })),
        "VALIDATION_FAILED",
      );
    }
    assert.deepEqual(harness.runs.calls, []);
  });

  it("should accept an epoch importedAt as a valid reproducible anchor", async () => {
    const harness = createHarness();

    const { run } = await harness.service.create(baseInput({ options: { importedAt: "1970-01-01T00:00:00.000Z" } }));

    assert.deepEqual(run.options, { importedAt: "1970-01-01T00:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("RunService.create — error handling", () => {
  it("should throw NOT_FOUND when the asset is not visible in this workspace", async () => {
    const harness = createHarness({ assets: [] });

    const error = await expectApiError(() => harness.service.create(baseInput()), "NOT_FOUND");

    assert.equal(error.statusCode, 404);
    assert.equal(error.message, "Asset was not found in this workspace.");
    assert.equal(error.message.includes(ASSET.id), false, "the response must not echo tenant identifiers");
    assert.deepEqual(harness.runs.calls, []);
  });

  it("should throw NOT_FOUND when the mapping id does not exist", async () => {
    const harness = createHarness();

    const error = await expectApiError(
      () => harness.service.create(baseInput({ mappingId: "mp_missing" })),
      "NOT_FOUND",
    );

    assert.equal(error.message, "Mapping was not found in this workspace.");
  });

  it("should throw NOT_FOUND when the mapping name has no versions", async () => {
    const harness = createHarness();

    const error = await expectApiError(
      () => harness.service.create(baseInput({ mappingId: undefined, mappingName: "never-published" })),
      "NOT_FOUND",
    );

    assert.equal(error.message, "Mapping was not found in this workspace.");
  });

  it("should throw NOT_FOUND for an unknown pipeline and create nothing", async () => {
    const harness = createHarness();

    const error = await expectApiError(
      () => harness.service.create(baseInput({ pipelineId: "pl_missing" })),
      "NOT_FOUND",
    );

    assert.equal(error.message, "Pipeline was not found in this workspace.");
    assert.deepEqual(harness.runs.calls, []);
    assert.equal(harness.enqueued.length, 0);
    assert.equal(harness.auditEvents.length, 0);
  });

  it("should propagate a persistence conflict without queueing or auditing", async () => {
    const harness = createHarness();
    harness.runs.failCreateWith = new PersistenceError("CONFLICT", "duplicate key");

    await assert.rejects(
      () => harness.service.create(baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, "CONFLICT");
        return true;
      },
    );

    assert.equal(harness.enqueued.length, 0);
    assert.equal(harness.auditEvents.length, 0);
  });

  it("should mark the run failed and answer 503 when the worker queue rejects the job", async () => {
    // Regression for a stranded-run trap: the row used to stay `queued` while no
    // worker would ever pick it up, and an idempotent retry kept returning it.
    const harness = createHarness();
    harness.queue.enqueue = () => {
      throw new Error("queue unavailable");
    };

    const error = await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "queue-1", requestId: "req_queue" })),
      "QUEUE_UNAVAILABLE",
    );

    assert.equal(error.statusCode, 503);
    assert.match(error.message, /could not be scheduled/);

    const [row] = [...harness.runs.rows.values()];
    assert.equal(row.status, "failed");
    assert.deepEqual(row.error, { code: "QUEUE_UNAVAILABLE", message: "queue unavailable" });
    assert.equal(row.finishedAt, NOW.toISOString());
    assert.equal(harness.enqueued.length, 0);
  });

  it("should audit a scheduling failure as a failure rather than a created run", async () => {
    const harness = createHarness();
    harness.queue.enqueue = () => {
      throw new Error("queue unavailable");
    };

    await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "queue-audit" })),
      "QUEUE_UNAVAILABLE",
    );

    assert.deepEqual(
      harness.auditEvents.map((event) => event.action),
      ["run.queue-failed"],
    );
    assert.equal(harness.auditEvents[0].outcome, "failure");
    assert.deepEqual(harness.auditEvents[0].metadata, { error: "queue unavailable", idempotencyKey: "queue-audit" });
  });

  it("should release the Idempotency-Key when scheduling failed, so the same request can be retried", async () => {
    const harness = createHarness();
    harness.queue.enqueue = () => {
      throw new Error("queue unavailable");
    };
    await expectApiError(
      () => harness.service.create(baseInput({ idempotencyKey: "queue-retry" })),
      "QUEUE_UNAVAILABLE",
    );

    harness.queue.enqueue = (job: RunJob) => {
      harness.enqueued.push(job);
    };
    const retried = await harness.service.create(baseInput({ idempotencyKey: "queue-retry" }));

    assert.equal(retried.created, true, "nothing executed, so the key must not block the retry");
    assert.equal(harness.enqueued.length, 1);
    assert.equal(harness.runs.rows.size, 2, "the failed attempt stays visible as history");
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("RunService reads", () => {
  it("should return a stored run for its own workspace", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());

    const fetched = await harness.service.get(PRINCIPAL.workspaceId, run.id);

    assert.equal(fetched.id, run.id);
  });

  it("should report NOT_FOUND for an unknown run id without disclosing the identifier", async () => {
    const harness = createHarness();

    const error = await expectApiError(() => harness.service.get(PRINCIPAL.workspaceId, "run_missing"), "NOT_FOUND");

    assert.equal(error.statusCode, 404);
    assert.equal(error.message, "Run was not found in this workspace.");
    assert.equal(error.message.includes("run_missing"), false);
  });

  it("should treat a run from another workspace as not found", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());

    await expectApiError(() => harness.service.get("ws_other", run.id), "NOT_FOUND");
  });

  it("should forward pagination and status filters to the repository unchanged", async () => {
    const harness = createHarness();
    const request = { limit: 7, cursor: "cursor_1", status: "failed" as const };
    let received: unknown;
    harness.repos.runs.list = async (workspaceId: string, page: unknown) => {
      received = { workspaceId, page };
      return { items: [], nextCursor: "cursor_2" };
    };

    const page = await harness.service.list(PRINCIPAL.workspaceId, request);

    assert.deepEqual(received, { workspaceId: PRINCIPAL.workspaceId, page: request });
    assert.equal(page.nextCursor, "cursor_2");
  });

  it("should return stored resources and report them as not omitted", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, {
      ...run,
      result: { resources: [{ resourceType: "Patient", id: "H001" }] },
      summary: { resourcesBytes: 42 },
    });

    const resources = await harness.service.resources(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(resources.resources, [{ resourceType: "Patient", id: "H001" }]);
    assert.equal(resources.omitted, false);
    assert.equal(resources.bytes, 42);
  });

  it("should report omitted output when the result exceeded the storage limit", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, { ...run, summary: { resourcesOmitted: true, resourcesBytes: 9_000_000 } });

    const resources = await harness.service.resources(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(resources.resources, []);
    assert.equal(resources.omitted, true);
    assert.equal(resources.bytes, 9_000_000);
  });

  it("should return the persisted traces for a run", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    const trace: RunTraceRecord = {
      runId: run.id,
      seq: 0,
      stage: "mapping",
      stepName: "map records",
      status: "ok",
      payload: { redacted: true },
      createdAt: NOW.toISOString(),
    };
    harness.runs.traces.set(run.id, [trace]);

    const traces = await harness.service.traces(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(traces, [trace]);
  });

  it("should refuse to list traces for an unknown run without querying traces", async () => {
    const harness = createHarness();

    await expectApiError(() => harness.service.traces(PRINCIPAL.workspaceId, "run_missing"), "NOT_FOUND");

    assert.equal(harness.runs.calls.includes("runs.listTraces"), false);
  });

  it("should prefer summary issues over validation issues and include rejected records", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, {
      ...run,
      summary: { issues: [{ code: "SUMMARY" }], rejectedRecords: [{ recordIndex: 3 }] },
      validation: { issues: [{ code: "VALIDATION" }] },
    });

    const issues = await harness.service.issues(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(issues.issues, [{ code: "SUMMARY" }]);
    assert.deepEqual(issues.rejected, [{ recordIndex: 3 }]);
  });

  it("should fall back to validation issues and an empty rejection list when the summary is absent", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, { ...run, validation: { issues: [{ code: "VALIDATION" }] } });

    const issues = await harness.service.issues(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(issues.issues, [{ code: "VALIDATION" }]);
    assert.deepEqual(issues.rejected, []);
  });

  it("should return empty collections when a run has neither summary nor validation", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());

    const issues = await harness.service.issues(PRINCIPAL.workspaceId, run.id);

    assert.deepEqual(issues, { issues: [], rejected: [] });
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("RunService.cancel", () => {
  it("should request cancellation and mark the run as cancelling when the queue accepts it", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.resetRecorders();

    const cancelled = await harness.service.cancel(PRINCIPAL, run.id, { requestId: "req_cancel" });

    assert.equal(cancelled.status, "cancelling");
    assert.deepEqual(
      harness.calls.filter((call) => call.startsWith("queue.")),
      [`queue.cancel:${run.id}`],
    );
    assert.deepEqual(
      harness.auditEvents.map((event) => event.action),
      ["run.cancelled"],
    );
    assert.deepEqual(harness.auditEvents[0].metadata, { queueAccepted: true, previousStatus: "queued" });
    assert.equal(harness.auditEvents[0].requestId, "req_cancel");
  });

  it("should mark the run as cancelled with a timestamp when it is not in this process's queue", async () => {
    // The realistic case after a restart: the row says running, but no local worker owns it.
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, { ...run, status: "running" });
    harness.queue.acceptCancel = false;

    const cancelled = await harness.service.cancel(PRINCIPAL, run.id);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledAt, NOW.toISOString());
    assert.equal(cancelled.finishedAt, NOW.toISOString());
    assert.deepEqual(harness.auditEvents.at(-1)?.metadata, { queueAccepted: false, previousStatus: "running" });
  });

  it("should refuse to cancel a completed run and leave it untouched", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, { ...run, status: "completed" });
    harness.resetRecorders();

    const error = await expectApiError(() => harness.service.cancel(PRINCIPAL, run.id), "RUN_NOT_CANCELLABLE");

    assert.equal(error.statusCode, 409);
    assert.match(error.message, /already completed/);
    assert.equal(harness.calls.includes(`queue.cancel:${run.id}`), false);
    assert.equal(harness.auditEvents.length, 0);
    assert.equal(harness.runs.rows.get(run.id)?.status, "completed");
  });

  it("should refuse to cancel an already cancelled or failed run", async () => {
    for (const status of ["cancelled", "failed", "completed_with_warnings"] as const) {
      const harness = createHarness();
      const { run } = await harness.service.create(baseInput());
      harness.runs.rows.set(run.id, { ...run, status });

      await expectApiError(() => harness.service.cancel(PRINCIPAL, run.id), "RUN_NOT_CANCELLABLE");
      assert.equal(harness.runs.rows.get(run.id)?.status, status);
    }
  });

  it("should refuse with CONFLICT instead of returning a stale run when the row changes mid-cancel", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.repos.runs.update = async () => undefined;

    const error = await expectApiError(() => harness.service.cancel(PRINCIPAL, run.id), "CONFLICT");

    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Fetch it again/);
    assert.deepEqual(harness.auditEvents.at(-1)?.outcome, "failure");
    assert.equal(harness.auditEvents.at(-1)?.metadata?.["reason" as never], "row-changed");
  });

  it("should report NOT_FOUND when the run is deleted while being cancelled", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.repos.runs.update = async () => undefined;
    harness.repos.runs.findById = async () => undefined;

    await expectApiError(() => harness.service.cancel(PRINCIPAL, run.id), "NOT_FOUND");
  });

  it("should throw NOT_FOUND when cancelling an unknown run", async () => {
    const harness = createHarness();

    await expectApiError(() => harness.service.cancel(PRINCIPAL, "run_missing"), "NOT_FOUND");
    assert.equal(harness.calls.includes("queue.cancel:run_missing"), false);
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe("RunService.replay", () => {
  it("should create a new run with the same asset, mapping, pipeline and options", async () => {
    const harness = createHarness();
    const original = await harness.service.create(baseInput({ options: { maxRecords: 3 }, pipelineId: PIPELINE.id }));
    harness.resetRecorders();

    const replayed = await harness.service.replay(PRINCIPAL, original.run.id);

    assert.equal(replayed.created, true);
    assert.notEqual(replayed.run.id, original.run.id);
    assert.equal(replayed.run.assetId, original.run.assetId);
    assert.equal(replayed.run.mappingId, original.run.mappingId);
    assert.equal(replayed.run.pipelineId, PIPELINE.id);
    assert.deepEqual(replayed.run.options, { maxRecords: 3 });
    assert.equal(replayed.run.status, "queued");
  });

  it("should not inherit the original Idempotency-Key, so the replay is a genuinely new run", async () => {
    const harness = createHarness();
    const original = await harness.service.create(baseInput({ idempotencyKey: "original-key" }));

    const replayed = await harness.service.replay(PRINCIPAL, original.run.id);

    assert.equal(replayed.run.idempotencyKey, undefined);
    assert.equal(harness.enqueued.length, 2, "the original and the replay are both scheduled");
  });

  it("should audit the replay with a reference to the original run", async () => {
    const harness = createHarness();
    const original = await harness.service.create(baseInput());
    harness.resetRecorders();

    await harness.service.replay(PRINCIPAL, original.run.id, { requestId: "req_replay" });

    const actions = harness.auditEvents.map((event) => event.action);
    assert.deepEqual(actions, ["run.created", "run.replayed"]);
    assert.deepEqual(harness.auditEvents.at(-1)?.metadata, { replayedFrom: original.run.id });
    assert.equal(harness.auditEvents.at(-1)?.requestId, "req_replay");
  });

  it("should refuse to replay a run that has no input asset", async () => {
    const harness = createHarness();
    const { run } = await harness.service.create(baseInput());
    harness.runs.rows.set(run.id, { ...run, assetId: undefined });
    harness.resetRecorders();

    const error = await expectApiError(() => harness.service.replay(PRINCIPAL, run.id), "VALIDATION_FAILED");

    assert.match(error.message, /no input asset/);
    assert.equal(harness.enqueued.length, 0);
  });

  it("should refuse to replay an unknown run", async () => {
    const harness = createHarness();

    await expectApiError(() => harness.service.replay(PRINCIPAL, "run_missing"), "NOT_FOUND");
  });

  it("should fail when the original mapping has been removed, rather than replaying with different rules", async () => {
    const harness = createHarness();
    const original = await harness.service.create(baseInput());
    harness.repos.mappings.findById = async () => undefined;

    const error = await expectApiError(() => harness.service.replay(PRINCIPAL, original.run.id), "NOT_FOUND");

    assert.equal(error.message, "Mapping was not found in this workspace.");
  });
});

// ---------------------------------------------------------------------------
// Helpers exported from the module
// ---------------------------------------------------------------------------

describe("isTerminal", () => {
  it("should treat every finished status as terminal", () => {
    for (const status of ["completed", "completed_with_warnings", "failed", "cancelled"] as const) {
      assert.equal(isTerminal(status), true, status);
    }
  });

  it("should treat every in-flight status as non-terminal", () => {
    for (const status of ["queued", "running", "cancelling"] as const) {
      assert.equal(isTerminal(status), false, status);
    }
  });
});

describe("canonicalJson", () => {
  it("should produce identical output regardless of key order", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });

  it("should preserve array order, because it is semantically meaningful", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("should drop undefined members instead of emitting invalid JSON", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it("should serialise nested objects and null deterministically", () => {
    assert.equal(
      canonicalJson({ options: { maxRecords: 5 }, pipelineId: null }),
      '{"options":{"maxRecords":5},"pipelineId":null}',
    );
  });
});
