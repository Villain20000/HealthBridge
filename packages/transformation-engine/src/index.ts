import { createHash } from "node:crypto";
import {
  CoverageReport,
  DataLossReport,
  ENGINE_VERSION,
  InputDescriptor,
  LiveCheckpointStage,
  MedicalDataEnvelope,
  RejectedRecord,
  RunCheckpoint,
  TransformationResult,
  ValidationIssue,
  ValidationReport,
} from "@healthbridge/shared-types";
import { AdapterRegistry, MedicalFormatAdapter, computeChecksum } from "@healthbridge/core";
import { createBuiltInAdapters } from "@healthbridge/adapters";
import {
  MappingDefinition,
  MappingEngine,
  MappingExecutionResult,
  RuleExecutionResult,
} from "@healthbridge/mapping-engine";
import { TraceCollector } from "@healthbridge/trace-protocol";
import { TargetBuilderRegistry, defaultTargetBuilderRegistry, BuildResult } from "@healthbridge/target-builders";
import { FhirValidator, TerminologyProvider } from "@healthbridge/validation";

export interface TransformOptions {
  input: InputDescriptor;
  mapping: MappingDefinition;
  adapterId?: string;
  runId?: string;
  maxRecords?: number;
  /** `false` keeps raw snippets in traces. Only for local, non-persisted debugging. */
  redactSensitiveData?: boolean;
  /** Fixed import timestamp for reproducible runs. Defaults to the run start. */
  importedAt?: string;
  pipelineVersion?: string;
  /**
   * Optional terminology provider. When set (and the target is FHIR), every
   * record is validated with `validateWithDetail`, so validation level 5
   * reports `executed` end-to-end. Providers are injected by the operator —
   * licensed code systems are never bundled — and only the injected
   * provider's name appears in the report.
   */
  terminology?: TerminologyProvider;
}

/** One emitted slice of a streaming run: the records mapped since the last batch. */
export interface StreamBatch {
  batchIndex: number;
  /** Indexes of the records processed in this batch (including rejected ones). */
  recordIndexes: number[];
  /** Successfully produced resources, in record order. */
  resources: unknown[];
}

export interface EnvelopeStreamOptions {
  /** Envelopes are consumed incrementally — never buffered by the pipeline. */
  envelopes: AsyncIterable<MedicalDataEnvelope>;
  mapping: MappingDefinition;
  adapterId?: string;
  adapterVersion?: string;
  sourceFormat?: string;
  /**
   * Adapter-level issues collected while streaming. The pipeline reads this
   * array when the run finalises, so a live array fed by the parser's
   * `onIssue` channel works: issues reported mid-stream are still counted.
   */
  parseIssues?: ValidationIssue[];
  /** Checksum of the streamed input, when the producer computed one. */
  inputChecksum?: string;
  runId?: string;
  maxRecords?: number;
  /** `false` keeps raw snippets in traces. Only for local, non-persisted debugging. */
  redactSensitiveData?: boolean;
  /** Fixed import timestamp for reproducible runs. Defaults to the run start. */
  importedAt?: string;
  pipelineVersion?: string;
  /** Same threading as `TransformOptions.terminology`: level 5 executes when set. */
  terminology?: TerminologyProvider;
  /** Records per `onBatch` callback. Defaults to 500. */
  batchSize?: number;
  onBatch?: (batch: StreamBatch) => void | Promise<void>;
}

export interface RecordTraceDetail {
  recordIndex: number;
  ruleResults: RuleExecutionResult[];
}

/** Structured source of one envelope: mapping-shaped data, or `{}` when absent. */
function structuredSourceOf(envelope: MedicalDataEnvelope): Record<string, unknown> {
  return envelope.content.kind === "structured" && envelope.content.data && typeof envelope.content.data === "object"
    ? (envelope.content.data as Record<string, unknown>)
    : {};
}

/** Validation level reporting shared by `execute` and `executeEnvelopes`. */
function buildLevelReports(args: {
  validationExecuted: boolean;
  adapterId: string;
  targetFormat: string;
  terminologyName?: string;
}): ValidationReport["levels"] {
  return [
    { level: 1, name: "source-structural", status: "executed", validator: args.adapterId },
    { level: 2, name: "mapping-definition", status: "executed", validator: "mapping-engine" },
    args.validationExecuted
      ? {
          level: 3 as const,
          name: "target-structural",
          status: "executed" as const,
          validator: "fhir-r4-validator",
        }
      : {
          level: 3 as const,
          name: "target-structural",
          status: "skipped" as const,
          reason: `no validator for target format '${args.targetFormat}'`,
        },
    {
      level: 4 as const,
      name: "profile",
      status: "skipped" as const,
      reason: "requires an external validator adapter (Phase F)",
    },
    args.validationExecuted && args.terminologyName
      ? {
          level: 5 as const,
          name: "terminology",
          status: "executed" as const,
          validator: args.terminologyName,
        }
      : {
          level: 5 as const,
          name: "terminology",
          status: "skipped" as const,
          reason: "requires licensed code systems (Phase F)",
        },
    {
      level: 6 as const,
      name: "referential-integrity",
      status: "skipped" as const,
      reason: "lands with Bundle workflows (Phase F)",
    },
  ];
}

/** Mutable aggregation for one mapping phase; consumed incrementally or buffered. */
interface MappingPhaseState {
  mapping: MappingDefinition;
  adapterId?: string;
  adapterVersion?: string;
  pipelineVersion: string;
  tracer: TraceCollector;
  validationExecuted: boolean;
  terminology?: TerminologyProvider;
  terminologyName?: string;
  builderId?: string;
  output: unknown[];
  rejectedRecords: RejectedRecord[];
  recordIssues: ValidationIssue[];
  rejectedValues: DataLossReport["rejectedValues"];
  mappedPaths: Set<string>;
  unmappedPaths: Set<string>;
  rejectedPaths: Set<string>;
  seenResourceIds: Map<string, number[]>;
  validationIssues: ValidationIssue[];
  operationOutcomes: Array<Record<string, unknown>>;
  targetFieldsPopulated: number;
  recordsSucceeded: number;
  validationIsValid: boolean;
}

const EMPTY_COVERAGE: CoverageReport = {
  totalSourceFields: 0,
  mappedSourceFields: 0,
  unmappedSourceFields: [],
  coveragePercentage: 0,
  targetFieldsPopulated: 0,
  rejectedValuesCount: 0,
  preservedExtensionsCount: 0,
  issues: [],
  mappedFieldPaths: [],
  rejectedFieldPaths: [],
  recordsConsidered: 0,
};

/**
 * End-to-end transformation pipeline:
 * detect → select adapter → parse → envelope → map → report.
 *
 * Invariants enforced here:
 *  - a record that cannot be produced is reported in `rejectedRecords`, never dropped;
 *  - coverage is aggregated across all records (it used to be "last record wins");
 *  - every run reports what was parsed, what was mapped, and what was lost.
 */
export class TransformationPipeline {
  private readonly registry: AdapterRegistry;
  private readonly mappingEngine: MappingEngine;
  private readonly builders: TargetBuilderRegistry;
  private readonly fhirValidator: FhirValidator;

  constructor(adapters?: MedicalFormatAdapter[], builders: TargetBuilderRegistry = defaultTargetBuilderRegistry) {
    this.registry = new AdapterRegistry();
    for (const adapter of adapters ?? createBuiltInAdapters()) {
      this.registry.register(adapter);
    }
    this.mappingEngine = new MappingEngine();
    this.builders = builders;
    this.fhirValidator = new FhirValidator();
  }

  public getRegistry(): AdapterRegistry {
    return this.registry;
  }

  private initMappingState(args: {
    mapping: MappingDefinition;
    adapterId?: string;
    adapterVersion?: string;
    pipelineVersion: string;
    tracer: TraceCollector;
    terminology?: TerminologyProvider;
  }): MappingPhaseState {
    const resolvedBuilder = this.builders.resolve({
      id: args.mapping.id,
      version: args.mapping.version,
      targetFormat: args.mapping.targetFormat,
      targetResourceType: args.mapping.targetResourceType,
      targetProfile: args.mapping.targetProfile,
    });
    return {
      mapping: args.mapping,
      adapterId: args.adapterId,
      adapterVersion: args.adapterVersion,
      pipelineVersion: args.pipelineVersion,
      tracer: args.tracer,
      validationExecuted: args.mapping.targetFormat === "fhir-r4",
      terminology: args.terminology,
      terminologyName: args.terminology?.name,
      builderId: resolvedBuilder?.id,
      output: [],
      rejectedRecords: [],
      recordIssues: [],
      rejectedValues: [],
      mappedPaths: new Set<string>(),
      unmappedPaths: new Set<string>(),
      rejectedPaths: new Set<string>(),
      seenResourceIds: new Map<string, number[]>(),
      validationIssues: [],
      operationOutcomes: [],
      targetFieldsPopulated: 0,
      recordsSucceeded: 0,
      validationIsValid: true,
    };
  }

