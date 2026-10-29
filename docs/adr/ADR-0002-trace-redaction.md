# ADR-0002 — Trace redaction defaults and protocol v1.1

**Status:** accepted (v3.1.0) · **Context:** trace protocol, debugger, exports

## Problem

Traces are the most exportable artefact in the product: they end up in bug reports, CI logs and debugger exports. The v3.0 collector intended to redact payload snippets but spread caller fields *after* the redacted ones, so raw PHI always won. The policy was also a short substring list (`ssn`, `email`, `phone`), which missed names, birth dates and addresses, and left snippets unbounded.

## Decision

1. **Ordering invariant.** Caller fields are spread first; computed redacted snippets are assigned last. A regression test asserts that SSN, e-mail, phone, given name and birth date never appear in a serialised trace event.
2. **Key classification.** Keys are classified as *direct identifiers* (SSN, MRN, patient/national id, passport, insurance, phone, e-mail, address, tokens, cookies, passwords), *quasi-identifiers* (names, birth dates, postal code, city, occupation) or *neutral*. Direct and quasi classes are masked by default.
3. **Value patterns.** Independently of the key, values matching SSN, e-mail, phone, IBAN or JWT shapes are masked.
4. **Bounded snippets.** Strings truncate at 120 characters, arrays at 25 items, depth at 8 levels, so traces stay usable on large records.
5. **Clinical values are preserved.** Codes, quantities and units stay readable — the debugger must remain able to explain a transformation. Raw payload mode is opt-in (`payloadMode: "full"`) and is documented as local-only.
6. **Protocol v1.1.** Events add `stage`, `spanId`, `adapterVersion`, `pipelineVersion`, `recordId`, `validationState` and `redactionState`, making stored traces self-describing for replay and diffing.

## Consequences

- Redaction state is explicit per event (`none` / `partial` / `full`) instead of a single boolean.
- Debugging may require re-running with raw payloads locally; hosted runs must never enable that mode.
- Pseudonymised traces are still linkable to a run: they are not anonymised data and must be handled under the same access controls.

## Alternatives rejected

- Dropping snippets entirely — destroys the debugging value proposition.
- Hashing every value — removes the ability to explain a failure, and hashed identifiers are still quasi-identifiers.
- Relying on downstream consumers to redact — the leak already happened at write time.
