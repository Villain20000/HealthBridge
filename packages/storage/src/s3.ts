import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type ClientRequestArgs } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  assertValidKey,
  checksumOf,
  DEFAULT_MAX_OBJECT_BYTES,
  keyFor,
  StorageError,
  type PutOptions,
  type StorageDriver,
  type StorageObject,
  type StoredObject,
} from "./index.js";

/**
 * S3-compatible content-addressed object storage.
 *
 * The driver speaks plain S3 over HTTP/HTTPS with AWS Signature Version 4
 * signed in-file (Node built-ins only, no new dependencies), so it works
 * against AWS S3 and S3-compatible stores (MinIO, LocalStack, …).
 *
 * Key layout is identical to {@link LocalFileStorage}: the storage key is
 * `sha256/<first-2-hex>/<full-64-hex>` derived from the object's SHA-256, and
 * the same string is used as the S3 object key (no prefix). Objects are
 * verified on read: the checksum travels as the `x-amz-meta-checksum`
 * user-metadata header and `get` refuses bytes that do not match it with
 * `INTEGRITY_MISMATCH`, exactly like the local driver refuses tampered files.
 *
 * Security: credentials are held in memory only, never logged, and travel
 * only in the SigV4 `Authorization` header. There is no fallback to unsigned
 * or query-string (`presigned-URL`) authentication.
 */

