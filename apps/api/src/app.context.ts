import { Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { ApiKeyService, TokenBucketRateLimiter } from "@healthbridge/auth";
import {
  createMemoryRepositories,
  createMySqlRepositories,
  MySqlConnection,
  MySqlJobStore,
  type Repositories,
} from "@healthbridge/persistence";
import { LocalFileStorage, MemoryStorageDriver, S3StorageDriver, type StorageDriver } from "@healthbridge/storage";
import { ConfigError, type ApiConfig } from "./config.js";
import { BootstrapRateLimiter } from "./common/bootstrap-rate-limiter.js";
import { BullMqJobStore, createBullMqJobStore } from "./jobs/bullmq-queue.js";
import { RunQueue } from "./jobs/run-queue.js";
import { createRunWorker } from "./jobs/run-worker.js";
import { AuditService } from "./services/audit.service.js";
import { MappingPreviewService } from "./services/mapping-preview.service.js";
import { MappingStudioService } from "./services/mapping-studio.service.js";
import { RetentionService } from "./services/retention.service.js";
import { RunService } from "./services/run.service.js";

/**
 * The composition root: everything the API needs is built once here and injected
 * into controllers through a single provider. That keeps Nest's DI surface small
 * and makes the whole stack constructible in a test with in-memory repositories.
 */

export interface AppContext {
  config: ApiConfig;
  repos: Repositories;
  storage: StorageDriver;
  apiKeys: ApiKeyService;
  limiter: TokenBucketRateLimiter;
  /** Separate per-IP limiter for the public bootstrap endpoint. */
  bootstrapLimiter: BootstrapRateLimiter;
  queue: RunQueue;
  audit: AuditService;
  studio: MappingStudioService;
  preview: MappingPreviewService;
  runs: RunService;
  retention: RetentionService;
  startedAt: string;
  close(): Promise<void>;
}

export interface CreateContextOptions {
  config: ApiConfig;
  /** Override for tests: avoids touching the filesystem. */
  storage?: StorageDriver;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Select the storage driver. S3 wins when `config.storage.s3` is present
 * (credentials resolve inside the driver from `HEALTHBRIDGE_S3_*` / `AWS_*`,
 * the same precedence as `s3OptionsFromEnv`); otherwise the historical
 * local/memory default is returned unchanged. A requested-but-unbuildable S3
 * driver is a startup failure, never a silent fallback to local disk, and the
 * error carries no secrets.
 */
function createStorageDriver(config: ApiConfig, logger: Logger): StorageDriver {
  const s3 = config.storage.s3;
  if (!s3) {
    return config.nodeEnv === "test"
      ? new MemoryStorageDriver({ maxObjectBytes: config.limits.maxUploadBytes })
      : new LocalFileStorage({ rootDir: config.storage.rootDir, maxObjectBytes: config.limits.maxUploadBytes });
  }
  try {
    const driver = new S3StorageDriver({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      maxObjectBytes: config.limits.maxUploadBytes,
    });
    logger.log(`storage: s3 ${s3.endpoint}/${s3.bucket} (region ${s3.region})`);
    return driver;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`S3 storage is configured but cannot be used: ${reason}`);
  }
}

export async function createAppContext(options: CreateContextOptions): Promise<AppContext> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const logger = new Logger("AppContext");

  let repos: Repositories;
  let connection: MySqlConnection | undefined;
  if (config.database) {
    connection = await MySqlConnection.open(config.database);
    repos = await createMySqlRepositories(connection, {
      migrateOnStart: config.database.migrateOnStart,
      log: (message) => logger.log(message),
      now,
    });
    logger.log(`persistence: mysql ${config.database.host}/${config.database.database}`);
  } else {
    repos = createMemoryRepositories();
    logger.warn(
      "persistence: in-memory demo mode — data is lost on restart. Set DATABASE_URL and HEALTHBRIDGE_KEY_PEPPER for a durable deployment.",
    );
  }

  const storage = options.storage ?? createStorageDriver(config, logger);

  const apiKeys = new ApiKeyService({
    pepper: config.auth.pepper,
    store: repos.apiKeys,
    defaultTtlDays: config.auth.defaultTtlDays,
    recordUsage: config.auth.recordUsage,
    now,
  });

  const limiter = new TokenBucketRateLimiter({
    capacity: config.limits.rateLimit.capacity,
    refillPerSecond: config.limits.rateLimit.refillPerSecond,
  });

  const bootstrapLimiter = new BootstrapRateLimiter({
    attemptsPerWindow: config.limits.bootstrapRateLimit.attemptsPerWindow,
    windowMs: config.limits.bootstrapRateLimit.windowMs,
    now: () => now().getTime(),
  });

  const audit = new AuditService(repos, { now, log });

  const studio = new MappingStudioService({ repos, audit, now });
  const preview = new MappingPreviewService({ repos, storage, audit, config });

  // Queue driver selection (ADR-0004 stays the default): BullMQ wins only when
  // `config.queue.redis` is present (`HEALTHBRIDGE_REDIS_URL`/`REDIS_URL`).
  // Otherwise the historical MySQL/process default is returned unchanged. A
  // selected-but-unreachable Redis is a startup failure, never a silent fallback.
  // In database mode the queue is a table: enqueue persists, every replica polls, and a
  // restart resumes whatever was pending instead of dropping it.
  const jobStore =
    config.queue.redis !== undefined
      ? await createBullMqJobStore({ url: config.queue.redis.url, now })
      : config.database && connection
        ? new MySqlJobStore(connection, now)
        : undefined;

  const queue = new RunQueue({
    concurrency: config.queue.concurrency,
    maxAttempts: config.queue.maxAttempts,
    execute: createRunWorker({ repos, storage, config, now, log }),
    now,
    log,
    store: jobStore,
    workerId: `worker-${process.pid}-${randomBytes(4).toString("hex")}`,
    pollIntervalMs: config.queue.pollIntervalMs,
    visibilityTimeoutMs: config.queue.visibilityTimeoutMs,
  });

  if (jobStore instanceof MySqlJobStore) {
    const counts = await jobStore.countByStatus().catch(() => undefined);
    const resumed = counts ? counts.pending + counts.claimed : 0;
    if (resumed > 0) logger.log(`queue: resuming ${resumed} unfinished job(s) from the database`);
  }

  const runs = new RunService({ repos, queue, audit, now, config });
  const retention = new RetentionService({ repos, storage, audit, config, now, log });
  retention.start();

  return {
    config,
    repos,
    storage,
    apiKeys,
    limiter,
    bootstrapLimiter,
    queue,
    audit,
    studio,
    preview,
    runs,
    retention,
    startedAt: now().toISOString(),
    close: async () => {
      retention.stop();
      await queue.shutdown();
      if (jobStore instanceof BullMqJobStore) await jobStore.close();
      await repos.close();
    },
  };
}
