import { randomBytes } from "node:crypto";
import type { Principal } from "@healthbridge/auth";
import { diffMappingDefinitions } from "@healthbridge/mapping-engine";
import {
  PersistenceError,
  type MappingDraftRecord,
  type MappingRecord,
  type Repositories,
} from "@healthbridge/persistence";
import type { MappingDiff, MappingDraft, MappingValidationResult } from "@healthbridge/shared-types";
import { ApiError, notFound, validationFailed } from "../common/errors.js";
import { mappingSpecChecksum, normaliseAndValidate, toValidationResult } from "../common/mapping-spec.js";
import type { AuditService } from "./audit.service.js";

/**
 * Mapping studio lifecycle.
 *
 * A draft is a mutable, optimistically versioned working copy; a published
 * mapping is an immutable version. Every operation is tenant-scoped through the
 * repositories and every write carries the expected revision, so two editors can
 * never silently overwrite each other.
 */

export interface MappingStudioDeps {
  repos: Repositories;
  audit: AuditService;
  now?: () => Date;
  idFactory?: () => string;
}

export interface MappingDraftView {
  draft: MappingDraft | null;
  latest: MappingRecord | null;
  validation: MappingValidationResult | null;
}

export interface PublishMappingResult {
  mapping: MappingRecord;
  created: boolean;
  validation: MappingValidationResult;
  draftRetained?: boolean;
}

export interface RequestAuditContext {
  requestId?: string;
  ip?: string;
}

function draftConflict(currentRevision: number): ApiError {
  return new ApiError("DRAFT_CONFLICT", "The mapping draft has changed since it was loaded.", {
    details: { currentRevision },
  });
}

function toDraft(record: MappingDraftRecord): MappingDraft {
  return {
    name: record.name,
    revision: record.revision,
    ...(record.baseVersion === undefined ? {} : { baseVersion: record.baseVersion }),
    spec: record.spec,
    specChecksum: record.specChecksum,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.updatedBy === undefined ? {} : { updatedBy: record.updatedBy }),
  };
}

function normaliseDiffToken(token: string | undefined, field: "from" | "to", fallback: string): string {
  if (token === undefined || token === "") return fallback;
  if (token === "latest" || token === "draft") return token;
  if (/^\d+$/.test(token)) {
    const version = Number(token);
    if (Number.isInteger(version) && version >= 1) return String(version);
  }
  throw validationFailed(`'${field}' must be 'latest', 'draft', or a positive integer version.`);
}

