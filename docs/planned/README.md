# Planned features — specs for everything not built yet

Every document here describes a capability that **does not exist in the codebase**. They exist so
the gap is specified instead of implied: what the API can do today, what is missing, what the
design is, and what "done" means.

The console renders these as **`planned` cards**, never as disabled buttons that pretend to work.
If a feature is implemented, its document moves out of this folder and into `docs/`.

| Document | Capability | Phase |
|---|---|---|
| [studio-mapping-editor.md](studio-mapping-editor.md) | Visual mapping studio (edit, validate, version) | D2 |
| [schema-explorer.md](schema-explorer.md) | Source schema inference and browsing | D3 |
| [data-lineage.md](data-lineage.md) | Field-level lineage from source to FHIR output | D3 |
| [fhir-validation-centre.md](fhir-validation-centre.md) | Profile/terminology validation and triage | F |
| [asset-explorer.md](asset-explorer.md) | Browse stored records and resources | D3 |
| [live-execution.md](live-execution.md) | Streaming upload/parse, pausable execution | C/F/G |
| [adapter-wave.md](adapter-wave.md) | HL7 v2, CDA, XLSX, DICOM, FHIR REST, OMOP, VCF | E/F |
| [auth-bff-oidc.md](auth-bff-oidc.md) | Cookie-based BFF/OIDC instead of an in-memory key | D4 |
| [openapi-client.md](openapi-client.md) | Committed OpenAPI document + generated client | C |
| [queue-broker.md](queue-broker.md) | Redis/BullMQ (or similar) queue behind the same contract | C/F |
| [storage-drivers.md](storage-drivers.md) | S3-compatible object storage | F |
| [component-tests.md](component-tests.md) | Angular TestBed layer (Vitest or Karma) | D |
| [multi-workspace.md](multi-workspace.md) | Workspace selection inside one session | D4 |
| [hardening-and-release.md](hardening-and-release.md) | Security suite, benchmarks, docs site, release automation | F |

## Rules for promoting a document

1. Implement the API contract and its integration tests first; the UI cannot invent semantics.
2. Remove the `planned` card from the console in the same change that adds the screen.
3. Move the document to `docs/`, rewrite "what exists today", add it to `PROGRESS.md` §1.
4. If the design changes while implementing, update the document in that commit, not later.
