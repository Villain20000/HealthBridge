import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixture, fixtureJson, startApi, waitForRun, type ApiClient, type TestApi } from "./harness.js";

/**
 * Deletion endpoints over the real HTTP stack: scope enforcement, tenant
 * isolation, refusal while data is still referenced, idempotency-key reuse,
 * shared-blob safety and workspace soft deletion with key revocation.
 */

const DELETION_SLUG = "deletion-lab";

describe("deletion API", () => {
  let api: TestApi;
  let owner: ApiClient;
  let workspaceId: string;
  let mappingId: string;

  before(async () => {
    api = await startApi();
    const bootstrap = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Deletion Lab", slug: DELETION_SLUG },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(bootstrap.status, 201, bootstrap.raw);
    workspaceId = bootstrap.body.workspace.id;
    owner = api.client(bootstrap.body.apiKey.key);

    const mapping = await owner.request<{ mapping: { id: string } }>("POST", "/api/v1/mappings", {
      body: {
        name: "deletion-lab",
        spec: fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json"),
        targetResourceType: "Patient",
      },
    });
    assert.equal(mapping.status, 201, mapping.raw);
    mappingId = mapping.body.mapping.id;
  });

  after(async () => {
    await api.close();
  });

  async function upload(
    client: ApiClient,
    body = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv"),
  ) {
    const upload = await client.request<{ asset: { id: string; storageKey: string } }>(
      "POST",
      "/api/v1/assets?filename=patients.csv",
      { raw: body, headers: { "content-type": "text/csv" } },
    );
    assert.equal(upload.status, 201, upload.raw);
    return upload.body.asset;
  }

  async function createRun(client: ApiClient, assetId: string, idempotencyKey?: string) {
    const created = await client.request<{ run: { id: string } }>("POST", "/api/v1/runs", {
      body: { assetId, mappingId },
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    });
    assert.equal(created.status, 202, created.raw);
    return created.body.run;
  }

  async function auditActions(): Promise<string[]> {
    const page = await api.context.repos.audit.list(workspaceId, { limit: 200 });
    return page.items.map((event) => event.action);
  }

  it("refuses to delete an asset a run references, then deletes both", async () => {
    const asset = await upload(owner);
    const run = await createRun(owner, asset.id);
    await waitForRun(owner, run.id);

    const refused = await owner.request<{ error: { code: string } }>("DELETE", `/api/v1/assets/${asset.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "CONFLICT");
    assert.equal((await owner.request("GET", `/api/v1/assets/${asset.id}`)).status, 200);

    const runDeleted = await owner.request<{ deleted: boolean; runId: string }>("DELETE", `/api/v1/runs/${run.id}`);
    assert.equal(runDeleted.status, 200, runDeleted.raw);
    assert.equal(runDeleted.body.deleted, true);
    assert.equal((await owner.request("GET", `/api/v1/runs/${run.id}`)).status, 404);

    const assetDeleted = await owner.request<{ deleted: boolean; blobDeleted: boolean }>(
      "DELETE",
      `/api/v1/assets/${asset.id}`,
    );
    assert.equal(assetDeleted.status, 200, assetDeleted.raw);
    assert.equal(assetDeleted.body.deleted, true);
    assert.equal(assetDeleted.body.blobDeleted, true);
    assert.equal((await owner.request("GET", `/api/v1/assets/${asset.id}`)).status, 404);

    const actions = await auditActions();
    assert.ok(actions.includes("run.deleted"));
    assert.ok(actions.includes("asset.deleted"));
  });

  it("frees the idempotency key when a run is deleted", async () => {
    const asset = await upload(owner);
    const first = await createRun(owner, asset.id, "reusable-key");
    await waitForRun(owner, first.id);

    const deleted = await owner.request<{ idempotencyKeysFreed: number }>("DELETE", `/api/v1/runs/${first.id}`);
    assert.equal(deleted.status, 200, deleted.raw);
    assert.equal(deleted.body.idempotencyKeysFreed, 1);

    const second = await createRun(owner, asset.id, "reusable-key");
    assert.notEqual(second.id, first.id, "the key now creates a new run instead of replaying a deleted one");

    await waitForRun(owner, second.id);
    const removed = await owner.request("DELETE", `/api/v1/runs/${second.id}`);
    assert.equal(removed.status, 200, removed.raw);
  });

  it("refuses to delete a run that has not finished", async () => {
    const asset = await upload(owner);
    const runId = "run_deletion_running";
    await api.context.repos.runs.create({
      id: runId,
      workspaceId,
      mappingId,
      assetId: asset.id,
      status: "running",
      engineVersion: "3.2.0",
      recordsProcessed: 1,
      recordsSucceeded: 1,
      recordsFailed: 0,
      createdAt: new Date().toISOString(),
    });

    const response = await owner.request<{ error: { code: string } }>("DELETE", `/api/v1/runs/${runId}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "RUN_NOT_TERMINAL");
    assert.ok(await api.context.repos.runs.findById(workspaceId, runId));

    await api.context.repos.runs.delete(workspaceId, runId);
  });

  it("enforces scopes and tenant isolation on every delete route", async () => {
    const asset = await upload(owner);
    const issued = await owner.request<{ key: string }>("POST", "/api/v1/keys", {
      body: { name: "deletion viewer", role: "viewer" },
    });
    assert.equal(issued.status, 201, issued.raw);
    const viewer = api.client(issued.body.key);

    assert.equal((await viewer.request("DELETE", `/api/v1/assets/${asset.id}`)).status, 403);
    assert.equal((await viewer.request("DELETE", "/api/v1/runs/run_missing")).status, 403);
    assert.equal(
      (await viewer.request("DELETE", "/api/v1/workspaces/current", { body: { confirm: DELETION_SLUG } })).status,
      403,
    );
    assert.equal((await owner.request("GET", `/api/v1/assets/${asset.id}`)).status, 200);

    const other = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Deletion Other", slug: "deletion-other" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(other.status, 201, other.raw);
    const otherClient = api.client(other.body.apiKey.key);
    const foreignAsset = await upload(otherClient);

    const crossTenant = await owner.request<{ error: { code: string } }>("DELETE", `/api/v1/assets/${foreignAsset.id}`);
    assert.equal(crossTenant.status, 404, "a foreign asset must be indistinguishable from a missing one");
    assert.equal((await otherClient.request("GET", `/api/v1/assets/${foreignAsset.id}`)).status, 200);

    const unknownRun = await owner.request<{ error: { code: string } }>("DELETE", "/api/v1/runs/run_missing");
    assert.equal(unknownRun.status, 404);
  });

  it("deletes a shared blob only when the last workspace reference is gone", async () => {
    const bytes = Buffer.from("shared,deletion,bytes\n");
    const mine = await upload(owner, bytes);
    const other = await api.client().request<{ apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
      body: { name: "Blob Neighbour", slug: "blob-neighbour" },
      headers: { "x-bootstrap-token": "test-bootstrap-token" },
    });
    assert.equal(other.status, 201, other.raw);
    const neighbour = api.client(other.body.apiKey.key);
    const theirs = await upload(neighbour, bytes);
    assert.equal(mine.storageKey, theirs.storageKey, "identical bytes share one object");

    const first = await owner.request<{ blobDeleted: boolean }>("DELETE", `/api/v1/assets/${mine.id}`);
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.body.blobDeleted, false, "the neighbour still references the object");
    assert.equal((await neighbour.request("GET", `/api/v1/assets/${theirs.id}/content`)).status, 200);

    const second = await neighbour.request<{ blobDeleted: boolean }>("DELETE", `/api/v1/assets/${theirs.id}`);
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.body.blobDeleted, true);
    assert.equal(await api.context.repos.assets.storageKeyInUse(mine.storageKey), false);
    assert.equal(await api.context.storage.exists(mine.storageKey), false);
  });

  it("requires the exact slug and admin scope, then revokes every key", async () => {
    const wrong = await owner.request<{ error: { code: string } }>("DELETE", "/api/v1/workspaces/current", {
      body: { confirm: "not-the-slug" },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, "VALIDATION_FAILED");
    assert.equal((await owner.request("GET", "/api/v1/runs")).status, 200, "a refused request changes nothing");

    const deleted = await owner.request<{
      deleted: boolean;
      purgeScheduledAt: string;
      keysRevoked: number;
    }>("DELETE", "/api/v1/workspaces/current", { body: { confirm: DELETION_SLUG } });
    assert.equal(deleted.status, 200, deleted.raw);
    assert.equal(deleted.body.deleted, true);
    assert.ok(deleted.body.keysRevoked >= 1);
    assert.ok(new Date(deleted.body.purgeScheduledAt).getTime() > Date.now());

    const revoked = await owner.request<{ error: { code: string } }>("GET", "/api/v1/runs");
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error.code, "REVOKED_KEY");

    assert.equal(await api.context.repos.workspaces.findBySlug(DELETION_SLUG), undefined, "the workspace is hidden");
    const purge = await api.context.repos.workspacePurges.find(workspaceId);
    assert.ok(purge, "a hard purge is scheduled after the grace period");
    assert.ok(new Date(purge.scheduledAt).getTime() > Date.now());

    const platform = await api.context.repos.platformAudit.list({ workspaceId });
    assert.ok(platform.items.some((event) => event.action === "workspace.deletion_requested"));
  });
});
