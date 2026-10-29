# ADR-0003 — Trace redaction is structural-by-default

**Status:** accepted (v3.2.0) · **Supersedes:** the field-blacklist approach shipped in v3.1.0

## Context

v3.1.0 fixed a bug where caller-supplied snippets overwrote redacted ones, but kept a
blacklist design: keys such as `ssn`, `mrn` and `birth_date` were masked and everything
else was kept. Two problems appeared while building the scenario lab:

1. International feeds use local header names (`familienname`, `geburtsdatum`,
   `mrn_nr`), which the blacklist did not recognise, so raw names reached the traces.
2. Identifier values travel inside generic containers (`identifier.0.value`), where the
   key itself carries no signal.

Blacklists cannot be complete for an international, schema-agnostic platform.

## Decision

Trace redaction (protocol v1.2) is **structural by default**:

- Object keys, array shapes and nesting depth are preserved — that is the information
  transformation debugging actually needs.
- Scalar values are masked (`"[REDACTED]"`) unless the key is a structural or
  terminology field: `resourceType`, `system`, `code`, `unit`, `url`, `status`,
  `gender`, `use`, `profile`, `contentType`, `language`, `method`.
- Values quoted inside issue messages are masked, because engines embed the offending
  value in the message (`Could not parse '<value>'`).
- Booleans are preserved; snippets are bounded by depth, array length and string length.
- `payloadMode: "full"` keeps raw values, is opt-in, and is documented as local-only
  (never persisted, never attached to bug reports).

## Consequences

**Positive**

- A new source language or container shape cannot leak through a missing pattern.
- Traces remain useful: you can see `Observation.valueQuantity.value` was mapped and
  that its value was redacted, plus every code, unit and status.
- The PHI guard in the scenario suite (`assertNoPhiInTraces`) is enforceable, because
  the guarantee is structural rather than heuristic.

**Negative / accepted trade-offs**

- Debugging a wrong *value* requires `payloadMode: "full"` locally, or inspecting the
  envelope under explicit authorisation (planned in the debugger phase).
- Numeric clinical measurements are masked in stored traces. This is intentional:
  measurements are patient data.
- Redaction is not anonymisation. Traces are still sensitive metadata (run ids,
  timestamps, structure) and inherit the workspace's retention and access policy.

## Alternatives considered

- **Keep the blacklist and extend it.** Rejected: unbounded and language-specific.
- **Hash values instead of masking.** Rejected for now: deterministic hashes of short
  values (dates, codes, small integers) are trivially reversible, so it invites misuse.
- **Mask everything including keys.** Rejected: makes traces useless for mapping work
  and would push users to disable redaction.
