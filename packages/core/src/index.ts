import { createHash } from "node:crypto";
import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  MedicalDomain,
  ParseContext,
  Sensitivity,
  ValidationIssue,
} from "@healthbridge/shared-types";

/**
 * Contract every medical format adapter implements.
 *
 * `detect` is required for backwards compatibility; new adapters should also
 * implement `score` so the registry can pick the most specific parser instead
 * of the first one that returns `true`.
 */
export interface MedicalFormatAdapter {
  id: string;
  version: string;
  getManifest(): CapabilityManifest;
  detect(input: InputDescriptor): Promise<boolean>;
  score?(input: InputDescriptor): Promise<number>;
  inspect(input: InputDescriptor): Promise<InspectionResult>;
  parse(input: InputDescriptor, context: ParseContext): AsyncIterable<MedicalDataEnvelope>;
  /** Optional self-check reported by `healthbridge doctor` and `GET /adapters`. */
  health?(): Promise<{ ok: boolean; details: string }>;
}

export interface DetectionCandidate {
  adapterId: string;
  format: string;
  confidence: number;
}

export interface AdapterHealthReport {
  adapterId: string;
  format: string;
  version: string;
  ok: boolean;
  details: string;
}

export class AdapterRegistry {
  private adapters: Map<string, MedicalFormatAdapter> = new Map();

  public register(adapter: MedicalFormatAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  public unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  public get(id: string): MedicalFormatAdapter | undefined {
    return this.adapters.get(id);
  }

  public list(): CapabilityManifest[] {
    return this.listAdapters().map((a) => a.getManifest());
  }

  public listAdapters(): MedicalFormatAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Rank every registered adapter for this input.
   *
   * Adapters exposing `score` provide a confidence in 0..1; adapters that only
   * implement `detect` score 0.5 when they accept the input. Results are sorted
   * by descending confidence so the most specific parser wins.
   */
  public async detect(input: InputDescriptor): Promise<DetectionCandidate[]> {
    const candidates: DetectionCandidate[] = [];

    for (const adapter of this.adapters.values()) {
      let confidence = 0;
      if (adapter.score) {
        confidence = clamp01(await adapter.score(input));
      } else if (await adapter.detect(input)) {
        confidence = 0.5;
      }
      if (confidence > 0) {
        candidates.push({
          adapterId: adapter.id,
          format: adapter.getManifest().format,
          confidence,
        });
      }
    }

    return candidates.sort((a, b) => b.confidence - a.confidence || a.adapterId.localeCompare(b.adapterId));
  }

  public async detectAdapter(input: InputDescriptor): Promise<MedicalFormatAdapter | undefined> {
    const [best] = await this.detect(input);
    return best ? this.adapters.get(best.adapterId) : undefined;
  }

  public async health(): Promise<AdapterHealthReport[]> {
    const reports: AdapterHealthReport[] = [];
    for (const adapter of this.adapters.values()) {
      const manifest = adapter.getManifest();
      if (adapter.health) {
        const result = await adapter.health();
        reports.push({
          adapterId: adapter.id,
          format: manifest.format,
          version: adapter.version,
          ok: result.ok,
          details: result.details,
        });
      } else {
        reports.push({
          adapterId: adapter.id,
          format: manifest.format,
          version: adapter.version,
          ok: true,
          details: "registered (no self-check implemented)",
        });
      }
    }
    return reports;
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** SHA-256 of the raw asset bytes. Never hashes PHI out of existence — it fingerprints it. */
export function computeChecksum(input: { buffer?: Buffer; contentString?: string }): string | undefined {
  const data =
    input.buffer ?? (input.contentString !== undefined ? Buffer.from(input.contentString, "utf-8") : undefined);
  if (!data) return undefined;
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export interface SensitivityRule {
  /** Restrict the rule to specific domains. */
  domains?: MedicalDomain[];
  /** Restrict the rule to specific formats. */
  formats?: string[];
  /** Filename pattern (case-insensitive). */
  filenamePattern?: RegExp;
  sensitivity: Sensitivity;
  reason: string;
}

/**
 * Default, deliberately conservative policy: healthcare payloads are
 * `sensitive` unless an operator explicitly configures otherwise.
 * Classification is policy-driven, never inferred from the file extension.
 */
export const DEFAULT_SENSITIVITY_POLICY: SensitivityRule[] = [
  {
    sensitivity: "sensitive",
    reason: "default-conservative-healthcare-policy",
  },
];

export function classifySensitivity(
  input: { domain: MedicalDomain; format: string; filename?: string },
  policy: SensitivityRule[] = DEFAULT_SENSITIVITY_POLICY,
): { sensitivity: Sensitivity; reason: string } {
  for (const rule of policy) {
    if (rule.domains && !rule.domains.includes(input.domain)) continue;
    if (rule.formats && !rule.formats.includes(input.format)) continue;
    if (rule.filenamePattern && !rule.filenamePattern.test(input.filename ?? "")) continue;
    return { sensitivity: rule.sensitivity, reason: rule.reason };
  }
  return { sensitivity: "sensitive", reason: "no-policy-match-conservative-default" };
}

export interface EnvelopeOptions {
  id: string;
  domain: MedicalDomain;
  sourceFormat: string;
  formatVersion?: string;
  content: MedicalDataEnvelope["content"];
  adapterId: string;
  adapterVersion: string;
  recordIndex?: number;
  sourceLocation?: string;
  filename?: string;
  checksum?: string;
  encoding?: string;
  metadata?: Record<string, unknown>;
  sensitivity?: Sensitivity;
  classificationReason?: string;
  sensitivityPolicy?: SensitivityRule[];
  unmappedFields?: Record<string, unknown>;
  parseIssues?: ValidationIssue[];
  system?: string;
  /** Fixed import timestamp for reproducible runs. Defaults to now. */
  importedAt?: string;
}

export function createCanonicalEnvelope(options: EnvelopeOptions): MedicalDataEnvelope {
  const classification = options.sensitivity
    ? { sensitivity: options.sensitivity, reason: options.classificationReason ?? "explicit" }
    : classifySensitivity(
        { domain: options.domain, format: options.sourceFormat, filename: options.filename },
        options.sensitivityPolicy,
      );

  return {
    id: options.id,
    domain: options.domain,
    source: {
      system: options.system,
      format: options.sourceFormat,
      formatVersion: options.formatVersion,
      checksum: options.checksum,
      filename: options.filename,
      encoding: options.encoding,
    },
    content: options.content,
    metadata: options.metadata ?? {},
    provenance: {
      importedAt: options.importedAt ?? new Date().toISOString(),
      adapterId: options.adapterId,
      adapterVersion: options.adapterVersion,
      recordIndex: options.recordIndex,
      sourceLocation: options.sourceLocation,
    },
    classification,
    unmappedFields: options.unmappedFields,
    parseIssues: options.parseIssues?.length ? options.parseIssues : undefined,
  };
}

export * from "@healthbridge/shared-types";
export * from "@healthbridge/trace-protocol";
