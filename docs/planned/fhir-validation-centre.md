# FHIR Validation Centre — planned

**Status:** 🟡 shipped per-run (validation centre page renders stored levels); aggregation across runs still planned · **Phase:** F · **UI today:** levels 4–6 render as executed only when a validator/provider is injected
only; the console never claims profile or terminology validation.

## Why it matters

Structural checks catch broken shapes; they do not catch a Patient that violates a national
profile or uses a retired LOINC code. Operators need to know which level was actually executed.

## What exists today (verified)

- Structural validation for Patient, Observation, Specimen (+ `resourceType` presence).
- Profile/terminology/referential levels are **not executed**; the CLI and docs say so.
- Issues are stored per run and shown in the console with codes and counts.

## What is missing

- External validator adapter and MIABIS profile validators exist as opt-in `ProfileValidator`s; no profile registry.
- Local terminology provider exists (operator-supplied tables with licence metadata; level 5 executes end-to-end); no terminology server integration for licensed systems (LOINC, SNOMED CT, ICD-10/11, RxNorm, ATC).
  Server integration for those systems is still open.
- Per-level result model exists (`result.validation.levels` with executed/skipped + reason); aggregation across runs and a profile registry are still open.

## Proposed design

Extend the issue model with `level` and `validator` fields (additive; existing codes unchanged).
`POST /runs/:id/validate {levels[], profiles[]}` enqueues a validation job (same durable queue),
results stored next to the run. UI gains a "Validation" tab per level, with export to CSV/JSON.

## Acceptance criteria

- The UI names the validator and version that produced each issue.
- A level that was not executed renders as `not run`, never as `passed`.
- Terminology loading is licence-aware: no unlicensed codesets shipped in the repo or image.
- Validation of a large bundle runs as a job with progress, not a blocking request.

## Risks / non-goals

- External validator availability becomes a deployment dependency; it must degrade to
  "structural only" loudly.
- No clinical validation, no FHIR Shorthand authoring, no terminology server shipped here.
