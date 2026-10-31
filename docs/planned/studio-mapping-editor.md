# Visual Mapping Studio (M2) — planned

**Status:** ⬜ not implemented · **Phase:** D2 · **UI today:** `features/mappings` is read-only
(import JSON, list, inspect stored spec, version history).

## Why it matters

Mappings are the product. Today an operator must edit JSON elsewhere and re-import; the console
cannot show why a target field is empty or let a domain expert change a transform safely.

## What exists today (verified)

- `POST /mappings` with `{name, spec, targetResourceType}`; server validates the spec shape and
  stores a checksum + version (`docs/api.md`).
- `GET /mappings`, `GET /mappings/:id`, `GET /mappings/:name/versions`.
- Runs pin `mappingId`; the Studio debugger loads the run's exact mapping version.
- Mapping engine supports 11 deterministic transforms with array-aware paths (ADR-0001).

## What is missing

- No endpoint that validates a spec **without** persisting it (edit-time feedback).
- No source schema: the editor cannot offer field autocomplete from the uploaded asset.
- No optimistic concurrency: two editors would silently overwrite by creating a new version.
- No server-side "dry run against one record" endpoint.

## Proposed design

Three panes (source · mapping table · target preview), reusing `ui/` primitives and the design
tokens. State in a page-scoped signal store like `debugger.store.ts`; no HTTP in components.

New API (proposed):

```
POST /mappings/validate   { spec }                 -> { valid, issues[], preview[] }
POST /mappings/:id/dry-run { assetId, maxRecords } -> { resources[], issues[], traces[] }
PUT  /mappings/:id        { spec, expectedVersion }-> 409 VERSION_CONFLICT on mismatch
GET  /assets/:id/schema                            -> inferred fields (see schema-explorer.md)
```

## Acceptance criteria

- Editing a spec produces validation errors inline, from the server, before any save.
- Saving requires `expectedVersion`; a stale tab gets `409` with the current version and diff.
- "Preview" runs the real engine against N records of the selected asset — no mocked rows.
- Every save creates an immutable version; the debugger can open a run against either version.
- Unimplemented panes (lineage, terminology) stay visible as `planned` cards.

## Risks / non-goals

- A drag-and-drop canvas is a large surface; v1 of M2 should be a table editor, not a graph.
- Spec semantics must not be duplicated in TypeScript: validation stays server-side.
- Bulk mapping generation from a template is out of scope.
