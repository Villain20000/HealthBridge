import {
  CapabilityManifest,
  InputDescriptor,
  InspectionResult,
  MedicalDataEnvelope,
  ParseContext,
} from "@healthbridge/shared-types";

export interface MedicalFormatAdapter {
  id: string;
  version: string;
  getManifest(): CapabilityManifest;
  detect(input: InputDescriptor): Promise<boolean>;
  inspect(input: InputDescriptor): Promise<InspectionResult>;
  parse(
    input: InputDescriptor,
    context: ParseContext
  ): AsyncIterable<MedicalDataEnvelope>;
}

export class AdapterRegistry {
  private adapters: Map<string, MedicalFormatAdapter> = new Map();

  public register(adapter: MedicalFormatAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(id: string): MedicalFormatAdapter | undefined {
    return this.adapters.get(id);
  }

  public list(): CapabilityManifest[] {
    return Array.from(this.adapters.values()).map((a) => a.getManifest());
  }

  public async detectAdapter(input: InputDescriptor): Promise<MedicalFormatAdapter | undefined> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.detect(input)) {
        return adapter;
      }
    }
    return undefined;
  }
}

export function createCanonicalEnvelope(
  id: string,
  domain: MedicalDataEnvelope["domain"],
  sourceFormat: string,
  content: MedicalDataEnvelope["content"],
  adapterId: string,
  adapterVersion: string,
  recordIndex?: number,
  metadata: Record<string, unknown> = {}
): MedicalDataEnvelope {
  return {
    id,
    domain,
    source: {
      format: sourceFormat,
    },
    content,
    metadata,
    provenance: {
      importedAt: new Date().toISOString(),
      adapterId,
      adapterVersion,
      recordIndex,
    },
    classification: {
      sensitivity: "internal",
    },
  };
}

export * from "@healthbridge/shared-types";
export * from "@healthbridge/trace-protocol";
