/**
 * HealthBridge OS — shared domain contracts.
 *
 * These types are the public contract shared by the engine, SDK, CLI and API.
 * Changes here are semver-significant for `@healthbridge/sdk`.
 */

export type MedicalDomain =
  | "clinical"
  | "laboratory"
  | "imaging"
  | "genomics"
  | "biobanking"
  | "research"
  | "waveform"
  | "document"
  | "administrative"
  | "public-health"
  | "unknown";

export type ContentKind = "structured" | "binary-reference" | "document-reference";

export type Sensitivity = "public" | "internal" | "sensitive";

export interface MedicalDataEnvelope {
  id: string;

  domain: MedicalDomain;

  source: {
    system?: string;
    format: string;
    formatVersion?: string;
    checksum?: string;
    filename?: string;
    encoding?: string;
  };

  content:
    | {
        kind: "structured";
        schemaId?: string;
        data: Record<string, unknown> | Array<unknown> | unknown;
      }
    | {
        kind: "binary-reference";
        uri: string;
        mediaType: string;
        sizeBytes?: number;
      }
    | {
        kind: "document-reference";
        uri: string;
        mediaType: string;
        title?: string;
      };

  /**
   * Adapter-specific structural metadata (delimiter, encoding, line number,
   * DICOM tag summary, ...). Always safe to serialise.
   */
  metadata: Record<string, unknown>;

  provenance: {
    importedAt: string;
    adapterId: string;
    adapterVersion: string;
    /** Zero-based index of the record inside the asset. */
    recordIndex?: number;
    /** 1-based physical source location (line number, JSON pointer, tag path). */
    sourceLocation?: string;
    sourcePath?: string;
  };

  classification: {
    sensitivity: Sensitivity;
    /** Machine-readable reason for the classification decision. */
    reason?: string;
  };

  /** Fields present in the source that no mapping rule consumed. */
  unmappedFields?: Record<string, unknown>;

  /** Non-fatal structural problems found while parsing this record. */
  parseIssues?: ValidationIssue[];
}

export interface FormatCapabilities {
  register: boolean;
  parseMetadata: boolean;
  parseStructured: boolean;
  preview: boolean;
  transformMetadataToFHIR: boolean;
  transformToFHIR: boolean;
  transcodePixelData?: boolean;
  validateFormat: boolean | "adapter-required";
  exportOriginal: boolean;
  /** Optional, free-form extra capability flags (e.g. `textExtraction`). */
  extra?: Record<string, boolean | "adapter-required">;
}

export type CapabilityStatus =
  "supported" | "partial" | "metadata-only" | "adapter-required" | "planned" | "unsupported";

export interface CapabilityManifest {
  format: string;
  version: string;
  description: string;
  extensions: string[];
  mimeTypes: string[];
  capabilities: FormatCapabilities;
  /** Honest, user-facing status. Must match documentation. */
  status?: CapabilityStatus;
  /** Explicitly documented support boundaries. */
  limitations?: string[];
}

export interface InputDescriptor {
  id: string;
  filename?: string;
  mimeType?: string;
  extension?: string;
  buffer?: Buffer;
  contentString?: string;
  uri?: string;
  sizeBytes?: number;
}

export interface DetectedSchemaField {
  name: string;
  type: string;
  sampleValues?: unknown[];
  nullable?: boolean;
}

export interface InspectionResult {
  format: string;
  formatVersion?: string;
  domain: MedicalDomain;
  recordCount?: number;
  detectedSchema?: {
    fields: DetectedSchemaField[];
  };
  sampleRecords?: Array<Record<string, unknown>>;
  capabilities: FormatCapabilities;
  warnings?: string[];
  /** Detection confidence in the range 0..1, when produced by the registry. */
  confidence?: number;
  status?: CapabilityStatus;
}

export interface ParseContext {
  options?: Record<string, unknown>;
  adapterId: string;
  adapterVersion: string;
  maxRecords?: number;
  /**
   * Fixed import timestamp, so repeated runs over the same input produce
   * byte-identical output (reproducibility).
   */
  importedAt?: string;
  /**
   * Optional channel for structural issues that cannot be attached to a record
   * (e.g. a corrupt NDJSON line, a ragged CSV row). Adapters must report
   * everything they had to skip — never swallow it.
   */
  onIssue?: (issue: ValidationIssue) => void;
}

export type IssueSeverity = "fatal" | "error" | "warning" | "information";

export interface ValidationIssue {
  /** Stable machine code, e.g. `INVALID_DATE_FORMAT`. */
  code: string;
  severity: IssueSeverity;
  message: string;
  /** Serialised location, e.g. `line 12` or `Patient.name[0].family`. */
  location?: string;
  /** Source or target field path. */
  path?: string;
  recordIndex?: number;
  ruleId?: string;
  /** Value that triggered the issue, only when safe to include. */
  offendingValue?: unknown;
  /** Actionable remediation hint. */
  advice?: string;
}

/** Trace protocol version emitted by this build. */
export const TRACE_PROTOCOL_VERSION = "1.2" as const;

