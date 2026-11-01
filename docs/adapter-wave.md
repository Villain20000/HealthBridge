# Adapter wave (HL7 v2, CDA, XLSX, DICOM, FHIR REST, OMOP, VCF) — shipped

**Status:** ✅ landed as opt-in adapters (built-ins: CSV/JSON/FHIR-JSON/NDJSON) · **Phase:** E/F · **UI today:** `/formats` lists what is actually
supported; the console shows the API response verbatim, including limitations.

## What exists today (verified)

| Adapter | Status |
|---|---|
| CSV (RFC 4180, delimiter detection, encodings) | supported |
| JSON (object or array) | supported |
| FHIR R4 JSON (resource, Bundle, NDJSON) | partial — structural inspection only |

## What is missing

- **HL7 v2** (ADT, ORU): segment/field parser, escaping, repeating fields, MSH-9 routing.
- **CDA / generic XML**: namespace-aware parse, section metadata; no clinical interpretation.
- **XLSX**: sheets, typed cells, formula results as stored; no macro execution.
- **FHIR REST client**: paging, capability statement, SSRF allowlist (explicitly not a crawler).
- **DICOM metadata**: explicit/implicit VR, private tags, PHI tag policy.
- **Split FHIR NDJSON package** handling, **OMOP CDM** staging subset, **VCF**, **FASTA/FASTQ**,
  **PDF** metadata with opt-in text extraction.
- A shared **conformance test suite** every adapter must pass before it is listed as supported.

## Proposed design

Adapters implement the existing capability manifest + `parse` contract (`ARCHITECTURE.md` §3).
Each new adapter ships: fixtures, conformance tests (including hostile inputs: XXE, zip bombs,
deep nesting, enormous cells), a manifest entry, a CLI/API smoke assertion, and docs that state
the supported subset. `GET /formats` is generated from manifests, so the UI cannot drift.

## Acceptance criteria

- A new adapter is listed only after its conformance suite is green in CI.
- Malformed input yields parse issues with source locations, never a crash or a silent drop.
- Security suite covers XXE, zip bombs, oversized inputs and tenant isolation per adapter.
- The console shows per-adapter limitations from `/formats` (no hardcoded capability text).

## Risks / non-goals

- Binary formats (DICOM, PDF) require licence-free fixtures; synthetic data only in the repo.
- No clinical interpretation, no terminology mapping, no DICOM pixel data in this wave.
