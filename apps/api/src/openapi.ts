import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { AssetsController } from "./controllers/assets.controller.js";
import { AuditController } from "./controllers/audit.controller.js";
import { HealthController } from "./controllers/health.controller.js";
import { KeysController } from "./controllers/keys.controller.js";
import { MappingsController } from "./controllers/mappings.controller.js";
import { PipelinesController } from "./controllers/pipelines.controller.js";
import { RunsController } from "./controllers/runs.controller.js";
import { WorkspacesController } from "./controllers/workspaces.controller.js";
import type { ApiErrorCode } from "./common/errors.js";

/**
 * Machine-readable contract for the HealthBridge REST API.
 *
 * The route list is NOT hand-copied: it is read from the NestJS decorator
 * metadata on the controllers, so a new `@Get()`/`@Post()` without a matching
 * entry in {@link ROUTE_DOCS} fails the build (`generate-openapi.ts --check`),
 * the `openapi.test.ts` suite and CI. Per-route prose, scopes, parameters and
 * schemas are hand-written next to the introspected route they describe and
 * reviewed like any other contract change.
 *
 * Regenerate with: `npx tsx apps/api/src/generate-openapi.ts` (from the repo
 * root). The committed artifact is `docs/openapi.json`.
 */

const PATH_METADATA = "path";
const METHOD_METADATA = "method";
const HTTP_CODE_METADATA = "__httpCode__";
const SSE_METADATA = "__sse__";

export const OPENAPI_VERSION = "3.1.0";

type ControllerClass = abstract new (...args: any[]) => object;

const CONTROLLERS: ControllerClass[] = [
  HealthController,
  WorkspacesController,
  KeysController,
  AssetsController,
  MappingsController,
  PipelinesController,
  RunsController,
  AuditController,
];

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
  [RequestMethod.DELETE]: "delete",
};

export interface ControllerRoute {
  /** Lowercase HTTP method as served (the SSE stream is a GET). */
  method: string;
  /** Express-style path as declared, e.g. `/api/v1/runs/:id/traces`. */
  expressPath: string;
  /** OpenAPI-style path, e.g. `/api/v1/runs/{id}/traces`. */
  openApiPath: string;
  /** Success status: the `@HttpCode()` value, else 201 for POST and 200 otherwise. */
  statusCode: number;
  /** True for `@Sse()` routes (served as `text/event-stream`). */
  sse: boolean;
  controller: string;
  handler: string;
}

function asPathList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return ["/"];
}

function joinRoutePath(prefix: string, routePath: string): string {
  const joined = `/${prefix}/${routePath}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Every route the API serves, read from decorator metadata (not copied by hand). */
export function listControllerRoutes(): ControllerRoute[] {
  const routes: ControllerRoute[] = [];
  for (const controller of CONTROLLERS) {
    const prefixes = asPathList(Reflect.getMetadata(PATH_METADATA, controller));
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === "constructor") continue;
      const handler = prototype[name];
      if (typeof handler !== "function") continue;
      const methodNumber = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodNumber === undefined) continue;
      const method = METHOD_NAMES[methodNumber];
      if (!method) throw new Error(`Unsupported HTTP method on ${controller.name}.${name}: ${methodNumber}.`);
      const explicitCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      const statusCode = explicitCode ?? (method === "post" ? 201 : 200);
      const sse = Reflect.getMetadata(SSE_METADATA, handler) === true;
      for (const prefix of prefixes) {
        for (const routePath of asPathList(Reflect.getMetadata(PATH_METADATA, handler))) {
          const expressPath = joinRoutePath(prefix, routePath);
          routes.push({
            method,
            expressPath,
            openApiPath: toOpenApiPath(expressPath),
            statusCode,
            sse,
            controller: controller.name,
            handler: name,
          });
        }
      }
    }
  }
  return routes;
}

export type Schema = Record<string, unknown>;

export interface QueryParameter {
  name: string;
  description: string;
  required?: boolean;
  schema?: Schema;
}

export interface HeaderParameter {
  name: string;
  description: string;
  required?: boolean;
}

export interface RouteDoc {
  summary: string;
  description?: string;
  tags: string[];
  /** Required scope, e.g. `runs:read`. Omit for public and bootstrap routes. */
  scope?: string;
  /** No credential of any kind (health, version, formats, workspace bootstrap). */
  public?: boolean;
  /** Uses `x-bootstrap-token` instead of an API key (workspace provisioning). */
  bootstrap?: boolean;
  query?: QueryParameter[];
  headers?: HeaderParameter[];
  requestBody?: { description: string; required?: boolean; contentType?: string; schema: Schema };
  successDescription: string;
  successSchema: Schema;
  /** Error codes this route can return beyond the shared authentication envelope. */
  errors?: ApiErrorCode[];
}

/**
 * HTTP status for each error code. Mirrors the one-to-one mapping in
 * `common/errors.ts`; the `openapi.test.ts` suite pins the codes that matter
 * so the two cannot drift silently.
 */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  MALFORMED_KEY: 400,
  REVOKED_KEY: 401,
  EXPIRED_KEY: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DRAFT_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 422,
  MAPPING_VALIDATION_FAILED: 422,
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_JSON: 400,
  CANCELLED: 409,
  RUN_NOT_CANCELLABLE: 409,
  RUN_NOT_TERMINAL: 409,
  QUEUE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const ERROR_ENVELOPE: Schema = { $ref: "#/components/schemas/ErrorEnvelope" };

function errorResponse(codes: ApiErrorCode[]): Schema {
  const description = codes.map((code) => `\`${code}\` (${ERROR_STATUS[code]})`).join(", ");
  return {
    description: `Failure envelope with one of: ${description}.`,
    content: { "application/json": { schema: ERROR_ENVELOPE } },
  };
}