  /**
   * Map, build, validate and aggregate ONE record. Shared by `execute` and
   * `executeEnvelopes`, so the buffered and streaming paths report identically.
   */
  private processRecord(
    state: MappingPhaseState,
    envelope: MedicalDataEnvelope,
    index: number,
    result: MappingExecutionResult,
  ): void {
    const sourceData = structuredSourceOf(envelope);
    const recordStart = Date.now();

    // Target-format construction: required elements, id hygiene, profile, provenance.
    const buildStart = Date.now();
    const build: BuildResult | undefined = this.builders.build({
      data: result.targetData,
      mapping: {
        id: state.mapping.id,
        version: state.mapping.version,
        targetFormat: state.mapping.targetFormat,
        targetResourceType: state.mapping.targetResourceType,
        targetProfile: state.mapping.targetProfile,
      },
      envelopeId: envelope.id,
      adapterId: state.adapterId ?? "unknown",
      adapterVersion: state.adapterVersion ?? "unknown",
      importedAt: envelope.provenance.importedAt,
      sensitivity: envelope.classification.sensitivity,
    });
    const targetResource = (build?.resource ?? result.targetData) as Record<string, unknown>;
    const buildIssues: ValidationIssue[] = (build?.issues ?? []).map((issue) => ({ ...issue, recordIndex: index }));
    if (!build) {
      buildIssues.push({
        code: "TARGET_BUILDER_MISSING",
        severity: "warning",
        message: `No target builder for '${state.mapping.targetFormat}'; output was not validated against the target standard`,
        recordIndex: index,
        advice: "Output is mapping-shaped only.",
      });
    }
    state.tracer.emit({
      stepId: "target-build",
      stepName: "Target Resource Construction",
      stage: "build",
      recordIndex: index,
      recordId: envelope.id,
      pipelineVersion: state.pipelineVersion,
      status: build?.rejected ? "error" : buildIssues.some((i) => i.severity === "warning") ? "warning" : "success",
      durationMs: Date.now() - buildStart,
      outputSnippet: targetResource,
      issues: buildIssues,
    });

    // Target-standard validation (level 3). Levels 4 and 6 are reported as
    // skipped; level 5 executes when a terminology provider was supplied.
    const validateStart = Date.now();
    let recordValidationIssues: ValidationIssue[] = [];
    if (state.validationExecuted) {
      const validation = state.terminology
        ? this.fhirValidator.validateWithDetail(targetResource, { terminology: state.terminology })
        : this.fhirValidator.validate(targetResource);
      recordValidationIssues = validation.issues.map((issue) => ({ ...issue, recordIndex: index }));
      state.operationOutcomes.push(validation.operationOutcome as unknown as Record<string, unknown>);
      state.validationIssues.push(...recordValidationIssues);
      if (!validation.isValid) state.validationIsValid = false;
      state.tracer.emit({
        stepId: "target-validation",
        stepName: "FHIR R4 Structural Validation",
        stage: "validate",
        recordIndex: index,
        recordId: envelope.id,
        pipelineVersion: state.pipelineVersion,
        status: validation.isValid ? "success" : "error",
        durationMs: Date.now() - validateStart,
        issues: recordValidationIssues,
        validationState: validation.isValid ? "valid" : "invalid",
      });
    }

    const recordIssues = [
      ...(envelope.parseIssues ?? []).map((issue) => ({ ...issue, recordIndex: index })),
      ...result.issues.map((issue) => ({ ...issue, recordIndex: index })),
      ...buildIssues,
      ...recordValidationIssues,
    ];
    state.recordIssues.push(...recordIssues);

    for (const path of result.coverage.mappedFieldPaths ?? []) state.mappedPaths.add(path);
    for (const path of result.coverage.unmappedSourceFields) state.unmappedPaths.add(path);
    for (const path of result.coverage.rejectedFieldPaths ?? []) state.rejectedPaths.add(path);
    state.targetFieldsPopulated += result.coverage.targetFieldsPopulated;

    for (const ruleResult of result.ruleResults) {
      if (ruleResult.status === "rejected") {
        const ruleIssue = result.issues.find((i) => i.ruleId === ruleResult.ruleId);
        state.rejectedValues.push({
          recordIndex: index,
          path: ruleResult.sourcePath,
          code: ruleIssue?.code ?? "VALUE_REJECTED",
        });
      }
    }

    const blocking: ValidationIssue[] = recordIssues.filter((i) => i.severity === "fatal" || i.severity === "error");
    if (build?.rejected && blocking.length === 0) {
      blocking.push({
        code: "TARGET_BUILD_REJECTED",
        severity: "error",
        message: "Target resource could not be constructed from this record",
        recordIndex: index,
      });
    }
    const hasWarning = recordIssues.some((i) => i.severity === "warning");

    if (blocking.length > 0) {
      state.rejectedRecords.push({
        recordIndex: index,
        envelopeId: envelope.id,
        sourceLocation: envelope.provenance.sourceLocation,
        partialOutput: targetResource,
        issues: blocking,
      });

      state.tracer.emit({
        stepId: "semantic-mapping",
        stepName: "Semantic Mapping",
        stage: "mapping",
        recordIndex: index,
        recordId: envelope.id,
        adapterId: state.adapterId,
        adapterVersion: state.adapterVersion,
        pipelineVersion: state.pipelineVersion,
        status: "error",
        durationMs: Date.now() - recordStart,
        inputSnippet: sourceData,
        outputSnippet: result.targetData,
        sourcePath: blocking[0]?.path,
        ruleId: blocking[0]?.ruleId,
        issues: recordIssues,
      });
      return;
    }

    state.recordsSucceeded++;
    state.output.push(targetResource);

    const resourceId = targetResource.id;
    if (typeof resourceId === "string" && resourceId !== "") {
      const key = `${String(targetResource.resourceType ?? state.mapping.targetResourceType ?? "Resource")}/${resourceId}`;
      const existing = state.seenResourceIds.get(key) ?? [];
      existing.push(index);
      state.seenResourceIds.set(key, existing);
    }

    state.tracer.emit({
      stepId: "semantic-mapping",
      stepName: "Semantic Mapping",
      stage: "mapping",
      recordIndex: index,
      recordId: envelope.id,
      adapterId: state.adapterId,
      adapterVersion: state.adapterVersion,
      pipelineVersion: state.pipelineVersion,
      status: hasWarning ? "warning" : "success",
      durationMs: Date.now() - recordStart,
      inputSnippet: sourceData,
      outputSnippet: result.targetData,
      issues: recordIssues,
    });
  }

  private finalizeMapping(
    state: MappingPhaseState,
    args: {
      recordsProcessed: number;
      parseIssues: ValidationIssue[];
      sourceFormat: string;
      inputChecksum?: string;
      runId: string;
      runImportedAt: string;
      startTime: number;
    },
  ): TransformationResult {
    const allIssues = [...args.parseIssues, ...state.recordIssues];

    for (const [key, indexes] of state.seenResourceIds) {
      if (indexes.length > 1) {
        allIssues.push({
          code: "DUPLICATE_RESOURCE_ID",
          severity: "warning",
          message: `Resource id '${key}' is produced by ${indexes.length} records (record indexes: ${indexes.join(", ")})`,
          path: "id",
          recordIndex: indexes[0],
          advice: "Define a unique identifier in the mapping, or deduplicate upstream.",
        });
      }
    }

    const unmappedFieldList = Array.from(state.unmappedPaths).sort();
    const coverage: CoverageReport = {
      totalSourceFields: new Set([...state.mappedPaths, ...state.unmappedPaths]).size,
      mappedSourceFields: state.mappedPaths.size,
      unmappedSourceFields: unmappedFieldList,
      coveragePercentage:
        state.mappedPaths.size + state.unmappedPaths.size > 0
          ? Math.round((state.mappedPaths.size / (state.mappedPaths.size + state.unmappedPaths.size)) * 100)
          : 100,
      targetFieldsPopulated: state.targetFieldsPopulated,
      rejectedValuesCount: state.rejectedValues.length,
      preservedExtensionsCount: 0,
      issues: allIssues,
      mappedFieldPaths: Array.from(state.mappedPaths).sort(),
      rejectedFieldPaths: Array.from(state.rejectedPaths).sort(),
      recordsConsidered: args.recordsProcessed,
    };

    if (args.recordsProcessed > 0 && coverage.coveragePercentage < 50) {
      allIssues.push({
        code: "LOW_MAPPING_COVERAGE",
        severity: "warning",
        message: `Only ${coverage.coveragePercentage}% of source fields are mapped; ${unmappedFieldList.length} field(s) are unused`,
        advice: "Check that this mapping targets the right domain, or extend it to cover the remaining fields.",
      });
    }

    const adapterNotes = args.parseIssues.map((i) => `${i.code}: ${i.message}`);
    const dataLoss: DataLossReport = {
      unmappedFields: unmappedFieldList,
      rejectedValues: state.rejectedValues,
      droppedRecordIndexes: state.rejectedRecords.map((r) => r.recordIndex),
      adapterNotes,
      isLossless:
        unmappedFieldList.length === 0 &&
        state.rejectedValues.length === 0 &&
        state.rejectedRecords.length === 0 &&
        adapterNotes.length === 0,
    };

    const validationReport: ValidationReport = {
      standard: state.mapping.targetFormat,
      isValid: state.validationExecuted ? state.validationIsValid : false,
      levels: buildLevelReports({
        validationExecuted: state.validationExecuted,
        adapterId: state.adapterId ?? "unknown",
        targetFormat: state.mapping.targetFormat,
        terminologyName: state.terminologyName,
      }),
      issues: state.validationIssues,
      operationOutcomes: state.operationOutcomes,
    };

    const hasWarnings = allIssues.some((i) => i.severity === "warning");
    const hasFatal = allIssues.some((i) => i.severity === "fatal");
    const status: TransformationResult["status"] =
      hasFatal || (args.recordsProcessed > 0 && state.recordsSucceeded === 0)
        ? "failed"
        : state.rejectedRecords.length > 0 || hasWarnings || adapterNotes.length > 0
          ? "completed_with_warnings"
          : "completed";

    state.tracer.emit({
      stepId: "export",
      stepName: "Export & Provenance",
      stage: "export",
      status: status === "completed" ? "success" : status === "failed" ? "error" : "warning",
      durationMs: Date.now() - args.startTime,
      outputSnippet: {
        recordsProcessed: args.recordsProcessed,
        recordsSucceeded: state.recordsSucceeded,
        recordsFailed: state.rejectedRecords.length,
        coveragePercentage: coverage.coveragePercentage,
        isLossless: dataLoss.isLossless,
        validationValid: validationReport.isValid,
        builder: state.builderId,
      },
      validationState: state.validationExecuted ? (validationReport.isValid ? "valid" : "invalid") : "skipped",
    });

    return {
      runId: args.runId,
      status,
      sourceFormat: args.sourceFormat,
      targetFormat: state.mapping.targetFormat,
      targetResourceType: state.mapping.targetResourceType,
      recordsProcessed: args.recordsProcessed,
      recordsSucceeded: state.recordsSucceeded,
      recordsFailed: state.rejectedRecords.length,
      output: state.output,
      coverage,
      rejectedRecords: state.rejectedRecords,
      dataLoss,
      validation: validationReport,
      traces: state.tracer.getEvents(),
      durationMs: Date.now() - args.startTime,
      importedAt: args.runImportedAt,
      inputChecksum: args.inputChecksum,
      outputChecksum: checksumOf(state.output),
      adapterId: state.adapterId,
      adapterVersion: state.adapterVersion,
      engineVersion: ENGINE_VERSION,
    };
  }

