# Data Lineage Explorer — planned

**Status:** 🟡 shipped read-only (`lineage/:runId` over stored traces); declared per-rule lineage still planned · **Phase:** D3 · **UI today:** provenance is only visible per
event inside the stored-trace debugger.

## Why it matters

"Where did this FHIR field come from, and what did we lose?" is the core debugging question for
healthcare interoperability. Lineage makes that answerable without reading traces by hand.

## What exists today (verified)

- Each stored trace event carries the payload diff and redaction state (`docs/api.md`,
  ADR-0002/0003).
- The debugger shows event detail and provenance for a single record (`features/studio/debugger`).
- Run resources link back to source locations in the envelope.

## What is missing

- No aggregate endpoint: lineage would have to be computed from stored traces, and doing that in
  the browser from one page of events would be a lie.
- No representation of *unmapped source fields* and *dropped values* as first-class nodes.

## Proposed design

`GET /runs/:id/lineage?resourceId=` returning nodes `{kind: source|transform|target|dropped}`
and edges `{from, to, transform, condition, count}` computed server-side from stored traces.
For a workspace-level view, an offline rollup per mapping version, never an on-demand scan of all
runs.

UI: directed graph with a table fallback (accessibility), pan/zoom, and a per-field side panel
reusing the debugger's event-detail component.

## Acceptance criteria

- Every edge is backed by a stored trace/issue; no inferred edges without a label saying so.
- Lineage of a rejected record shows the rejection reason and the failing transform.
- Works for a run whose mapping version is no longer the latest.
- The table view alone is sufficient to answer all questions (graph is an enhancement).

## Risks / non-goals

- Aggregating across thousands of runs is a batch job, not a request.
- No lineage across separate runs (cross-run joins) in v1.