export type TraceStage =
  "detect" | "adapter-selection" | "parse" | "envelope" | "mapping" | "build" | "validate" | "export";

export type RedactionState = "none" | "partial" | "full";

export interface TraceEvent {
  protocolVersion: typeof TRACE_PROTOCOL_VERSION;
  runId: string;
  correlationId?: string;
  timestamp: string;
  stepId: string;
  stepName: string;
  stage?: TraceStage;
  recordIndex?: number;
  recordId?: string;
  sourceAssetId?: string;
  adapterId?: string;
  adapterVersion?: string;
  pipelineVersion?: string;
  ruleId?: string;
  sourcePath?: string;
  targetPath?: string;
  inputSnippet?: unknown;
  outputSnippet?: unknown;
  durationMs?: number;
  issues?: ValidationIssue[];
  redacted: boolean;
  redactionState?: RedactionState;
  validationState?: "not-run" | "valid" | "invalid" | "skipped";
  status: "success" | "warning" | "error" | "skipped";
  spanId?: string;
  parentSpanId?: string;
}

export interface CoverageReport {
  totalSourceFields: number;
  mappedSourceFields: number;
  unmappedSourceFields: string[];
  coveragePercentage: number;
  targetFieldsPopulated: number;
  rejectedValuesCount: number;
  preservedExtensionsCount: number;
  issues: ValidationIssue[];
  /** Source leaf paths that were consumed by at least one rule. */
  mappedFieldPaths?: string[];
  /** Source leaf paths whose values were consumed but rejected by a transform. */
  rejectedFieldPaths?: string[];
  /** Number of records contributing to this report. */
  recordsConsidered?: number;
}

/** A record that could not be produced. Never silently dropped. */
export interface RejectedRecord {
  recordIndex: number;
  envelopeId: string;
  sourceLocation?: string;
  /** Best-effort partial target object, for debugging only. */
  partialOutput: Record<string, unknown>;
  issues: ValidationIssue[];
}

export interface DataLossReport {
  /** Source fields that no rule consumed (union across records). */
  unmappedFields: string[];
  /** Values dropped because a transform rejected them. */
  rejectedValues: Array<{ recordIndex: number; path: string; code: string; value?: unknown }>;
  /** Full records that produced no output. */
  droppedRecordIndexes: number[];
  /** Non-empty when the adapter could not interpret part of the source. */
  adapterNotes: string[];
  /** True when nothing was dropped, rejected or left unmapped. */
  isLossless: boolean;
}

export interface TransformationResult {
  runId: string;
  status: "completed" | "failed" | "completed_with_warnings";
  sourceFormat: string;
  targetFormat: string;
  targetResourceType?: string;
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  output: unknown[];
  coverage: CoverageReport;
  rejectedRecords: RejectedRecord[];
  dataLoss: DataLossReport;
  validation: ValidationReport;
  traces: TraceEvent[];
  durationMs: number;
  /** Effective provenance timestamp used for this run (reproducibility anchor). */
  importedAt: string;
  inputChecksum?: string;
  outputChecksum?: string;
  adapterId?: string;
  adapterVersion?: string;
  engineVersion?: string;
}

export const ENGINE_VERSION = "3.2.0" as const;

/** Which validation levels actually ran — never infer, always report. */
export interface ValidationLevelExecution {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  status: "executed" | "skipped";
  validator?: string;
  reason?: string;
}

export interface ValidationReport {
  standard: string;
  isValid: boolean;
  levels: ValidationLevelExecution[];
  issues: ValidationIssue[];
  operationOutcomes?: Array<Record<string, unknown>>;
}

/**
 * Self-describing description of a run, sufficient to reproduce it elsewhere
 * given the original input bytes (identified by checksum, never embedded).
 */
