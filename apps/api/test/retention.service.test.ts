import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetRecord, Repositories, RunRecord, Workspace } from "@healthbridge/persistence";
import { createMemoryRepositories } from "@healthbridge/persistence";
import { MemoryStorageDriver } from "@healthbridge/storage";
import { ApiError } from "../src/common/errors.js";
import { ConfigError, loadConfig, loadTestConfig } from "../src/config.js";
import { AuditService } from "../src/services/audit.service.js";
import { RetentionService } from "../src/services/retention.service.js";

/**
 * Retention policy, exercised directly with an injected clock and in-memory
 * repositories. The sweeper is the only code allowed to delete data without a
 * request, so its rules (terminal runs only, unreferenced assets, shared blobs,
 * disabled retention) are pinned here rather than only through HTTP.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-05-01T00:00:00.000Z");

interface Fixture {
  repos: Repositories;
  storage: MemoryStorageDriver;
  retention: RetentionService;
}

function setup(options: { graceDays?: number } = {}): Fixture {
  const repos = createMemoryRepositories();
  const storage = new MemoryStorageDriver();
  const audit = new AuditService(repos, { now: () => NOW });
  const config = loadTestConfig({
    retention: { sweepIntervalMs: 0, workspaceGraceDays: options.graceDays ?? 7 },
  });
  const retention = new RetentionService({ repos, storage, audit, config, now: () => NOW });
  return { repos, storage, retention };
}

let assetSequence = 0;
let runSequence = 0;

async function seedWorkspace(repos: Repositories, id: string, retentionDays: number): Promise<Workspace> {
  return repos.workspaces.create({
    id,
    slug: id.replace(/_/g, "-"),
    name: id,
    plan: "community",
    retentionDays,
    createdAt: NOW.toISOString(),
  });
}

async function seedAsset(
  repos: Repositories,
  storage: MemoryStorageDriver,
  workspaceId: string,
  bytes: Buffer,
  createdAt: Date,
): Promise<AssetRecord> {
  const stored = await storage.put(bytes);
  return repos.assets.create({
    id: `as_retention_${++assetSequence}`,
    workspaceId,
    storageKey: stored.key,
    checksum: stored.checksum,
    filename: "records.csv",
    contentType: "text/csv",
    sizeBytes: stored.sizeBytes,
    domain: "claims",
    sourceFormat: "csv",
    createdAt: createdAt.toISOString(),
  });
}

async function seedRun(
  repos: Repositories,
  workspaceId: string,
  input: { status: RunRecord["status"]; finishedAt?: Date; assetId?: string; idempotencyKey?: string },
): Promise<RunRecord> {
  const { run } = await repos.runs.create({
    id: `run_retention_${++runSequence}`,
    workspaceId,
    mappingId: "mp_retention",
    assetId: input.assetId,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    engineVersion: "3.2.0",
    recordsProcessed: 1,
    recordsSucceeded: 1,
    recordsFailed: 0,
    createdAt: new Date(NOW.getTime() - 60 * DAY).toISOString(),
    finishedAt: input.finishedAt?.toISOString(),
  });
  return run;
}

async function auditActions(repos: Repositories, workspaceId: string): Promise<string[]> {
  const page = await repos.audit.list(workspaceId, { limit: 100 });
  return page.items.map((event) => event.action);
}

describe("retention sweep", () => {
  it("deletes expired terminal runs and unreferenced assets, and the blob with the last reference", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const asset = await seedAsset(
      repos,
      storage,
      "ws_retention",
      Buffer.from("a,b\n1,2\n"),
      new Date(NOW.getTime() - 40 * DAY),
    );
    const run = await seedRun(repos, "ws_retention", {
      status: "completed",
      finishedAt: new Date(NOW.getTime() - 40 * DAY),
      assetId: asset.id,
    });

    const first = await retention.sweep();
    assert.equal(first.runsDeleted, 1);
    assert.equal(first.assetsDeleted, 1);
    assert.equal(first.blobsDeleted, 1);
    assert.equal(await repos.runs.findById("ws_retention", run.id), undefined);
    assert.equal(await repos.assets.findById("ws_retention", asset.id), undefined);
    assert.equal(await storage.exists(asset.storageKey), false);
    assert.ok((await auditActions(repos, "ws_retention")).includes("retention.swept"));

    const second = await retention.sweep();
    assert.equal(second.runsDeleted, 0);
    assert.equal(second.assetsDeleted, 0, "a second sweep has nothing left to delete");
    assert.equal(second.blobsDeleted, 0);
  });

  it("keeps an old asset that a retained run still references", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const asset = await seedAsset(
      repos,
      storage,
      "ws_retention",
      Buffer.from("old,asset\n"),
      new Date(NOW.getTime() - 40 * DAY),
    );
    await seedRun(repos, "ws_retention", {
      status: "completed",
      finishedAt: new Date(NOW.getTime() - 1 * DAY),
      assetId: asset.id,
    });

    const result = await retention.sweep();
    assert.equal(result.runsDeleted, 0, "a run inside the window is retained");
    assert.equal(result.assetsDeleted, 0, "the asset it references must survive");
    assert.ok(await repos.assets.findById("ws_retention", asset.id));
    assert.equal(await storage.exists(asset.storageKey), true);
  });

  it("never deletes a non-terminal run, even when it is old", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const bytes = Buffer.from("queued\n");
    const asset = await seedAsset(repos, storage, "ws_retention", bytes, new Date(NOW.getTime() - 40 * DAY));
    const run = await seedRun(repos, "ws_retention", { status: "queued", assetId: asset.id });

    const result = await retention.sweep();
    assert.equal(result.runsDeleted, 0);
    assert.equal(result.assetsDeleted, 0);
    assert.ok(await repos.runs.findById("ws_retention", run.id));
  });

  it("retentionDays = 0 keeps everything", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 0);
    const asset = await seedAsset(
      repos,
      storage,
      "ws_retention",
      Buffer.from("keep\n"),
      new Date(NOW.getTime() - 400 * DAY),
    );
    await seedRun(repos, "ws_retention", {
      status: "completed",
      finishedAt: new Date(NOW.getTime() - 400 * DAY),
      assetId: asset.id,
    });

    const result = await retention.sweep();
    assert.equal(result.runsDeleted, 0);
    assert.equal(result.assetsDeleted, 0);
    assert.ok(await repos.assets.findById("ws_retention", asset.id));
  });

  it("keeps a content-addressed blob referenced by another workspace", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_expiring", 30);
    await seedWorkspace(repos, "ws_keeping", 0);
    const bytes = Buffer.from("shared,bytes\n");
    const expiring = await seedAsset(repos, storage, "ws_expiring", bytes, new Date(NOW.getTime() - 40 * DAY));
    const keeping = await seedAsset(repos, storage, "ws_keeping", bytes, new Date(NOW.getTime() - 40 * DAY));
    assert.equal(expiring.storageKey, keeping.storageKey, "identical bytes share one object");

    const result = await retention.sweep();
    assert.equal(result.assetsDeleted, 1, "the expired row is deleted");
    assert.equal(result.blobsDeleted, 0, "the object is still referenced by the other workspace");
    assert.ok(await repos.assets.findById("ws_keeping", keeping.id));
    assert.equal(await storage.exists(expiring.storageKey), true);
  });
});

describe("direct deletion", () => {
  it("refuses to delete an asset referenced by any run", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const asset = await seedAsset(repos, storage, "ws_retention", Buffer.from("x\n"), NOW);
    await seedRun(repos, "ws_retention", { status: "completed", finishedAt: NOW, assetId: asset.id });

    await assert.rejects(
      () =>
        retention.deleteAsset({
          principal: { workspaceId: "ws_retention", apiKeyId: "key_1", keyName: "test", role: "owner", scopes: [] },
          assetId: asset.id,
        }),
      (error: unknown) => error instanceof ApiError && error.code === "CONFLICT",
    );
    assert.ok(await repos.assets.findById("ws_retention", asset.id));
  });

  it("refuses to delete a run that has not finished", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const asset = await seedAsset(repos, storage, "ws_retention", Buffer.from("x\n"), NOW);
    const run = await seedRun(repos, "ws_retention", { status: "running", assetId: asset.id });

    await assert.rejects(
      () =>
        retention.deleteRun({
          principal: { workspaceId: "ws_retention", apiKeyId: "key_1", keyName: "test", role: "owner", scopes: [] },
          runId: run.id,
        }),
      (error: unknown) => error instanceof ApiError && error.code === "RUN_NOT_TERMINAL",
    );
    assert.ok(await repos.runs.findById("ws_retention", run.id));
  });

  it("deletes a terminal run, its traces and its idempotency key", async () => {
    const { repos, storage, retention } = setup();
    await seedWorkspace(repos, "ws_retention", 30);
    const asset = await seedAsset(repos, storage, "ws_retention", Buffer.from("x\n"), NOW);
    const run = await seedRun(repos, "ws_retention", {
      status: "completed",
      finishedAt: NOW,
      assetId: asset.id,
      idempotencyKey: "retention-key",
    });
    await repos.idempotency.save({
      workspaceId: "ws_retention",
      key: "retention-key",
      requestChecksum: "sha256:request",
      resourceType: "run",
      resourceId: run.id,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    });

    const result = await retention.deleteRun({
      principal: { workspaceId: "ws_retention", apiKeyId: "key_1", keyName: "test", role: "owner", scopes: [] },
      runId: run.id,
    });

    assert.equal(result.idempotencyKeysFreed, 1);
    assert.equal(await repos.runs.findById("ws_retention", run.id), undefined);
    assert.equal(await repos.idempotency.get("ws_retention", "retention-key"), undefined);
    assert.ok((await auditActions(repos, "ws_retention")).includes("run.deleted"));
  });
});

describe("retention configuration", () => {
  const baseEnv = {
    NODE_ENV: "development",
    HEALTHBRIDGE_BOOTSTRAP_TOKEN: "test-bootstrap-token",
  } as NodeJS.ProcessEnv;

  it("defaults to an hourly sweep and a seven-day workspace grace period", () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.retention.sweepIntervalMs, 3_600_000);
    assert.equal(config.retention.workspaceGraceDays, 7);
  });

  it("accepts zero, which disables the scheduler and makes a purge immediately due", () => {
    const config = loadConfig({
      ...baseEnv,
      HEALTHBRIDGE_RETENTION_SWEEP_MS: "0",
      HEALTHBRIDGE_WORKSPACE_GRACE_DAYS: "0",
    } as NodeJS.ProcessEnv);
    assert.equal(config.retention.sweepIntervalMs, 0);
    assert.equal(config.retention.workspaceGraceDays, 0);
  });

  it("rejects negative values instead of coercing them", () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, HEALTHBRIDGE_RETENTION_SWEEP_MS: "-1" } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof ConfigError && /HEALTHBRIDGE_RETENTION_SWEEP_MS/.test(error.message),
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, HEALTHBRIDGE_WORKSPACE_GRACE_DAYS: "-5" } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof ConfigError && /HEALTHBRIDGE_WORKSPACE_GRACE_DAYS/.test(error.message),
    );
  });
});

describe("workspace deletion", () => {
  const principal = {
    workspaceId: "ws_retention",
    apiKeyId: "key_1",
    keyName: "owner",
    role: "owner" as const,
    scopes: [],
  };

  async function seedWorkspaceWithData(fixture: Fixture): Promise<{ asset: AssetRecord; run: RunRecord }> {
    const workspace = await seedWorkspace(fixture.repos, "ws_retention", 30);
    await fixture.repos.apiKeys.save({
      id: "key_1",
      workspaceId: workspace.id,
      name: "owner",
      role: "owner",
      scopes: [],
      prefix: "hb_aaaaaaaaaaaa",
      secretHash: "0".repeat(64),
      createdAt: NOW.toISOString(),
    });
    const asset = await seedAsset(fixture.repos, fixture.storage, workspace.id, Buffer.from("delete me\n"), NOW);
    const run = await seedRun(fixture.repos, workspace.id, { status: "completed", finishedAt: NOW, assetId: asset.id });
    return { asset, run };
  }

  it("requires the slug to confirm the request", async () => {
    const fixture = setup();
    await seedWorkspaceWithData(fixture);

    await assert.rejects(
      () => fixture.retention.requestWorkspaceDeletion({ principal, confirm: "wrong-slug" }),
      (error: unknown) => error instanceof ApiError && error.code === "VALIDATION_FAILED",
    );
    const workspace = await fixture.repos.workspaces.findById("ws_retention");
    assert.ok(workspace, "a refused request leaves the workspace visible");
    assert.equal(workspace.deletedAt, undefined);
    assert.equal(await fixture.repos.workspacePurges.find("ws_retention"), undefined);
  });

  it("soft-deletes, revokes every key and schedules a purge after the grace period", async () => {
    const fixture = setup({ graceDays: 7 });
    const { run } = await seedWorkspaceWithData(fixture);

    const result = await fixture.retention.requestWorkspaceDeletion({ principal, confirm: "ws-retention" });
    assert.equal(result.keysRevoked, 1);
    assert.equal(result.purgeScheduledAt, new Date(NOW.getTime() + 7 * DAY).toISOString());

    const schedule = await fixture.repos.workspacePurges.find("ws_retention");
    assert.equal(schedule?.scheduledAt, new Date(NOW.getTime() + 7 * DAY).toISOString());
    assert.equal(
      await fixture.repos.workspaces.findBySlug("ws-retention"),
      undefined,
      "a soft-deleted workspace is hidden from lookups",
    );
    assert.ok((await fixture.repos.apiKeys.findById("key_1"))?.revokedAt);
    assert.ok(await fixture.repos.runs.findById("ws_retention", run.id), "data survives the grace period");

    const platform = await fixture.repos.platformAudit.list({ workspaceId: "ws_retention" });
    assert.ok(platform.items.some((event) => event.action === "workspace.deletion_requested"));

    const sweep = await fixture.retention.sweep();
    assert.equal(sweep.workspacesPurged, 0, "the purge is not due yet");
    assert.ok(await fixture.repos.runs.findById("ws_retention", run.id), "the sweep respects the grace period");
    assert.ok(await fixture.repos.workspacePurges.find("ws_retention"));
  });

  it("purges the workspace when the grace period has elapsed", async () => {
    const fixture = setup({ graceDays: 0 });
    const { asset, run } = await seedWorkspaceWithData(fixture);

    await fixture.retention.requestWorkspaceDeletion({ principal, confirm: "ws-retention" });
    const sweep = await fixture.retention.sweep();

    assert.equal(sweep.workspacesPurged, 1);
    assert.equal(await fixture.repos.workspaces.findById("ws_retention"), undefined);
    assert.equal(await fixture.repos.runs.findById("ws_retention", run.id), undefined);
    assert.equal(await fixture.repos.assets.findById("ws_retention", asset.id), undefined);
    assert.equal(await fixture.repos.apiKeys.findById("key_1"), undefined);
    assert.equal(await fixture.repos.workspacePurges.find("ws_retention"), undefined);
    assert.equal(await fixture.storage.exists(asset.storageKey), false);

    const platform = await fixture.repos.platformAudit.list({ workspaceId: "ws_retention" });
    assert.ok(
      platform.items.some((event) => event.action === "workspace.purged"),
      "the platform audit survives the workspace it describes",
    );
  });
});