const AUTH_ERRORS: Schema = errorResponse(["UNAUTHENTICATED", "REVOKED_KEY", "EXPIRED_KEY", "MALFORMED_KEY"]);
const FORBIDDEN_ERROR: Schema = errorResponse(["FORBIDDEN"]);
const RATE_LIMIT_ERROR: Schema = errorResponse(["RATE_LIMITED"]);
const DEFAULT_ERROR: Schema = errorResponse(["INTERNAL"]);

const PAGINATION_QUERY: QueryParameter[] = [
  {
    name: "limit",
    description: "Maximum items to return. Defaults are service-defined; values are bounded.",
    schema: { type: "string" },
  },
  { name: "cursor", description: "Opaque cursor from a previous `nextCursor`.", schema: { type: "string" } },
];

const NEXT_CURSOR: Schema = {
  nextCursor: { type: ["string", "null"], description: "Cursor for the next page, or null." },
};

const IDEMPOTENCY_HEADER: HeaderParameter = {
  name: "idempotency-key",
  description:
    "Client-chosen key scoped to the workspace. Same key + same request returns the same run (`created: false`); same key + different request returns 422 `IDEMPOTENCY_CONFLICT`.",
};

const RUN_SUMMARY: Schema = {
  type: "object",
  required: ["id", "status", "mappingId", "recordsProcessed", "recordsSucceeded", "recordsFailed", "createdAt"],
  properties: {
    id: { type: "string", description: "Run id (`run_…`)." },
    status: {
      type: "string",
      enum: ["queued", "running", "cancelling", "cancelled", "completed", "completed_with_warnings", "failed"],
    },
    mappingId: { type: "string" },
    assetId: { type: "string" },
    recordsProcessed: { type: "integer" },
    recordsSucceeded: { type: "integer" },
    recordsFailed: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    finishedAt: { type: "string", format: "date-time" },
    progress: { type: "object", description: "Stage progress; present while running.", additionalProperties: true },
    error: { type: "object", description: "Failure detail; present when the run failed.", additionalProperties: true },
  },
};

