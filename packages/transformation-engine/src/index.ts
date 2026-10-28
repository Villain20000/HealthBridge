import {
  CoverageReport,
  InputDescriptor,
  TransformationResult,
  ValidationIssue,
} from "@healthbridge/shared-types";
import { AdapterRegistry, MedicalFormatAdapter } from "@healthbridge/core";
import { CsvFormatAdapter, JsonFormatAdapter, FhirJsonFormatAdapter } from "@healthbridge/adapters";
import { MappingDefinition, MappingEngine } from "@healthbridge/mapping-engine";
import { TraceCollector } from "@healthbridge/trace-protocol";

export interface TransformOptions {
  input: InputDescriptor;
  mapping: MappingDefinition;
  adapterId?: string;
  runId?: string;
}

export class TransformationPipeline {
  private registry: AdapterRegistry;
  private mappingEngine: MappingEngine;

  constructor() {
    this.registry = new AdapterRegistry();
    this.registry.register(new CsvFormatAdapter());
    this.registry.register(new JsonFormatAdapter());
    this.registry.register(new FhirJsonFormatAdapter());
    this.mappingEngine = new MappingEngine();
  }

  public getRegistry(): AdapterRegistry {
    return this.registry;
  }

  public async execute(options: TransformOptions): Promise<TransformationResult> {
    const startTime = Date.now();
    const runId = options.runId || `run-${Math.random().toString(36).substring(2, 9)}`;
    const tracer = new TraceCollector({ runId });

    let adapter: MedicalFormatAdapter | undefined;
    if (options.adapterId) {
      adapter = this.registry.get(options.adapterId);
    } else {
      adapter = await this.registry.detectAdapter(options.input);
    }

    if (!adapter) {
      tracer.emit({
        stepId: "adapter-selection",
        stepName: "Adapter Selection",
        status: "error",
        issues: [
          {
            code: "NO_COMPATIBLE_ADAPTER",
            severity: "fatal",
            message: "No compatible adapter found for the input payload.",
          },
        ],
      });
      return {
        runId,
        status: "failed",
        sourceFormat: "unknown",
        targetFormat: options.mapping.targetFormat,
        recordsProcessed: 0,
        recordsSucceeded: 0,
        recordsFailed: 0,
        output: [],
        coverage: {
          totalSourceFields: 0,
          mappedSourceFields: 0,
          unmappedSourceFields: [],
          coveragePercentage: 0,
          targetFieldsPopulated: 0,
          rejectedValuesCount: 0,
          preservedExtensionsCount: 0,
          issues: [],
        },
        traces: tracer.getEvents(),
        durationMs: Date.now() - startTime,
      };
    }

    tracer.emit({
      stepId: "adapter-selection",
      stepName: "Adapter Selection",
      adapterId: adapter.id,
      status: "success",
      inputSnippet: { filename: options.input.filename, size: options.input.sizeBytes },
    });

    const parsedEnvelopes = [];
    const parseStart = Date.now();
    for await (const envelope of adapter.parse(options.input, { adapterId: adapter.id, adapterVersion: adapter.version })) {
      parsedEnvelopes.push(envelope);
    }

    tracer.emit({
      stepId: "structural-parsing",
      stepName: "Structural Parsing",
      adapterId: adapter.id,
      status: "success",
      durationMs: Date.now() - parseStart,
      outputSnippet: { parsedRecordsCount: parsedEnvelopes.length },
    });

    const outputRecords: unknown[] = [];
    let recordsSucceeded = 0;
    let recordsFailed = 0;
    const allIssues: ValidationIssue[] = [];
    let aggregatedCoverage: CoverageReport = {
      totalSourceFields: 0,
      mappedSourceFields: 0,
      unmappedSourceFields: [],
      coveragePercentage: 0,
      targetFieldsPopulated: 0,
      rejectedValuesCount: 0,
      preservedExtensionsCount: 0,
      issues: [],
    };

    for (let idx = 0; idx < parsedEnvelopes.length; idx++) {
      const envelope = parsedEnvelopes[idx];
      const sourceData = (envelope.content.kind === "structured" ? envelope.content.data : {}) as Record<string, unknown>;

      const transformStart = Date.now();
      const { targetData, coverage, issues } = this.mappingEngine.execute(sourceData, options.mapping);

      allIssues.push(...issues);
      aggregatedCoverage = coverage;

      if (issues.some((i) => i.severity === "fatal" || i.severity === "error")) {
        recordsFailed++;
        tracer.emit({
          stepId: "semantic-mapping",
          stepName: "Semantic Mapping & Rule Execution",
          recordIndex: idx,
          ruleId: issues.find((i) => i.ruleId)?.ruleId,
          status: "error",
          durationMs: Date.now() - transformStart,
          inputSnippet: sourceData,
          issues,
        });
      } else {
        recordsSucceeded++;
        outputRecords.push(targetData);
        tracer.emit({
          stepId: "semantic-mapping",
          stepName: "Semantic Mapping & Rule Execution",
          recordIndex: idx,
          status: "success",
          durationMs: Date.now() - transformStart,
          inputSnippet: sourceData,
          outputSnippet: targetData,
          issues,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      runId,
      status: recordsFailed > 0 ? (recordsSucceeded > 0 ? "completed_with_warnings" : "failed") : "completed",
      sourceFormat: adapter.getManifest().format,
      targetFormat: options.mapping.targetFormat,
      recordsProcessed: parsedEnvelopes.length,
      recordsSucceeded,
      recordsFailed,
      output: outputRecords,
      coverage: {
        ...aggregatedCoverage,
        issues: allIssues,
      },
      traces: tracer.getEvents(),
      durationMs,
    };
  }
}
