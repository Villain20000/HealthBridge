# HealthBridge OS — System Architecture & Design Specification

## 1. Architectural Philosophy

HealthBridge OS adheres to the principle of **Universal Input, Explicit Capabilities, and No Silent Data Loss**.

Healthcare data originates across incompatible formats, legacy standards, and proprietary schemas. HealthBridge OS operates as a decoupled interoperability and debugging layer between systems.

---

## 2. Monorepo Organization & Package Contracts

```text
packages/shared-types          --> Core domain types, envelopes, and trace interfaces
packages/trace-protocol        --> Normalized event collector & PII redaction
packages/core                  --> Adapter registry & Envelope contracts
packages/adapters              --> CSV, JSON, FHIR R4 JSON / NDJSON format adapters
packages/mapping-engine        --> Declarative transformation rules & coverage calculator
packages/transformation-engine --> Pipeline execution coordinator
packages/fhir-r4              --> Resource contracts (Patient, Observation, Specimen, etc.)
packages/validation           --> FHIR validator & OperationOutcome generator
packages/lineage-engine        --> Source-to-target field provenance graph
packages/sdk                   --> Standalone TypeScript SDK (@healthbridge/sdk)
packages/cli                   --> Standalone CLI (@healthbridge/cli)
apps/api                       --> NestJS REST API with OpenAPI Swagger documentation
apps/web                       --> Angular Web Studio & Visual Debugger
```

---

## 3. Canonical Medical Data Envelope

Regardless of the source format (CSV, JSON, FHIR, DICOM metadata), datasets are parsed into the `MedicalDataEnvelope`:

```typescript
interface MedicalDataEnvelope {
  id: string;
  domain: MedicalDomain;
  source: {
    format: string;
    formatVersion?: string;
    checksum?: string;
    filename?: string;
  };
  content:
    | { kind: "structured"; data: unknown }
    | { kind: "binary-reference"; uri: string; mediaType: string }
    | { kind: "document-reference"; uri: string; mediaType: string };
  metadata: Record<string, unknown>;
  provenance: {
    importedAt: string;
    adapterId: string;
    adapterVersion: string;
    recordIndex?: number;
  };
  classification: { sensitivity: "public" | "internal" | "sensitive" };
}
```

---

## 4. Execution Modes

1. **Offline Standalone Mode (`@healthbridge/sdk`, `@healthbridge/cli`):**
   - No database, Redis, or external cloud connection required.
   - Runs locally in air-gapped or developer CLI environments.
   - Generates deterministic JSON transformation outputs and normalized trace reports.

2. **Hosted / Self-Hosted Mode (`apps/api`, `apps/web`, Docker):**
   - NestJS REST API server on port 3000 (`/api/v1`).
   - OpenAPI Swagger documentation at `/api/docs`.
   - Angular Web Studio on port 4200.