export const COMPONENT_SCHEMAS: Record<string, Schema> = {
  ErrorEnvelope: {
    type: "object",
    required: ["error", "statusCode"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "requestId"],
        properties: {
          code: {
            $ref: "#/components/schemas/ErrorCode",
            description: "Stable machine-readable code; documented per operation.",
          },
          message: { type: "string", description: "Human-readable detail. Never contains SQL, paths or stacks." },
          requestId: { type: "string", description: "Echo this when reporting the failure." },
          details: { description: "Optional machine-readable context (e.g. `requiredScope`, `runId`)." },
        },
      },
      statusCode: { type: "integer", description: "Mirrors the HTTP status." },
    },
  },
  ErrorCode: {
    type: "string",
    enum: Object.keys(ERROR_STATUS),
    description: "Shared error taxonomy (`apps/api/src/common/errors.ts`).",
  },
  Workspace: {
    type: "object",
    required: ["id", "slug", "name"],
    properties: {
      id: { type: "string" },
      slug: { type: "string" },
      name: { type: "string" },
      plan: { type: "string" },
      retentionDays: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      createdBy: { type: "string" },
    },
  },
  ApiKey: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      role: { type: "string", enum: ["owner", "editor", "viewer", "service"] },
      scopes: { type: "array", items: { type: "string" } },
      keyPrefix: { type: "string", description: "Identifying prefix; the secret itself is never returned." },
      expiresAt: { type: "string", format: "date-time" },
      revokedAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Asset: {
    type: "object",
    required: ["id", "checksum", "sizeBytes"],
    properties: {
      id: { type: "string", description: "Asset id (`as_…`)." },
      checksum: { type: "string", description: "SHA-256 of the bytes (`sha256:…`). Matches the `x-checksum` header." },
      filename: { type: "string" },
      contentType: { type: "string" },
      sizeBytes: { type: "integer" },
      domain: { type: "string", description: "Detected domain, or `unknown` when detection found nothing." },
      sourceFormat: { type: "string", description: "Detected format, or `unknown`." },
      metadata: { type: "object", additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Mapping: {
    type: "object",
    required: ["id", "name", "version", "spec", "specChecksum"],
    properties: {
      id: { type: "string", description: "Mapping id (`mp_…`). Runs reference this, never the name." },
      name: { type: "string", description: "Slug; posting an existing name creates the next version." },
      version: { type: "integer" },
      spec: { type: "object", description: "Mapping spec (`spec.rules` is an array).", additionalProperties: true },
      specChecksum: { type: "string" },
      sourceFormat: { type: "string" },
      targetFormat: { type: "string" },
      targetResourceType: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Pipeline: {
    type: "object",
    required: ["id", "name", "mappingId"],
    properties: {
      id: { type: "string", description: "Pipeline id (`pl_…`)." },
      name: { type: "string" },
      mappingId: { type: "string" },
      config: { type: "object", description: "Engine options applied at run creation.", additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Run: {
    allOf: [{ $ref: "#/components/schemas/RunSummary" }],
    description: "Full run row, including options, summary, validation and engine versions.",
  },
  RunSummary: RUN_SUMMARY,
  RunBundle: {
    type: "object",
    required: ["bundleVersion", "runId", "engineVersion", "traceProtocolVersion", "input", "expected"],
    description: "Self-describing replay descriptor. Never embeds payload bytes.",
    properties: {
      bundleVersion: { type: "string" },
      source: { type: "string" },
      apiVersion: { type: "string" },
      runId: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      engineVersion: { type: "string" },
      traceProtocolVersion: { type: "string" },
      pipelineVersion: { type: "string" },
      input: { type: "object", additionalProperties: true },
      adapter: { type: "object", additionalProperties: true },
      mapping: {
        type: "object",
        description: "The mapping spec version the run executed.",
        additionalProperties: true,
      },
      mappingRef: { type: "object", additionalProperties: true },
      options: { type: "object", additionalProperties: true },
      expected: {
        type: "object",
        description: "Checksums and counts a reproduction must match.",
        properties: {
          status: { type: "string" },
          recordsProcessed: { type: "integer" },
          recordsSucceeded: { type: "integer" },
          recordsFailed: { type: "integer" },
          outputChecksum: { type: "string" },
          validationValid: { type: "boolean" },
        },
      },
      environment: { type: "object", additionalProperties: true },
    },
  },
  RunCheckpoint: {
    type: "object",
    required: ["runId", "stage", "recordIndex", "recordsProcessed", "importedAt", "updatedAt"],
    description:
      "Persisted resume cursor for a live run: the pipeline stage, the next record index, and the checksums that bind the checkpoint to one exact input and output prefix.",
    properties: {
      runId: { type: "string", description: "Run id (`run_…`)." },
      stage: {
        type: "string",
        enum: ["parse", "mapping", "paused", "done"],
        description: "Pipeline stage the checkpoint was taken at.",
      },
      recordIndex: { type: "integer", description: "Zero-based index of the next record to process." },
      recordsProcessed: { type: "integer", description: "Records processed when the checkpoint was taken." },
      recordsTotal: { type: "integer", description: "Total records when known (after parsing)." },
      inputChecksum: {
        type: "string",
        description: "Checksum of the run input; a resume with different bytes is refused.",
      },
      outputChecksumSoFar: { type: "string", description: "Checksum of the output prefix produced so far." },
      adapterId: { type: "string" },
      adapterVersion: { type: "string" },
      importedAt: {
        type: "string",
        format: "date-time",
        description: "Effective provenance timestamp; a resume must reuse it for byte-identical output.",
      },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  AuditEvent: {
    type: "object",
    required: ["action", "outcome"],
    properties: {
      id: { type: "string" },
      workspaceId: { type: "string" },
      actorKeyId: { type: "string" },
      action: {
        type: "string",
        description:
          "One of `workspace.created`, `workspace.deletion_requested`, `key.issued`, `key.revoked`, `key.rotated`, `asset.uploaded`, `asset.deleted`, `mapping.created`, `pipeline.created`, `run.created`, `run.cancelled`, `run.deleted`, `run.replayed`, `retention.swept`. Workspace purges are recorded in the platform audit (`workspace.purged`), not the tenant trail.",
      },
      targetType: { type: "string" },
      targetId: { type: "string" },
      outcome: { type: "string", enum: ["success", "failure"] },
      metadata: { type: "object", additionalProperties: true },
      requestId: { type: "string" },
      ip: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Health: {
    type: "object",
    required: ["status", "mode", "persistence"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      mode: { type: "string", enum: ["demo", "database"] },
      nodeEnv: { type: "string" },
      persistence: { type: "string" },
      storage: { type: "string" },
      queue: { type: "object", additionalProperties: true },
      limits: {
        type: "object",
        description: "Authoritative limits; clients must read these instead of hard-coding maximums.",
        properties: {
          maxUploadBytes: { type: "integer" },
          maxRequestBodyBytes: { type: "integer" },
          maxStoredResultBytes: { type: "integer" },
          maxTracesPerRun: { type: "integer" },
          rateLimit: { type: "object", additionalProperties: true },
          queue: { type: "object", additionalProperties: true },
        },
      },
      startedAt: { type: "string", format: "date-time" },
      uptimeSeconds: { type: "integer" },
    },
  },
};

/**
 * Hand-written documentation for every introspected route, keyed by
 * `METHOD <express path>`. `buildOpenApiDocument()` throws when a controller
 * route has no entry here (or an entry has no route), so the table cannot
 * cover a subset of the API.
 */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /api/v1/healthz": {
    summary: "Liveness and limits discovery",
    description:
      "Public on purpose: a health check that needs credentials is not a health check. Reports the persistence mode so a demo instance can never be mistaken for a durable deployment, and the authoritative upload/body/rate/queue limits.",
    tags: ["Health"],
    public: true,
    successDescription: "Liveness report with mode, queue depth and limits.",
    successSchema: { $ref: "#/components/schemas/Health" },
  },
  "GET /api/v1/version": {
    summary: "Engine and protocol versions",
    description: "Public. Reports the engine, trace-protocol and API versions plus the persistence mode.",
    tags: ["Health"],
    public: true,
    successDescription: "Version report.",
    successSchema: {
      type: "object",
      properties: {
        engine: { type: "string" },
        traceProtocol: { type: "string" },
        api: { type: "string" },
        node: { type: "string" },
        persistence: { type: "string" },
      },
    },
  },
  "GET /api/v1/formats": {
    summary: "Adapter capability manifest",
    description: "Public. Capability manifest of the adapter registry (no patient data involved).",
    tags: ["Health"],
    public: true,
    successDescription: "Adapter capability manifest.",
    successSchema: { type: "object", properties: { formats: { type: "array", items: { type: "object" } } } },
  },
  "POST /api/v1/workspaces": {
    summary: "Provision a workspace",
    description:
      "Creates the first workspace with the operator-held bootstrap token (`x-bootstrap-token`). The token is platform-level: it cannot read tenant data and is the only way to add a tenant. Returns the workspace and its owner key; the plaintext key is shown exactly once. Attempts are rate limited per client IP.",
    tags: ["Workspaces"],
    public: true,
    bootstrap: true,
    headers: [
      {
        name: "x-bootstrap-token",
        description: "Operator-held bootstrap token (minimum 16 characters).",
        required: true,
      },
    ],
    requestBody: {
      description: "Workspace to provision.",
      required: true,
      schema: {
        type: "object",
        required: ["name", "slug"],
        properties: {
          name: { type: "string", maxLength: 200 },
          slug: { type: "string", description: "URL-safe slug." },
          plan: { type: "string", default: "community" },
        },
      },
    },
    successDescription: "The created workspace and its owner key (plaintext, shown once).",
    successSchema: {
      type: "object",
      properties: {
        workspace: { $ref: "#/components/schemas/Workspace" },
        apiKey: {
          type: "object",
          properties: {
            key: { type: "string", description: "Plaintext key (`hb_…`). Store it now: it cannot be retrieved again." },
            id: { type: "string" },
            role: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
        },
      },
    },
    errors: ["VALIDATION_FAILED", "UNAUTHENTICATED", "RATE_LIMITED"],
  },
  "GET /api/v1/workspaces/current": {
    summary: "Describe the current workspace and key",
    description: "Returns the workspace identified by the caller's key plus the key metadata (never the secret).",
    tags: ["Workspaces"],
    scope: "runs:read",
    successDescription: "Workspace and key metadata.",
    successSchema: {
      type: "object",
      properties: {
        workspace: { $ref: "#/components/schemas/Workspace" },
        key: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            role: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "DELETE /api/v1/workspaces/current": {
    summary: "Delete the current workspace",
    description:
      "Owner-only. Requires the workspace slug in `confirm`. Soft-deletes the workspace, revokes every API key in it and schedules a hard purge (`workspace_purges`) after the configured grace period (`HEALTHBRIDGE_WORKSPACE_GRACE_DAYS`, default 7). Data stays readable to operators during the grace period; the retention sweep then deletes the workspace and every tenant row, keeping a platform audit record of the purge. A wrong slug returns 400 `VALIDATION_FAILED` and changes nothing.",
    tags: ["Workspaces"],
    scope: "workspaces:admin",
    requestBody: {
      description: "Destructive-action confirmation.",
      required: true,
      schema: {
        type: "object",
        required: ["confirm"],
        properties: {
          confirm: { type: "string", description: "The workspace slug, exactly." },
        },
      },
    },
    successDescription: "Deletion receipt with the scheduled purge time and revoked-key count.",
    successSchema: {
      type: "object",
      required: ["deleted", "workspaceId", "workspaceSlug", "purgeScheduledAt", "keysRevoked"],
      properties: {
        deleted: { type: "boolean" },
        workspaceId: { type: "string" },
        workspaceSlug: { type: "string" },
        purgeScheduledAt: { type: "string", format: "date-time" },
        keysRevoked: { type: "integer" },
      },
    },
    errors: ["VALIDATION_FAILED", "NOT_FOUND", "CONFLICT"],
  },
  "POST /api/v1/keys": {
    summary: "Issue an API key",
    description:
      "Issues a key for the caller's workspace. The plaintext is returned exactly once; every other response carries the prefix and metadata. `role` defaults to `viewer`. Unknown scope names are rejected with `VALIDATION_FAILED`.",
    tags: ["Keys"],
    scope: "workspaces:admin",
    requestBody: {
      description: "Key to issue.",
      required: true,
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 200 },
          role: { type: "string", enum: ["owner", "editor", "viewer", "service"], default: "viewer" },
          scopes: {
            type: "array",
            items: { type: "string" },
            description: "Explicit scopes; validated against the role.",
          },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
    },
    successDescription: "Plaintext key (once) plus its metadata.",
    successSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Plaintext key. Store it now: it cannot be retrieved again." },
        apiKey: { $ref: "#/components/schemas/ApiKey" },
        note: { type: "string" },
      },
    },
    errors: ["VALIDATION_FAILED"],
  },
  "GET /api/v1/keys": {
    summary: "List API keys",
    description: "Lists key metadata (prefixes, roles, scopes). Never returns secrets.",
    tags: ["Keys"],
    scope: "workspaces:admin",
    successDescription: "Key metadata for the workspace.",
    successSchema: {
      type: "object",
      properties: { keys: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } } },
    },
  },
  "DELETE /api/v1/keys/:id": {
    summary: "Revoke an API key",
    description: "Revokes the key. A revoked key authenticates as `REVOKED_KEY` (401).",
    tags: ["Keys"],
    scope: "workspaces:admin",
    successDescription: "Revocation receipt.",
    successSchema: { type: "object", properties: { revoked: { type: "boolean" }, id: { type: "string" } } },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/keys/:id/rotate": {
    summary: "Rotate an API key",
    description: "Issues a replacement key and revokes the old one. The new plaintext is returned exactly once.",
    tags: ["Keys"],
    scope: "workspaces:admin",
    successDescription: "Replacement plaintext key plus metadata; `revoked` names the retired key id.",
    successSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        apiKey: { $ref: "#/components/schemas/ApiKey" },
        revoked: { type: "string" },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/assets": {
    summary: "Upload an asset (raw bytes)",
    description:
      "Uploads a file as the raw request body (any content type; hospital exports are routinely mislabelled). Objects are content-addressed by SHA-256, so identical bytes are stored once; the metadata row is tenant-scoped. Detection fills in `sourceFormat`/`domain` honestly — an unknown format stays `unknown`. `filename` may be a query parameter or the `x-filename` header.",
    tags: ["Assets"],
    scope: "assets:write",
    query: [
      {
        name: "filename",
        description: "File name (max 255 characters). Defaults to `upload.bin`.",
        schema: { type: "string" },
      },
      { name: "domain", description: "Override the detected domain.", schema: { type: "string" } },
      { name: "format", description: "Override the detected source format.", schema: { type: "string" } },
    ],
    headers: [{ name: "x-filename", description: "Alternative to the `filename` query parameter." }],
    requestBody: {
      description: "The file bytes (`application/octet-stream` or the file's own type). Must be non-empty.",
      required: true,
      contentType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    },
    successDescription: "The stored asset with checksum and detection result.",
    successSchema: { type: "object", properties: { asset: { $ref: "#/components/schemas/Asset" } } },
    errors: ["VALIDATION_FAILED", "PAYLOAD_TOO_LARGE"],
  },
  "GET /api/v1/assets": {
    summary: "List assets",
    description: "Lists asset metadata for the workspace, newest first.",
    tags: ["Assets"],
    scope: "assets:read",
    query: PAGINATION_QUERY,
    successDescription: "Asset page.",
    successSchema: {
      type: "object",
      properties: { assets: { type: "array", items: { $ref: "#/components/schemas/Asset" } }, ...NEXT_CURSOR },
    },
  },
  "GET /api/v1/assets/:id": {
    summary: "Get an asset",
    description: "Returns asset metadata. A foreign id reads as 404, never 403, so identifiers cannot be probed.",
    tags: ["Assets"],
    scope: "assets:read",
    successDescription: "Asset metadata.",
    successSchema: { type: "object", properties: { asset: { $ref: "#/components/schemas/Asset" } } },
    errors: ["NOT_FOUND"],
  },
  "DELETE /api/v1/assets/:id": {
    summary: "Delete an asset",
    description:
      "Hard-deletes the asset metadata row. Refused with 409 `CONFLICT` while any run in the workspace still references the asset — delete or retain those runs first. The content-addressed object is deleted only when no asset in any workspace still references the same bytes, so shared uploads survive another tenant's deletion.",
    tags: ["Assets"],
    scope: "assets:write",
    successDescription: "Deletion receipt; `blobDeleted` reports whether the shared object was removed.",
    successSchema: {
      type: "object",
      required: ["deleted", "assetId", "blobDeleted"],
      properties: {
        deleted: { type: "boolean" },
        assetId: { type: "string" },
        blobDeleted: { type: "boolean" },
      },
    },
    errors: ["NOT_FOUND", "CONFLICT"],
  },
  "GET /api/v1/assets/:id/content": {
    summary: "Download asset bytes",
    description:
      "Returns the exact uploaded bytes with `x-checksum` (the content-addressed SHA-256) and `etag` headers.",
    tags: ["Assets"],
    scope: "assets:read",
    successDescription: "The exact uploaded bytes.",
    successSchema: { type: "string", format: "binary" },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/assets/:id/schema": {
    summary: "Get an asset's detected schema",
    description:
      "Re-inspects the stored bytes with the adapter registry and returns the adapter's field summary. A foreign id reads as 404, never 403. An asset no registered adapter accepts returns `supported: false` with a null schema (plus the detection recorded at upload) instead of an error.",
    tags: ["Assets"],
    scope: "assets:read",
    successDescription: "Adapter inspect/schema summary for the stored asset.",
    successSchema: {
      type: "object",
      required: ["assetId", "format", "domain", "supported"],
      properties: {
        assetId: { type: "string", description: "Asset id (`as_…`)." },
        format: { type: "string", description: "Detected format, or the stored `sourceFormat` when unsupported." },
        formatVersion: { type: ["string", "null"], description: "Adapter-reported format version, when known." },
        domain: { type: "string", description: "Detected domain, or the stored `domain` when unsupported." },
        supported: { type: "boolean", description: "False when no registered adapter accepts the asset." },
        adapterId: { type: ["string", "null"], description: "Adapter that produced the summary, when supported." },
        recordCount: { type: ["integer", "null"], description: "Records the adapter counted, when known." },
        confidence: { type: ["number", "null"], description: "Detection confidence in 0..1, when supported." },
        schema: {
          description:
            "Detected field summary (names and types only — never sample values, which can carry patient data); null when unsupported.",
          type: ["object", "null"],
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  nullable: { type: ["boolean", "null"] },
                },
              },
            },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/mappings": {
    summary: "Create a mapping version",
    description:
      "Creates a mapping version. Versions are immutable: posting an existing `name` again creates version n+1, and a run references a mapping *id*, so editing a mapping can never silently change what an old run did. `spec.rules` must be an array.",
    tags: ["Mappings"],
    scope: "mappings:write",
    requestBody: {
      description: "Mapping to create.",
      required: true,
      schema: {
        type: "object",
        required: ["name", "spec"],
        properties: {
          name: { type: "string", description: "Slug; posting an existing name creates the next version." },
          spec: {
            type: "object",
            required: ["rules"],
            description: "Mapping spec.",
            properties: { rules: { type: "array", items: { type: "object" } } },
          },
          sourceFormat: { type: "string", default: "auto" },
          targetFormat: { type: "string", default: "fhir-r4" },
          targetResourceType: { type: "string" },
        },
      },
    },
    successDescription: "The created mapping version.",
    successSchema: { type: "object", properties: { mapping: { $ref: "#/components/schemas/Mapping" } } },
    errors: ["VALIDATION_FAILED"],
  },
  "GET /api/v1/mappings": {
    summary: "List mappings",
    description: "Lists mapping versions for the workspace.",
    tags: ["Mappings"],
    scope: "mappings:read",
    query: PAGINATION_QUERY,
    successDescription: "Mapping page.",
    successSchema: {
      type: "object",
      properties: { mappings: { type: "array", items: { $ref: "#/components/schemas/Mapping" } }, ...NEXT_CURSOR },
    },
  },
  "GET /api/v1/mappings/:name/versions": {
    summary: "List versions of a mapping",
    description:
      "Lists every immutable version of the named mapping. Declared before `:id`, so a name is never captured as an id.",
    tags: ["Mappings"],
    scope: "mappings:read",
    successDescription: "All versions of the mapping.",
    successSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        versions: { type: "array", items: { $ref: "#/components/schemas/Mapping" } },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/mappings/:id": {
    summary: "Get a mapping",
    description: "Returns one mapping version by id.",
    tags: ["Mappings"],
    scope: "mappings:read",
    successDescription: "The mapping version.",
    successSchema: { type: "object", properties: { mapping: { $ref: "#/components/schemas/Mapping" } } },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/pipelines": {
    summary: "Create a pipeline",
    description:
      "Creates a named combination of a mapping and engine options. A pipeline is a convenience for repeatable operations, not a second execution path: it resolves to a mapping id and options, and the run service executes that.",
    tags: ["Pipelines"],
    scope: "pipelines:write",
    requestBody: {
      description: "Pipeline to create. The mapping must exist in the workspace.",
      required: true,
      schema: {
        type: "object",
        required: ["name", "mappingId"],
        properties: {
          name: { type: "string", description: "Slug." },
          mappingId: { type: "string" },
          config: {
            type: "object",
            description: "Engine options applied at run creation.",
            additionalProperties: true,
          },
        },
      },
    },
    successDescription: "The created pipeline.",
    successSchema: { type: "object", properties: { pipeline: { $ref: "#/components/schemas/Pipeline" } } },
    errors: ["VALIDATION_FAILED", "NOT_FOUND"],
  },
  "GET /api/v1/pipelines": {
    summary: "List pipelines",
    description: "Lists pipelines for the workspace.",
    tags: ["Pipelines"],
    scope: "pipelines:read",
    query: PAGINATION_QUERY,
    successDescription: "Pipeline page.",
    successSchema: {
      type: "object",
      properties: { pipelines: { type: "array", items: { $ref: "#/components/schemas/Pipeline" } }, ...NEXT_CURSOR },
    },
  },
  "GET /api/v1/pipelines/:id": {
    summary: "Get a pipeline",
    description: "Returns the pipeline plus the mapping it currently resolves to.",
    tags: ["Pipelines"],
    scope: "pipelines:read",
    successDescription: "The pipeline and its mapping.",
    successSchema: {
      type: "object",
      properties: {
        pipeline: { $ref: "#/components/schemas/Pipeline" },
        mapping: { $ref: "#/components/schemas/Mapping" },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/runs": {
    summary: "Create a run (async, 202)",
    description:
      "Runs are created with 202 plus a run resource, never as a synchronous transform. The row is written before the job is persisted, so 202 always means a job exists. Allowed `options`: `maxRecords`, `importedAt` (ISO-8601 reproducibility anchor), `adapterId`, `pipelineVersion`. Anything else is rejected with `VALIDATION_FAILED`. If the worker queue refuses the job, the call returns 503 and the run is recorded as failed with `error.code = QUEUE_UNAVAILABLE`.",
    tags: ["Runs"],
    scope: "runs:write",
    headers: [IDEMPOTENCY_HEADER],
    requestBody: {
      description: "Run inputs. Reference an asset plus a mapping (`mappingId` or `mappingName`) or a `pipelineId`.",
      required: true,
      schema: {
        type: "object",
        required: ["assetId"],
        properties: {
          assetId: { type: "string" },
          mappingId: { type: "string" },
          mappingName: { type: "string", description: "Resolves to the latest version of the named mapping." },
          pipelineId: { type: "string" },
          options: {
            type: "object",
            properties: {
              maxRecords: { type: "integer" },
              importedAt: { type: "string", format: "date-time" },
              adapterId: { type: "string" },
              pipelineVersion: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
    },
    successDescription: "The queued run, whether it was created now, and links to follow it.",
    successSchema: {
      type: "object",
      properties: {
        run: { $ref: "#/components/schemas/Run" },
        created: { type: "boolean", description: "False when the Idempotency-Key replayed an earlier request." },
        links: {
          type: "object",
          properties: {
            self: { type: "string" },
            events: { type: "string" },
            traces: { type: "string" },
            resources: { type: "string" },
            bundle: { type: "string" },
          },
        },
      },
    },
    errors: ["VALIDATION_FAILED", "NOT_FOUND", "IDEMPOTENCY_CONFLICT", "QUEUE_UNAVAILABLE"],
  },
  "GET /api/v1/runs": {
    summary: "List runs",
    description: "Lists run summaries for the workspace. `status` must be a known lifecycle state when given.",
    tags: ["Runs"],
    scope: "runs:read",
    query: [
      {
        name: "status",
        description:
          "Filter by lifecycle state: `queued`, `running`, `cancelling`, `cancelled`, `completed`, `completed_with_warnings`, `failed`.",
        schema: { type: "string" },
      },
      ...PAGINATION_QUERY,
    ],
    successDescription: "Run summary page.",
    successSchema: {
      type: "object",
      properties: { runs: { type: "array", items: { $ref: "#/components/schemas/RunSummary" } }, ...NEXT_CURSOR },
    },
    errors: ["VALIDATION_FAILED"],
  },
  "GET /api/v1/runs/:id": {
    summary: "Get a run",
    description: "Returns the run row for the workspace.",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "The run.",
    successSchema: { type: "object", properties: { run: { $ref: "#/components/schemas/Run" } } },
    errors: ["NOT_FOUND"],
  },
  "DELETE /api/v1/runs/:id": {
    summary: "Delete a finished run",
    description:
      "Hard-deletes a terminal run (`completed`, `completed_with_warnings`, `failed`, `cancelled`) together with its traces, resource index and queued job rows. Idempotency keys that created the run are freed, so the same key can create a new run afterwards. A live run returns 409 `RUN_NOT_TERMINAL`: cancel it first.",
    tags: ["Runs"],
    scope: "runs:write",
    successDescription: "Deletion receipt and how many idempotency keys were freed.",
    successSchema: {
      type: "object",
      required: ["deleted", "runId", "idempotencyKeysFreed"],
      properties: {
        deleted: { type: "boolean" },
        runId: { type: "string" },
        idempotencyKeysFreed: { type: "integer" },
      },
    },
    errors: ["NOT_FOUND", "RUN_NOT_TERMINAL"],
  },
  "GET /api/v1/runs/:id/resources": {
    summary: "Get run output resources",
    description:
      "Returns the stored output resources. When output exceeded the stored-result limit, `omitted` is true and the summary keeps the checksums and counts instead; re-run with `maxRecords` to materialise a subset.",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "Output resources, or an omission report.",
    successSchema: {
      type: "object",
      properties: {
        resources: { type: "array", items: { type: "object" } },
        omitted: { type: "boolean" },
        bytes: { type: "integer" },
        note: { type: "string" },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/runs/:id/issues": {
    summary: "Get run issues",
    description: "Returns validation issues and rejected records for the run.",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "Issues and rejected records.",
    successSchema: {
      type: "object",
      properties: {
        issues: { type: "array", items: { type: "object" } },
        rejected: { type: "array", items: { type: "object" } },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/runs/:id/traces": {
    summary: "Get run traces",
    description:
      "Returns the stored execution traces, up to the configured per-run limit. Trace payloads use the structural-by-default redaction policy (protocol v1.2).",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "Traces and count.",
    successSchema: {
      type: "object",
      properties: { traces: { type: "array", items: { type: "object" } }, count: { type: "integer" } },
    },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/runs/:id/bundle": {
    summary: "Get the run bundle (replay descriptor)",
    description:
      "A self-describing descriptor that never embeds payload bytes — safe to attach to a ticket and replay against the same input. Carries the mapping spec version the run executed plus the checksums a reproduction must match.",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "The bundle descriptor.",
    successSchema: { $ref: "#/components/schemas/RunBundle" },
    errors: ["NOT_FOUND"],
  },
  "POST /api/v1/runs/:id/cancel": {
    summary: "Cancel a run",
    description:
      "Cancellation is cooperative: an in-flight record finishes before the run stops, at stage boundaries. A run that already finished returns 409 `RUN_NOT_CANCELLABLE`; a row that changed or disappeared between read and write returns 409 `CONFLICT` / 404.",
    tags: ["Runs"],
    scope: "runs:write",
    successDescription: "The cancelled run.",
    successSchema: {
      type: "object",
      properties: {
        run: { $ref: "#/components/schemas/Run" },
        note: { type: "string" },
      },
    },
    errors: ["NOT_FOUND", "CONFLICT", "RUN_NOT_CANCELLABLE", "CANCELLED"],
  },
  "POST /api/v1/runs/:id/pause": {
    summary: "Pause a live run after its current chunk",
    description:
      "Cooperative pause — not a cancel. The worker finishes its in-flight record chunk, persists a checkpoint (`stage` + next `recordIndex` + input/output checksums) on the run row, and holds its queue slot with status `running` and `progress.stage: paused`. `POST /runs/:id/resume` continues it; cancelling a paused run aborts it and drops the checkpoint. Pause handles are process-local (demo mode): only the replica running the job observes the request, at its next chunk boundary. A run that already finished, is cancelling, or is already paused returns 409 `CONFLICT`. Static replay (`POST /runs/:id/replay`) is a separate path and is never labelled live.",
    tags: ["Runs"],
    scope: "runs:write",
    successDescription: "The pausing run plus its latest checkpoint, when one has been persisted yet.",
    successSchema: {
      type: "object",
      properties: {
        run: { $ref: "#/components/schemas/Run" },
        checkpoint: { $ref: "#/components/schemas/RunCheckpoint" },
        note: { type: "string" },
      },
    },
    errors: ["NOT_FOUND", "CONFLICT"],
  },
  "POST /api/v1/runs/:id/resume": {
    summary: "Resume a paused live run from its checkpoint",
    description:
      "Continues a paused run from its persisted checkpoint with byte-identical output to an uninterrupted run. Resume is cooperative like pause: the worker continues at its next scheduling turn. A run that is not paused — including finished runs, and cancelled runs, which do not keep a checkpoint — returns 409 `CONFLICT`.",
    tags: ["Runs"],
    scope: "runs:write",
    successDescription: "The resuming run plus the checkpoint it continues from.",
    successSchema: {
      type: "object",
      properties: {
        run: { $ref: "#/components/schemas/Run" },
        checkpoint: { $ref: "#/components/schemas/RunCheckpoint" },
        note: { type: "string" },
      },
    },
    errors: ["NOT_FOUND", "CONFLICT"],
  },
  "POST /api/v1/runs/:id/replay": {
    summary: "Replay a run",
    description: "Creates a new run from the same asset, mapping and options.",
    tags: ["Runs"],
    scope: "runs:write",
    successDescription: "The new run and the id it was replayed from.",
    successSchema: {
      type: "object",
      properties: {
        run: { $ref: "#/components/schemas/Run" },
        created: { type: "boolean" },
        replayedFrom: { type: "string" },
      },
    },
    errors: ["NOT_FOUND"],
  },
  "GET /api/v1/runs/:id/events": {
    summary: "Stream run progress (SSE)",
    description:
      "Server-sent events for one run (`Accept: text/event-stream`). The stream sends the current snapshot first, so a client that connects late (or reconnects) is never blind, then forwards queue events and closes on a terminal state. Event types: `snapshot`, `queued`, `started`, `progress`, `warning`, `done`, `error`, `cancelled`, plus `ping` heartbeats. A terminal event is always sent, even to a late subscriber.",
    tags: ["Runs"],
    scope: "runs:read",
    successDescription: "Event stream ending in a terminal event.",
    successSchema: { type: "string", description: "SSE frames (`text/event-stream`)." },
  },
  "GET /api/v1/audit": {
    summary: "List audit events",
    description:
      "Append-only audit trail, tenant scoped. Owner-only: the trail names actors. Records workspace creation, key issue/rotate/revoke, asset upload, mapping and pipeline creation, run creation, cancellation and replay. An audit write failure is logged, never allowed to break the request.",
    tags: ["Audit"],
    scope: "audit:read",
    query: PAGINATION_QUERY,
    successDescription: "Audit event page.",
    successSchema: {
      type: "object",
      properties: { events: { type: "array", items: { $ref: "#/components/schemas/AuditEvent" } }, ...NEXT_CURSOR },
    },
  },
};

const PATH_PARAM_DESCRIPTIONS: Record<string, string> = {
  id: "Opaque resource id. Scoped to the workspace; a foreign id reads as 404, never 403.",
  name: "Mapping name (slug). Versions share the name; runs reference immutable ids.",
};

function pathParameters(openApiPath: string): Schema[] {
  const names = [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    description: PATH_PARAM_DESCRIPTIONS[name] ?? "Path parameter.",
    schema: { type: "string" },
  }));
}

function securityFor(doc: RouteDoc): Schema[] {
  if (doc.public && !doc.bootstrap) return [];
  if (doc.bootstrap) return [{ BootstrapToken: [] }];
  return [{ ApiKey: [] }];
}

function scopeNote(doc: RouteDoc): string {
  if (doc.scope) return `\n\nRequires scope \`${doc.scope}\`. A key without it gets 403 \`FORBIDDEN\`.`;
  if (doc.bootstrap) return "\n\nRequires the operator-held `x-bootstrap-token`, not an API key.";
  return "";
}

/** Builds the full OpenAPI document. Throws when a route lacks documentation. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const routes = listControllerRoutes();

  const documented = new Set(Object.keys(ROUTE_DOCS));
  for (const route of routes) {
    if (!documented.has(`${route.method.toUpperCase()} ${route.expressPath}`)) {
      throw new Error(
        `OpenAPI: ${route.controller}.${route.handler} (${route.method.toUpperCase()} ${route.expressPath}) has no entry in ROUTE_DOCS.`,
      );
    }
  }
  for (const key of documented) {
    if (!routes.some((route) => `${route.method.toUpperCase()} ${route.expressPath}` === key)) {
      throw new Error(`OpenAPI: ROUTE_DOCS entry "${key}" matches no controller route. Remove it.`);
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${route.expressPath}`;
    const doc = ROUTE_DOCS[key];

    const parameters: Schema[] = [
      ...pathParameters(route.openApiPath),
      ...(doc.query ?? []).map((param) => ({
        name: param.name,
        in: "query",
        required: param.required ?? false,
        description: param.description,
        schema: param.schema ?? { type: "string" },
      })),
      ...(doc.headers ?? []).map((header) => ({
        name: header.name,
        in: "header",
        required: header.required ?? false,
        description: header.description,
        schema: { type: "string" },
      })),
    ];
    if (!doc.public && !doc.bootstrap) {
      parameters.push({
        name: "x-api-key",
        in: "header",
        required: true,
        description: "API key (`hb_…`). Tenant isolation comes from the key, never the URL.",
        schema: { type: "string" },
      });
    }

    const routeErrors = [...(doc.errors ?? [])];
    const errorByStatus = new Map<number, ApiErrorCode[]>();
    for (const code of routeErrors) {
      const status = ERROR_STATUS[code];
      errorByStatus.set(status, [...(errorByStatus.get(status) ?? []), code]);
    }

    const successContentType = route.sse
      ? "text/event-stream"
      : route.openApiPath.endsWith("/content")
        ? "application/octet-stream"
        : "application/json";
    const responses: Record<string, unknown> = {
      [String(route.statusCode)]: {
        description: doc.successDescription,
        content: { [successContentType]: { schema: doc.successSchema } },
      },
    };
    if (!doc.public) {
      responses["401"] = AUTH_ERRORS;
      responses["403"] = FORBIDDEN_ERROR;
      responses["429"] = RATE_LIMIT_ERROR;
    } else if (doc.bootstrap) {
      responses["401"] = errorResponse(["UNAUTHENTICATED"]);
      responses["429"] = RATE_LIMIT_ERROR;
    }
    for (const [status, codes] of [...errorByStatus.entries()].sort(([a], [b]) => a - b)) {
      if (responses[String(status)] === undefined) responses[String(status)] = errorResponse(codes);
    }
    responses["default"] = DEFAULT_ERROR;

    const operation: Record<string, unknown> = {
      operationId: `${route.controller}.${route.handler}`,
      summary: doc.summary,
      description: `${doc.description ?? doc.summary}${scopeNote(doc)}`,
      tags: doc.tags,
      security: securityFor(doc),
      responses,
    };
    if (doc.scope) operation["x-required-scope"] = doc.scope;
    if (parameters.length > 0) operation["parameters"] = parameters;
    if (doc.requestBody) {
      operation["requestBody"] = {
        description: doc.requestBody.description,
        required: doc.requestBody.required ?? false,
        content: { [doc.requestBody.contentType ?? "application/json"]: { schema: doc.requestBody.schema } },
      };
    }

    paths[route.openApiPath] = { ...(paths[route.openApiPath] ?? {}), [route.method]: operation };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "HealthBridge API",
      version: "1",
      description:
        "REST API over the HealthBridge transformation engine. Base path `/api/v1`; uploads are raw bytes, everything else is JSON. Every failure uses one envelope (`ErrorEnvelope`) with a stable `ErrorCode`. Engine and trace-protocol versions are runtime values — see `GET /version`.",
    },
    servers: [{ url: "/", description: "Same origin as the API deployment." }],
    tags: [
      { name: "Health", description: "Public liveness, versions and capabilities." },
      { name: "Workspaces", description: "Bootstrap provisioning and the current workspace." },
      { name: "Keys", description: "API key issue, list, revoke and rotate." },
      { name: "Assets", description: "Content-addressed file upload and retrieval." },
      { name: "Mappings", description: "Immutable versioned mapping catalogue." },
      { name: "Pipelines", description: "Named mapping + options combinations." },
      { name: "Runs", description: "Async execution, outputs, traces, bundles, replay and live progress." },
      { name: "Audit", description: "Append-only, tenant-scoped audit trail (owner only)." },
    ],
    paths,
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Workspace API key (`hb_…`)." },
        BootstrapToken: {
          type: "apiKey",
          in: "header",
          name: "x-bootstrap-token",
          description: "Operator-held bootstrap token for workspace provisioning only.",
        },
      },
      schemas: COMPONENT_SCHEMAS,
    },
  };
}

/** Canonical serialization: fixed key order from the builder, 2-space JSON plus trailing newline. */
export function serializeOpenApiDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
