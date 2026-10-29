# ADR-0001 — Array-aware target paths in the mapping engine

**Status:** accepted (v3.1.0) · **Context:** mapping engine, transformation pipeline

## Problem

Mapping rules used dotted target paths such as `name.0.given.0` to build FHIR resources. The path writer treated every segment as an object key, producing:

```json
{ "name": { "0": { "given": { "0": "Jane" } } } }
```

This is not valid FHIR (cardinality and datatype are wrong), so every produced resource failed real validation, while the tool reported success.

## Decision

Numeric path segments create and address arrays; named segments create objects. Sparse indexes are allowed (`address.2.city`). The same helper reads paths (`getPath`), so mapping conditions and coverage use identical semantics. A mapping targeting a root array (`0.id`) is supported.

## Consequences

- Output cardinality matches the mapping author's intent; `name.0.given.0` yields `name: [{ given: ["…"] }]`.
- Mappings written against the old (broken) behaviour must be rewritten. This was pre-release behaviour and no compatibility shim is provided.
- Cycles are prevented by construction (`Array.isArray(child) !== mustBeArray` replaces the child node).

## Alternatives rejected

- Required every mapping author to pre-declare target schemas — more ceremony, no additional safety for the common case.
- Post-processing the object graph into arrays heuristically — ambiguous, and would hide authoring mistakes.
