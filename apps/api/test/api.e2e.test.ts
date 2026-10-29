import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixture, fixtureJson, startApi, waitForRun, type ApiClient, type TestApi } from "./harness.js";

/**
 * End-to-end tests over HTTP against the real stack: real adapters, real mapping
 * engine, real queue, real persistence (in-memory) and real storage.
 */

describe("HealthBridge API", () => {
  let api: TestApi;
  let owner: ApiClient;
  let workspaceId: string;

  before(async () => {
    api = await startApi();
    const bootstrap = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Test Clinic", slug: "test-clinic" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(bootstrap.status, 201, bootstrap.raw);
    workspaceId = bootstrap.body.workspace.id;
    owner = api.client(bootstrap.body.apiKey.key);
  });

  after(async () => {
    await api.close();
  });

  it("exposes a public liveness endpoint that reports the persistence mode", async () => {
    const response = await api
      .client()
      .request<{ status: string; mode: string; persistence: string }>("GET", "/api/v1/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ok");
    assert.equal(response.body.mode, "demo");
    assert.match(response.body.persistence, /in-memory/);
    assert.ok(response.headers.get("x-request-id"), "every response carries a request id");
  });

  it("rejects unauthenticated and malformed keys with a structured envelope", async () => {
    const anonymous = await api
      .client()
      .request<{ error: { code: string; requestId?: string } }>("GET", "/api/v1/assets");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "UNAUTHENTICATED");
    assert.ok(anonymous.body.error.requestId);

    const malformed = await api.client("nonsense").request<{ error: { code: string } }>("GET", "/api/v1/assets");
    assert.ok([400, 401].includes(malformed.status));
    assert.ok(["MALFORMED_KEY", "UNAUTHENTICATED"].includes(malformed.body.error.code));
  });

  it("refuses workspace creation without the bootstrap token", async () => {
    const response = await api.client().request<{ error: { code: string } }>("POST", "/api/v1/workspaces", {
      body: { name: "Rogue", slug: "rogue" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "UNAUTHENTICATED");
  });

  it("enforces scopes: a viewer key cannot write mappings", async () => {
    const issued = await owner.request<{ key: string }>("POST", "/api/v1/keys", {
      body: { name: "read only", role: "viewer" },
    });
    assert.equal(issued.status, 201, issued.raw);

    const viewer = api.client(issued.body.key);
    const read = await viewer.request("GET", "/api/v1/runs");
    assert.equal(read.status, 200);

    const write = await viewer.request<{ error: { code: string; details?: { requiredScope?: string } } }>(
      "POST",
      "/api/v1/mappings",
      {
        body: {
          name: "nope",
          spec: { id: "x", name: "x", version: "1", sourceFormat: "csv", targetFormat: "fhir-r4", rules: [] },
        },
      },
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, "FORBIDDEN");
    assert.equal(write.body.error.details?.requiredScope, "mappings:write");
  });

  it("uploads an asset, content-addresses it and serves the identical bytes", async () => {
    const bytes = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const upload = await owner.request<{
      asset: { id: string; checksum: string; sizeBytes: number; sourceFormat: string };
    }>("POST", "/api/v1/assets?filename=patients.csv", { raw: bytes, headers: { "content-type": "text/csv" } });
    assert.equal(upload.status, 201, upload.raw);
    assert.equal(upload.body.asset.sizeBytes, bytes.byteLength);
    assert.equal(upload.body.asset.sourceFormat, "csv");
    assert.match(upload.body.asset.checksum, /^sha256:[0-9a-f]{64}$/);

    const download = await owner.request("GET", `/api/v1/assets/${upload.body.asset.id}/content`);
    assert.equal(download.status, 200);
    assert.equal(download.raw.length > 0, true);
    assert.equal(download.headers.get("x-checksum"), upload.body.asset.checksum);
  });

  it("runs the hospital-migration scenario end to end", async () => {
    const mappingSpec = fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json");
    const mapping = await owner.request<{ mapping: { id: string; version: number } }>("POST", "/api/v1/mappings", {
      body: { name: "patient-migration", spec: mappingSpec, targetResourceType: "Patient" },
    });
    assert.equal(mapping.status, 201, mapping.raw);
    assert.equal(mapping.body.mapping.version, 1);

    const csv = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const asset = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=patients.csv", {
      raw: csv,
      headers: { "content-type": "text/csv" },
    });
    assert.equal(asset.status, 201, asset.raw);

    const created = await owner.request<{ run: { id: string; status: string }; links: Record<string, string> }>(
      "POST",
      "/api/v1/runs",
      {
        body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id },
        headers: { "idempotency-key": "run-1" },
      },
    );
    assert.equal(created.status, 202, created.raw);
    assert.equal(created.body.run.status, "queued");
    assert.ok(created.body.links.events);

    const finished = await waitForRun(owner, created.body.run.id);
    assert.ok(["completed", "completed_with_warnings"].includes(finished.status), JSON.stringify(finished));
    assert.ok((finished.recordsProcessed as number) > 0);

    const resources = await owner.request<{ resources: Array<Record<string, unknown>> }>(
      "GET",
      `/api/v1/runs/${created.body.run.id}/resources`,
    );
    assert.equal(resources.status, 200);
    assert.ok(resources.body.resources.length > 0);
    for (const resource of resources.body.resources) {
      assert.equal(resource.resourceType, "Patient");
      assert.ok(typeof resource.id === "string" && resource.id.length > 0);
    }

    const traces = await owner.request<{ traces: unknown[]; count: number }>(
      "GET",
      `/api/v1/runs/${created.body.run.id}/traces`,
    );
    assert.equal(traces.status, 200);
    assert.ok(traces.body.count > 0, "traces are persisted for the debugger");

    const bundle = await owner.request<{
      bundleVersion: string;
      expected: { outputChecksum?: string };
      mappingRef: { version: number };
    }>("GET", `/api/v1/runs/${created.body.run.id}/bundle`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.body.bundleVersion, "1");
    assert.ok(bundle.body.expected.outputChecksum);
    assert.equal(bundle.body.mappingRef.version, 1);

    // Replaying with the same Idempotency-Key returns the same run, not a duplicate.
    const duplicate = await owner.request<{ run: { id: string }; created: boolean }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id },
      headers: { "idempotency-key": "run-1" },
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.run.id, created.body.run.id);
    assert.equal(duplicate.body.created, false);

    // Same key, different payload → explicit conflict.
    const conflict = await owner.request<{ error: { code: string } }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id, options: { maxRecords: 1 } },
      headers: { "idempotency-key": "run-1" },
    });
    assert.equal(conflict.status, 422);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    // Replay creates a new run from the same inputs.
    const replay = await owner.request<{ run: { id: string }; replayedFrom: string }>(
      "POST",
      `/api/v1/runs/${created.body.run.id}/replay`,
    );
    assert.equal(replay.status, 202, replay.raw);
    assert.notEqual(replay.body.run.id, created.body.run.id);
    const replayed = await waitForRun(owner, replay.body.run.id);
    assert.ok(["completed", "completed_with_warnings"].includes(replayed.status));
  });

  it("treats a nested option change as a different request under the same Idempotency-Key", async () => {
    const mappingSpec = fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json");
    const mapping = await owner.request<{ mapping: { id: string } }>("POST", "/api/v1/mappings", {
      body: { name: "checksum-mapping", spec: mappingSpec },
    });
    const csv = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const asset = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=checksum.csv", {
      raw: csv,
      headers: { "content-type": "text/csv" },
    });

    const headers = { "idempotency-key": "nested-options" };
    const first = await owner.request<{ run: { id: string } }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id, options: { maxRecords: 1 } },
      headers,
    });
    assert.equal(first.status, 202, first.raw);
    await waitForRun(owner, first.body.run.id);

    const second = await owner.request<{ error: { code: string } }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id, options: { maxRecords: 2 } },
      headers,
    });
    assert.equal(second.status, 422, "a nested option change must not reuse the previous run");
    assert.equal(second.body.error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("returns a 503 envelope and a failed run when the worker queue rejects the job", async () => {
    const mappingSpec = fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json");
    const mapping = await owner.request<{ mapping: { id: string } }>("POST", "/api/v1/mappings", {
      body: { name: "queue-failure-mapping", spec: mappingSpec, targetResourceType: "Patient" },
    });
    assert.equal(mapping.status, 201, mapping.raw);

    const csv = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const asset = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=patients.csv", {
      raw: csv,
      headers: { "content-type": "text/csv" },
    });
    assert.equal(asset.status, 201, asset.raw);

    const healthyEnqueue = api.context.queue.enqueue.bind(api.context.queue);
    api.context.queue.enqueue = () => {
      throw new Error("worker pool exhausted");
    };
    let created: { status: number; body: { error: { code: string; message: string; requestId: string } } };
    try {
      created = await owner.request("POST", "/api/v1/runs", {
        body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id },
        headers: { "idempotency-key": "queue-failure-1" },
      });
    } finally {
      api.context.queue.enqueue = healthyEnqueue;
    }

    assert.equal(created.status, 503, JSON.stringify(created.body));
    assert.equal(created.body.error.code, "QUEUE_UNAVAILABLE");
    assert.ok(created.body.error.requestId, "the envelope still carries a request id");

    const runId = (created.body.error as { details?: { runId?: string } }).details?.runId;
    assert.ok(runId, "the client is told which run was recorded");
    const stored = await owner.request<{ run: { status: string; error?: { code: string } } }>(
      "GET",
      `/api/v1/runs/${runId}`,
    );
    assert.equal(stored.status, 200, stored.raw);
    assert.equal(stored.body.run.status, "failed", "the run must not claim to be queued");
    assert.equal(stored.body.run.error?.code, "QUEUE_UNAVAILABLE");

    // The key was released because nothing executed, so the same request can be retried.
    const retried = await owner.request<{ run: { id: string; status: string } }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id },
      headers: { "idempotency-key": "queue-failure-1" },
    });
    assert.equal(retried.status, 202, retried.raw);
    assert.equal(retried.body.run.status, "queued");
    assert.notEqual(retried.body.run.id, runId);
  });

  it("records audit events for privileged actions", async () => {
    const audit = await owner.request<{ events: Array<{ action: string }> }>("GET", "/api/v1/audit");
    assert.equal(audit.status, 200, audit.raw);
    const actions = audit.body.events.map((event) => event.action);
    assert.ok(actions.includes("workspace.created"));
    assert.ok(actions.includes("asset.uploaded"));
    assert.ok(actions.includes("mapping.created"));
    assert.ok(actions.includes("run.created"));
  });

  it("streams run progress over server-sent events", async () => {
    const mappingSpec = fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json");
    const mapping = await owner.request<{ mapping: { id: string } }>("POST", "/api/v1/mappings", {
      body: { name: "sse-mapping", spec: mappingSpec },
    });
    const csv = fixture("scenarios", "01-hospital-patient-migration", "data", "patients.csv");
    const asset = await owner.request<{ asset: { id: string } }>("POST", "/api/v1/assets?filename=sse.csv", {
      raw: csv,
      headers: { "content-type": "text/csv" },
    });
    const run = await owner.request<{ run: { id: string } }>("POST", "/api/v1/runs", {
      body: { assetId: asset.body.asset.id, mappingId: mapping.body.mapping.id },
    });

    const controller = new AbortController();
    const response = await fetch(`${api.url}/api/v1/runs/${run.body.run.id}/events`, {
      headers: { "x-api-key": owner.key! },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const types: string[] = [];
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const typeLine = frame.split("\n").find((line) => line.startsWith("event:"));
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (typeLine) types.push(typeLine.replace("event:", "").trim());
        if (dataLine && /"type":"(done|error|cancelled)"/.test(dataLine)) {
          controller.abort();
          assert.ok(types.includes("snapshot"), `expected a snapshot event, got ${types.join(",")}`);
          return;
        }
      }
    }
    controller.abort();
    assert.fail(`SSE stream did not reach a terminal event; saw ${types.join(",")}`);
  });

  it("isolates tenants: another workspace cannot read or reference these records", async () => {
    const other = await api.client().request<{ apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
      body: { name: "Other Clinic", slug: "other-clinic" },
      headers: { "x-bootstrap-token": "test-bootstrap-token" },
    });
    assert.equal(other.status, 201, other.raw);
    const intruder = api.client(other.body.apiKey.key);

    const runs = await intruder.request<{ runs: unknown[] }>("GET", "/api/v1/runs");
    assert.equal(runs.status, 200);
    assert.equal(runs.body.runs.length, 0, "runs are scoped to the workspace");

    const assets = await owner.request<{ assets: Array<{ id: string }> }>("GET", "/api/v1/assets");
    const foreignAssetId = assets.body.assets[0].id;

    const probe = await intruder.request<{ error: { code: string } }>("GET", `/api/v1/assets/${foreignAssetId}`);
    assert.equal(probe.status, 404);
    assert.equal(probe.body.error.code, "NOT_FOUND");

    const runProbe = await owner.request<{ runs: Array<{ id: string; mappingId: string }> }>(
      "GET",
      "/api/v1/runs?limit=1",
    );
    const foreignRun = runProbe.body.runs[0];
    const runRead = await intruder.request<{ error: { code: string } }>("GET", `/api/v1/runs/${foreignRun.id}`);
    assert.equal(runRead.status, 404);

    const crossRun = await intruder.request<{ error: { code: string } }>("POST", "/api/v1/runs", {
      body: { assetId: foreignAssetId, mappingId: foreignRun.mappingId },
    });
    assert.equal(crossRun.status, 404, "a foreign asset is not usable as run input");
  });

  it("refuses to cancel a finished run", async () => {
    const runs = await owner.request<{ runs: Array<{ id: string; status: string }> }>(
      "GET",
      "/api/v1/runs?status=completed",
    );
    const done =
      runs.body.runs[0] ??
      (await owner.request<{ runs: Array<{ id: string; status: string }> }>("GET", "/api/v1/runs?limit=50")).body
        .runs[0];
    const response = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${done.id}/cancel`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "RUN_NOT_CANCELLABLE");
  });

  it("rate limits a key that exceeds its burst", async () => {
    const limited = await startApi({
      limits: { ...(await api.context.config).limits, rateLimit: { capacity: 3, refillPerSecond: 1 } },
    });
    try {
      const workspace = await limited.client().request<{ apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Limited", slug: "limited" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
      const client = limited.client(workspace.body.apiKey.key);
      const statuses: number[] = [];
      for (let index = 0; index < 6; index++) {
        const response = await client.request("GET", "/api/v1/runs");
        statuses.push(response.status);
      }
      assert.ok(statuses.includes(429), `expected a 429, saw ${statuses.join(",")}`);
    } finally {
      await limited.close();
    }
  });

  it("returns a JSON 404 envelope for unknown routes", async () => {
    const response = await owner.request<{ error: { code: string } }>("GET", "/api/v1/does-not-exist");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
  });

  it("rejects an invalid run body without creating a run", async () => {
    const response = await owner.request<{ error: { code: string; message: string } }>("POST", "/api/v1/runs", {
      body: { assetId: "" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_FAILED");
  });

  it("rejects an upload over the documented limit with 413, not 500", async () => {
    // Regression: body-parser raises a plain Error with status 413, which used to fall through
    // to the generic INTERNAL handler. An operator must get PAYLOAD_TOO_LARGE plus a request id.
    const limit = globalThis.process.env["HEALTHBRIDGE_MAX_UPLOAD_BYTES"]
      ? Number(globalThis.process.env["HEALTHBRIDGE_MAX_UPLOAD_BYTES"])
      : 64 * 1024 * 1024;
    const oversized = Buffer.alloc(limit + 1024, 0x61);
    const response = await owner.request<{ error: { code: string; requestId: string } }>(
      "POST",
      "/api/v1/assets?filename=huge.csv",
      {
        raw: oversized,
        headers: { "content-type": "text/csv" },
      },
    );
    assert.equal(response.status, 413, response.raw.slice(0, 200));
    assert.equal(response.body.error.code, "PAYLOAD_TOO_LARGE");
    assert.ok(response.body.error.requestId);
  });

  it("rejects malformed JSON with INVALID_JSON instead of a 500", async () => {
    const response = await owner.request<{ error: { code: string } }>("POST", "/api/v1/mappings", {
      raw: Buffer.from("{ this is not json"),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 400, response.raw.slice(0, 200));
    assert.equal(response.body.error.code, "INVALID_JSON");
  });

  it("keeps workspace_id out of the URL and in the key: unknown workspace ids are not addressable", async () => {
    const response = await owner.request("GET", `/api/v1/workspaces/${workspaceId}`);
    assert.equal(response.status, 404, "workspace ids are never used as a routing parameter");
  });
});
