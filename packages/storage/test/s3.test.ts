import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage, checksumOf, keyFor } from "@healthbridge/storage";
import { S3StorageDriver, buildS3ObjectUrl, s3OptionsFromEnv, type S3StorageOptions } from "../src/s3.js";

/**
 * Offline tests for the S3 driver. No network, no credentials in the repo:
 * a loopback HTTP stub speaks just enough S3 (PUT/GET/HEAD/DELETE per key,
 * S3-style XML errors, S3's always-204 DELETE) and — importantly — verifies
 * the driver's SigV4 signature the way a real store would, using a test-only
 * secret that never leaves this file.
 */

const ACCESS_KEY_ID = "HBTESTACCESSKEY";
const SECRET_ACCESS_KEY = "HBTESTSECRET0123456789abcdef";
const BUCKET = "healthbridge-test-objects";

interface StubObject {
  bytes: Buffer;
  contentType: string;
  checksum?: string;
}

interface SeenRequest {
  method?: string;
  path?: string;
  authorization?: string;
}

interface S3Stub {
  url: string;
  objects: Map<string, StubObject>;
  seen: SeenRequest[];
  close: () => Promise<void>;
}

function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function xmlError(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function sendXml(res: ServerResponse, status: number, xml: string): void {
  const body = Buffer.from(xml, "utf-8");
  res.writeHead(status, { "content-type": "application/xml", "content-length": body.byteLength });
  res.end(body);
}

/** Recompute the SigV4 signature over what actually arrived, like S3 does. */
function checkAuth(req: IncomingMessage, body: Buffer): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return "MissingAuthentication";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!match) return "MalformedAuthentication";
  const [, accessKeyId, dateStamp, region, signedList, signature] = match;
  if (accessKeyId !== ACCESS_KEY_ID) return "InvalidAccessKeyId";
  const names = (signedList as string).split(";");
  const lines: string[] = [];
  for (const name of names) {
    const value = req.headers[name];
    if (value === undefined) return "MissingSignedHeader";
    lines.push(`${name}:${(Array.isArray(value) ? value.join(",") : value).trim()}`);
  }
  const payloadHash = sha256hex(body);
  if (req.headers["x-amz-content-sha256"] !== payloadHash) return "BadDigest";
  const canonicalUri = (req.url ?? "/").split("?")[0];
  const canonicalRequest = [
    req.method ?? "GET",
    canonicalUri,
    "",
    `${lines.join("\n")}\n`,
    signedList,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", req.headers["x-amz-date"], scope, sha256hex(canonicalRequest)].join("\n");
  let signingKey = createHmac("sha256", `AWS4${SECRET_ACCESS_KEY}`).update(dateStamp as string).digest();
  signingKey = createHmac("sha256", signingKey).update(region as string).digest();
  signingKey = createHmac("sha256", signingKey).update("s3").digest();
  signingKey = createHmac("sha256", signingKey).update("aws4_request").digest();
  const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return expected === signature ? null : "SignatureDoesNotMatch";
}

