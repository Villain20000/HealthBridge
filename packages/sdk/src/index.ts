import { InputDescriptor, TransformationResult } from "@healthbridge/shared-types";
import { TransformationPipeline } from "@healthbridge/transformation-engine";
import { MappingDefinition } from "@healthbridge/mapping-engine";
import { FhirValidator } from "@healthbridge/validation";

export interface HealthBridgeSdkConfig {
  debug?: {
    enabled?: boolean;
    payloadMode?: "full" | "redacted";
  };
}

export class HealthBridge {
  private pipeline: TransformationPipeline;
  private fhirValidator: FhirValidator;

  constructor(config: HealthBridgeSdkConfig = {}) {
    this.pipeline = new TransformationPipeline();
    this.fhirValidator = new FhirValidator();
  }

  public async transform(params: {
    input: InputDescriptor;
    mapping: MappingDefinition;
    adapterId?: string;
  }): Promise<TransformationResult> {
    return this.pipeline.execute({
      input: params.input,
      mapping: params.mapping,
      adapterId: params.adapterId,
    });
  }

  public validateFhir(resource: Record<string, unknown>) {
    return this.fhirValidator.validate(resource);
  }

  public listFormats() {
    return this.pipeline.getRegistry().list();
  }
}

export * from "@healthbridge/shared-types";
export * from "@healthbridge/mapping-engine";
export * from "@healthbridge/transformation-engine";
export * from "@healthbridge/validation";
export * from "@healthbridge/lineage-engine";
