# @healthbridge/validation

Healthcare standards validation and `OperationOutcome` generation for HealthBridge OS.

**Status:** Partial: structural checks for Patient, Observation, Specimen and `resourceType`. Profile, terminology and referential levels execute only when injected (`ProfileValidator`, `TerminologyProvider`, sibling resources — e.g. the MIABIS validators or operator-supplied code tables); otherwise they report skipped, never passed.

## Install

Install from source until the first npm release: `npm ci && npm run build`.

Published as `@healthbridge/validation` when released.

## Links

- [Project README](../../README.md)
- [Roadmap](../../ROADMAP.md)
- [Security policy](../../SECURITY.md)
- [License (Apache-2.0)](LICENSE)