export interface S3StorageOptions {
  /** Base URL of the S3 endpoint, e.g. `https://s3.eu-west-1.amazonaws.com` or `http://127.0.0.1:9000`. */
  endpoint: string;
  /** Bucket that holds the objects. It must already exist; the driver never creates buckets. */
  bucket: string;
  /** Signing region, e.g. `eu-west-1`. S3-compatible stores accept any non-empty value. */
  region?: string;
  /** Falls back to `HEALTHBRIDGE_S3_ACCESS_KEY_ID` then `AWS_ACCESS_KEY_ID`. */
  accessKeyId?: string;
  /** Falls back to `HEALTHBRIDGE_S3_SECRET_ACCESS_KEY` then `AWS_SECRET_ACCESS_KEY`. Never logged. */
  secretAccessKey?: string;
  /** Optional session token; falls back to `HEALTHBRIDGE_S3_SESSION_TOKEN` then `AWS_SESSION_TOKEN`. */
  sessionToken?: string;
  /**
   * Address objects as `<endpoint>/<bucket>/<key>` instead of
   * `<bucket>.<endpoint>/<key>`. Required by most S3-compatible stores;
   * defaults to `false` (the AWS virtual-hosted standard).
   */
  forcePathStyle?: boolean;
  maxObjectBytes?: number;
  /** Per-request timeout in milliseconds. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

interface ResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface S3Response {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

const META_CHECKSUM_HEADER = "x-amz-meta-checksum";
const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EMPTY_SHA256_HEX = createHash("sha256").update("").digest("hex");
const DEFAULT_REGION = "us-east-1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class S3StorageDriver implements StorageDriver {
  public readonly name = "s3";
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: ResolvedCredentials;
  private readonly forcePathStyle: boolean;
  private readonly maxObjectBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(options: S3StorageOptions) {
    if (!options.endpoint) throw new Error("S3 endpoint is required");
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new Error(`Invalid S3 endpoint URL: ${options.endpoint}`);
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error(`S3 endpoint must use http(s): ${options.endpoint}`);
    }
    if (!options.bucket || options.bucket.includes("/") || /\s/.test(options.bucket)) {
      throw new Error(`Invalid S3 bucket name: ${options.bucket}`);
    }
    const region = options.region?.trim() || DEFAULT_REGION;
    const accessKeyId =
      options.accessKeyId ?? process.env.HEALTHBRIDGE_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "";
    const secretAccessKey =
      options.secretAccessKey ??
      process.env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY ??
      process.env.AWS_SECRET_ACCESS_KEY ??
      "";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "S3 credentials are required: pass accessKeyId/secretAccessKey or set " +
          "HEALTHBRIDGE_S3_ACCESS_KEY_ID/HEALTHBRIDGE_S3_SECRET_ACCESS_KEY (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY work too)",
      );
    }
    const sessionToken =
      options.sessionToken ?? process.env.HEALTHBRIDGE_S3_SESSION_TOKEN ?? process.env.AWS_SESSION_TOKEN;
    if (
      options.maxObjectBytes !== undefined &&
      (!Number.isFinite(options.maxObjectBytes) || options.maxObjectBytes <= 0)
    ) {
      throw new Error("maxObjectBytes must be a positive number");
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new Error("requestTimeoutMs must be a positive number");
    }

    this.endpoint = endpoint;
    this.bucket = options.bucket;
    this.region = region;
    this.credentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    this.forcePathStyle = options.forcePathStyle ?? false;
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public async put(data: Buffer | Uint8Array, options: PutOptions = {}): Promise<StorageObject> {
    const bytes = Buffer.from(data);
    assertSize(bytes, this.maxObjectBytes);

    const checksum = checksumOf(bytes);
    const key = keyFor(checksum);
    const contentType = normaliseContentType(options.contentType);

    // Same bytes hash to the same key, so a second upload is a no-op and the
    // first write's content type wins — exactly like LocalFileStorage.
    const existing = await this.stat(key);
    if (existing) return existing;

    const response = await this.sendRequest("PUT", key, bytes, {
      "content-type": contentType,
      [META_CHECKSUM_HEADER]: checksum,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw unexpectedStatus("PUT", key, response);
    }
    return { key, checksum, sizeBytes: bytes.byteLength, contentType };
  }

  public async get(key: string): Promise<StoredObject> {
    assertValidKey(key);
    const response = await this.sendRequest("GET", key);
    if (response.statusCode === 404) {
      throw new StorageError("OBJECT_NOT_FOUND", `No object stored under ${key}`);
    }
    if (response.statusCode !== 200) {
      throw unexpectedStatus("GET", key, response);
    }

    const storedChecksum = response.headers[META_CHECKSUM_HEADER];
    if (!storedChecksum || !CHECKSUM_PATTERN.test(storedChecksum)) {
      // Mirrors LocalFileStorage refusing objects whose sidecar metadata is gone.
      throw new StorageError("INTEGRITY_MISMATCH", `Object ${key} is missing its checksum metadata.`);
    }
    const actual = checksumOf(response.body);
    if (actual !== storedChecksum || keyFor(actual) !== key) {
      // Bit rot, a truncated copy or a partial restore: never serve corrupted bytes.
      throw new StorageError(
        "INTEGRITY_MISMATCH",
        `Object ${key} is corrupted: expected ${storedChecksum}, found ${actual}.`,
      );
    }
    return {
      key,
      checksum: actual,
      sizeBytes: response.body.byteLength,
      contentType: response.headers["content-type"]?.split(";")[0].trim().toLowerCase() || "application/octet-stream",
      bytes: response.body,
    };
  }

  public async stat(key: string): Promise<StorageObject | undefined> {
    assertValidKey(key);
    const response = await this.sendRequest("HEAD", key);
    if (response.statusCode === 404) return undefined;
    if (response.statusCode !== 200) {
      throw unexpectedStatus("HEAD", key, response);
    }
    const headerChecksum = response.headers[META_CHECKSUM_HEADER];
    // The key itself embeds the full digest, so a store that drops user
    // metadata still reports the content address; stored metadata wins when valid.
    const checksum = headerChecksum && CHECKSUM_PATTERN.test(headerChecksum) ? headerChecksum : keyToChecksum(key);
    const sizeBytes = Number(response.headers["content-length"]);
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`S3 HEAD ${key} returned an invalid Content-Length.`);
    }
    return {
      key,
      checksum,
      sizeBytes,
      contentType: response.headers["content-type"]?.split(";")[0].trim().toLowerCase() || "application/octet-stream",
    };
  }

  public async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    // S3 DELETE is idempotent (204 even when nothing existed), so check first
    // to preserve the driver's "true only when something was removed" contract.
    const existed = await this.exists(key);
    const response = await this.sendRequest("DELETE", key);
    if (response.statusCode === 404) return false;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw unexpectedStatus("DELETE", key, response);
    }
    return existed;
  }

  public async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    const response = await this.sendRequest("HEAD", key);
    if (response.statusCode === 404) return false;
    if (response.statusCode !== 200) {
      throw unexpectedStatus("HEAD", key, response);
    }
    return true;
  }

  private async sendRequest(
    method: string,
    objectKey: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<S3Response> {
    const { url, canonicalUri } = this.urlFor(objectKey);
    const payloadHash = body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256_HEX;
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = toDateStamp(now);

    const headerEntries: Array<[string, string]> = [
      ["host", url.host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", amzDate],
    ];
    if (this.credentials.sessionToken) {
      headerEntries.push(["x-amz-security-token", this.credentials.sessionToken]);
    }
    const signedHeaders = headerEntries.map(([name]) => name);
    const canonicalHeaders = signedHeaders
      .map((name) => `${name}:${headerEntries.find(([n]) => n === name)![1]}\n`)
      .join("");

    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders.join(";"), payloadHash].join(
      "\n",
    );
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const signingKey = hmacBytes(
      hmacBytes(hmacBytes(hmacBytes(`AWS4${this.credentials.secretAccessKey}`, dateStamp), this.region), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const headers: Record<string, string> = {
      ...extraHeaders,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
    };
    if (this.credentials.sessionToken) {
      headers["x-amz-security-token"] = this.credentials.sessionToken;
    }
    // A fixed length keeps the PUT a single plain (non-chunked) request, which
    // plain SigV4 covers; chunked streaming would need a streaming signature.
    if (body && body.byteLength > 0) {
      headers["content-length"] = String(body.byteLength);
    }

    const requestOptions: ClientRequestArgs = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: this.requestTimeoutMs,
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<S3Response>((resolve, reject) => {
      const request = send(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const flattened: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            flattened[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ statusCode: response.statusCode ?? 0, headers: flattened, body: Buffer.concat(chunks) });
        });
        response.on("error", reject);
      });
      request.on("timeout", () => {
        request.destroy(new Error(`S3 ${method} ${objectKey} timed out after ${this.requestTimeoutMs}ms.`));
      });
      request.on("error", reject);
      if (body && body.byteLength > 0) request.write(body);
      request.end();
    });
  }

  private urlFor(objectKey: string): { url: URL; canonicalUri: string } {
    return buildS3ObjectUrl(this.endpoint, this.bucket, objectKey, this.forcePathStyle);
  }
}

/**
 * Address an object under either URL style. Pure (no network), exported so the
 * addressing can be unit-tested without DNS: virtual-hosted style needs a
 * `<bucket>.<host>` name that never resolves on a loopback stub.
 */
export function buildS3ObjectUrl(
  endpoint: string | URL,
  bucket: string,
  objectKey: string,
  forcePathStyle: boolean,
): { url: URL; canonicalUri: string } {
  const base = typeof endpoint === "string" ? new URL(endpoint) : endpoint;
  const encodedKey = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  if (forcePathStyle) {
    const url = new URL(`${base.origin}${basePath}/${bucket}/${encodedKey}`);
    return { url, canonicalUri: `${basePath}/${bucket}/${encodedKey}` };
  }
  const port = base.port ? `:${base.port}` : "";
  const url = new URL(`${base.protocol}//${bucket}.${base.hostname}${port}${basePath}/${encodedKey}`);
  return { url, canonicalUri: `${basePath}/${encodedKey}` };
}

/**
 * Build driver options from the environment. Returns `undefined` when S3 is
 * not configured (no endpoint), so callers can fall back to another driver.
 * Throws a plain `Error` when the endpoint/bucket pair is half-configured.
 */
export function s3OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageOptions | undefined {
  const endpoint = (env.HEALTHBRIDGE_S3_ENDPOINT ?? "").trim();
  const bucket = (env.HEALTHBRIDGE_S3_BUCKET ?? "").trim();
  if (!endpoint && !bucket) return undefined;
  if (!endpoint || !bucket) {
    throw new Error("HEALTHBRIDGE_S3_ENDPOINT and HEALTHBRIDGE_S3_BUCKET must be set together");
  }
  const forcePathStyleRaw = (env.HEALTHBRIDGE_S3_FORCE_PATH_STYLE ?? "").trim().toLowerCase();
  return {
    endpoint,
    bucket,
    region: (env.HEALTHBRIDGE_S3_REGION ?? "").trim() || (env.AWS_REGION ?? "").trim() || DEFAULT_REGION,
    accessKeyId: (env.HEALTHBRIDGE_S3_ACCESS_KEY_ID ?? "").trim() || undefined,
    secretAccessKey: (env.HEALTHBRIDGE_S3_SECRET_ACCESS_KEY ?? "").trim() || undefined,
    sessionToken: (env.HEALTHBRIDGE_S3_SESSION_TOKEN ?? "").trim() || undefined,
    // A custom endpoint almost always means an S3-compatible store, where
    // path-style addressing is the interoperable default (it also works on AWS).
    forcePathStyle: forcePathStyleRaw === "" ? true : !["0", "false", "no"].includes(forcePathStyleRaw),
  };
}

function assertSize(bytes: Uint8Array, maxObjectBytes: number): void {
  if (bytes.byteLength > maxObjectBytes) {
    throw new StorageError(
      "OBJECT_TOO_LARGE",
      `Object is ${bytes.byteLength} bytes, which exceeds the ${maxObjectBytes}-byte limit.`,
    );
  }
  if (bytes.byteLength === 0) throw new StorageError("INVALID_ARGUMENT", "Refusing to store an empty object");
}

function normaliseContentType(value?: string): string {
  if (!value) return "application/octet-stream";
  const trimmed = value.split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(trimmed)) return "application/octet-stream";
  return trimmed;
}

function keyToChecksum(key: string): string {
  return `sha256:${key.split("/")[2]}`;
}

function unexpectedStatus(method: string, objectKey: string, response: S3Response): Error {
  const snippet = response.body.slice(0, 200).toString("utf-8").replace(/\s+/g, " ").trim();
  const hint = response.statusCode === 403 ? " Check the access key, secret, session token and region." : "";
  return new Error(
    `S3 ${method} ${objectKey} failed with status ${response.statusCode}${snippet ? `: ${snippet}` : "."}${hint}`,
  );
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function toDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function hmacBytes(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
