# Schema Explorer — planned

**Status:** 🟡 shipped (mapping-editor explorers + `GET /assets/:id/schema`); full explorer still planned · **Phase:** D3 · **UI today:** mapping editor embeds source/target schema explorers.

## Why it matters

Before mapping, an operator needs to know what the file actually contained: inferred types,
nullability, samples, parse issues, and which columns were never mapped.

## What exists today (verified)

- Uploads parse into the canonical envelope, which records source location, encoding,
  classification, parse issues and unmapped fields (`ARCHITECTURE.md` §4).
- `GET /assets/:id` returns asset metadata; `GET /formats` lists adapter capabilities.
- `run.resources` / issues expose per-record mapping outcomes.

## What is missing

- No endpoint that returns an asset's inferred schema (fields, types, null counts, samples).
- The envelope is not exposed through the API in a browser-safe shape.
- No "unmapped fields" report per asset independent of a run.

## Proposed design

`GET /assets/:id/schema` returning, per field: `name`, `inferredTypes[]`, `nullable`,
`nullCount`, `sampleValues[]` (redacted by advisory only), `parseIssueCount`. Cached per
(`assetId`, adapterVersion) and stored with the asset at upload time.

UI: a single route under `/studio/schema/:assetId`, lazy-loaded, table-based, keyboard
navigable, with a filter box and a "used by mappings" column derived from stored specs.

## Acceptance criteria

- Schema is produced by the adapter, not re-guessed in the browser.
- Sample values respect the same redaction policy as traces (ADR-0002/0003).
- A field hidden by redaction says so explicitly instead of showing blanks.
- Works for CSV, JSON and FHIR R4 inputs; unsupported adapters show `not supported`, not empty.

## Risks / non-goals

- Inference is a heuristic; the UI must label it as inferred, never as a source contract.
- No schema editing, no JSON-Schema export, no cross-asset schema merging in v1.
