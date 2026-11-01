import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { buildOpenApiDocument, listControllerRoutes } from "../src/openapi.js";
import { startApi } from "./harness.js";

/**
 * OpenAPI contract tests.
 *
 * `docs/openapi.json` is generated from the controllers
 * (`apps/api/src/generate-openapi.ts`), and these tests prove the committed
 * artifact matches both the code and the live router: every documented path
 * exists in the controllers, every controller route is documented, and the
 * committed file is byte-identical to a fresh generation (the same check CI
 * runs with `--check`).
 */

const DOCUMENT_PATH = resolve(process.cwd(), "docs/openapi.json");

function readCommitted(): { raw: string; document: Record<string, any> } {
  const raw = readFileSync(DOCUMENT_PATH, "utf-8");
  return { raw, document: JSON.parse(raw) as Record<string, any> };
}

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

describe("OpenAPI document", () => {
  it("parses as an OpenAPI 3.x document with shared components", () => {
    const { document } = readCommitted();
    assert.match(String(document.openapi), /^3\./, "must be an OpenAPI 3.x document");
    assert.ok(document.info?.title, "info.title is required");
    assert.ok(document.paths && typeof document.paths === "object", "paths is required");
    assert.ok(document.components?.schemas?.ErrorEnvelope, "the shared error envelope must exist");
    assert.ok(document.components?.schemas?.ErrorCode, "the shared error taxonomy must exist");
    assert.ok(document.components?.securitySchemes?.ApiKey, "the API key scheme must exist");
  });

  it("pins the shared error taxonomy codes", () => {
    const { document } = readCommitted();
    const codes = document.components.schemas.ErrorCode.enum as string[];
    for (const code of [
      "UNAUTHENTICATED",
      "MALFORMED_KEY",
      "REVOKED_KEY",
      "EXPIRED_KEY",
      "FORBIDDEN",
      "RATE_LIMITED",
      "NOT_FOUND",
      "CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "VALIDATION_FAILED",
      "PAYLOAD_TOO_LARGE",
      "INVALID_JSON",
      "RUN_NOT_CANCELLABLE",
      "QUEUE_UNAVAILABLE",
      "CANCELLED",
      "INTERNAL",
    ]) {
      assert.ok(codes.includes(code), `ErrorCode must include ${code}`);
    }
  });

  it("documents every controller route and no route that does not exist", () => {
    const { document } = readCommitted();
    const routes = listControllerRoutes();
    assert.ok(routes.length > 0, "introspection must find the controller routes");

    const committedKeys = new Set<string>();
    for (const [path, item] of Object.entries(document.paths as Record<string, Record<string, any>>)) {
      for (const method of Object.keys(item)) {
        committedKeys.add(`${method.toUpperCase()} ${toOpenApiPath(path)}`);
      }
    }

    const routeKeys = routes.map((route) => `${route.method.toUpperCase()} ${route.openApiPath}`);
    for (const key of routeKeys) {
      assert.ok(committedKeys.has(key), `controller route ${key} is missing from docs/openapi.json`);
    }
    for (const key of committedKeys) {
      assert.ok(routeKeys.includes(key), `docs/openapi.json documents ${key}, which exists in no controller`);
    }
  });

  it("is byte-identical to a fresh generation (no drift)", () => {
    const { raw, document } = readCommitted();
    const generated = buildOpenApiDocument();
    assert.deepEqual(document, generated, "docs/openapi.json differs from buildOpenApiDocument()");
    assert.equal(raw, `${JSON.stringify(generated, null, 2)}\n`, "docs/openapi.json is not canonically serialized");
  });

  it("marks health routes public and secured routes with scopes", () => {
    const { document } = readCommitted();
    const healthz = document.paths["/api/v1/healthz"].get;
    assert.deepEqual(healthz.security, [], "healthz must require no credential");
    assert.ok(!("401" in healthz.responses), "a public route documents no 401");

    const createRun = document.paths["/api/v1/runs"].post;
    assert.deepEqual(createRun.security, [{ ApiKey: [] }]);
    assert.equal(createRun["x-required-scope"], "runs:write");
    assert.equal(createRun.responses["202"].description.length > 0, true);
    const idempotency = (createRun.parameters as Array<{ name: string }>).find((p) => p.name === "idempotency-key");
    assert.ok(idempotency, "POST /runs documents the idempotency-key header");
    assert.ok("422" in createRun.responses, "IDEMPOTENCY_CONFLICT (422) is documented on POST /runs");
    assert.ok("503" in createRun.responses, "QUEUE_UNAVAILABLE (503) is documented on POST /runs");

    const events = document.paths["/api/v1/runs/{id}/events"].get;
    assert.equal(events.operationId, "RunsController.events");
    assert.ok("text/event-stream" in events.responses["200"].content, "SSE is served as text/event-stream");
  });

  it("serves the documented liveness and 404 envelope through the live router", async () => {
    const api = await startApi();
    try {
      const health = await api.client().request<{ status: string }>("GET", "/api/v1/healthz");
      assert.equal(health.status, 200, health.raw);
      assert.equal(health.body.status, "ok");

      const missing = await api.client().request<{ error: { code: string } }>("GET", "/api/v1/does-not-exist");
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "NOT_FOUND");
    } finally {
      await api.close();
    }
  });
});
