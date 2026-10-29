import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, MIN_BOOTSTRAP_TOKEN_LENGTH, loadConfig } from "../src/config.js";
import { startApi } from "./harness.js";

/**
 * Bootstrap provisioning hardening.
 *
 * `POST /api/v1/workspaces` is public: the API-key guard returns before it can
 * rate limit anything, so these tests prove the route is protected by a token
 * strength check and its own per-IP limiter instead.
 */

const BOOTSTRAP_PATH = "/api/v1/workspaces";
const VALID_TOKEN = "test-bootstrap-token";

describe("bootstrap token configuration", () => {
  it("rejects a token shorter than 16 characters in demo (development) mode", () => {
    assert.throws(
      () =>
        loadConfig({ NODE_ENV: "development", HEALTHBRIDGE_BOOTSTRAP_TOKEN: "short-token-123" } as NodeJS.ProcessEnv),
      (error: unknown) =>
        error instanceof ConfigError &&
        /HEALTHBRIDGE_BOOTSTRAP_TOKEN must be at least 16 characters/.test(error.message),
    );
  });

  it("rejects a token shorter than 16 characters in database mode", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "development",
          DATABASE_URL: "mysql://healthbridge:secret@127.0.0.1:3306/healthbridge",
          HEALTHBRIDGE_KEY_PEPPER: "test-pepper-at-least-16-chars",
          HEALTHBRIDGE_BOOTSTRAP_TOKEN: "too-short-token",
        } as NodeJS.ProcessEnv),
      (error: unknown) => error instanceof ConfigError && /at least 16 characters/.test(error.message),
    );
  });

  it("accepts the demo, e2e and boundary-length tokens used by scripts and tests", () => {
    for (const token of [
      "demo-bootstrap-token",
      "e2e-bootstrap-token",
      VALID_TOKEN,
      "x".repeat(MIN_BOOTSTRAP_TOKEN_LENGTH),
    ]) {
      const config = loadConfig({ NODE_ENV: "development", HEALTHBRIDGE_BOOTSTRAP_TOKEN: token } as NodeJS.ProcessEnv);
      assert.equal(config.auth.bootstrapToken, token);
      assert.equal(config.mode, "demo");
    }
  });

  it("reads the per-IP bootstrap limit from HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      HEALTHBRIDGE_BOOTSTRAP_TOKEN: VALID_TOKEN,
      HEALTHBRIDGE_BOOTSTRAP_RATE_LIMIT: "3",
    } as NodeJS.ProcessEnv);
    assert.equal(config.limits.bootstrapRateLimit.attemptsPerWindow, 3);
    assert.equal(config.limits.bootstrapRateLimit.windowMs, 15 * 60 * 1000);
  });
});

describe("bootstrap endpoint rate limiting", () => {
  it("returns 429 with RATE_LIMITED and retry-after after exhausting the per-IP window", async () => {
    const api = await startApi();
    try {
      // Failed attempts cost a slot: an unauthenticated caller cannot brute force the token.
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await api.client().request<{ error: { code: string } }>("POST", BOOTSTRAP_PATH, {
          body: { name: `Attempt ${attempt}`, slug: `attempt-${attempt}` },
          headers: { "x-bootstrap-token": "definitely-not-the-token" },
        });
        assert.equal(response.status, 401, response.raw);
        assert.equal(response.body.error.code, "UNAUTHENTICATED");
      }

      const limited = await api.client().request<{
        error: { code: string; details?: { retryAfterSeconds?: number } };
      }>("POST", BOOTSTRAP_PATH, {
        body: { name: "One Too Many", slug: "one-too-many" },
        headers: { "x-bootstrap-token": VALID_TOKEN },
      });

      assert.equal(limited.status, 429, limited.raw);
      assert.equal(limited.body.error.code, "RATE_LIMITED");
      const retryAfter = Number(limited.headers.get("retry-after"));
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, "retry-after must be a positive number of seconds");
      assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
      assert.equal(limited.body.error.details?.retryAfterSeconds, retryAfter);
    } finally {
      await api.close();
    }
  });

  it("still provisions a workspace and returns the owner key exactly once", async () => {
    const api = await startApi();
    try {
      const created = await api.client().request<{
        workspace: { id: string; slug: string };
        apiKey: { key: string; id: string; role: string; scopes: string[] };
      }>("POST", BOOTSTRAP_PATH, {
        body: { name: "Bootstrap Clinic", slug: "bootstrap-clinic", plan: "community" },
        headers: { "x-bootstrap-token": VALID_TOKEN },
      });

      assert.equal(created.status, 201, created.raw);
      assert.equal(created.body.workspace.slug, "bootstrap-clinic");
      assert.match(created.body.apiKey.key, /^hb_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{40,64}$/);
      assert.equal(created.body.apiKey.role, "owner");

      // The plaintext key works, but is never returned again: `current` exposes the key metadata only.
      const current = await api.client(created.body.apiKey.key).request<{
        workspace: { id: string };
        key: { id: string; role: string; [field: string]: unknown };
      }>("GET", "/api/v1/workspaces/current");
      assert.equal(current.status, 200, current.raw);
      assert.equal(current.body.workspace.id, created.body.workspace.id);
      assert.equal(current.body.key.id, created.body.apiKey.id);
      assert.equal(current.body.key.role, "owner");
      assert.equal("key" in current.body.key, false, "the owner key is returned exactly once");
    } finally {
      await api.close();
    }
  });
});
