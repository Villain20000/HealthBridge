# @healthbridge/adapters

Healthcare format adapters for HealthBridge OS: CSV/TSV, JSON and FHIR R4 JSON/Bundle/NDJSON are built in; HL7 v2, CDA/XML, DICOM, DICOMweb, XLSX, VCF, FASTA/FASTQ, FHIR REST, OMOP, PDF, EDF/WFDB, CDISC ODM and a read-only MySQL source connector exist as opt-in adapters (`registerAdapter`).

**Status:** CSV and JSON adapters are supported in the v3.2.0 developer preview. The FHIR R4 JSON and NDJSON adapters are partial: structural inspection only. Opt-in adapters are metadata-only (MySQL is partial); profile validation executes only when a validator is injected, terminology only with an operator-supplied provider. No adapter interprets clinical content.

## Install

Install from source until the first npm release: `npm ci && npm run build`.

Published as `@healthbridge/adapters` when released.

## Links

- [Project README](../../README.md)
- [Roadmap](../../ROADMAP.md)
- [Security policy](../../SECURITY.md)
- [License (Apache-2.0)](LICENSE)
