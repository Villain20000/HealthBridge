# Scenario 2 — Laboratory interoperability (CSV → Observation / DiagnosticReport)

**Domain:** laboratory · **Status:** works end-to-end, verified by test · **Data:** synthetic only

Three laboratory results are mapped twice: once into FHIR R4 `Observation`
(value, UCUM unit, reference range, LOINC coding, subject reference) and once
into `DiagnosticReport`.

## Files

| File | Purpose |
|---|---|
| `data/lab-results.csv` | 3 synthetic results with LOINC codes, UCUM units and reference ranges |
| `mapping/observation.json` | `Observation` mapping using `codeable_concept`, `to_reference`, `string_to_number` |
| `mapping/diagnostic-report.json` | `DiagnosticReport` mapping (intentionally narrower) |
| `expected/observations.json` | Expected `Observation` output |
| `expected/diagnostic-reports.json` | Expected `DiagnosticReport` output |
| `expected/issues.json` | `Observation` is clean; `DiagnosticReport` reports its lower coverage |
| `scenario.test.ts` | Verification of both mappings, UCUM/LOINC fields and trace redaction |

## Why there are two mappings

A laboratory record holds both the measurement and the report it belongs to.
HealthBridge does not guess: each target resource gets an explicit mapping, and
the coverage report tells you how much of the source each one uses.

## Reproduction

```bash
# Human-readable inspection of the source
node packages/cli/dist/bin.js inspect scenarios/02-laboratory-interop/data/lab-results.csv

# Transform, writing FHIR resources to a file
node packages/cli/dist/bin.js transform scenarios/02-laboratory-interop/data/lab-results.csv \
  --mapping scenarios/02-laboratory-interop/mapping/observation.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --out out/02-laboratory-interop.json

# Export a run bundle (no patient data inside) and reproduce the run byte-for-byte
node packages/cli/dist/bin.js transform scenarios/02-laboratory-interop/data/lab-results.csv \
  --mapping scenarios/02-laboratory-interop/mapping/observation.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --run-bundle out/02-laboratory-interop.bundle.json --out out/02-laboratory-interop.json
node packages/cli/dist/bin.js reproduce out/02-laboratory-interop.bundle.json --input scenarios/02-laboratory-interop/data/lab-results.csv
```

```bash
# The verification test for this scenario
node --import tsx --test "scenarios/02-laboratory-interop/scenario.test.ts"
```


## Limitations

- One `DiagnosticReport` per row: real reports group several observations.
  Cross-record grouping and `DiagnosticReport.result` references are **not**
  implemented yet (see ROADMAP Phase F).
- LOINC codes are carried through verbatim. No terminology server validates that
  the code exists, that the unit matches the analyte, or that the reference range
  is appropriate. **No clinical interpretation is performed.**
- Abnormal flags are not derived. Deriving "high/low" requires a validated,
  context-aware implementation.
