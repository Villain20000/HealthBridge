import { Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { randomBytes } from "node:crypto";
import { HealthBridge } from "@healthbridge/sdk";
import type { InputDescriptor } from "@healthbridge/shared-types";
import { StorageError } from "@healthbridge/storage";
import type { Principal } from "@healthbridge/auth";
import { CurrentPrincipal, RequiresScope, type AuthenticatedRequest } from "../common/auth.guard.js";
import { ApiError, notFound, validationFailed } from "../common/errors.js";
import { parseCursor, parseLimit } from "../common/validate.js";
import { APP_CONTEXT, type AppContext } from "../providers.js";

/**
 * Asset upload and retrieval.
 *
 * Uploads are content-addressed (the storage key is the SHA-256 of the bytes), so
 * the same file is stored once and an object's identity is verifiable. The
 * *metadata* row is tenant-scoped; the bytes are reachable only through an
 * authorised metadata lookup.
 */
@Controller("api/v1/assets")
export class AssetsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @RequiresScope("assets:write")
  @Post()
  public async upload(
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
    @Query("filename") filenameQuery?: string,
    @Query("domain") domainQuery?: string,
    @Query("format") formatQuery?: string,
  ) {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw validationFailed(
        "Upload the file as the raw request body (Content-Type: application/octet-stream or the file's own type).",
      );
    }

    const filename = filenameQuery ?? request.header("x-filename") ?? "upload.bin";
    if (filename.length > 255) throw validationFailed("'filename' must be at most 255 characters.");

    const contentType = request.header("content-type") ?? "application/octet-stream";

    let stored;
    try {
      stored = await this.ctx.storage.put(body, { contentType });
    } catch (error) {
      if (error instanceof StorageError && error.code === "OBJECT_TOO_LARGE") {
        throw new ApiError("PAYLOAD_TOO_LARGE", error.message);
      }
      if (error instanceof StorageError) throw new ApiError("VALIDATION_FAILED", error.message);
      throw error;
    }

    // Detection fills in capability metadata honestly; an unknown format stays unknown.
    const sdk = new HealthBridge({ keepRunsInMemory: false });
    const input: InputDescriptor = {
      id: stored.key,
      filename,
      mimeType: stored.contentType,
      buffer: body,
      sizeBytes: body.byteLength,
    };
    let sourceFormat = formatQuery ?? "unknown";
    let domain = domainQuery ?? "unknown";
    try {
      const candidates = await sdk.detect(input);
      const best = candidates[0];
      if (best) {
        sourceFormat = formatQuery ?? best.format ?? best.adapterId;
        // The domain comes from the adapter's own inspection report, not a guess.
        const inspection = await sdk.inspect(input, { adapterId: best.adapterId });
        domain = domainQuery ?? inspection.domain ?? domain;
      }
    } catch {
      // Detection is advisory only.
    }

    const asset = await this.ctx.repos.assets.create({
      id: `as_${randomBytes(9).toString("hex")}`,
      workspaceId: principal.workspaceId,
      storageKey: stored.key,
      checksum: stored.checksum,
      filename,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      domain,
      sourceFormat,
      metadata: { detected: domain !== "unknown" },
      createdAt: new Date().toISOString(),
      createdBy: principal.apiKeyId,
    });

    await this.ctx.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "asset.uploaded",
      targetType: "asset",
      targetId: asset.id,
      outcome: "success",
      metadata: { checksum: asset.checksum, sizeBytes: asset.sizeBytes, sourceFormat, domain },
      requestId: request.requestId,
      ip: request.ip,
    });

    return { asset };
  }

  @RequiresScope("assets:read")
  @Get()
  public async list(
    @CurrentPrincipal() principal: Principal,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    const page = await this.ctx.repos.assets.list(principal.workspaceId, {
      limit: parseLimit(limit),
      cursor: parseCursor(cursor),
    });
    return { assets: page.items, nextCursor: page.nextCursor };
  }

  @RequiresScope("assets:read")
  @Get(":id")
  public async get(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const asset = await this.ctx.repos.assets.findById(principal.workspaceId, id);
    if (!asset) throw notFound("Asset");
    return { asset };
  }

  @RequiresScope("assets:write")
  @Delete(":id")
  public async remove(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ctx.retention.deleteAsset({
      principal,
      assetId: id,
      requestId: request.requestId,
      ip: request.ip,
    });
  }

  @RequiresScope("assets:read")
  @Get(":id/schema")
  public async schema(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    const asset = await this.ctx.repos.assets.findById(principal.workspaceId, id);
    if (!asset) throw notFound("Asset");

    const object = await this.ctx.storage.get(asset.storageKey);
    const sdk = new HealthBridge({ keepRunsInMemory: false });
    const input: InputDescriptor = {
      id: asset.storageKey,
      filename: asset.filename,
      mimeType: asset.contentType,
      buffer: Buffer.from(object.bytes),
      sizeBytes: asset.sizeBytes,
    };

    const unsupported = (warnings: string[]) => ({
      assetId: asset.id,
      format: asset.sourceFormat,
      domain: asset.domain,
      supported: false,
      adapterId: null,
      recordCount: null,
      confidence: null,
      schema: null,
      warnings,
    });

    const candidates = await sdk.detect(input);
    const best = candidates[0];
    if (!best) {
      return unsupported([
        `No registered adapter accepts '${asset.filename ?? asset.id}'; ` +
          `stored detection at upload was format '${asset.sourceFormat}', domain '${asset.domain}'.`,
      ]);
    }

    try {
      const inspection = await sdk.inspect(input, { adapterId: best.adapterId });
      // Field names and types only: per-field `sampleValues` can carry patient
      // data and must never leave the API inside a metadata summary.
      const schema = inspection.detectedSchema
        ? {
            fields: inspection.detectedSchema.fields.map((field) => ({
              name: field.name,
              type: field.type,
              nullable: field.nullable ?? null,
            })),
          }
        : null;
      return {
        assetId: asset.id,
        format: inspection.format,
        formatVersion: inspection.formatVersion ?? null,
        domain: inspection.domain,
        supported: true,
        adapterId: best.adapterId,
        recordCount: inspection.recordCount ?? null,
        confidence: best.confidence,
        schema,
        warnings: inspection.warnings ?? [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return unsupported([`Adapter '${best.adapterId}' accepted the asset but inspection failed: ${reason}`]);
    }
  }

  @RequiresScope("assets:read")
  @Get(":id/content")
  public async content(@CurrentPrincipal() principal: Principal, @Param("id") id: string, @Res() response: Response) {
    const asset = await this.ctx.repos.assets.findById(principal.workspaceId, id);
    if (!asset) throw notFound("Asset");

    const object = await this.ctx.storage.get(asset.storageKey);
    response
      .status(200)
      .setHeader("content-type", asset.contentType)
      .setHeader("content-length", String(object.bytes.byteLength))
      .setHeader("etag", `"${asset.checksum.replace("sha256:", "")}"`)
      .setHeader("x-checksum", asset.checksum)
      .setHeader("content-disposition", `attachment; filename="${asset.filename.replace(/["\\]/g, "_")}"`)
      .end(object.bytes);
  }
}
