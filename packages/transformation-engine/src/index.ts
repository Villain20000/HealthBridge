import { createHash } from "node:crypto";
import {
  CoverageReport,
  DataLossReport,
  ENGINE_VERSION,
  InputDescriptor,
  RejectedRecord,
  TransformationResult,
  ValidationIssue,
  ValidationReport,
} from "@healthbridge/shared-types";
import { AdapterRegistry, MedicalFormatAdapter, computeChecksum } from "@healthbridge/core";
import { createBuiltInAdapters } from "@healthbridge/adapters";
import { MappingDefinition, MappingEngine, RuleExecutionResult } from "@healthbridge/mapping-engine";
import { TraceCollector } from "@healthbridge/trace-protocol";
import { TargetBuilderRegistry, defaultTargetBuilderRegistry, BuildResult } from "@healthbridge/target-builders";
import { FhirValidator } from "@healthbridge/validation";

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
}

export interface RecordTraceDetail {
  recordIndex: number;
  ruleResults: RuleExecutionResult[];
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
      tracer.emit({
        stepId: "mapping-validation",
        stepName: "Mapping Definition Validation",
        stage: "mapping",
        status: "error",
        issues: mappingIssues,
      });
      return finish({
        status: "failed",
        recordsProcessed: 0,
        recordsSucceeded: 0,
        recordsFailed: 0,
        output: [],
        coverage: { ...EMPTY_COVERAGE, issues: mappingIssues },
        rejectedRecords: [],
        dataLoss: {
          unmappedFields: [],
          rejectedValues: [],
          droppedRecordIndexes: [],
          adapterNotes: ["Run aborted: mapping definition is invalid"],
          isLossless: false,
        },
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

    for (let index = 0; index < envelopes.length; index++) {
      const envelope = envelopes[index];
      const sourceData =
        envelope.content.kind === "structured" && envelope.content.data && typeof envelope.content.data === "object"
          ? (envelope.content.data as Record<string, unknown>)
          : {};

      const recordStart = Date.now();
      const result = this.mappingEngine.execute(sourceData, options.mapping);

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

      // Target-standard validation (level 3). Levels 4-6 are reported as skipped.
      const validateStart = Date.now();
      let recordValidationIssues: ValidationIssue[] = [];
      if (validationExecuted) {
        const validation = this.fhirValidator.validate(targetResource);
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
      levels: [
        { level: 1, name: "source-structural", status: "executed", validator: adapter.id },
        { level: 2, name: "mapping-definition", status: "executed", validator: "mapping-engine" },
        validationExecuted
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
              reason: `no validator for target format '${options.mapping.targetFormat}'`,
            },
        {
          level: 4 as const,
          name: "profile",
          status: "skipped" as const,
          reason: "requires an external validator adapter (Phase F)",
        },
        {
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
      ],
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
