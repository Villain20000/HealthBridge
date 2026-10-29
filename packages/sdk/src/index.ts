import * as fs from "node:fs";
import * as path from "node:path";
import {
  AdapterHealthReport,
  CapabilityManifest,
  DetectionCandidate,
  InputDescriptor,
  InspectionResult,
  MedicalFormatAdapter,
  TransformationResult,
} from "@healthbridge/core";
import { TransformationPipeline } from "@healthbridge/transformation-engine";
import { MappingDefinition } from "@healthbridge/mapping-engine";
import { FhirValidator } from "@healthbridge/validation";
import { exportTraceReport } from "@healthbridge/trace-protocol";
import { ENGINE_VERSION, RunBundle, TRACE_PROTOCOL_VERSION, TraceEvent } from "@healthbridge/shared-types";

export type InputSource = InputDescriptor | string;

export interface HealthBridgeSdkConfig {
  debug?: {
    enabled?: boolean;
    payloadMode?: "full" | "redacted";
  };
  /** Extra adapters (plugins). Registration is explicit — plugins are privileged code. */
  adapters?: MedicalFormatAdapter[];
  /** Keep completed runs in memory so traces can be inspected/replayed. */
  keepRunsInMemory?: boolean;
}

export type ErrorCategory = "usage" | "input" | "adapter" | "validation" | "internal" | "cancelled";

export class HealthBridgeError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly details?: unknown;

  constructor(code: string, message: string, category: ErrorCategory, details?: unknown) {
    super(message);
    this.name = "HealthBridgeError";
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

export interface StoredRun {
  runId: string;
  result: TransformationResult;
  mapping: MappingDefinition;
  input: InputDescriptor;
  options: { adapterId?: string; maxRecords?: number; importedAt?: string; pipelineVersion?: string };
  createdAt: string;
}

export interface ReproduceOutcome {
  result: TransformationResult;
  matches: boolean;
  expectedChecksum?: string;
  actualChecksum?: string;
  checksumMatches?: boolean;
  /** False when the payload differs from the one recorded in the bundle. */
  inputChecksumMatches: boolean;
}

function isPathSource(source: InputSource): source is string {
  return typeof source === "string";
}

function describeInput(source: InputSource): InputDescriptor {
  if (!isPathSource(source)) return source;

  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new HealthBridgeError("INPUT_NOT_FOUND", `Input file not found: ${source}`, "input", { source });
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new HealthBridgeError("INPUT_NOT_A_FILE", `Input path is not a file: ${source}`, "input", { source });
  }
  const buffer = fs.readFileSync(resolved);
  return {
    id: `file-${path.basename(resolved)}`,
    filename: path.basename(resolved),
    buffer,
    sizeBytes: stat.size,
  };
}

export class HealthBridge {
  private readonly pipeline: TransformationPipeline;
  private readonly fhirValidator: FhirValidator;
  private readonly config: HealthBridgeSdkConfig;
  private readonly runs = new Map<string, StoredRun>();

  constructor(config: HealthBridgeSdkConfig = {}) {
    this.config = config;
    this.pipeline = new TransformationPipeline(config.adapters);
    this.fhirValidator = new FhirValidator();
  }

  public registerAdapter(adapter: MedicalFormatAdapter): void {
    this.pipeline.getRegistry().register(adapter);
  }

  public listFormats(): CapabilityManifest[] {
    return this.pipeline.getRegistry().list();
  }

  public listAdapters(): MedicalFormatAdapter[] {
    return this.pipeline.getRegistry().listAdapters();
  }

  public async adapterHealth(): Promise<AdapterHealthReport[]> {
    return this.pipeline.getRegistry().health();
  }

  public async detect(source: InputSource): Promise<DetectionCandidate[]> {
    return this.pipeline.getRegistry().detect(describeInput(source));
  }

  public async inspect(
    source: InputSource,
    options: { adapterId?: string; maxRecords?: number } = {},
  ): Promise<InspectionResult> {
    const input = describeInput(source);
    const registry = this.pipeline.getRegistry();

    const adapter = options.adapterId ? registry.get(options.adapterId) : await registry.detectAdapter(input);

    if (!adapter) {
      throw new HealthBridgeError(
        "NO_COMPATIBLE_ADAPTER",
        `No adapter accepted input '${input.filename ?? input.id}'`,
        "adapter",
        { candidates: await registry.detect(input) },
      );
    }

    const inspection = await adapter.inspect(input);
    const candidates = await registry.detect(input);
    const confidence = candidates.find((c) => c.adapterId === adapter.id)?.confidence;
    return { ...inspection, confidence };
  }

