import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HealthBridgeApiError, HealthBridgeClient } from "../src/index.js";

/**
 * Loopback stub: a real HTTP server speaking just enough of the documented
 * `/api/v1` surface (docs/api.md) to prove the client builds the right
 * requests and unwraps the right envelopes. No engine, no persistence.
 */

const CSV = "id,name\n1,Alice\n";
const ASSET = {
  id: "as_test",
  checksum: "sha256:abc",
  filename: "patients.csv",
  contentType: "text/csv",
  sizeBytes: CSV.length,
  domain: "clinical",
  sourceFormat: "csv",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(text);
}

function envelope(code: string, message: string): object {
  return { error: { code, message, requestId: "req_test" }, statusCode: 404 };
}

let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://stub");
  seen.push({ method: request.method ?? "", url: url.pathname + url.search, headers: request.headers });
  const key = request.headers["x-api-key"];

  if (url.pathname === "/api/v1/healthz") {
    json(response, 200, { status: "ok", mode: "demo", requestId: undefined });
    return;
  }

  if (url.pathname === "/api/v1/assets" && request.method === "POST") {
    assert.equal(key, "hb_test", "the client must send the configured API key");
    assert.match(url.searchParams.get("filename") ?? "", /patients\.csv/);
    const body = await readBody(request);
    assert.equal(body.toString("utf-8"), CSV);
    json(response, 201, { asset: ASSET });
    return;
  }

  if (url.pathname === "/api/v1/assets/as_test/schema") {
    json(response, 200, {
      assetId: "as_test",
      format: "csv",
      domain: "clinical",
      supported: true,
      adapterId: "csv-adapter",
      recordCount: 1,
      confidence: 0.9,
      schema: { fields: [{ name: "id", type: "integer" }] },
      warnings: [],
    });
    return;
  }

  if (url.pathname === "/api/v1/assets/as_test/content") {
    response.writeHead(200, { "content-type": "text/csv", "x-checksum": ASSET.checksum });
    response.end(CSV);
    return;
  }

  if (url.pathname === "/api/v1/runs" && request.method === "POST") {
    assert.equal(request.headers["idempotency-key"], "nightly-1");
    const body = JSON.parse((await readBody(request)).toString("utf-8")) as Record<string, unknown>;
    assert.equal(body.assetId, "as_test");
    assert.equal(body.mappingId, "mp_test");
    json(response, 202, {
      run: { id: "run_1", status: "queued" },
      created: true,
      links: { self: "/api/v1/runs/run_1" },
    });
    return;
  }

  if (url.pathname === "/api/v1/runs" && request.method === "GET") {
    json(response, 200, { runs: [], nextCursor: null });
    return;
  }

  if (url.pathname === "/api/v1/audit") {
    json(response, 200, { events: [], nextCursor: null });
    return;
  }

  json(response, 404, envelope("NOT_FOUND", "No such test route."));
}

describe("@healthbridge/client", () => {
  before(async () => {
    server = createServer((request, response) => {
      route(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function client(): HealthBridgeClient {
    // A trailing slash must not produce a doubled path segment.
    return new HealthBridgeClient({ baseUrl: `${baseUrl}/`, apiKey: "hb_test" });
  }

  test("reads health without a key and normalises the base URL", async () => {
    const anonymous = new HealthBridgeClient({ baseUrl });
    assert.equal(anonymous.baseUrl, `${baseUrl}/api/v1`);
    const health = await anonymous.health();
    assert.equal(health.status, "ok");
    assert.ok(seen.some((entry) => entry.url === "/api/v1/healthz"));
  });

  test("uploads raw bytes and unwraps the asset envelope", async () => {
    const asset = await client().uploadAsset(Buffer.from(CSV, "utf-8"), {
      filename: "patients.csv",
      contentType: "text/csv",
    });
    assert.equal(asset.id, "as_test");
    assert.equal(asset.sourceFormat, "csv");
  });

  test("fetches the asset schema summary", async () => {
    const schema = await client().getAssetSchema("as_test");
    assert.equal(schema.assetId, "as_test");
    assert.equal(schema.supported, true);
    assert.equal(schema.adapterId, "csv-adapter");
    assert.deepEqual(schema.schema, { fields: [{ name: "id", type: "integer" }] });
  });

  test("downloads bytes with the checksum header", async () => {
    const { bytes, checksum } = await client().downloadAsset("as_test");
    assert.equal(Buffer.from(bytes).toString("utf-8"), CSV);
    assert.equal(checksum, ASSET.checksum);
  });

  test("creates a run with an idempotency key and lists runs", async () => {
    const created = await client().createRun({ assetId: "as_test", mappingId: "mp_test" }, "nightly-1");
    assert.equal(created.run.id, "run_1");
    assert.equal(created.created, true);

    const page = await client().listRuns({ limit: 25 });
    assert.deepEqual(page.items, []);
  });

  test("lists the audit trail", async () => {
    const page = await client().listAudit();
    assert.deepEqual(page.items, []);
  });

  test("maps the failure envelope to a typed error", async () => {
    await assert.rejects(
      () => client().getRun("run_missing"),
      (error: unknown) => {
        assert.ok(error instanceof HealthBridgeApiError);
        assert.equal(error.code, "NOT_FOUND");
        assert.equal(error.status, 404);
        assert.equal(error.requestId, "req_test");
        assert.match(error.message, /No such test route/);
        return true;
      },
    );
  });

  test("builds the SSE URL without opening a stream", () => {
    assert.equal(client().runEventsUrl("run_1"), `${baseUrl}/api/v1/runs/run_1/events`);
  });

  test("refuses an empty base URL", () => {
    assert.throws(() => new HealthBridgeClient({ baseUrl: "" }), /baseUrl/);
  });
});
