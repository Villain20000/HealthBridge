# HealthBridge OS — Global Open-Source Master Platform v3.0

> **Universal Medical Data Interoperability, Transformation and Debugging Platform**

HealthBridge OS is an open-source, developer-first platform for processing, mapping, validating, transforming, and debugging heterogeneous medical, clinical, laboratory, imaging, research, genomic, biospecimen, device, and healthcare administrative datasets across modern software environments.

---

## 🌟 Key Features

- **Universal Medical Data Envelope:** Format-independent, non-lossy representation preserving source metadata, lineage, provenance, and unmapped attributes.
- **Pluggable Adapter Engine:** Provider-agnostic adapter framework supporting CSV, JSON, FHIR R4 JSON / NDJSON, DICOM metadata, HL7 v2, and CDA.
- **Visual Transformation Debugger 2.0:** Signature developer tool for step-by-step trace inspection, record-level before/after JSON comparison, conditional debugging, and normalized issue logs.
- **Declarative Schema Mapping Engine:** Safe, deterministic mapping rules (string, number, date, unit, gender) without raw JS code evaluation.
- **Standalone TypeScript SDK (`@healthbridge/sdk`):** Embed lightweight, offline transformation logic directly into Node.js applications without requiring MySQL or Redis.
- **Standalone CLI (`@healthbridge/cli`):** Terminal developer tool (`healthbridge doctor`, `inspect`, `transform`, `validate`, `formats`) for offline local workflows.
- **NestJS REST API & OpenAPI Swagger:** High-throughput API server with Swagger docs (`/api/docs`), background queue support, and audit persistence.
- **Angular Web Studio:** VS Code / Linear inspired developer studio built with Angular Signals, dark/light mode themes, and responsive inspection panels.
- **One-Command Self-Hosting:** Instant setup using Docker Compose (`docker compose -f docker/compose.demo.yaml up --build`).

---

## 🚀 Quickstart

### 1. Standalone CLI Usage

```bash
# Environment & Doctor check
healthbridge doctor

# Inspect supported healthcare format adapters
healthbridge formats list

# Inspect a medical dataset
healthbridge inspect ./datasets/synthetic-patients.csv

# Transform CSV to FHIR R4 Patient resources
healthbridge transform ./datasets/synthetic-patients.csv --mapping ./examples/patient-mapping.json

# Validate a FHIR resource
healthbridge validate ./patient.json
```

### 2. Standalone TypeScript SDK Usage

```typescript
import { HealthBridge } from "@healthbridge/sdk";

const bridge = new HealthBridge();

const result = await bridge.transform({
  input: { id: "input-1", filename: "patients.csv", contentString: csvData },
  mapping: patientMappingDefinition,
});

console.log("Transformation Status:", result.status);
console.log("Generated FHIR Patients:", result.output);
```

### 3. Docker Compose Self-Hosting

```bash
docker compose -f docker/compose.demo.yaml up --build
```
- **Web Studio UI:** `http://localhost:4200`
- **REST API:** `http://localhost:3000`
- **Swagger Documentation:** `http://localhost:3000/api/docs`

---

## 🏗 Repository Structure

```text
healthbridge-os/
├── apps/
│   ├── web/            # Angular Web Studio & Visual Transformation Debugger
│   └── api/            # NestJS REST API Server
├── packages/
│   ├── shared-types/   # Shared TypeScript types & interfaces
│   ├── trace-protocol/ # Normalized trace collector & event schema
│   ├── core/           # Envelope builder, adapter registry & contracts
│   ├── adapters/       # CSV, JSON, FHIR R4 adapters
│   ├── mapping-engine/ # Safe declarative schema mapping engine
│   ├── transformation-engine/ # End-to-end transformation pipeline
│   ├── fhir-r4/        # FHIR R4 resource models
│   ├── validation/     # FHIR Validator & OperationOutcome generator
│   ├── lineage-engine/ # Data provenance graph builder
│   ├── sdk/            # @healthbridge/sdk standalone library
│   └── cli/            # @healthbridge/cli executable tool
├── datasets/           # Deterministic synthetic healthcare datasets
├── examples/           # Mapping definitions and SDK usage scripts
└── docker/             # Docker Compose and Dockerfile deployment manifests
```

---

## 🛡 Privacy & Security

- **Payload Redaction:** PII / sensitive attributes (SSNs, passwords, emails) are masked by default in normalized trace events.
- **Least Privilege:** Workspace isolation and audit logging for hosted instances.
- **No Telemetry:** HealthBridge OS does not transmit healthcare data to third-party services or AI providers without explicit configuration.

---

## 📜 License

Licensed under the **Apache License, Version 2.0**. See `LICENSE` for details.