  public async transform(params: {
    input: InputSource;
    mapping: MappingDefinition;
    adapterId?: string;
    maxRecords?: number;
    signal?: AbortSignal;
    runId?: string;
    /** Fixed import timestamp — required for byte-identical reproduction. */
    importedAt?: string;
    pipelineVersion?: string;
  }): Promise<TransformationResult> {
    if (params.signal?.aborted) {
      throw new HealthBridgeError("CANCELLED", "Transformation cancelled before start", "cancelled");
    }

    const input = describeInput(params.input);
    const result = await this.pipeline.execute({
      input,
      mapping: params.mapping,
      adapterId: params.adapterId,
      maxRecords: params.maxRecords,
      runId: params.runId,
      importedAt: params.importedAt,
      pipelineVersion: params.pipelineVersion,
      redactSensitiveData: this.config.debug?.payloadMode !== "full",
    });

    if (params.signal?.aborted) {
      throw new HealthBridgeError("CANCELLED", "Transformation cancelled", "cancelled", { runId: result.runId });
    }

    if (this.config.keepRunsInMemory !== false) {
      this.runs.set(result.runId, {
        runId: result.runId,
        result,
        mapping: params.mapping,
        input,
        options: {
          adapterId: params.adapterId,
          maxRecords: params.maxRecords,
          importedAt: params.importedAt,
          pipelineVersion: params.pipelineVersion,
        },
        createdAt: new Date().toISOString(),
      });
    }

    return result;
  }

  public getRun(runId: string): StoredRun | undefined {
    return this.runs.get(runId);
  }

  public listRuns(): StoredRun[] {
    return Array.from(this.runs.values());
  }

  public getTrace(runId: string): TraceEvent[] {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HealthBridgeError("RUN_NOT_FOUND", `Run '${runId}' is not available in memory`, "usage");
    }
    return run.result.traces;
  }

  public exportTrace(runId: string, format: "json" = "json"): string {
    const traces = this.getTrace(runId);
    if (format !== "json") {
      throw new HealthBridgeError("UNSUPPORTED_FORMAT", `Unsupported trace export format '${format}'`, "usage");
    }
    return exportTraceReport(traces);
  }

  /** Re-execute a stored run with the exact same input, mapping and options. */
  public async replay(runId: string): Promise<TransformationResult> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HealthBridgeError("RUN_NOT_FOUND", `Run '${runId}' is not available for replay`, "usage");
    }
    return this.transform({ input: run.input, mapping: run.mapping, ...run.options });
  }

  /**
   * A self-describing run descriptor. It never embeds the payload — only its
   * checksum — so bundles are safe to commit and share.
   */
  public createRunBundle(runId: string): RunBundle {
    const run = this.runs.get(runId);
    if (!run) {
      throw new HealthBridgeError("RUN_NOT_FOUND", `Run '${runId}' is not available in memory`, "usage");
    }
    const { result, input, mapping, options } = run;
    return {
      bundleVersion: "1",
      runId: result.runId,
      createdAt: run.createdAt,
      engineVersion: result.engineVersion ?? ENGINE_VERSION,
      traceProtocolVersion: TRACE_PROTOCOL_VERSION,
      pipelineVersion: options.pipelineVersion ?? result.engineVersion ?? ENGINE_VERSION,
      input: {
        id: input.id,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        checksum: result.inputChecksum,
      },
      adapter: result.adapterId ? { id: result.adapterId, version: result.adapterVersion ?? "unknown" } : undefined,
      mapping,
      options: {
        maxRecords: options.maxRecords,
        // Fall back to the effective timestamp so a run started without
        // --imported-at is still reproducible from its own bundle.
        importedAt: options.importedAt ?? result.importedAt,
      } as RunBundle["options"],
      expected: {
        status: result.status,
        recordsProcessed: result.recordsProcessed,
        recordsSucceeded: result.recordsSucceeded,
        recordsFailed: result.recordsFailed,
        outputChecksum: result.outputChecksum,
        validationValid: result.validation?.isValid ?? false,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  /** Re-run a bundle against the supplied input and compare output checksums. */
  public async reproduce(bundle: RunBundle, input: InputSource): Promise<ReproduceOutcome> {
    const result = await this.transform({
      input,
      mapping: bundle.mapping as MappingDefinition,
      adapterId: bundle.adapter?.id,
      maxRecords: (bundle.options as { maxRecords?: number }).maxRecords,
      importedAt: (bundle.options as { importedAt?: string }).importedAt ?? bundle.createdAt,
      pipelineVersion: bundle.pipelineVersion,
    });
    const checksumMatches =
      bundle.expected.outputChecksum === undefined
        ? undefined
        : bundle.expected.outputChecksum === result.outputChecksum;
    const inputChecksumMatches = bundle.input.checksum === undefined || bundle.input.checksum === result.inputChecksum;
    return {
      result,
      matches: checksumMatches === true,
      expectedChecksum: bundle.expected.outputChecksum,
      actualChecksum: result.outputChecksum,
      checksumMatches,
      inputChecksumMatches,
    };
  }

  public validateFhir(resource: Record<string, unknown>) {
    return this.fhirValidator.validate(resource);
  }
}

export * from "@healthbridge/shared-types";
export * from "@healthbridge/core";
export * from "@healthbridge/mapping-engine";
export * from "@healthbridge/transformation-engine";
export * from "@healthbridge/validation";
export * from "@healthbridge/lineage-engine";
export * from "@healthbridge/target-builders";
export * from "@healthbridge/trace-protocol";