export class MappingStudioService {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(deps: MappingStudioDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => `mp_${randomBytes(9).toString("hex")}`);
  }

  public async getDraft(principal: Principal, name: string): Promise<MappingDraftView> {
    const [draft, latest] = await Promise.all([
      this.repos.mappingDrafts.get(principal.workspaceId, name),
      this.repos.mappings.findLatestByName(principal.workspaceId, name),
    ]);
    if (!draft) return { draft: null, latest: latest ?? null, validation: null };

    return {
      draft: toDraft(draft),
      latest: latest ?? null,
      validation: toValidationResult(normaliseAndValidate(draft.spec, name).issues),
    };
  }

  public async saveDraft(
    principal: Principal,
    name: string,
    input: { spec: Record<string, unknown>; revision: number; baseVersion?: number },
    auditContext?: RequestAuditContext,
  ): Promise<MappingDraftView> {
    const workspaceId = principal.workspaceId;
    const existing = await this.repos.mappingDrafts.get(workspaceId, name);
    const currentRevision = existing?.revision ?? 0;
    if (input.revision !== currentRevision) throw draftConflict(currentRevision);

    const checksum = mappingSpecChecksum(input.spec);

    // Autosave sends the whole spec on every keystroke pause; an unchanged spec is
    // not a new revision and must not produce another audit event.
    if (existing && existing.specChecksum === checksum) {
      const latest = await this.repos.mappings.findLatestByName(workspaceId, name);
      return {
        draft: toDraft(existing),
        latest: latest ?? null,
        validation: toValidationResult(normaliseAndValidate(existing.spec, name).issues),
      };
    }

    const nowIso = this.now().toISOString();
    let saved: MappingDraftRecord;
    try {
      saved = await this.repos.mappingDrafts.save(
        {
          workspaceId,
          name,
          spec: input.spec,
          specChecksum: checksum,
          baseVersion: input.baseVersion ?? existing?.baseVersion,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
          updatedBy: principal.apiKeyId,
        },
        input.revision,
      );
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "CONFLICT") {
        const current = await this.repos.mappingDrafts.get(workspaceId, name);
        throw draftConflict(current?.revision ?? 0);
      }
      throw error;
    }

    // Invalid specs are stored on purpose: autosave must survive mid-edit and the
    // returned validation is what tells the editor what is still broken.
    const validation = toValidationResult(normaliseAndValidate(saved.spec, name).issues);
    await this.audit.record({
      workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "mapping.draft-saved",
      targetType: "mapping-draft",
      targetId: name,
      outcome: "success",
      metadata: { name, revision: saved.revision, specChecksum: checksum, issueCounts: validation.counts },
      requestId: auditContext?.requestId,
      ip: auditContext?.ip,
    });

    const latest = await this.repos.mappings.findLatestByName(workspaceId, name);
    return { draft: toDraft(saved), latest: latest ?? null, validation };
  }

  public async discardDraft(
    principal: Principal,
    name: string,
    expectedRevision: number | undefined,
    auditContext?: RequestAuditContext,
  ): Promise<void> {
    const workspaceId = principal.workspaceId;
    const existing = await this.repos.mappingDrafts.get(workspaceId, name);
    if (!existing) return;
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw draftConflict(existing.revision);
    }

    const deleted = await this.repos.mappingDrafts.delete(workspaceId, name, expectedRevision);
    if (!deleted) {
      const current = await this.repos.mappingDrafts.get(workspaceId, name);
      if (current) throw draftConflict(current.revision);
      return;
    }

    // A revision supplied by the caller is enforced by the conditional delete
    // above (a mismatch is a 409). A no-revision delete can race a concurrent
    // save between the read and the delete; the event then names the revision
    // that was observed, not necessarily the one removed. The web client always
    // sends the revision, so that window is not reachable from the editor.
    await this.audit.record({
      workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "mapping.draft-discarded",
      targetType: "mapping-draft",
      targetId: name,
      outcome: "success",
      metadata: { name, revision: existing.revision },
      requestId: auditContext?.requestId,
      ip: auditContext?.ip,
    });
  }

  public async publish(
    principal: Principal,
    name: string,
    input: { revision: number },
    auditContext?: RequestAuditContext,
  ): Promise<PublishMappingResult> {
    const workspaceId = principal.workspaceId;
    const draft = await this.repos.mappingDrafts.get(workspaceId, name);
    if (!draft) throw notFound("Mapping draft");
    if (input.revision !== draft.revision) throw draftConflict(draft.revision);

    const validated = normaliseAndValidate(draft.spec, name);
    const validation = toValidationResult(validated.issues);
    if (!validated.definition) {
      throw new ApiError("MAPPING_VALIDATION_FAILED", "The mapping draft is not valid and cannot be published.", {
        details: { issues: validation.issues },
      });
    }
    const definition = validated.definition;

    const latest = await this.repos.mappings.findLatestByName(workspaceId, name);
    if (latest && latest.specChecksum === draft.specChecksum) {
      return this.finishIdempotentPublish(principal, name, latest, draft, validation, auditContext);
    }

    const nowIso = this.now().toISOString();
    let mapping: MappingRecord;
    try {
      // No explicit version: the repository assigns latest+1 and fails on a race.
      mapping = await this.repos.mappings.create({
        id: this.idFactory(),
        workspaceId,
        name,
        spec: draft.spec,
        specChecksum: draft.specChecksum,
        sourceFormat: definition.sourceFormat,
        targetFormat: definition.targetFormat,
        targetResourceType: definition.targetResourceType,
        createdAt: nowIso,
        createdBy: principal.apiKeyId,
      });
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "CONFLICT") {
        const raced = await this.repos.mappings.findLatestByName(workspaceId, name);
        if (raced && raced.specChecksum === draft.specChecksum) {
          return this.finishIdempotentPublish(principal, name, raced, draft, validation, auditContext);
        }
        throw new ApiError("CONFLICT", "A concurrent publish created a different mapping version.");
      }
      throw error;
    }

    const retained = await this.deleteDraftForPublish(workspaceId, name, draft.revision);
    await this.auditPublished(principal, mapping, draft, false, auditContext);

    return {
      mapping,
      created: true,
      validation,
      ...(retained ? { draftRetained: true } : {}),
    };
  }

  public async diff(
    principal: Principal,
    name: string,
    fromToken: string | undefined,
    toToken: string | undefined,
  ): Promise<{ name: string; from: string; to: string; diff: MappingDiff }> {
    const from = normaliseDiffToken(fromToken, "from", "latest");
    const to = normaliseDiffToken(toToken, "to", "draft");
    const workspaceId = principal.workspaceId;

    const fromSpec = await this.resolveDiffSpec(workspaceId, name, from);
    const toSpec = await this.resolveDiffSpec(workspaceId, name, to);

    const fromValidated = normaliseAndValidate(fromSpec, name);
    if (!fromValidated.definition) {
      throw new ApiError("MAPPING_VALIDATION_FAILED", "The 'from' mapping is not valid.", {
        details: { side: "from", issues: fromValidated.issues },
      });
    }
    const toValidated = normaliseAndValidate(toSpec, name);
    if (!toValidated.definition) {
      throw new ApiError("MAPPING_VALIDATION_FAILED", "The 'to' mapping is not valid.", {
        details: { side: "to", issues: toValidated.issues },
      });
    }

    return { name, from, to, diff: diffMappingDefinitions(fromValidated.definition, toValidated.definition) };
  }

  private async finishIdempotentPublish(
    principal: Principal,
    name: string,
    mapping: MappingRecord,
    draft: MappingDraftRecord,
    validation: MappingValidationResult,
    auditContext?: RequestAuditContext,
  ): Promise<PublishMappingResult> {
    const retained = await this.deleteDraftForPublish(principal.workspaceId, name, draft.revision);
    await this.auditPublished(principal, mapping, draft, true, auditContext);

    return {
      mapping,
      created: false,
      validation,
      ...(retained ? { draftRetained: true } : {}),
    };
  }

  /** R20 pins the published event's metadata set; one helper keeps both paths identical. */
  private async auditPublished(
    principal: Principal,
    mapping: MappingRecord,
    draft: MappingDraftRecord,
    idempotent: boolean,
    auditContext?: RequestAuditContext,
  ): Promise<void> {
    await this.audit.record({
      workspaceId: principal.workspaceId,
      actorKeyId: principal.apiKeyId,
      action: "mapping.published",
      targetType: "mapping",
      targetId: mapping.id,
      outcome: "success",
      metadata: {
        name: mapping.name,
        mappingId: mapping.id,
        version: mapping.version,
        revision: draft.revision,
        specChecksum: draft.specChecksum,
        idempotent,
      },
      requestId: auditContext?.requestId,
      ip: auditContext?.ip,
    });
  }

  /** Returns true when a newer draft survived the conditional delete. */
  private async deleteDraftForPublish(workspaceId: string, name: string, revision: number): Promise<boolean> {
    const deleted = await this.repos.mappingDrafts.delete(workspaceId, name, revision);
    if (deleted) return false;
    const current = await this.repos.mappingDrafts.get(workspaceId, name);
    return current !== undefined;
  }

  private async resolveDiffSpec(workspaceId: string, name: string, token: string): Promise<unknown> {
    if (token === "latest") {
      const mapping = await this.repos.mappings.findLatestByName(workspaceId, name);
      if (!mapping) throw notFound("Mapping");
      return mapping.spec;
    }
    if (token === "draft") {
      const draft = await this.repos.mappingDrafts.get(workspaceId, name);
      if (!draft) throw notFound("Mapping draft");
      return draft.spec;
    }

    const version = Number(token);
    const mapping = (await this.repos.mappings.versions(workspaceId, name)).find((item) => item.version === version);
    if (!mapping) throw notFound("Mapping version");
    return mapping.spec;
  }
}
