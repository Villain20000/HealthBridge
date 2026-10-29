import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The console's own server: static hosting, `/api` proxying, security headers, and — the part
 * that only shows up in production — SSE that is not buffered by the proxy.
 *
 * A fake upstream stands in for the API so the test asserts the proxy contract, not the API.
 */
const WEB_DIR = join(import.meta.dirname, "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

describe("console server", () => {
  let upstreamPort = 0;
  let webPort = 0;
  let staticDir = "";
  let child: ReturnType<typeof spawn> | undefined;
  let upstream: ReturnType<typeof createServer> | undefined;

  before(async () => {
    upstreamPort = await freePort();
    webPort = await freePort();
    staticDir = mkdtempSync(join(tmpdir(), "hb-console-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>console</title>");
    writeFileSync(join(staticDir, "main-ABCD1234.js"), "console.log('bundle')");

    upstream = createServer((req, res) => {
      if (req.url?.startsWith("/api/v1/runs/1/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write('event: status\ndata: {"status":"running"}\n\n');
        setTimeout(() => {
          res.write('event: done\ndata: {"status":"completed"}\n\n');
          res.end();
        }, 150);
        return;
      }
      if (req.url === "/api/v1/echo") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.writeHead(201, {
            "content-type": "application/json",
            "x-request-id": String(req.headers["x-request-id"] ?? ""),
          });
          res.end(
            JSON.stringify({
              method: req.method,
              body,
              requestId: req.headers["x-request-id"] ?? null,
              key: req.headers["x-api-key"] ?? null,
            }),
          );
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }));
    });
    await new Promise<void>((resolve) => upstream?.listen(upstreamPort, "127.0.0.1", resolve));

    child = spawn(process.execPath, [join(WEB_DIR, "server.mjs")], {
      env: {
        ...process.env,
        PORT: String(webPort),
        API_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
        STATIC_DIR: staticDir,
        PROXY_TIMEOUT_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForHealth(webPort);
  });

  after(async () => {
    child?.kill();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  it("serves index.html with no-store and a strict CSP", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("marks hashed bundles immutable and refuses traversal", async () => {
    const bundle = await fetch(`http://127.0.0.1:${webPort}/main-ABCD1234.js`);
    assert.match(bundle.headers.get("cache-control") ?? "", /immutable/);

    const traversal = await fetch(`http://127.0.0.1:${webPort}/..%2f..%2fpackage.json`);
    assert.equal(traversal.status, 404);
  });

  it("falls back to the SPA shell for client routes", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/runs/abc`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  });

  it("proxies /api with the key and request id, and never caches the response", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/v1/echo`, {
      method: "POST",
      headers: { "x-api-key": "hb_test", "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = (await response.json()) as { method: string; body: string; requestId: string; key: string };
    assert.equal(payload.method, "POST");
    assert.equal(payload.body, '{"hello":"world"}');
    assert.ok(payload.requestId.length > 0, "a request id must always be forwarded");
    assert.equal(payload.key, "hb_test");
  });

  it("streams SSE through the proxy without buffering the first frame", async () => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${webPort}/api/v1/runs/1/events`, {
      headers: { "x-api-key": "hb_test" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");

    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstChunkMs = Date.now() - started;
    const text = decoder.decode(first.value, { stream: true });
    assert.match(text, /event: status/);
    // The second frame is sent 150 ms later: receiving the first one early proves no buffering.
    assert.ok(firstChunkMs < 150, `first frame should not wait for the end of the stream (took ${firstChunkMs} ms)`);
    await reader.cancel();
  });

  it("returns a structured 502 when the API is unreachable", async () => {
    const deadPort = await freePort();
    const port = await freePort();
    const orphan = spawn(process.execPath, [join(WEB_DIR, "server.mjs")], {
      env: { ...process.env, PORT: String(port), API_ORIGIN: `http://127.0.0.1:${deadPort}`, STATIC_DIR: staticDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForHealth(port);
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`);
      assert.equal(response.status, 502);
      const payload = (await response.json()) as { error: { code: string; requestId?: string } };
      assert.equal(payload.error.code, "UPSTREAM_UNAVAILABLE");
      assert.ok(payload.error.requestId);
    } finally {
      orphan.kill();
    }
  });

  it("rejects non-GET requests outside /api", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/runs`, { method: "DELETE" });
    assert.equal(response.status, 405);
  });

  it("answers its own health check without touching the API", async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/healthz`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { status: string; upstream: string };
    assert.equal(payload.status, "ok");
    assert.equal(payload.upstream, `http://127.0.0.1:${upstreamPort}`);
  });
});

async function waitForHealth(port: number, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`console server did not become healthy on port ${port}`);
}
