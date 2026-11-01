import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppContext } from "../src/app.context.js";
import { ConfigError, loadConfig, loadTestConfig } from "../src/config.js";

const S3_ENV_KEYS = [
  "HEALTHBRIDGE_S3_ENDPOINT",
  "HEALTHBRIDGE_S3_BUCKET",
  "HEALTHBRIDGE_S3_REGION",
  "HEALTHBRIDGE_S3_FORCE_PATH_STYLE",
  "HEALTHBRIDGE_S3_ACCESS_KEY_ID",
  "HEALTHBRIDGE_S3_SECRET_ACCESS_KEY",
  "HEALTHBRIDGE_S3_SESSION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;

function snapshotS3Env(): Partial<Record<(typeof S3_ENV_KEYS)[number], string | undefined>> {
  const snapshot: Partial<Record<(typeof S3_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of S3_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreS3Env(snapshot: Partial<Record<(typeof S3_ENV_KEYS)[number], string | undefined>>): void {
  for (const key of S3_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function clearS3Env(): void {
  for (const key of S3_ENV_KEYS) delete process.env[key];
}

describe("storage driver selection", () => {
  it("selects the S3 driver when config.storage.s3 is present (no network)", async () => {
    const snapshot = snapshotS3Env();
    try {
      clearS3Env();
      process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID = "test-key-id";
      process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY = "test-secret";
      const config = loadTestConfig({
        storage: {
          rootDir: "",
          maxObjectBytes: 64 * 1024 * 1024,
          s3: {
            endpoint: "http://127.0.0.1:9",
            bucket: "healthbridge-test",
            region: "us-east-1",
            forcePathStyle: true,
          },
        },
      });
      const context = await createAppContext({ config });
      try {
        assert.equal(context.storage.name, "s3");
      } finally {
        await context.close();
      }
    } finally {
      restoreS3Env(snapshot);
    }
  });

  it("keeps the historical default when S3 is not configured", async () => {
    const snapshot = snapshotS3Env();
    try {
      clearS3Env();
      const testConfig = loadTestConfig();
      assert.equal(testConfig.storage.s3, undefined);
      const testContext = await createAppContext({ config: testConfig });
      try {
        assert.equal(testContext.storage.name, "memory");
      } finally {
        await testContext.close();
      }

      const localConfig = loadTestConfig({
        nodeEnv: "development",
        storage: { rootDir: "./.data/objects", maxObjectBytes: 64 * 1024 * 1024 },
      });
      const localContext = await createAppContext({ config: localConfig });
      try {
        assert.equal(localContext.storage.name, "local-fs");
      } finally {
        await localContext.close();
      }
    } finally {
      restoreS3Env(snapshot);
    }
  });

  it("still honours an explicit storage override", async () => {
    const snapshot = snapshotS3Env();
    try {
      clearS3Env();
      process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID = "test-key-id";
      process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY = "test-secret";
      const config = loadTestConfig({
        storage: {
          rootDir: "",
          maxObjectBytes: 64 * 1024 * 1024,
          s3: {
            endpoint: "http://127.0.0.1:9",
            bucket: "healthbridge-test",
            region: "us-east-1",
            forcePathStyle: true,
          },
        },
      });
      const { MemoryStorageDriver } = await import("@healthbridge/storage");
      const override = new MemoryStorageDriver({});
      const context = await createAppContext({ config, storage: override });
      try {
        assert.equal(context.storage, override);
      } finally {
        await context.close();
      }
    } finally {
      restoreS3Env(snapshot);
    }
  });

  it("refuses a half-configured endpoint/bucket pair at config load", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          HEALTHBRIDGE_S3_ENDPOINT: "http://127.0.0.1:9000",
        } as NodeJS.ProcessEnv),
      (error: unknown) =>
        error instanceof ConfigError && /HEALTHBRIDGE_S3_ENDPOINT and HEALTHBRIDGE_S3_BUCKET/.test(error.message),
    );
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "test",
          HEALTHBRIDGE_S3_BUCKET: "healthbridge-test",
        } as NodeJS.ProcessEnv),
      (error: unknown) =>
        error instanceof ConfigError && /HEALTHBRIDGE_S3_ENDPOINT and HEALTHBRIDGE_S3_BUCKET/.test(error.message),
    );
  });

  it("fails fast with ConfigError (never silent local fallback, never logged secrets) when S3 cannot be built", async () => {
    const snapshot = snapshotS3Env();
    const secret = "super-secret-should-never-appear-in-errors";
    try {
      clearS3Env();
      // Missing credentials: the driver cannot be constructed.
      const missingCreds = loadTestConfig({
        storage: {
          rootDir: "",
          maxObjectBytes: 64 * 1024 * 1024,
          s3: {
            endpoint: "http://127.0.0.1:9",
            bucket: "healthbridge-test",
            region: "us-east-1",
            forcePathStyle: true,
          },
        },
      });
      await assert.rejects(
        createAppContext({ config: missingCreds }),
        (error: unknown) =>
          error instanceof ConfigError && /S3 storage is configured but cannot be used/.test(error.message),
      );

      // Invalid bucket with credentials present: still ConfigError, and the
      // secret must not leak into the message.
      process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID = "test-key-id";
      process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY = secret;
      const badBucket = loadTestConfig({
        storage: {
          rootDir: "",
          maxObjectBytes: 64 * 1024 * 1024,
          s3: {
            endpoint: "http://127.0.0.1:9",
            bucket: "not a bucket",
            region: "us-east-1",
            forcePathStyle: true,
          },
        },
      });
      await assert.rejects(createAppContext({ config: badBucket }), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /S3 storage is configured but cannot be used/);
        assert.ok(!error.message.includes(secret), "error message must not contain the secret");
        return true;
      });
    } finally {
      restoreS3Env(snapshot);
    }
  });
});
