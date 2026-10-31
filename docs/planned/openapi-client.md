# OpenAPI document and generated client — planned

**Status:** ⬜ not implemented · **Phase:** C · **UI today:** `docs/api.md` is the contract and
`core/api-types.ts` is hand-written against it.

## Why it matters

Two defects in the console cycle came from DTO drift (resource-named list envelopes; the
pipeline `steps` vs `config` shape). A generated client makes that class of bug impossible.

## What exists today (verified)

- `docs/api.md` documents every route, scope, error code and lifecycle.
- The controller set is NestJS; no OpenAPI document is served or committed.
- Console DTOs are hand-maintained and covered by E2E, not by schema checks.

## What is missing

- An OpenAPI 3.1 document generated from DTOs/controllers (or hand-written and linted).
- A committed artifact diffed in CI ("the contract changed; regenerate the client").
- A generated TypeScript client with `Page<T>` mapping and `ApiProblem` normalisation.

## Proposed design

Generate the document at build time (`@nestjs/swagger` or a small serialiser), commit it to
`docs/openapi.json`, and fail CI when regeneration produces a diff. Generate a client package
(`packages/api-client`) used by the console and the SDK; keep `ApiProblem` as a thin wrapper so
error handling does not change.

## Acceptance criteria

- CI fails if the committed document differs from the generated one.
- The console imports generated types; hand-written duplicates are deleted.
- Error envelopes and unknown-route 404 shapes are represented in the document.
- `docs/api.md` keeps the narrative; the OpenAPI file is the machine contract.

## Risks / non-goals

- Decorator-driven generation can leak internals; the document is reviewed, not auto-published.
- No public API stability guarantee yet; the document is versioned with the API version.
