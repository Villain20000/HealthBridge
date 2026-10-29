import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiKeyService,
  InMemoryApiKeyStore,
  ROLE_SCOPES,
  TokenBucketRateLimiter,
  normaliseScopes,
} from "@healthbridge/auth";

const pepper = "test-pepper-at-least-16-chars";

function service(overrides: Partial<ConstructorParameters<typeof ApiKeyService>[0]> = {}) {
  const store = overrides.store ?? new InMemoryApiKeyStore();
  const svc = new ApiKeyService({ pepper, store, ...overrides });
  return { svc, store };
}

describe("api keys", () => {
  test("issues a prefixed key and never stores the secret", async () => {
    const { svc, store } = service();
    const issued = await svc.issue({ workspaceId: "ws_1", name: "CI pipeline", role: "editor" });
    const secret = issued.key.split("_").slice(2).join("_");

    assert.match(issued.key, /^hb_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{40,64}$/);
    assert.equal(issued.record.prefix, issued.key.split("_")[1]);
    assert.ok(!JSON.stringify(issued.record).includes(secret));
    assert.equal(issued.record.workspaceId, "ws_1");
    assert.deepEqual([...issued.record.scopes].sort(), [...ROLE_SCOPES.editor].sort());

    const stored = await store.findByPrefix(issued.record.prefix);
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(secret));
  });

  test("authenticates a valid key and reports the workspace and scopes", async () => {
    const { svc } = service();
    const issued = await svc.issue({ workspaceId: "ws_1", name: "worker", role: "service" });
    const result = await svc.authenticate(issued.key, "runs:write");

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.principal.workspaceId, "ws_1");
    assert.equal(result.principal.apiKeyId, issued.record.id);
    assert.equal(result.principal.role, "service");
  });

  test("distinguishes missing, malformed, unknown, revoked and expired keys", async () => {
    const { svc } = service({ defaultTtlDays: 1 });
    const issued = await svc.issue({ workspaceId: "ws_1", name: "k", role: "viewer" });

    const missing = await svc.authenticate(undefined);
    const malformed = await svc.authenticate("nonsense");
    const unknown = await svc.authenticate("hb_aaaaaaaaaaaa_" + "x".repeat(43));

    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "MISSING_CREDENTIALS");
    if (!malformed.ok) assert.equal(malformed.code, "MALFORMED_KEY");
    if (!unknown.ok) assert.equal(unknown.code, "UNKNOWN_KEY");

    await svc.revoke(issued.record.id, "ws_1");
    const revoked = await svc.authenticate(issued.key);
    if (!revoked.ok) assert.equal(revoked.code, "REVOKED_KEY");

    // Expiry is decided against the injected clock, not the wall clock.
    let clock = new Date("2024-01-01T00:00:00.000Z");
    const timed = new ApiKeyService({
      pepper,
      store: new InMemoryApiKeyStore(),
      now: () => clock,
      defaultTtlDays: 30,
    });
    const expiring = await timed.issue({ workspaceId: "ws_2", name: "short", role: "viewer" });
    assert.equal((await timed.authenticate(expiring.key)).ok, true);
    clock = new Date("2024-03-01T00:00:00.000Z");
    const expired = await timed.authenticate(expiring.key);
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.code, "EXPIRED_KEY");
  });

  test("enforces scopes separately from validity (403 vs 401)", async () => {
    const { svc } = service();
    const viewer = await svc.issue({ workspaceId: "ws_1", name: "viewer", role: "viewer" });

    const read = await svc.authenticate(viewer.key, "runs:read");
    assert.equal(read.ok, true);

    const write = await svc.authenticate(viewer.key, "runs:write");
    assert.equal(write.ok, false);
    if (!write.ok) {
      assert.equal(write.code, "INSUFFICIENT_SCOPE");
      assert.equal(write.requiredScope, "runs:write");
    }
  });

  test("validate requested scopes against the role", async () => {
    assert.throws(() => normaliseScopes("viewer", ["runs:write"]), /cannot be granted/);
    assert.throws(() => normaliseScopes("owner", ["runs:nuke" as never]), /Unknown scope/);
    assert.deepEqual(normaliseScopes("viewer", ["runs:read"]), ["runs:read"]);
  });

  test("rotating a key revokes the old one and keeps scope/expiry", async () => {
    const { svc } = service();
    const issued = await svc.issue({
      workspaceId: "ws_1",
      name: "rotating",
      role: "editor",
      scopes: ["runs:read", "runs:write"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const rotated = await svc.rotate(issued.record.id, "ws_1");
    assert.ok(rotated);
    assert.notEqual(rotated.key, issued.key);
    assert.deepEqual(rotated.record.scopes, ["runs:read", "runs:write"]);
    assert.equal(rotated.record.expiresAt, "2030-01-01T00:00:00.000Z");

    assert.equal((await svc.authenticate(issued.key)).ok, false);
    assert.equal((await svc.authenticate(rotated.key)).ok, true);
  });

  test("tenant isolation: revoke and rotate are scoped to the owning workspace", async () => {
    const { svc } = service();
    const issued = await svc.issue({ workspaceId: "ws_1", name: "k", role: "editor" });

    assert.equal(await svc.revoke(issued.record.id, "ws_other"), undefined);
    assert.equal(await svc.rotate(issued.record.id, "ws_other"), undefined);
    assert.equal((await svc.authenticate(issued.key)).ok, true, "key must still work");

    assert.equal((await svc.list("ws_other")).length, 0);
    const mine = await svc.list("ws_1");
    assert.equal(mine.length, 1);
    assert.ok(!("secretHash" in mine[0]), "listings must not expose hashes");
  });

  test("a different pepper invalidates existing keys", async () => {
    const store = new InMemoryApiKeyStore();
    const issued = await service({ store }).svc.issue({ workspaceId: "ws_1", name: "k", role: "viewer" });
    const other = new ApiKeyService({ pepper: "another-pepper-16+chars", store });
    const result = await other.authenticate(issued.key);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNKNOWN_KEY");
  });

  test("records last usage without touching the secret", async () => {
    let clock = new Date("2024-05-01T00:00:00.000Z");
    const { svc, store } = service({ now: () => clock });
    const issued = await svc.issue({ workspaceId: "ws_1", name: "k", role: "viewer" });
    clock = new Date("2024-05-02T00:00:00.000Z");
    await svc.authenticate(issued.key);
    const record = await store.findById(issued.record.id);
    assert.equal(record?.lastUsedAt, "2024-05-02T00:00:00.000Z");
    assert.equal(record?.secretHash, issued.record.secretHash);
  });

  test("refuses a weak pepper", () => {
    assert.throws(() => new ApiKeyService({ pepper: "short", store: new InMemoryApiKeyStore() }), /at least 16/);
  });
});

describe("rate limiting", () => {
  test("allows a burst, then refuses with a retry hint, then refills", () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => clock });

    assert.equal(limiter.consume("key-a").allowed, true);
    assert.equal(limiter.consume("key-a").allowed, true);
    const third = limiter.consume("key-a");
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const blocked = limiter.consume("key-a");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 1);
    assert.equal(blocked.limit, 3);

    clock += 1000;
    const refilled = limiter.consume("key-a");
    assert.equal(refilled.allowed, true);
  });

  test("buckets are isolated per key", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 0 });
    assert.equal(limiter.consume("a").allowed, true);
    assert.equal(limiter.consume("a").allowed, false);
    assert.equal(limiter.consume("b").allowed, true);
  });

  test("never exceeds capacity when idle for a long time", () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 10, now: () => clock });
    limiter.consume("k");
    clock += 60_000;
    assert.equal(limiter.consume("k").remaining, 1);
    assert.equal(limiter.consume("k").remaining, 0);
    assert.equal(limiter.consume("k").allowed, false);
  });
});
