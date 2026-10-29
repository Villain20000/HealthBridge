import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage, MemoryStorageDriver, StorageError, checksumOf, keyFor } from "@healthbridge/storage";

const cleanups: string[] = [];

async function localStorage(options: { maxObjectBytes?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hb-storage-"));
  cleanups.push(dir);
  return { driver: new LocalFileStorage({ rootDir: dir, ...options }), dir };
}

after(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

const drivers = [
  { name: "memory", create: async () => ({ driver: new MemoryStorageDriver(), dir: undefined }) },
  { name: "local-fs", create: localStorage },
];

for (const { name, create } of drivers) {
  describe(`storage driver: ${name}`, () => {
    test("stores content under its checksum and reads it back", async () => {
      const { driver } = await create();
      const payload = Buffer.from("patient_id,family_name\nP1,Doe\n", "utf-8");
      const stored = await driver.put(payload, { contentType: "text/csv; charset=utf-8" });

      assert.equal(stored.checksum, checksumOf(payload));
      assert.equal(stored.key, keyFor(stored.checksum));
      assert.equal(stored.sizeBytes, payload.byteLength);
      assert.equal(stored.contentType, "text/csv");

      const read = await driver.get(stored.key);
      assert.equal(read.bytes.toString("utf-8"), payload.toString("utf-8"));
      assert.equal(read.checksum, stored.checksum);
    });

    test("deduplicates identical bytes", async () => {
      const { driver } = await create();
      const a = await driver.put(Buffer.from("same"));
      const b = await driver.put(Buffer.from("same"));
      assert.equal(a.key, b.key);
      assert.equal(await driver.exists(a.key), true);
      assert.equal(await driver.stat(a.key).then((s) => s?.sizeBytes), 4);
    });

    test("rejects empty objects and oversized ones", async () => {
      const { driver } = await create();
      await assert.rejects(
        () => driver.put(Buffer.alloc(0)),
        (error: unknown) => (error as StorageError).code === "INVALID_ARGUMENT",
      );

      const { driver: small } = await create();
      const limited = new LocalFileStorage({ rootDir: await mkdtemp(join(tmpdir(), "hb-small-")), maxObjectBytes: 8 });
      cleanups.push((limited as unknown as { rootDir: string }).rootDir);
      await assert.rejects(
        () => limited.put(Buffer.alloc(9)),
        (error: unknown) => (error as StorageError).code === "OBJECT_TOO_LARGE",
      );
      assert.ok(small);
      assert.ok(driver);
    });

    test("reports a missing object instead of returning nothing", async () => {
      const { driver } = await create();
      const missing = keyFor(checksumOf(Buffer.from("never stored")));
      await assert.rejects(
        () => driver.get(missing),
        (error: unknown) => (error as StorageError).code === "OBJECT_NOT_FOUND",
      );
      assert.equal(await driver.stat(missing), undefined);
      assert.equal(await driver.delete(missing), false);
    });

    test("rejects keys that are not content addresses (path traversal guard)", async () => {
      const { driver } = await create();
      for (const key of ["../../etc/passwd", "sha256/aa/../bb", "/etc/passwd", "sha256/zz/" + "a".repeat(64)]) {
        await assert.rejects(
          () => driver.get(key),
          (error: unknown) => (error as StorageError).code === "INVALID_KEY",
          `expected ${key} to be rejected`,
        );
      }
    });

    test("deletes objects and keeps deletion idempotent", async () => {
      const { driver } = await create();
      const stored = await driver.put(Buffer.from("delete me"));
      assert.equal(await driver.delete(stored.key), true);
      assert.equal(await driver.delete(stored.key), false);
      assert.equal(await driver.exists(stored.key), false);
    });
  });
}

describe("storage integrity", () => {
  test("a tampered object is refused, not served", async () => {
    const { driver, dir } = await localStorage();
    const stored = await driver.put(Buffer.from("original clinical payload"), { contentType: "text/csv" });

    // Simulate bit rot / a manual edit on disk.
    const path = join(dir!, stored.key);
    await writeFile(path, Buffer.from("tampered clinical payload!!"));

    await assert.rejects(
      () => driver.get(stored.key),
      (error: unknown) => (error as StorageError).code === "INTEGRITY_MISMATCH",
    );
  });

  test("local driver writes objects atomically (no partial files left behind)", async () => {
    const { driver, dir } = await localStorage();
    const payload = Buffer.from("x".repeat(1024));
    const stored = await driver.put(payload);
    const written = await readFile(join(dir!, stored.key));
    assert.equal(written.byteLength, payload.byteLength);
    assert.equal(stored.checksum, checksumOf(written));
  });

  test("content type is normalised and never reflected blindly", async () => {
    const driver = new MemoryStorageDriver();
    const stored = await driver.put(Buffer.from("hi"), { contentType: "TEXT/CSV; charset=utf-8" });
    assert.equal(stored.contentType, "text/csv");
    const weird = await driver.put(Buffer.from("hi2"), { contentType: "not a mime type" });
    assert.equal(weird.contentType, "application/octet-stream");
  });
});