  private abortInvalidMapping(args: {
    tracer: TraceCollector;
    mapping: MappingDefinition;
    runId: string;
    runImportedAt: string;
    startTime: number;
    inputChecksum?: string;
    mappingIssues: ValidationIssue[];
  }): TransformationResult {
    args.tracer.emit({
      stepId: "mapping-validation",
      stepName: "Mapping Definition Validation",
      stage: "mapping",
      status: "error",
      issues: args.mappingIssues,
    });
    return {
      runId: args.runId,
      status: "failed",
      sourceFormat: "unknown",
      targetFormat: args.mapping.targetFormat,
      targetResourceType: args.mapping.targetResourceType,
      recordsProcessed: 0,
      recordsSucceeded: 0,
      recordsFailed: 0,
      output: [],
      coverage: { ...EMPTY_COVERAGE, issues: args.mappingIssues },
      rejectedRecords: [],
      dataLoss: {
        unmappedFields: [],
        rejectedValues: [],
        droppedRecordIndexes: [],
        adapterNotes: ["Run aborted: mapping definition is invalid"],
        isLossless: false,
      },
      validation: {
        standard: args.mapping.targetFormat,
        isValid: false,
        levels: skippedValidationLevels("Run aborted before validation"),
        issues: args.mappingIssues,
      },
      traces: args.tracer.getEvents(),
      durationMs: Date.now() - args.startTime,
      importedAt: args.runImportedAt,
      inputChecksum: args.inputChecksum,
      outputChecksum: checksumOf([]),
      adapterId: undefined,
      adapterVersion: undefined,
      engineVersion: ENGINE_VERSION,
    };
  }

  /**
   * Streaming twin of `execute`: consumes an envelope iterable incrementally
   * (only the current batch is ever retained) and calls `onBatch` as mapped
   * resources accumulate. The returned aggregate is identical in shape to
   * `execute` — same coverage, data-loss, validation-level and checksum
   * semantics — so buffered and streamed runs stay comparable.
   *
   * With `allowCrossRecordContext` the batch is necessarily buffered first
   * (cross-record references need random access to sources); otherwise
   * envelopes are mapped strictly one at a time.
   */
  public async executeEnvelopes(options: EnvelopeStreamOptions): Promise<TransformationResult> {
    const startTime = Date.now();
    const runId = options.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pipelineVersion = options.pipelineVersion ?? ENGINE_VERSION;
    const tracer = new TraceCollector({
      runId,
      redactSensitiveData: options.redactSensitiveData ?? true,
    });
    const runImportedAt = options.importedAt ?? new Date(startTime).toISOString();
    const parseIssues = options.parseIssues ?? [];
    const batchSize = options.batchSize !== undefined && options.batchSize > 0 ? Math.floor(options.batchSize) : 500;

    const mappingIssues = this.mappingEngine.validate(options.mapping);
    const mappingErrors = mappingIssues.filter((i) => i.severity === "error" || i.severity === "fatal");
    if (mappingErrors.length > 0) {
      return this.abortInvalidMapping({
        tracer,
        mapping: options.mapping,
        runId,
        runImportedAt,
        startTime,
        inputChecksum: options.inputChecksum,
        mappingIssues,
      });
    }

    if (mappingIssues.length > 0) {
      tracer.emit({
        stepId: "mapping-validation",
        stepName: "Mapping Definition Validation",
        stage: "mapping",
        status: "warning",
        issues: mappingIssues,
      });
    }

    const state = this.initMappingState({
      mapping: options.mapping,
      adapterId: options.adapterId,
      adapterVersion: options.adapterVersion,
      pipelineVersion,
      tracer,
      terminology: options.terminology,
    });

    let sourceFormat = options.sourceFormat;
    let processed = 0;
    let batchIndex = 0;
    let batchRecordIndexes: number[] = [];
    let batchOutputStart = 0;
    const emitBatch = async (): Promise<void> => {
      if (batchRecordIndexes.length === 0) return;
      await options.onBatch?.({
        batchIndex,
        recordIndexes: batchRecordIndexes,
        resources: state.output.slice(batchOutputStart),
      });
      batchIndex++;
      batchRecordIndexes = [];
      batchOutputStart = state.output.length;
    };

    const crossRecord = options.mapping.allowCrossRecordContext === true;
    const buffered: MedicalDataEnvelope[] = [];

    // Explicit iteration (not `for await`) so `maxRecords` stops the producer
    // before it is pulled again, and the producer is always released.
    const iterator = options.envelopes[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (options.maxRecords !== undefined && processed >= options.maxRecords) break;
        const next = await iterator.next();
        if (next.done) break;
        const envelope = next.value;
        if (sourceFormat === undefined) sourceFormat = envelope.source.format;
        if (state.adapterId === undefined) state.adapterId = envelope.provenance.adapterId;
        if (state.adapterVersion === undefined) state.adapterVersion = envelope.provenance.adapterVersion;
        if (processed === 0) {
          state.tracer.emit({
            stepId: "stream-start",
            stepName: "Streaming Consumption",
            stage: "parse",
            adapterId: state.adapterId,
            adapterVersion: state.adapterVersion,
            pipelineVersion,
            status: "success",
            outputSnippet: { sourceFormat },
          });
          if (
            options.mapping.sourceDomains &&
            options.mapping.sourceDomains.length > 0 &&
            !options.mapping.sourceDomains.includes(envelope.domain)
          ) {
            state.recordIssues.push({
              code: "DOMAIN_MISMATCH",
              severity: "warning",
              message: `Mapping '${options.mapping.id}' targets ${options.mapping.sourceDomains.join("/")} data but the source looks like '${envelope.domain}'`,
              advice: "Use a mapping designed for this domain, or review the source columns.",
            });
          }
        }
        if (crossRecord) {
          buffered.push(envelope);
        } else {
          const result = this.mappingEngine.execute(structuredSourceOf(envelope), options.mapping);
          this.processRecord(state, envelope, processed, result);
          batchRecordIndexes.push(processed);
          if (batchRecordIndexes.length >= batchSize) await emitBatch();
        }
        processed++;
      }
    } finally {
      await iterator.return?.();
    }

    if (crossRecord) {
      const sources = buffered.map((envelope) => structuredSourceOf(envelope));
      const results = this.mappingEngine.executeBatch(sources, options.mapping);
      for (let index = 0; index < buffered.length; index++) {
        this.processRecord(state, buffered[index], index, results[index]);
        batchRecordIndexes.push(index);
        if (batchRecordIndexes.length >= batchSize) await emitBatch();
      }
    }
    await emitBatch();

    tracer.emit({
      stepId: "structural-parsing",
      stepName: "Structural Parsing",
      stage: "parse",
      adapterId: state.adapterId,
      adapterVersion: state.adapterVersion,
      status: parseIssues.some((i) => i.severity === "fatal") ? "error" : "success",
      outputSnippet: { parsedRecords: processed },
      issues: parseIssues,
    });

