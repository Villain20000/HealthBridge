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

export interface MedicalDataEnvelope {
  id: string;
  domain: MedicalDomain;
  source: {
    system?: string;
    format: string;
    formatVersion?: string;
    checksum?: string;
    filename?: string;
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
  metadata: Record<string, unknown>;
  provenance: {
    importedAt: string;
    adapterId: string;
    adapterVersion: string;
    recordIndex?: number;
    sourcePath?: string;
  };
  classification: {
    sensitivity: "public" | "internal" | "sensitive";
  };
  unmappedFields?: Record<string, unknown>;
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
}

export interface CapabilityManifest {
  format: string;
  version: string;
  description: string;
  extensions: string[];
  mimeTypes: string[];
  capabilities: FormatCapabilities;
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

export interface InspectionResult {
  format: string;
  formatVersion?: string;
  domain: MedicalDomain;
  recordCount?: number;
  detectedSchema?: {
    fields: Array<{
      name: string;
      type: string;
      sampleValues?: unknown[];
      nullable?: boolean;
    }>;
  };
  sampleRecords?: Array<Record<string, unknown>>;
  capabilities: FormatCapabilities;
  warnings?: string[];
}

export interface ParseContext {
  options?: Record<string, unknown>;
  adapterId: string;
  adapterVersion: string;
  maxRecords?: number;
}

export interface ValidationIssue {
  code: string;
  severity: "fatal" | "error" | "warning" | "information";
  message: string;
  location?: string;
  path?: string;
  recordIndex?: number;
  ruleId?: string;
}

export interface TraceEvent {
  protocolVersion: "1.0";
  runId: string;
  correlationId?: string;
  timestamp: string;
  stepId: string;
  stepName: string;
  recordIndex?: number;
  adapterId?: string;
  ruleId?: string;
  sourcePath?: string;
  targetPath?: string;
  inputSnippet?: unknown;
  outputSnippet?: unknown;
  durationMs?: number;
  issues?: ValidationIssue[];
  redacted: boolean;
  status: "success" | "warning" | "error" | "skipped";
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
}

export interface TransformationResult {
  runId: string;
  status: "completed" | "failed" | "completed_with_warnings";
  sourceFormat: string;
  targetFormat: string;
  recordsProcessed: number;
  recordsSucceeded: number;
  recordsFailed: number;
  output: unknown[];
  coverage: CoverageReport;
  traces: TraceEvent[];
  durationMs: number;
}
