# @healthbridge/fhir-ndjson

HL7 FHIR R4 NDJSON (line-delimited JSON) adapter for HealthBridge OS: one FHIR resource per line, with per-line `MALFORMED_NDJSON_LINE` issues instead of silent drops.

**Status:** Partial in the v3.2.0 developer preview. Structural inspection only, with no profile or terminology validation. Split out of `@healthbridge/adapters` (`FhirJsonFormatAdapter` keeps single-resource and Bundle JSON); envelopes keep the `fhir-r4-json` source format so pipeline output is unchanged.

## Install

Install from source until the first npm release: `npm ci && npm run build`.

Published as `@healthbridge/fhir-ndjson` when released.

## Links

- [Project README](../../README.md)
- [Roadmap](../../ROADMAP.md)
- [Security policy](../../SECURITY.md)
- [License (Apache-2.0)](LICENSE)