async function startS3Stub(): Promise<S3Stub> {
  const objects = new Map<string, StubObject>();
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.writeHead(500).end();
      } catch {
        // The test fails on the hanging request; nothing useful to do here.
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const authError = checkAuth(req, body);
    if (authError) {
      sendXml(res, 403, xmlError(authError, "The request signature we calculated does not match."));
      return;
    }
    const rawPath = (req.url ?? "/").split("?")[0] as string;
    const prefix = `/${BUCKET}/`;
    if (!rawPath.startsWith(prefix)) {
      sendXml(res, 404, xmlError("NoSuchBucket", "The specified bucket does not exist."));
      return;
    }
    const key = rawPath.slice(prefix.length);

    if (req.method === "PUT") {
      objects.set(key, {
        bytes: body,
        contentType: req.headers["content-type"] ?? "application/octet-stream",
        checksum: req.headers["x-amz-meta-checksum"],
      });
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      res.writeHead(200, { etag });
      res.end();
      return;
    }
    if (req.method === "GET") {
      const stored = objects.get(key);
      if (!stored) {
        sendXml(res, 404, xmlError("NoSuchKey", "The specified key does not exist."));
        return;
      }
      const headers: Record<string, string> = {
        "content-type": stored.contentType,
        "content-length": String(stored.bytes.byteLength),
        etag: `"${createHash("md5").update(stored.bytes).digest("hex")}"`,
      };
      if (stored.checksum) headers["x-amz-meta-checksum"] = stored.checksum;
      res.writeHead(200, headers);
      res.end(stored.bytes);
      return;
    }
    if (req.method === "HEAD") {
      const stored = objects.get(key);
      if (!stored) {
        res.writeHead(404);
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        "content-type": stored.contentType,
        "content-length": String(stored.bytes.byteLength),
      };
      if (stored.checksum) headers["x-amz-meta-checksum"] = stored.checksum;
      res.writeHead(200, headers);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      // Real S3 is idempotent here: 204 whether or not the key existed.
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    sendXml(res, 400, xmlError("NotImplemented", `The stub does not implement ${req.method}.`));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

let stub: S3Stub;
const tempDirs: string[] = [];

before(async () => {
  stub = await startS3Stub();
});

after(async () => {
  await stub?.close();
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function makeDriver(overrides: Partial<S3StorageOptions> = {}): S3StorageDriver {
  return new S3StorageDriver({
    endpoint: stub.url,
    bucket: BUCKET,
    region: "eu-west-1",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    forcePathStyle: true,
    ...overrides,
  });
}

describe("s3OptionsFromEnv", () => {
  test("returns undefined when S3 is not configured", () => {
    assert.equal(s3OptionsFromEnv({} as NodeJS.ProcessEnv), undefined);
  });

  test("refuses a half-configured endpoint/bucket pair", () => {
    assert.throws(
      () => s3OptionsFromEnv({ HEALTHBRIDGE_S3_ENDPOINT: "http://localhost:9000" } as NodeJS.ProcessEnv),
      /HEALTHBRIDGE_S3_ENDPOINT and HEALTHBRIDGE_S3_BUCKET must be set together/,
    );
  });

  test("parses the full configuration with safe defaults", () => {
    const options = s3OptionsFromEnv({
      HEALTHBRIDGE_S3_ENDPOINT: "http://localhost:9000",
      HEALTHBRIDGE_S3_BUCKET: "records",
    } as NodeJS.ProcessEnv);
    assert.equal(options?.endpoint, "http://localhost:9000");
    assert.equal(options?.bucket, "records");
    assert.equal(options?.region, "us-east-1");
    assert.equal(options?.forcePathStyle, true);
  });

  test("honours explicit region and path-style opt-out", () => {
    const options = s3OptionsFromEnv({
      HEALTHBRIDGE_S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com",
      HEALTHBRIDGE_S3_BUCKET: "records",
      HEALTHBRIDGE_S3_REGION: "eu-west-1",
      HEALTHBRIDGE_S3_FORCE_PATH_STYLE: "false",
      HEALTHBRIDGE_S3_ACCESS_KEY_ID: "key",
      HEALTHBRIDGE_S3_SECRET_ACCESS_KEY: "secret",
    } as NodeJS.ProcessEnv);
    assert.equal(options?.region, "eu-west-1");
    assert.equal(options?.forcePathStyle, false);
    assert.equal(options?.accessKeyId, "key");
  });
});

describe("buildS3ObjectUrl", () => {
  const key = `sha256/ab/${"c".repeat(64)}`;

  test("builds path-style URLs for S3-compatible endpoints", () => {
    const { url, canonicalUri } = buildS3ObjectUrl("http://127.0.0.1:9000", "records", key, true);
    assert.equal(url.href, `http://127.0.0.1:9000/records/${key}`);
    assert.equal(canonicalUri, `/records/${key}`);
  });

  test("builds virtual-hosted URLs for AWS", () => {
    const { url, canonicalUri } = buildS3ObjectUrl("https://s3.eu-west-1.amazonaws.com", "records", key, false);
    assert.equal(url.href, `https://records.s3.eu-west-1.amazonaws.com/${key}`);
    assert.equal(canonicalUri, `/${key}`);
  });
});

describe("S3StorageDriver constructor", () => {
  test("rejects bad endpoints, buckets and missing credentials", () => {
    const base = { bucket: BUCKET, accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY };
    assert.throws(() => makeDriver({ endpoint: "not a url" }), /Invalid S3 endpoint URL/);
    assert.throws(() => makeDriver({ endpoint: "ftp://host/x" }), /must use http\(s\)/);
    assert.throws(() => makeDriver({ bucket: "has/slash" }), /Invalid S3 bucket name/);
    assert.throws(
      () =>
        new S3StorageDriver({
          endpoint: stub.url,
          ...base,
          accessKeyId: "",
          secretAccessKey: "",
        } as S3StorageOptions),
      /credentials are required/,
    );
  });

  test("resolves credentials from the environment when omitted", async () => {
    const savedAccess = process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID;
    const savedSecret = process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY;
    process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY = SECRET_ACCESS_KEY;
    try {
      const driver = new S3StorageDriver({ endpoint: stub.url, bucket: BUCKET, region: "eu-west-1", forcePathStyle: true });
      const stored = await driver.put(Buffer.from("env credentials payload"));
      assert.equal((await driver.get(stored.key)).bytes.toString("utf-8"), "env credentials payload");
    } finally {
      if (savedAccess === undefined) delete process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID;
      else process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID = savedAccess;
      if (savedSecret === undefined) delete process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY;
      else process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY = savedSecret;
    }
  });
});

describe("S3StorageDriver contract", () => {
  test("stores content under its checksum and reads it back", async () => {
    const driver = makeDriver();
    const payload = Buffer.from("patient_id,family_name\nP1,Doe\n", "utf-8");
    const stored = await driver.put(payload, { contentType: "text/csv; charset=utf-8" });

    assert.equal(stored.checksum, checksumOf(payload));
    assert.equal(stored.key, keyFor(stored.checksum));
    assert.equal(stored.sizeBytes, payload.byteLength);
    assert.equal(stored.contentType, "text/csv");

    const read = await driver.get(stored.key);
    assert.equal(read.bytes.toString("utf-8"), payload.toString("utf-8"));
    assert.equal(read.checksum, stored.checksum);
    assert.equal(read.contentType, "text/csv");
  });

  test("uses the same content-addressed key layout as LocalFileStorage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-s3-layout-"));
    tempDirs.push(dir);
    const local = new LocalFileStorage({ rootDir: dir });
    const payload = Buffer.from("same clinical bytes");

    const viaS3 = await makeDriver().put(payload);
    const viaLocal = await local.put(payload);
    assert.equal(viaS3.key, viaLocal.key);
    assert.equal(viaS3.checksum, viaLocal.checksum);
  });

  test("deduplicates identical bytes without re-uploading", async () => {
    const driver = makeDriver();
    const putsBefore = stub.seen.filter((request) => request.method === "PUT").length;
    const first = await driver.put(Buffer.from("same"));
    const second = await driver.put(Buffer.from("same"), { contentType: "text/other" });
    assert.equal(first.key, second.key);
    assert.equal(second.contentType, first.contentType);
    assert.equal(
      stub.seen.filter((request) => request.method === "PUT").length,
      putsBefore + 1,
    );
    assert.equal(await driver.exists(first.key), true);
  });

  test("rejects empty objects and oversized ones", async () => {
    await assert.rejects(makeDriver().put(Buffer.alloc(0)), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_ARGUMENT");
      return true;
    });
    const small = makeDriver({ maxObjectBytes: 8 });
    await assert.rejects(small.put(Buffer.alloc(9)), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "OBJECT_TOO_LARGE");
      return true;
    });
  });

  test("reports a missing object instead of returning nothing", async () => {
    const driver = makeDriver();
    const missing = keyFor(checksumOf(Buffer.from("never stored via s3")));
    await assert.rejects(driver.get(missing), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "OBJECT_NOT_FOUND");
      return true;
    });
    assert.equal(await driver.stat(missing), undefined);
    assert.equal(await driver.exists(missing), false);
    assert.equal(await driver.delete(missing), false);
  });

  test("rejects keys that are not content addresses (path traversal guard)", async () => {
    const driver = makeDriver();
    for (const key of ["../../etc/passwd", "sha256/aa/../bb", "/etc/passwd", `sha256/zz/${"a".repeat(64)}`]) {
      for (const operation of ["get", "stat", "delete", "exists"] as const) {
        await assert.rejects(driver[operation](key), (error: unknown) => {
          assert.equal((error as { code?: string }).code, "INVALID_KEY");
          return true;
        }, `expected ${operation}(${key}) to be rejected`);
      }
    }
  });

  test("deletes objects and keeps deletion idempotent", async () => {
    const driver = makeDriver();
    const stored = await driver.put(Buffer.from("delete me via s3"));
    assert.equal(await driver.delete(stored.key), true);
    assert.equal(await driver.delete(stored.key), false);
    assert.equal(await driver.exists(stored.key), false);
  });

  test("a tampered object is refused, not served", async () => {
    const driver = makeDriver();
    const stored = await driver.put(Buffer.from("original s3 payload"), { contentType: "text/csv" });

    stub.objects.get(stored.key)!.bytes = Buffer.from("tampered s3 payload!!!");
    await assert.rejects(driver.get(stored.key), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INTEGRITY_MISMATCH");
      return true;
    });
  });

  test("an object that lost its checksum metadata is refused", async () => {
    const driver = makeDriver();
    const stored = await driver.put(Buffer.from("s3 payload without metadata one day"));
    delete stub.objects.get(stored.key)!.checksum;

    await assert.rejects(driver.get(stored.key), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INTEGRITY_MISMATCH");
      return true;
    });
  });

  test("a bad signature is rejected instead of silently succeeding", async () => {
    const driver = makeDriver({ secretAccessKey: "wrong-secret" });
    // put() probes with HEAD first, and HEAD responses carry no body by HTTP
    // semantics, so assert on the status plus the credentials hint.
    await assert.rejects(driver.put(Buffer.from("will not be stored")), /failed with status 403.*access key/);
    await assert.rejects(driver.get(keyFor(checksumOf(Buffer.from("x")))), /failed with status 403/);
  });

  test("every request carries an Authorization header", async () => {
    const driver = makeDriver();
    const seenBefore = stub.seen.length;
    const stored = await driver.put(Buffer.from("signed traffic"));
    await driver.get(stored.key);
    const fresh = stub.seen.slice(seenBefore);
    assert.ok(fresh.length > 0);
    for (const request of fresh) {
      assert.match(request.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=/);
    }
  });

  test("content type is normalised and never reflected blindly", async () => {
    const driver = makeDriver();
    const stored = await driver.put(Buffer.from("typed"), { contentType: "TEXT/CSV; charset=utf-8" });
    assert.equal(stored.contentType, "text/csv");
    assert.equal((await driver.get(stored.key)).contentType, "text/csv");
    const weird = await driver.put(Buffer.from("typed2"), { contentType: "not a mime type" });
    assert.equal(weird.contentType, "application/octet-stream");
  });
});
