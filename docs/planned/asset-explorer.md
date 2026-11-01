# Healthcare Data Asset Explorer — planned

**Status:** 🟡 shipped (mapping-editor explorers + `GET /assets/:id/schema`); full asset record browser still planned · **Phase:** D3 · **UI today:** `/assets` lists uploads and links
to the bytes; it does not browse records or generated resources.

## Why it matters

An operator debugging a run needs to see the actual input record and the actual generated
resource, side by side, without downloading a file and opening it elsewhere.

## What exists today (verified)

- Assets are content-addressed with a checksum; downloads carry `x-checksum`
  (`docs/api.md`, B1).
- Generated resources are served by `GET /runs/:id/resources` and listed in run detail.
- The run bundle (`GET /runs/:id/bundle`) is downloadable and reproducible.

## What is missing

- No paginated access to *records inside an asset* (the envelope is stored, not queryable).
- No redaction-aware preview (a raw preview could leak PHI into a browser cache or a screenshot).
- No resource-level viewer: run resources are a list of ids, not rendered resources.

## Proposed design

- `GET /assets/:id/records?limit&cursor` — paged envelope records with redaction applied by the
  same policy as traces; `?redact=none` only for scopes that carry `assets:read_raw`.
- `GET /runs/:id/resources/:resourceId` — the stored FHIR resource.
- UI: two-column inspector (source record ↔ generated resource) inside `/studio`, reusing the
  debugger's JSON viewer and virtual window. No `innerHTML`; JSON is rendered as data.

## Acceptance criteria

- Paging is server-side; the browser never holds the whole object.
- Redacted fields are labelled, and requesting raw data requires an explicit scope.
- Previews never land in `localStorage`, and downloads keep `no-store`.
- Works for CSV, JSON and FHIR inputs; binary assets show metadata only.

## Risks / non-goals

- Previewing PHI in a browser is a real privacy decision; default is redacted.
- No editing of records, no ad-hoc query language, no export of a filtered subset in v1.
