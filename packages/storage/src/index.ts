import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Content-addressed object storage.
 *
 * Keys are derived from the object's SHA-256, so storing the same file twice is
 * free and an object's identity is verifiable. Keys never contain user input:
 * that removes path traversal as a class of bug rather than filtering for it.
 *
 * Tenant scoping lives one level up (the asset repository), because the same
 * bytes may legitimately be referenced by several workspaces; sharing blobs is
 * safe precisely because the key is a hash, while access is always authorised
 * against a tenant-scoped metadata row.
 */

export type StorageErrorCode =
  "OBJECT_TOO_LARGE" | "OBJECT_NOT_FOUND" | "INTEGRITY_MISMATCH" | "INVALID_KEY" | "INVALID_ARGUMENT";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface StorageObject {
  key: string;
  checksum: string;
  sizeBytes: number;
  contentType: string;
}

export interface StoredObject extends StorageObject {
  bytes: Buffer;
}

export interface PutOptions {
  contentType?: string;
}

export interface StorageDriver {
  readonly name: string;
  put(data: Buffer | Uint8Array, options?: PutOptions): Promise<StorageObject>;
  get(key: string): Promise<StoredObject>;
  stat(key: string): Promise<StorageObject | undefined>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function checksumOf(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function keyFor(checksum: string): string {
  const hex = checksum.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new StorageError("INVALID_ARGUMENT", "checksum must be a sha256 hex digest");
  return `sha256/${hex.slice(0, 2)}/${hex}`;
}

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new StorageError("INVALID_KEY", `Invalid storage key: ${key}`);
  }
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

export class MemoryStorageDriver implements StorageDriver {
  public readonly name = "memory";
  private readonly objects = new Map<string, StoredObject>();
  private readonly maxObjectBytes: number;

  constructor(options: { maxObjectBytes?: number } = {}) {
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  public async put(data: Buffer | Uint8Array, options: PutOptions = {}): Promise<StorageObject> {
    const bytes = Buffer.from(data);
    assertSize(bytes, this.maxObjectBytes);
    const checksum = checksumOf(bytes);
    const key = keyFor(checksum);
    const existing = this.objects.get(key);
    if (existing) return toMetadata(existing);

    this.objects.set(key, {
      key,
      checksum,
      sizeBytes: bytes.byteLength,
      contentType: normaliseContentType(options.contentType),
      bytes,
    });
    return toMetadata(this.objects.get(key)!);
  }

  public async get(key: string): Promise<StoredObject> {
    assertValidKey(key);
    const stored = this.objects.get(key);
    if (!stored) throw new StorageError("OBJECT_NOT_FOUND", `No object stored under ${key}`);
    return { ...stored, bytes: Buffer.from(stored.bytes) };
  }

  public async stat(key: string): Promise<StorageObject | undefined> {
    assertValidKey(key);
    const stored = this.objects.get(key);
    return stored ? toMetadata(stored) : undefined;
  }

  public async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.objects.delete(key);
  }

  public async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.objects.has(key);
  }

  public get size(): number {
    return this.objects.size;
  }
}

export interface LocalFileStorageOptions {
  rootDir: string;
  maxObjectBytes?: number;
}

export class LocalFileStorage implements StorageDriver {
  public readonly name = "local-fs";
  private readonly rootDir: string;
  private readonly maxObjectBytes: number;

  constructor(options: LocalFileStorageOptions) {
    if (!options.rootDir) throw new Error("rootDir is required");
    this.rootDir = resolve(options.rootDir);
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  public async put(data: Buffer | Uint8Array, options: PutOptions = {}): Promise<StorageObject> {
    const bytes = Buffer.from(data);
    assertSize(bytes, this.maxObjectBytes);

    const checksum = checksumOf(bytes);
    const key = keyFor(checksum);
    const target = this.pathFor(key);
    const meta = target + ".meta.json";

    if (await this.exists(key)) return (await this.stat(key))!;

    await mkdir(dirname(target), { recursive: true });
    // Write to a temp file and rename: readers never see a partially written object.
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    await writeFile(
      meta,
      JSON.stringify({ contentType: normaliseContentType(options.contentType), checksum, sizeBytes: bytes.byteLength }),
      "utf-8",
    );

    return { key, checksum, sizeBytes: bytes.byteLength, contentType: normaliseContentType(options.contentType) };
  }

  public async get(key: string): Promise<StoredObject> {
    assertValidKey(key);
    const target = this.pathFor(key);
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      throw new StorageError("OBJECT_NOT_FOUND", `No object stored under ${key}`);
    }

    const metadata = await this.readMeta(target);
    const actual = checksumOf(bytes);
    if (actual !== metadata.checksum) {
      // Bit rot, a truncated copy or a partial restore: never serve corrupted bytes.
      throw new StorageError(
        "INTEGRITY_MISMATCH",
        `Object ${key} is corrupted: expected ${metadata.checksum}, found ${actual}.`,
      );
    }

    return { key, checksum: actual, sizeBytes: bytes.byteLength, contentType: metadata.contentType, bytes };
  }

  public async stat(key: string): Promise<StorageObject | undefined> {
    assertValidKey(key);
    const target = this.pathFor(key);
    try {
      const info = await stat(target);
      const metadata = await this.readMeta(target);
      return { key, checksum: metadata.checksum, sizeBytes: info.size, contentType: metadata.contentType };
    } catch {
      return undefined;
    }
  }

  public async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    const target = this.pathFor(key);
    const existed = await this.exists(key);
    await rm(target, { force: true });
    await rm(target + ".meta.json", { force: true });
    return existed;
  }

  public async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private async readMeta(target: string): Promise<{ checksum: string; contentType: string }> {
    try {
      const raw = JSON.parse(await readFile(target + ".meta.json", "utf-8")) as {
        checksum: string;
        contentType: string;
      };
      return { checksum: raw.checksum, contentType: raw.contentType };
    } catch {
      throw new StorageError("INTEGRITY_MISMATCH", `Missing metadata for ${target}`);
    }
  }

  /** Keys are validated against a strict pattern, so this cannot escape rootDir. */
  private pathFor(key: string): string {
    assertValidKey(key);
    const path = join(this.rootDir, key);
    const root = this.rootDir.endsWith(sep) ? this.rootDir : this.rootDir + sep;
    if (!path.startsWith(root)) throw new StorageError("INVALID_KEY", `Key escapes the storage root: ${key}`);
    return path;
  }
}

function normaliseContentType(value?: string): string {
  if (!value) return "application/octet-stream";
  const trimmed = value.split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(trimmed)) return "application/octet-stream";
  return trimmed;
}

function toMetadata(object: StoredObject): StorageObject {
  return {
    key: object.key,
    checksum: object.checksum,
    sizeBytes: object.sizeBytes,
    contentType: object.contentType,
  };
}
