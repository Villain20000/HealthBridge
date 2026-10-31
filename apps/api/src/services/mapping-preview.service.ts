import { randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import type { Repositories } from "@healthbridge/persistence";
import { HealthBridge, HealthBridgeError } from "@healthbridge/sdk";
import { StorageError, type StorageDriver } from "@healthbridge/storage";
import type { MappingPreview, MappingPreviewResponse, TransformationResult } from "@healthbridge/shared-types";
import type { ApiConfig } from "../config.js";
import { ApiError, notFound, validationFailed } from "../common/errors.js";
import { MAX_MAPPING_ISSUES, normaliseAndValidate, toValidationResult } from "../common/mapping-spec.js";
import type { AuditService } from "./audit.service.js";

/**
 * Bounded, read-only mapping preview.
 *
 * A preview is intentionally not a run: nothing is persisted except the audit
 * event, no storage object is written and no trace is retained. The response is
 * bounded by record count, dropped detail and a final byte measurement so a
 * pathological mapping cannot turn the editor into a memory amplifier.
 */

export interface MappingPreviewDeps {
  repos: Repositories;
  storage: StorageDriver;
  audit: AuditService;
  config: ApiConfig;
}

export interface PreviewInput {
  spec: Record<string, unknown>;
  assetId: string;
  maxRecords?: number;
  adapterId?: string;
  requestId?: string;
  ip?: string;
}

const MAX_SAMPLE_RECORDS = 10;
const MAX_REJECTED_RECORDS = 10;
const MAX_PREVIEW_DETAIL_ENTRIES = 200;
const MAX_PREVIEW_RECORDS_CEILING = 100;

/** One engine per process: detection and transformation are stateless reads. */
const bridge = new HealthBridge({ keepRunsInMemory: false });

export class MappingPreviewService {
  private readonly repos: Repositories;
  private readonly storage: StorageDriver;
  private readonly audit: AuditService;
  private readonly config: ApiConfig;

  constructor(deps: MappingPreviewDeps) {
    this.repos = deps.repos;
    this.storage = deps.storage;
    this.audit = deps.audit;
    this.config = deps.config;
  }

  public async preview(principal: Principal, input: PreviewInput): Promise<MappingPreviewResponse> {
    // The route guard checks mappings:write; reading the tenant's asset is a
    // second authorisation decision and belongs here so it is testable directly.
    if (!principal.scopes.includes("assets:read")) {
      throw new ApiError("FORBIDDEN", "Previewing requires both mappings:write and assets:read.", {
        details: { requiredScopes: ["mappings:write", "assets:read"] },
      });
    }

    // Validate before reading anything from the asset store: a broken spec must
    // never depend on whether an asset exists, and must not leak asset existence.
    const validated = normaliseAndValidate(input.spec);
    const validation = toValidationResult(validated.issues);
    if (!validated.definition) {
      throw new ApiError("MAPPING_VALIDATION_FAILED", "The mapping spec is not valid.", {
        details: { issues: validation.issues },
      });
    }
    const definition = validated.definition;

    const asset = await this.repos.assets.findById(principal.workspaceId, input.assetId);
    if (!asset) throw notFound("Asset");
    if (asset.sizeBytes > this.config.limits.maxPreviewInputBytes) {
      throw new ApiError(
        "PAYLOAD_TOO_LARGE",
        "The asset exceeds the preview input limit reported by GET /api/v1/healthz.",
      );
    }

    let bytes: Buffer;
    try {
      bytes = (await this.storage.get(asset.storageKey)).bytes;
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.code === "OBJECT_NOT_FOUND") throw notFound("Asset content");
        throw new ApiError("INTERNAL", "The stored asset could not be read.", { cause: error });
      }
      throw error;
    }

    const descriptor = {
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.contentType,
      buffer: bytes,
      sizeBytes: bytes.byteLength,
    };

    const registeredAdapters = new Set(bridge.listAdapters().map((adapter) => adapter.id));
    let selectedAdapterId: string | undefined;
    if (input.adapterId !== undefined) {
      if (!registeredAdapters.has(input.adapterId)) {
        throw validationFailed("The requested adapter is not registered.", {
          reason: "UNKNOWN_ADAPTER",
          adapterId: input.adapterId,
        });
      }
      selectedAdapterId = input.adapterId;
    } else {
      const metadataAdapterId = asset.metadata?.adapterId;
      // Stored metadata is a hint, not authority. An id no longer registered
      // (e.g. the adapter was removed after upload) must not reach the engine:
      // it reports that as a failed result, not an exception, which would turn
      // into a 200 preview that misnames its adapter.
      if (typeof metadataAdapterId === "string" && registeredAdapters.has(metadataAdapterId)) {
        selectedAdapterId = metadataAdapterId;
      } else {
        selectedAdapterId = (await bridge.detect(descriptor))[0]?.adapterId;
      }
    }
    if (!selectedAdapterId) {
      throw validationFailed("No adapter is compatible with this asset.", { reason: "NO_COMPATIBLE_ADAPTER" });
    }

    const maxRecords = Math.max(
      1,
      Math.min(
        input.maxRecords ?? this.config.limits.maxPreviewRecords,
        this.config.limits.maxPreviewRecords,
        MAX_PREVIEW_RECORDS_CEILING,
      ),
    );

    let result: TransformationResult;
    try {
      result = await bridge.transform({
        input: descriptor,
        mapping: definition,
        adapterId: selectedAdapterId,
        maxRecords,
        runId: `preview_${randomBytes(9).toString("hex")}`,
      });
    } catch (error) {
      if (error instanceof HealthBridgeError) {
        if (error.code === "NO_COMPATIBLE_ADAPTER") {
          throw validationFailed("No adapter is compatible with this asset.", { reason: "NO_COMPATIBLE_ADAPTER" });
        }
        throw new ApiError("VALIDATION_FAILED", "The mapping could not be previewed for this asset.", {
          details: { reason: error.code },
        });
      }
      throw error;
    }

    const preview: MappingPreview = {
      adapter: {
        id: result.adapterId ?? selectedAdapterId,
        version: result.adapterVersion ?? "unknown",
        format: result.sourceFormat,
      },
      recordsProcessed: result.recordsProcessed,
      recordsSucceeded: result.recordsSucceeded,
      recordsRejected: result.rejectedRecords.length,
      coverage: {
        ...result.coverage,
        unmappedSourceFields: result.coverage.unmappedSourceFields.slice(0, MAX_PREVIEW_DETAIL_ENTRIES),
        mappedFieldPaths: result.coverage.mappedFieldPaths?.slice(0, MAX_PREVIEW_DETAIL_ENTRIES),
        rejectedFieldPaths: result.coverage.rejectedFieldPaths?.slice(0, MAX_PREVIEW_DETAIL_ENTRIES),
        issues: result.coverage.issues.slice(0, MAX_MAPPING_ISSUES),
      },
      validation: result.validation,
      issues: result.validation.issues.slice(0, MAX_MAPPING_ISSUES),
      rejected: result.rejectedRecords
        .slice(0, MAX_REJECTED_RECORDS)
        .map(({ partialOutput: _partialOutput, ...rest }) => rest),
      sample: result.output.slice(0, MAX_SAMPLE_RECORDS),
      durationMs: result.durationMs,
      truncated: false,
      omitted: [],
      bytes: 0,
    };

    const limit = this.config.limits.maxPreviewBytes;
    let measured = this.measure(preview);

    if (measured > limit && preview.sample.length > 0) {
      preview.sample = [];
      preview.omitted.push("sample");
      measured = this.measure(preview);
    }
    if (measured > limit && preview.rejected.length > 0) {
      preview.rejected = [];
      preview.omitted.push("rejected");
      measured = this.measure(preview);
    }
    if (measured > limit) {
      const hasCoverageDetail =
        preview.coverage.unmappedSourceFields.length > 0 ||
        (preview.coverage.mappedFieldPaths?.length ?? 0) > 0 ||
        (preview.coverage.rejectedFieldPaths?.length ?? 0) > 0 ||
        preview.coverage.issues.length > 0;
      if (hasCoverageDetail) {
        preview.coverage.unmappedSourceFields = [];
        // Only clear optional arrays that the engine actually populated; an
        // absent array must stay absent so truncation does not change the shape.
        if (preview.coverage.mappedFieldPaths !== undefined) preview.coverage.mappedFieldPaths = [];
        if (preview.coverage.rejectedFieldPaths !== undefined) preview.coverage.rejectedFieldPaths = [];
        preview.coverage.issues = [];
        preview.omitted.push("coverage.detail");
        measured = this.measure(preview);
      }
    }
    if (measured > limit) {
      const hasIssues =
        preview.issues.length > 0 ||
        preview.validation.issues.length > 0 ||
        preview.validation.operationOutcomes !== undefined ||
        preview.coverage.issues.length > 0;
      if (hasIssues) {
        preview.issues = [];
        preview.validation.issues = [];
        preview.validation.operationOutcomes = undefined;
        preview.coverage.issues = [];
        preview.omitted.push("issues");
      }
    }

    // The byte limit is a target, not a failure: a preview that is still over
    // after every drop is returned with accurate bounds and `truncated: true`.
    preview.truncated = preview.omitted.length > 0;
    preview.bytes = this.measure(preview);

    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "mapping.previewed",
      targetType: "asset",
      targetId: input.assetId,
      outcome: "success",
      metadata: {
        assetId: input.assetId,
        adapterId: preview.adapter.id,
        maxRecords,
        rules: definition.rules.length,
        recordsProcessed: preview.recordsProcessed,
        recordsFailed: result.recordsFailed,
        bytes: preview.bytes,
        truncated: preview.truncated,
      },
      requestId: input.requestId,
      ip: input.ip,
    });

    return { validation, preview };
  }

  private measure(preview: MappingPreview): number {
    preview.bytes = 0;
    const json = JSON.stringify(preview);
    preview.bytes = Buffer.byteLength(json, "utf8");
    return preview.bytes;
  }
}