    return this.finalizeMapping(state, {
      recordsProcessed: processed,
      parseIssues,
      sourceFormat: sourceFormat ?? "unknown",
      inputChecksum: options.inputChecksum,
      runId,
      runImportedAt,
      startTime,
    });
  }

  public async execute(options: TransformOptions): Promise<TransformationResult> {
    const startTime = Date.now();
    const runId = options.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pipelineVersion = options.pipelineVersion ?? ENGINE_VERSION;
    const tracer = new TraceCollector({
      runId,
      redactSensitiveData: options.redactSensitiveData ?? true,
    });
    const inputChecksum = computeChecksum(options.input);
    const runImportedAt = options.importedAt ?? new Date(startTime).toISOString();
    const parseIssues: ValidationIssue[] = [];

    const finish = (partial: {
      status: TransformationResult["status"];
      adapter?: MedicalFormatAdapter;
      recordsProcessed: number;
      recordsSucceeded: number;
      recordsFailed: number;
      output: unknown[];
      coverage: CoverageReport;
      rejectedRecords: RejectedRecord[];
      dataLoss: DataLossReport;
      validation?: ValidationReport;
      outputChecksum?: string;
    }): TransformationResult => ({
      runId,
      status: partial.status,
      sourceFormat: partial.adapter?.getManifest().format ?? "unknown",
      targetFormat: options.mapping.targetFormat,
      targetResourceType: options.mapping.targetResourceType,
      recordsProcessed: partial.recordsProcessed,
      recordsSucceeded: partial.recordsSucceeded,
      recordsFailed: partial.recordsFailed,
      output: partial.output,
      coverage: partial.coverage,
      rejectedRecords: partial.rejectedRecords,
      dataLoss: partial.dataLoss,
      validation: partial.validation ?? {
        standard: options.mapping.targetFormat,
        isValid: false,
        levels: skippedValidationLevels("Run aborted before validation"),
        issues: partial.coverage.issues,
      },
      traces: tracer.getEvents(),
      durationMs: Date.now() - startTime,
      importedAt: runImportedAt,
      inputChecksum,
      outputChecksum: partial.outputChecksum ?? checksumOf(partial.output),
      adapterId: partial.adapter?.id,
      adapterVersion: partial.adapter?.version,
      engineVersion: ENGINE_VERSION,
    });

    // 1. Static mapping validation.
    const mappingIssues = this.mappingEngine.validate(options.mapping);
    const mappingErrors = mappingIssues.filter((i) => i.severity === "error" || i.severity === "fatal");
    if (mappingErrors.length > 0) {
      return this.abortInvalidMapping({
        tracer,
        mapping: options.mapping,
        runId,
        runImportedAt,
        startTime,
        inputChecksum,
        mappingIssues,
      });
    }

    if (mappingIssues.length > 0) {
      tracer.emit({
        stepId: "mapping-validation",
        stepName: "Mapping Definition Validation",
        stage: "mapping",
        status: "warning",
        issues: mappingIssues,
      });
    }

    // 2. Adapter detection / selection.
    let adapter: MedicalFormatAdapter | undefined;
    if (options.adapterId) {
      adapter = this.registry.get(options.adapterId);
      if (!adapter) {
        const issue: ValidationIssue = {
          code: "UNKNOWN_ADAPTER",
          severity: "fatal",
          message: `Adapter '${options.adapterId}' is not registered`,
          advice: `Available adapters: ${this.registry
            .listAdapters()
            .map((a) => a.id)
            .join(", ")}`,
        };
        tracer.emit({
          stepId: "adapter-selection",
          stepName: "Adapter Selection",
          stage: "adapter-selection",
          status: "error",
          issues: [issue],
        });
        return finish({
          status: "failed",
          recordsProcessed: 0,
          recordsSucceeded: 0,
          recordsFailed: 0,
          output: [],
          coverage: { ...EMPTY_COVERAGE, issues: [issue] },
          rejectedRecords: [],
          dataLoss: {
            unmappedFields: [],
            rejectedValues: [],
            droppedRecordIndexes: [],
            adapterNotes: ["Run aborted: requested adapter is not registered"],
            isLossless: false,
          },
        });
      }
    } else {
      const candidates = await this.registry.detect(options.input);
      const [best] = candidates;
      adapter = best ? this.registry.get(best.adapterId) : undefined;

      tracer.emit({
        stepId: "format-detection",
        stepName: "Format Detection",
        stage: "detect",
        status: adapter ? "success" : "error",
        outputSnippet: {
          candidates: candidates.map((c) => ({ adapterId: c.adapterId, format: c.format, confidence: c.confidence })),
        },
        issues: adapter
          ? []
          : [
              {
                code: "NO_COMPATIBLE_ADAPTER",
                severity: "fatal",
                message: "No registered adapter accepted this input",
                advice: "Run `healthbridge formats list` to see supported formats.",
              },
            ],
      });
    }

    if (!adapter) {
      const issue: ValidationIssue = {
        code: "NO_COMPATIBLE_ADAPTER",
        severity: "fatal",
        message: "No compatible adapter found for the input payload.",
      };
      return finish({
        status: "failed",
        recordsProcessed: 0,
        recordsSucceeded: 0,
        recordsFailed: 0,
        output: [],
        coverage: { ...EMPTY_COVERAGE, issues: [issue] },
        rejectedRecords: [],
        dataLoss: {
          unmappedFields: [],
          rejectedValues: [],
          droppedRecordIndexes: [],
          adapterNotes: ["Run aborted: no adapter available"],
          isLossless: false,
        },
      });
    }

    tracer.emit({
      stepId: "adapter-selection",
      stepName: "Adapter Selection",
      stage: "adapter-selection",
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      status: "success",
      inputSnippet: { filename: options.input.filename, sizeBytes: options.input.sizeBytes },
      outputSnippet: { format: adapter.getManifest().format, capabilities: adapter.getManifest().capabilities },
    });

    // 3. Structural parsing.
    const parseStart = Date.now();
    const envelopes = [];
    try {
      for await (const envelope of adapter.parse(options.input, {
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        maxRecords: options.maxRecords,
        importedAt: runImportedAt,
        onIssue: (issue) => parseIssues.push(issue),
      })) {
        envelopes.push(envelope);
        if (options.maxRecords && envelopes.length >= options.maxRecords) break;
      }
    } catch (error) {
      const issue: ValidationIssue = {
        code: "ADAPTER_PARSE_ERROR",
        severity: "fatal",
        message: `Adapter '${adapter.id}' failed to parse the input: ${(error as Error).message}`,
      };
      parseIssues.push(issue);
      tracer.emit({
        stepId: "structural-parsing",
        stepName: "Structural Parsing",
        stage: "parse",
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        status: "error",
        durationMs: Date.now() - parseStart,
        issues: [issue],
      });
      return finish({
        status: "failed",
        adapter,
        recordsProcessed: 0,
        recordsSucceeded: 0,
        recordsFailed: 0,
        output: [],
        coverage: { ...EMPTY_COVERAGE, issues: parseIssues },
        rejectedRecords: [],
        dataLoss: {
          unmappedFields: [],
          rejectedValues: [],
          droppedRecordIndexes: [],
          adapterNotes: parseIssues.map((i) => i.message),
          isLossless: false,
        },
      });
    }

    tracer.emit({
      stepId: "structural-parsing",
      stepName: "Structural Parsing",
      stage: "parse",
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      status: parseIssues.some((i) => i.severity === "fatal") ? "error" : "success",
      durationMs: Date.now() - parseStart,
      outputSnippet: { parsedRecords: envelopes.length },
      issues: parseIssues,
    });

    // 4. Semantic mapping per record.
    const output: unknown[] = [];
    const rejectedRecords: RejectedRecord[] = [];
    const allIssues: ValidationIssue[] = [...parseIssues];
    const rejectedValues: DataLossReport["rejectedValues"] = [];
    const mappedPaths = new Set<string>();
    const unmappedPaths = new Set<string>();
    const rejectedPaths = new Set<string>();
    const seenResourceIds = new Map<string, number[]>();
    const validationIssues: ValidationIssue[] = [];
    const operationOutcomes: Array<Record<string, unknown>> = [];
    const resolvedBuilder = this.builders.resolve({
      id: options.mapping.id,
      version: options.mapping.version,
      targetFormat: options.mapping.targetFormat,
      targetResourceType: options.mapping.targetResourceType,
      targetProfile: options.mapping.targetProfile,
    });
    const builderId = resolvedBuilder?.id;
    const validationExecuted = options.mapping.targetFormat === "fhir-r4";
    let validationIsValid = true;
    let targetFieldsPopulated = 0;
    let recordsSucceeded = 0;

    if (
      options.mapping.sourceDomains &&
      options.mapping.sourceDomains.length > 0 &&
      envelopes.length > 0 &&
      !options.mapping.sourceDomains.includes(envelopes[0].domain)
    ) {
      allIssues.push({
        code: "DOMAIN_MISMATCH",
        severity: "warning",
        message: `Mapping '${options.mapping.id}' targets ${options.mapping.sourceDomains.join("/")} data but the source looks like '${envelopes[0].domain}'`,
        advice: "Use a mapping designed for this domain, or review the source columns.",
      });
    }

    const sources = envelopes.map((envelope) => structuredSourceOf(envelope));
    const mappingResults = options.mapping.allowCrossRecordContext
      ? this.mappingEngine.executeBatch(sources, options.mapping)
      : sources.map((source) => this.mappingEngine.execute(source, options.mapping));

    for (let index = 0; index < envelopes.length; index++) {
      const envelope = envelopes[index];
      const sourceData = sources[index];
      const recordStart = Date.now();
      const result = mappingResults[index];

      // Target-format construction: required elements, id hygiene, profile, provenance.
      const buildStart = Date.now();
      const build: BuildResult | undefined = this.builders.build({
        data: result.targetData,
        mapping: {
          id: options.mapping.id,
          version: options.mapping.version,
          targetFormat: options.mapping.targetFormat,
          targetResourceType: options.mapping.targetResourceType,
          targetProfile: options.mapping.targetProfile,
        },
        envelopeId: envelope.id,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        importedAt: envelope.provenance.importedAt,
        sensitivity: envelope.classification.sensitivity,
      });
      const targetResource = (build?.resource ?? result.targetData) as Record<string, unknown>;
      const buildIssues: ValidationIssue[] = (build?.issues ?? []).map((issue) => ({ ...issue, recordIndex: index }));
      if (!build) {
        buildIssues.push({
          code: "TARGET_BUILDER_MISSING",
          severity: "warning",
          message: `No target builder for '${options.mapping.targetFormat}'; output was not validated against the target standard`,
          recordIndex: index,
          advice: "Output is mapping-shaped only.",
        });
      }
      tracer.emit({
        stepId: "target-build",
        stepName: "Target Resource Construction",
        stage: "build",
        recordIndex: index,
        recordId: envelope.id,
        pipelineVersion,
        status: build?.rejected ? "error" : buildIssues.some((i) => i.severity === "warning") ? "warning" : "success",
        durationMs: Date.now() - buildStart,
        outputSnippet: targetResource,
        issues: buildIssues,
      });

      // Target-standard validation (level 3). Levels 4 and 6 are reported as
      // skipped; level 5 executes when a terminology provider was supplied.
      const validateStart = Date.now();
      let recordValidationIssues: ValidationIssue[] = [];
      if (validationExecuted) {
        const validation = options.terminology
          ? this.fhirValidator.validateWithDetail(targetResource, { terminology: options.terminology })
          : this.fhirValidator.validate(targetResource);
        recordValidationIssues = validation.issues.map((issue) => ({ ...issue, recordIndex: index }));
        operationOutcomes.push(validation.operationOutcome as unknown as Record<string, unknown>);
        validationIssues.push(...recordValidationIssues);
        if (!validation.isValid) validationIsValid = false;
        tracer.emit({
          stepId: "target-validation",
          stepName: "FHIR R4 Structural Validation",
          stage: "validate",
          recordIndex: index,
          recordId: envelope.id,
          pipelineVersion,
          status: validation.isValid ? "success" : "error",
          durationMs: Date.now() - validateStart,
          issues: recordValidationIssues,
          validationState: validation.isValid ? "valid" : "invalid",
        });
      }

      const recordIssues = [
        ...(envelope.parseIssues ?? []).map((issue) => ({ ...issue, recordIndex: index })),
        ...result.issues.map((issue) => ({ ...issue, recordIndex: index })),
        ...buildIssues,
        ...recordValidationIssues,
      ];
      allIssues.push(...recordIssues);

      for (const path of result.coverage.mappedFieldPaths ?? []) mappedPaths.add(path);
      for (const path of result.coverage.unmappedSourceFields) unmappedPaths.add(path);
      for (const path of result.coverage.rejectedFieldPaths ?? []) rejectedPaths.add(path);
      targetFieldsPopulated += result.coverage.targetFieldsPopulated;

      for (const ruleResult of result.ruleResults) {
        if (ruleResult.status === "rejected") {
          const ruleIssue = result.issues.find((i) => i.ruleId === ruleResult.ruleId);
          rejectedValues.push({
            recordIndex: index,
            path: ruleResult.sourcePath,
            code: ruleIssue?.code ?? "VALUE_REJECTED",
          });
        }
      }

      const blocking: ValidationIssue[] = recordIssues.filter((i) => i.severity === "fatal" || i.severity === "error");
      if (build?.rejected && blocking.length === 0) {
        blocking.push({
          code: "TARGET_BUILD_REJECTED",
          severity: "error",
          message: "Target resource could not be constructed from this record",
          recordIndex: index,
        });
      }
      const hasWarning = recordIssues.some((i) => i.severity === "warning");

      if (blocking.length > 0) {
        rejectedRecords.push({
          recordIndex: index,
          envelopeId: envelope.id,
          sourceLocation: envelope.provenance.sourceLocation,
          partialOutput: targetResource,
          issues: blocking,
        });

        tracer.emit({
          stepId: "semantic-mapping",
          stepName: "Semantic Mapping",
          stage: "mapping",
          recordIndex: index,
          recordId: envelope.id,
          adapterId: adapter.id,
          adapterVersion: adapter.version,
          pipelineVersion,
          status: "error",
          durationMs: Date.now() - recordStart,
          inputSnippet: sourceData,
          outputSnippet: result.targetData,
          sourcePath: blocking[0]?.path,
          ruleId: blocking[0]?.ruleId,
          issues: recordIssues,
        });
        continue;
      }

      recordsSucceeded++;
      output.push(targetResource);

      const resourceId = targetResource.id;
      if (typeof resourceId === "string" && resourceId !== "") {
        const key = `${String(targetResource.resourceType ?? options.mapping.targetResourceType ?? "Resource")}/${resourceId}`;
        const existing = seenResourceIds.get(key) ?? [];
        existing.push(index);
        seenResourceIds.set(key, existing);
      }

      tracer.emit({
        stepId: "semantic-mapping",
        stepName: "Semantic Mapping",
        stage: "mapping",
        recordIndex: index,
        recordId: envelope.id,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        pipelineVersion,
        status: hasWarning ? "warning" : "success",
        durationMs: Date.now() - recordStart,
        inputSnippet: sourceData,
        outputSnippet: result.targetData,
        issues: recordIssues,
      });
    }

    for (const [key, indexes] of seenResourceIds) {
      if (indexes.length > 1) {
        allIssues.push({
          code: "DUPLICATE_RESOURCE_ID",
          severity: "warning",
          message: `Resource id '${key}' is produced by ${indexes.length} records (record indexes: ${indexes.join(", ")})`,
          path: "id",
          recordIndex: indexes[0],
          advice: "Define a unique identifier in the mapping, or deduplicate upstream.",
        });
      }
    }

    const unmappedFieldList = Array.from(unmappedPaths).sort();
    const coverage: CoverageReport = {
      totalSourceFields: new Set([...mappedPaths, ...unmappedPaths]).size,
      mappedSourceFields: mappedPaths.size,
      unmappedSourceFields: unmappedFieldList,
      coveragePercentage:
        mappedPaths.size + unmappedPaths.size > 0
          ? Math.round((mappedPaths.size / (mappedPaths.size + unmappedPaths.size)) * 100)
          : 100,
      targetFieldsPopulated,
      rejectedValuesCount: rejectedValues.length,
      preservedExtensionsCount: 0,
      issues: allIssues,
      mappedFieldPaths: Array.from(mappedPaths).sort(),
      rejectedFieldPaths: Array.from(rejectedPaths).sort(),
      recordsConsidered: envelopes.length,
    };

    if (envelopes.length > 0 && coverage.coveragePercentage < 50) {
      allIssues.push({
        code: "LOW_MAPPING_COVERAGE",
        severity: "warning",
        message: `Only ${coverage.coveragePercentage}% of source fields are mapped; ${unmappedFieldList.length} field(s) are unused`,
        advice: "Check that this mapping targets the right domain, or extend it to cover the remaining fields.",
      });
    }

    const adapterNotes = parseIssues.map((i) => `${i.code}: ${i.message}`);
    const dataLoss: DataLossReport = {
      unmappedFields: unmappedFieldList,
      rejectedValues,
      droppedRecordIndexes: rejectedRecords.map((r) => r.recordIndex),
      adapterNotes,
      isLossless:
        unmappedFieldList.length === 0 &&
        rejectedValues.length === 0 &&
        rejectedRecords.length === 0 &&
        adapterNotes.length === 0,
    };

    const validationReport: ValidationReport = {
      standard: options.mapping.targetFormat,
      isValid: validationExecuted ? validationIsValid : false,
      levels: buildLevelReports({
        validationExecuted,
        adapterId: adapter.id,
        targetFormat: options.mapping.targetFormat,
        terminologyName: options.terminology?.name,
      }),
      issues: validationIssues,
      operationOutcomes,
    };

    const hasWarnings = allIssues.some((i) => i.severity === "warning");
    const hasFatal = allIssues.some((i) => i.severity === "fatal");
    const status: TransformationResult["status"] =
      hasFatal || (envelopes.length > 0 && recordsSucceeded === 0)
        ? "failed"
        : rejectedRecords.length > 0 || hasWarnings || adapterNotes.length > 0
          ? "completed_with_warnings"
          : "completed";

    tracer.emit({
      stepId: "export",
      stepName: "Export & Provenance",
      stage: "export",
      status: status === "completed" ? "success" : status === "failed" ? "error" : "warning",
      durationMs: Date.now() - startTime,
      outputSnippet: {
        recordsProcessed: envelopes.length,
        recordsSucceeded,
        recordsFailed: rejectedRecords.length,
        coveragePercentage: coverage.coveragePercentage,
        isLossless: dataLoss.isLossless,
        validationValid: validationReport.isValid,
        builder: builderId,
      },
      validationState: validationExecuted ? (validationReport.isValid ? "valid" : "invalid") : "skipped",
    });

    return finish({
      status,
      adapter,
      recordsProcessed: envelopes.length,
      recordsSucceeded,
      recordsFailed: rejectedRecords.length,
      output,
      coverage,
      rejectedRecords,
      dataLoss,
      validation: validationReport,
    });
  }

  /**
   * Chunked, pausable twin of `execute`.
   *
   * `execute()` is untouched: when this method runs to completion without a
   * pause or cancellation it reports exactly what `execute()` reports for the
   * same input, mapping and `importedAt` (same output, coverage, data-loss,
   * validation levels and checksums).
   *
   * Differences, all additive:
   *  - records are mapped in chunks (`chunkSize`, default 100). After every
   *    chunk a {@link RunCheckpoint} (`stage` + next `recordIndex` +
   *    input/output checksums) is emitted through `onCheckpoint`;
   *  - `signal` is honoured at every chunk boundary (cooperative
   *    cancellation: the in-flight chunk finishes first);
   *  - `shouldPause()` is honoured at the same boundaries and returns a
   *    `paused` outcome that keeps its checkpoint — unlike `cancelled`, which
   *    drops it;
   *  - `resumeFrom` replays the run deterministically from the first record
   *    with the checkpoint's reproducibility anchor (`importedAt`) after
   *    validating its `inputChecksum`, so the resumed result is byte-identical
   *    to an uninterrupted run. (Prefix state such as coverage unions is
   *    rebuilt by the replay rather than serialised into the checkpoint.)
   *
   * Static replay (`replay`, bundles, `reproduce`) keeps using `execute()` and
   * is never routed through here, so nothing stored is ever relabelled "live".
   */
  public async executeChunked(options: ChunkedExecuteOptions): Promise<ChunkedExecuteOutcome> {
    const startTime = Date.now();
    const runId = options.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pipelineVersion = options.pipelineVersion ?? ENGINE_VERSION;
    const tracer = new TraceCollector({
      runId,
      redactSensitiveData: options.redactSensitiveData ?? true,
    });
    const inputChecksum = computeChecksum(options.input);
    const runImportedAt = options.importedAt ?? new Date(startTime).toISOString();
    const parseIssues: ValidationIssue[] = [];
    const chunkSize =
      options.chunkSize !== undefined && options.chunkSize > 0 ? Math.floor(options.chunkSize) : 100;
    const signal = options.signal;
    const shouldPause = options.shouldPause ?? (() => false);

    const takeCheckpoint = async (
      stage: LiveCheckpointStage,
      recordIndex: number,
      recordsTotal: number | undefined,
      outputSoFar: unknown[],
      adapter?: MedicalFormatAdapter,
    ): Promise<RunCheckpoint> => {
      const checkpoint: RunCheckpoint = {
        runId,
        stage,
        recordIndex,
        recordsProcessed: recordIndex,
        recordsTotal,
        inputChecksum,
        outputChecksumSoFar: checksumOf(outputSoFar),
        adapterId: adapter?.id,
        adapterVersion: adapter?.version,
        importedAt: runImportedAt,
        updatedAt: new Date().toISOString(),
      };
      await options.onCheckpoint?.(checkpoint);
      return checkpoint;
    };

    if (signal?.aborted) {
      const checkpoint = await takeCheckpoint("parse", 0, undefined, []);
      return { status: "cancelled", checkpoint, outputSoFar: [] };
    }

    if (options.resumeFrom) {
      if (options.resumeFrom.inputChecksum !== undefined && options.resumeFrom.inputChecksum !== inputChecksum) {
        throw new Error("executeChunked: checkpoint inputChecksum does not match the supplied input; refusing to resume.");
      }
      if (options.resumeFrom.importedAt !== runImportedAt) {
        throw new Error("executeChunked: resume must reuse the checkpoint importedAt for byte-identical output.");
      }
      if (!Number.isInteger(options.resumeFrom.recordIndex) || options.resumeFrom.recordIndex < 0) {
        throw new Error("executeChunked: checkpoint recordIndex is not a valid resume cursor.");
      }
    }

    const finish = (partial: {
      status: TransformationResult["status"];
      adapter?: MedicalFormatAdapter;
      recordsProcessed: number;
      recordsSucceeded: number;
      recordsFailed: number;
      output: unknown[];
      coverage: CoverageReport;
      rejectedRecords: RejectedRecord[];
      dataLoss: DataLossReport;
      validation?: ValidationReport;
      outputChecksum?: string;
    }): TransformationResult => ({
      runId,
      status: partial.status,
      sourceFormat: partial.adapter?.getManifest().format ?? "unknown",
      targetFormat: options.mapping.targetFormat,
      targetResourceType: options.mapping.targetResourceType,
      recordsProcessed: partial.recordsProcessed,
      recordsSucceeded: partial.recordsSucceeded,
      recordsFailed: partial.recordsFailed,
      output: partial.output,
      coverage: partial.coverage,
      rejectedRecords: partial.rejectedRecords,
      dataLoss: partial.dataLoss,
      validation: partial.validation ?? {
        standard: options.mapping.targetFormat,
        isValid: false,
        levels: skippedValidationLevels("Run aborted before validation"),
        issues: partial.coverage.issues,
      },
      traces: tracer.getEvents(),
      durationMs: Date.now() - startTime,
      importedAt: runImportedAt,
      inputChecksum,
      outputChecksum: partial.outputChecksum ?? checksumOf(partial.output),
      adapterId: partial.adapter?.id,
      adapterVersion: partial.adapter?.version,
      engineVersion: ENGINE_VERSION,
    });

    // 1. Static mapping validation (identical to `execute`).
    const mappingIssues = this.mappingEngine.validate(options.mapping);
    const mappingErrors = mappingIssues.filter((i) => i.severity === "error" || i.severity === "fatal");
    if (mappingErrors.length > 0) {
      const checkpoint = await takeCheckpoint("mapping", 0, undefined, []);
      return {
        status: "failed",
        result: this.abortInvalidMapping({
          tracer,
          mapping: options.mapping,
          runId,
          runImportedAt,
          startTime,
          inputChecksum,
          mappingIssues,
        }),
        checkpoint,
        outputSoFar: [],
      };
    }

    if (mappingIssues.length > 0) {
      tracer.emit({
        stepId: "mapping-validation",
        stepName: "Mapping Definition Validation",
        stage: "mapping",
        status: "warning",
        issues: mappingIssues,
      });
    }

    // 2. Adapter detection / selection (identical to `execute`).
    let adapter: MedicalFormatAdapter | undefined;
    if (options.adapterId) {
      adapter = this.registry.get(options.adapterId);
      if (!adapter) {
        const issue: ValidationIssue = {
          code: "UNKNOWN_ADAPTER",
          severity: "fatal",
          message: `Adapter '${options.adapterId}' is not registered`,
          advice: `Available adapters: ${this.registry
            .listAdapters()
            .map((a) => a.id)
            .join(", ")}`,
        };
        tracer.emit({
          stepId: "adapter-selection",
          stepName: "Adapter Selection",
          stage: "adapter-selection",
          status: "error",
          issues: [issue],
        });
        const checkpoint = await takeCheckpoint("mapping", 0, undefined, []);
        return {
          status: "failed",
          result: finish({
            status: "failed",
            recordsProcessed: 0,
            recordsSucceeded: 0,
            recordsFailed: 0,
            output: [],
            coverage: { ...EMPTY_COVERAGE, issues: [issue] },
            rejectedRecords: [],
            dataLoss: {
              unmappedFields: [],
              rejectedValues: [],
              droppedRecordIndexes: [],
              adapterNotes: ["Run aborted: requested adapter is not registered"],
              isLossless: false,
            },
          }),
          checkpoint,
          outputSoFar: [],
        };
      }
    } else {
      const candidates = await this.registry.detect(options.input);
      const [best] = candidates;
      adapter = best ? this.registry.get(best.adapterId) : undefined;

      tracer.emit({
        stepId: "format-detection",
        stepName: "Format Detection",
        stage: "detect",
        status: adapter ? "success" : "error",
        outputSnippet: {
          candidates: candidates.map((c) => ({ adapterId: c.adapterId, format: c.format, confidence: c.confidence })),
        },
        issues: adapter
          ? []
          : [
              {
                code: "NO_COMPATIBLE_ADAPTER",
                severity: "fatal",
                message: "No registered adapter accepted this input",
                advice: "Run `healthbridge formats list` to see supported formats.",
              },
            ],
      });
    }

    if (!adapter) {
      const issue: ValidationIssue = {
        code: "NO_COMPATIBLE_ADAPTER",
        severity: "fatal",
        message: "No compatible adapter found for the input payload.",
      };
      const checkpoint = await takeCheckpoint("mapping", 0, undefined, []);
      return {
        status: "failed",
        result: finish({
          status: "failed",
          recordsProcessed: 0,
          recordsSucceeded: 0,
          recordsFailed: 0,
          output: [],
          coverage: { ...EMPTY_COVERAGE, issues: [issue] },
          rejectedRecords: [],
          dataLoss: {
            unmappedFields: [],
            rejectedValues: [],
            droppedRecordIndexes: [],
            adapterNotes: ["Run aborted: no adapter available"],
            isLossless: false,
          },
        }),
        checkpoint,
        outputSoFar: [],
      };
    }

    tracer.emit({
      stepId: "adapter-selection",
      stepName: "Adapter Selection",
      stage: "adapter-selection",
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      status: "success",
      inputSnippet: { filename: options.input.filename, sizeBytes: options.input.sizeBytes },
      outputSnippet: { format: adapter.getManifest().format, capabilities: adapter.getManifest().capabilities },
    });

    // 3. Structural parsing (identical to `execute`).
    const parseStart = Date.now();
    const envelopes = [];
    try {
      for await (const envelope of adapter.parse(options.input, {
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        maxRecords: options.maxRecords,
        importedAt: runImportedAt,
        onIssue: (issue) => parseIssues.push(issue),
      })) {
        envelopes.push(envelope);
        if (options.maxRecords && envelopes.length >= options.maxRecords) break;
      }
    } catch (error) {
      const issue: ValidationIssue = {
        code: "ADAPTER_PARSE_ERROR",
        severity: "fatal",
        message: `Adapter '${adapter.id}' failed to parse the input: ${(error as Error).message}`,
      };
      parseIssues.push(issue);
      tracer.emit({
        stepId: "structural-parsing",
        stepName: "Structural Parsing",
        stage: "parse",
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        status: "error",
        durationMs: Date.now() - parseStart,
        issues: [issue],
      });
      const checkpoint = await takeCheckpoint("parse", 0, undefined, [], adapter);
      return {
        status: "failed",
        result: finish({
          status: "failed",
          adapter,
          recordsProcessed: 0,
          recordsSucceeded: 0,
          recordsFailed: 0,
          output: [],
          coverage: { ...EMPTY_COVERAGE, issues: parseIssues },
          rejectedRecords: [],
          dataLoss: {
            unmappedFields: [],
            rejectedValues: [],
            droppedRecordIndexes: [],
            adapterNotes: parseIssues.map((i) => i.message),
            isLossless: false,
          },
        }),
        checkpoint,
        outputSoFar: [],
      };
    }

    tracer.emit({
      stepId: "structural-parsing",
      stepName: "Structural Parsing",
      stage: "parse",
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      status: parseIssues.some((i) => i.severity === "fatal") ? "error" : "success",
      durationMs: Date.now() - parseStart,
      outputSnippet: { parsedRecords: envelopes.length },
      issues: parseIssues,
    });

    // 4. Semantic mapping per record, in chunks with pause/cancel boundaries.
    const output: unknown[] = [];
    const rejectedRecords: RejectedRecord[] = [];
    const allIssues: ValidationIssue[] = [...parseIssues];
    const rejectedValues: DataLossReport["rejectedValues"] = [];
    const mappedPaths = new Set<string>();
    const unmappedPaths = new Set<string>();
    const rejectedPaths = new Set<string>();
    const seenResourceIds = new Map<string, number[]>();
    const validationIssues: ValidationIssue[] = [];
    const operationOutcomes: Array<Record<string, unknown>> = [];
    const resolvedBuilder = this.builders.resolve({
      id: options.mapping.id,
      version: options.mapping.version,
      targetFormat: options.mapping.targetFormat,
      targetResourceType: options.mapping.targetResourceType,
      targetProfile: options.mapping.targetProfile,
    });
    const builderId = resolvedBuilder?.id;
    const validationExecuted = options.mapping.targetFormat === "fhir-r4";
    let validationIsValid = true;
    let targetFieldsPopulated = 0;
    let recordsSucceeded = 0;

    if (
      options.mapping.sourceDomains &&
      options.mapping.sourceDomains.length > 0 &&
      envelopes.length > 0 &&
      !options.mapping.sourceDomains.includes(envelopes[0].domain)
    ) {
      allIssues.push({
        code: "DOMAIN_MISMATCH",
        severity: "warning",
        message: `Mapping '${options.mapping.id}' targets ${options.mapping.sourceDomains.join("/")} data but the source looks like '${envelopes[0].domain}'`,
        advice: "Use a mapping designed for this domain, or review the source columns.",
      });
    }

    const sources = envelopes.map((envelope) => structuredSourceOf(envelope));
    const mappingResults = options.mapping.allowCrossRecordContext
      ? this.mappingEngine.executeBatch(sources, options.mapping)
      : sources.map((source) => this.mappingEngine.execute(source, options.mapping));

    for (let base = 0; base < envelopes.length; base += chunkSize) {
      const end = Math.min(base + chunkSize, envelopes.length);
      for (let index = base; index < end; index++) {
        const envelope = envelopes[index];
        const sourceData = sources[index];
        const recordStart = Date.now();
        const result = mappingResults[index];

        // Target-format construction: required elements, id hygiene, profile, provenance.
        const buildStart = Date.now();
        const build: BuildResult | undefined = this.builders.build({
          data: result.targetData,
          mapping: {
            id: options.mapping.id,
            version: options.mapping.version,
            targetFormat: options.mapping.targetFormat,
            targetResourceType: options.mapping.targetResourceType,
            targetProfile: options.mapping.targetProfile,
          },
          envelopeId: envelope.id,
          adapterId: adapter.id,
          adapterVersion: adapter.version,
          importedAt: envelope.provenance.importedAt,
          sensitivity: envelope.classification.sensitivity,
        });
        const targetResource = (build?.resource ?? result.targetData) as Record<string, unknown>;
        const buildIssues: ValidationIssue[] = (build?.issues ?? []).map((issue) => ({ ...issue, recordIndex: index }));
        if (!build) {
          buildIssues.push({
            code: "TARGET_BUILDER_MISSING",
            severity: "warning",
            message: `No target builder for '${options.mapping.targetFormat}'; output was not validated against the target standard`,
            recordIndex: index,
            advice: "Output is mapping-shaped only.",
          });
        }
        tracer.emit({
          stepId: "target-build",
          stepName: "Target Resource Construction",
          stage: "build",
          recordIndex: index,
          recordId: envelope.id,
          pipelineVersion,
          status: build?.rejected ? "error" : buildIssues.some((i) => i.severity === "warning") ? "warning" : "success",
          durationMs: Date.now() - buildStart,
          outputSnippet: targetResource,
          issues: buildIssues,
        });

        // Target-standard validation (level 3). Levels 4 and 6 are reported as
        // skipped; level 5 executes when a terminology provider was supplied.
        const validateStart = Date.now();
        let recordValidationIssues: ValidationIssue[] = [];
        if (validationExecuted) {
          const validation = options.terminology
            ? this.fhirValidator.validateWithDetail(targetResource, { terminology: options.terminology })
            : this.fhirValidator.validate(targetResource);
          recordValidationIssues = validation.issues.map((issue) => ({ ...issue, recordIndex: index }));
          operationOutcomes.push(validation.operationOutcome as unknown as Record<string, unknown>);
          validationIssues.push(...recordValidationIssues);
          if (!validation.isValid) validationIsValid = false;
          tracer.emit({
            stepId: "target-validation",
            stepName: "FHIR R4 Structural Validation",
            stage: "validate",
            recordIndex: index,
            recordId: envelope.id,
            pipelineVersion,
            status: validation.isValid ? "success" : "error",
            durationMs: Date.now() - validateStart,
            issues: recordValidationIssues,
            validationState: validation.isValid ? "valid" : "invalid",
          });
        }

        const recordIssues = [
          ...(envelope.parseIssues ?? []).map((issue) => ({ ...issue, recordIndex: index })),
          ...result.issues.map((issue) => ({ ...issue, recordIndex: index })),
          ...buildIssues,
          ...recordValidationIssues,
        ];
        allIssues.push(...recordIssues);

        for (const path of result.coverage.mappedFieldPaths ?? []) mappedPaths.add(path);
        for (const path of result.coverage.unmappedSourceFields) unmappedPaths.add(path);
        for (const path of result.coverage.rejectedFieldPaths ?? []) rejectedPaths.add(path);
        targetFieldsPopulated += result.coverage.targetFieldsPopulated;

        for (const ruleResult of result.ruleResults) {
          if (ruleResult.status === "rejected") {
            const ruleIssue = result.issues.find((i) => i.ruleId === ruleResult.ruleId);
            rejectedValues.push({
              recordIndex: index,
              path: ruleResult.sourcePath,
              code: ruleIssue?.code ?? "VALUE_REJECTED",
            });
          }
        }

        const blocking: ValidationIssue[] = recordIssues.filter((i) => i.severity === "fatal" || i.severity === "error");
        if (build?.rejected && blocking.length === 0) {
          blocking.push({
            code: "TARGET_BUILD_REJECTED",
            severity: "error",
            message: "Target resource could not be constructed from this record",
            recordIndex: index,
          });
        }
        const hasWarning = recordIssues.some((i) => i.severity === "warning");

        if (blocking.length > 0) {
          rejectedRecords.push({
            recordIndex: index,
            envelopeId: envelope.id,
            sourceLocation: envelope.provenance.sourceLocation,
            partialOutput: targetResource,
            issues: blocking,
          });

          tracer.emit({
            stepId: "semantic-mapping",
            stepName: "Semantic Mapping",
            stage: "mapping",
            recordIndex: index,
            recordId: envelope.id,
            adapterId: adapter.id,
            adapterVersion: adapter.version,
            pipelineVersion,
            status: "error",
            durationMs: Date.now() - recordStart,
            inputSnippet: sourceData,
            outputSnippet: result.targetData,
            sourcePath: blocking[0]?.path,
            ruleId: blocking[0]?.ruleId,
            issues: recordIssues,
          });
          continue;
        }

        recordsSucceeded++;
        output.push(targetResource);

        const resourceId = targetResource.id;
        if (typeof resourceId === "string" && resourceId !== "") {
          const key = `${String(targetResource.resourceType ?? options.mapping.targetResourceType ?? "Resource")}/${resourceId}`;
          const existing = seenResourceIds.get(key) ?? [];
          existing.push(index);
          seenResourceIds.set(key, existing);
        }

        tracer.emit({
          stepId: "semantic-mapping",
          stepName: "Semantic Mapping",
          stage: "mapping",
          recordIndex: index,
          recordId: envelope.id,
          adapterId: adapter.id,
          adapterVersion: adapter.version,
          pipelineVersion,
          status: hasWarning ? "warning" : "success",
          durationMs: Date.now() - recordStart,
          inputSnippet: sourceData,
          outputSnippet: result.targetData,
          issues: recordIssues,
        });
      }

      // Chunk boundary: persist the resume cursor, then honour control signals.
      // Cancellation is cooperative — the in-flight chunk above always finishes.
      const checkpoint = await takeCheckpoint("mapping", end, envelopes.length, output, adapter);
      if (signal?.aborted) {
        return { status: "cancelled", checkpoint, outputSoFar: [...output] };
      }
      if (shouldPause()) {
        return { status: "paused", checkpoint, outputSoFar: [...output] };
      }
    }

    for (const [key, indexes] of seenResourceIds) {
      if (indexes.length > 1) {
        allIssues.push({
          code: "DUPLICATE_RESOURCE_ID",
          severity: "warning",
          message: `Resource id '${key}' is produced by ${indexes.length} records (record indexes: ${indexes.join(", ")})`,
          path: "id",
          recordIndex: indexes[0],
          advice: "Define a unique identifier in the mapping, or deduplicate upstream.",
        });
      }
    }

    const unmappedFieldList = Array.from(unmappedPaths).sort();
    const coverage: CoverageReport = {
      totalSourceFields: new Set([...mappedPaths, ...unmappedPaths]).size,
      mappedSourceFields: mappedPaths.size,
      unmappedSourceFields: unmappedFieldList,
      coveragePercentage:
        mappedPaths.size + unmappedPaths.size > 0
          ? Math.round((mappedPaths.size / (mappedPaths.size + unmappedPaths.size)) * 100)
          : 100,
      targetFieldsPopulated,
      rejectedValuesCount: rejectedValues.length,
      preservedExtensionsCount: 0,
      issues: allIssues,
      mappedFieldPaths: Array.from(mappedPaths).sort(),
      rejectedFieldPaths: Array.from(rejectedPaths).sort(),
      recordsConsidered: envelopes.length,
    };

    if (envelopes.length > 0 && coverage.coveragePercentage < 50) {
      allIssues.push({
        code: "LOW_MAPPING_COVERAGE",
        severity: "warning",
        message: `Only ${coverage.coveragePercentage}% of source fields are mapped; ${unmappedFieldList.length} field(s) are unused`,
        advice: "Check that this mapping targets the right domain, or extend it to cover the remaining fields.",
      });
    }

    const adapterNotes = parseIssues.map((i) => `${i.code}: ${i.message}`);
    const dataLoss: DataLossReport = {
      unmappedFields: unmappedFieldList,
      rejectedValues,
      droppedRecordIndexes: rejectedRecords.map((r) => r.recordIndex),
      adapterNotes,
      isLossless:
        unmappedFieldList.length === 0 &&
        rejectedValues.length === 0 &&
        rejectedRecords.length === 0 &&
        adapterNotes.length === 0,
    };

    const validationReport: ValidationReport = {
      standard: options.mapping.targetFormat,
      isValid: validationExecuted ? validationIsValid : false,
      levels: buildLevelReports({
        validationExecuted,
        adapterId: adapter.id,
        targetFormat: options.mapping.targetFormat,
        terminologyName: options.terminology?.name,
      }),
      issues: validationIssues,
      operationOutcomes,
    };

    const hasWarnings = allIssues.some((i) => i.severity === "warning");
    const hasFatal = allIssues.some((i) => i.severity === "fatal");
    const status: TransformationResult["status"] =
      hasFatal || (envelopes.length > 0 && recordsSucceeded === 0)
        ? "failed"
        : rejectedRecords.length > 0 || hasWarnings || adapterNotes.length > 0
          ? "completed_with_warnings"
          : "completed";

    tracer.emit({
      stepId: "export",
      stepName: "Export & Provenance",
      stage: "export",
      status: status === "completed" ? "success" : status === "failed" ? "error" : "warning",
      durationMs: Date.now() - startTime,
      outputSnippet: {
        recordsProcessed: envelopes.length,
        recordsSucceeded,
        recordsFailed: rejectedRecords.length,
        coveragePercentage: coverage.coveragePercentage,
        isLossless: dataLoss.isLossless,
        validationValid: validationReport.isValid,
        builder: builderId,
      },
      validationState: validationExecuted ? (validationReport.isValid ? "valid" : "invalid") : "skipped",
    });

    const result = finish({
      status,
      adapter,
      recordsProcessed: envelopes.length,
      recordsSucceeded,
      recordsFailed: rejectedRecords.length,
      output,
      coverage,
      rejectedRecords,
      dataLoss,
      validation: validationReport,
    });
    const checkpoint = await takeCheckpoint("done", envelopes.length, envelopes.length, output, adapter);
    return { status: result.status, result, checkpoint, outputSoFar: [...output] };
  }
}