export interface RunBundle {
  bundleVersion: "1";
  runId: string;
  createdAt: string;
  engineVersion: string;
  traceProtocolVersion: string;
  pipelineVersion: string;
  input: {
    id: string;
    filename?: string;
    sizeBytes?: number;
    checksum?: string;
  };
  adapter?: { id: string; version: string };
  mapping: unknown;
  options: { maxRecords?: number };
  expected: {
    status: string;
    recordsProcessed: number;
    recordsSucceeded: number;
    recordsFailed: number;
    outputChecksum?: string;
    validationValid: boolean;
  };
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Mapping contracts                                                          */
/* -------------------------------------------------------------------------- */

export type TransformFunctionKind =
  | "identity"
  | "uppercase"
  | "lowercase"
  | "trim"
  | "parse_date_iso"
  | "format_gender_fhir"
  | "concat"
  | "split"
  | "number_to_string"
  | "string_to_number"
  | "default_value"
  | "to_reference"
  | "codeable_concept";

/** Supported transforms, in the same order as the engine's `TRANSFORM_FUNCTIONS`. */
export const MAPPING_TRANSFORM_KINDS: readonly TransformFunctionKind[] = [
  "identity",
  "uppercase",
  "lowercase",
  "trim",
  "parse_date_iso",
  "format_gender_fhir",
  "concat",
  "split",
  "number_to_string",
  "string_to_number",
  "default_value",
  "to_reference",
  "codeable_concept",
];

export type ConditionOperator =
  "exists" | "not_exists" | "equals" | "not_equals" | "in" | "not_in" | "matches" | "gt" | "gte" | "lt" | "lte";

export interface RuleCondition {
  path: string;
  op: ConditionOperator;
  value?: unknown;
}

export interface MappingRule {
  id: string;
  sourcePath: string;
  targetPath: string;
  transform: TransformFunctionKind;
  defaultValue?: unknown;
  params?: Record<string, unknown>;
  required?: boolean;
  /** All conditions must hold for the rule to run. */
  when?: RuleCondition[];
  description?: string;
}

export interface MappingDefinition {
  id: string;
  name: string;
  version: string;
  sourceFormat: string;
  targetFormat: string;
  targetResourceType?: string;
  targetProfile?: string;
  description?: string;
  /**
   * Domains this mapping is intended for. When the detected source domain is
   * not listed, the run emits a `DOMAIN_MISMATCH` warning instead of silently
   * producing semantically wrong resources.
   */
  sourceDomains?: MedicalDomain[];
  rules: MappingRule[];
}

export interface MappingFieldChange {
  field: string;
  from?: unknown;
  to?: unknown;
}

export interface MappingRuleChange {
  ruleId: string;
  fields: MappingFieldChange[];
}

export interface MappingDiff {
  metadata: MappingFieldChange[];
  rules: {
    added: MappingRule[];
    removed: MappingRule[];
    changed: MappingRuleChange[];
    reordered: Array<{ ruleId: string; fromIndex: number; toIndex: number }>;
    unchanged: number;
  };
  counts: { added: number; removed: number; changed: number; reordered: number; unchanged: number };
  truncated: boolean;
}

export interface MappingValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  counts: { fatal: number; error: number; warning: number; information: number };
}

export interface MappingDraft {
  name: string;
  revision: number;
  baseVersion?: number;
  spec: unknown;
  specChecksum: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export type MappingPreviewRejectedRecord = Omit<RejectedRecord, "partialOutput">;

export interface MappingPreview {
  adapter: { id: string; version: string; format: string };
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsRejected: number;
  coverage: CoverageReport;
  validation: ValidationReport;
  issues: ValidationIssue[]; // max 200
  rejected: MappingPreviewRejectedRecord[]; // max 10, partialOutput stripped
  sample: unknown[]; // max 10 target resources
  durationMs: number;
  truncated: boolean;
  omitted: string[];
  bytes: number;
}

export interface MappingPreviewResponse {
  validation: MappingValidationResult;
  preview: MappingPreview;
}

/* -------------------------------------------------------------------------- */
/* Lineage contracts                                                          */
/* -------------------------------------------------------------------------- */

export type RunStatus =
  "queued" | "running" | "cancelling" | "cancelled" | "completed" | "completed_with_warnings" | "failed";

export type LineageNodeType =
  | "source_asset"
  | "adapter"
  | "source_field"
  | "mapping_rule"
  | "transformation_step"
  | "target_field"
  | "target_resource";

export interface LineageNode {
  id: string;
  label: string;
  type: LineageNodeType;
  metadata?: Record<string, unknown>;
}

export interface LineageEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface DeclaredLineage extends LineageGraph {
  name: string;
  mappingId: string;
  version: number;
  basis: "declared";
  rules: Array<{
    ruleId: string;
    sourcePath: string;
    targetPath: string;
    transform: TransformFunctionKind;
    conditionCount: number;
  }>;
  truncated: boolean;
}

export interface RunLineageEvidence {
  traceProtocolVersion: string;
  mappingEvents: number;
  records: number;
  success: number;
  warning: number;
  error: number;
  ruleLevel: false;
  redacted: boolean;
  note: string;
}

export interface RunLineage {
  runId: string;
  runStatus: RunStatus;
  mappingId: string;
  mappingVersion: number;
  basis: "declared";
  declared: DeclaredLineage;
  evidence: RunLineageEvidence;
  truncated: boolean;
}

/** Flatten an object into leaf paths, bounded by depth and array length. */
export function flattenLeafPaths(
  value: unknown,
  options: { prefix?: string; maxDepth?: number; maxArrayItems?: number } = {},
): string[] {
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayItems = options.maxArrayItems ?? 100;
  const prefix = options.prefix ?? "";
  const out: string[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      const limit = Math.min(node.length, maxArrayItems);
      for (let i = 0; i < limit; i++) {
        walk(node[i], path ? `${path}.${i}` : String(i), depth + 1);
      }
      if (node.length === 0 && path) out.push(path);
      return;
    }
    if (typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length === 0 && path) {
        out.push(path);
        return;
      }
      for (const [key, child] of entries) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
      return;
    }
    if (path) out.push(path);
  };

  walk(value, prefix, 0);
  return out;
}