/**
 * Options for {@link TransformationPipeline.executeChunked}: everything
 * `execute()` accepts, plus chunking and live-control hooks.
 */
export interface ChunkedExecuteOptions extends TransformOptions {
  /** Records per chunk (and therefore per checkpoint). Defaults to 100. */
  chunkSize?: number;
  /** Cooperative cancellation, honoured at every chunk boundary. */
  signal?: AbortSignal;
  /**
   * Cooperative pause, honoured at the same boundaries. Returning `true`
   * finishes the in-flight chunk, persists its checkpoint and returns a
   * `paused` outcome that keeps the checkpoint — unlike cancellation.
   */
  shouldPause?: () => boolean;
  /**
   * Resume cursor from a previous `paused` outcome. The run replays
   * deterministically from the first record with this checkpoint's
   * reproducibility anchor; mismatched input or `importedAt` throws rather
   * than silently diverging.
   */
  resumeFrom?: RunCheckpoint;
  /** Called with every checkpoint, including the final `done` one. */
  onCheckpoint?: (checkpoint: RunCheckpoint) => void | Promise<void>;
}

/** Terminal report of one `executeChunked` call. */
export type ChunkedRunStatus = TransformationResult["status"] | "paused" | "cancelled";

export interface ChunkedExecuteOutcome {
  status: ChunkedRunStatus;
  /** Present when every record was processed. Absent when paused/cancelled/failed-early. */
  result?: TransformationResult;
  /** Last checkpoint taken: resume cursor plus binding checksums. Always present. */
  checkpoint: RunCheckpoint;
  /** Resources produced so far, in record order (the full output when finished). */
  outputSoFar: unknown[];
}

export * from "@healthbridge/mapping-engine";

function checksumOf(output: unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(output)).digest("hex")}`;
}

function skippedValidationLevels(reason: string) {
  const names: Array<[1 | 2 | 3 | 4 | 5 | 6, string]> = [
    [1, "source-structural"],
    [2, "mapping-definition"],
    [3, "target-structural"],
    [4, "profile"],
    [5, "terminology"],
    [6, "referential-integrity"],
  ];
  return names.map(([level, name]) => ({ level, name, status: "skipped" as const, reason }));
}
