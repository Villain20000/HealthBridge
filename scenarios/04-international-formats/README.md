# Scenario 4 — International healthcare formats

**Domain:** clinical · **Status:** works end-to-end, verified by test · **Data:** synthetic only

A semicolon-delimited export with German headers, `DD.MM.YYYY` dates, decimal
commas, local gender codes (`w`/`m`) and multilingual names (German, Spanish,
Chinese).

## Files

| File | Purpose |
|---|---|
| `data/patients-intl.csv` | 3 rows, `;` delimiter, UTF-8 |
| `mapping/patient.json` | Explicit `inputFormat: DD.MM.YYYY`, gender aliases, decimal-comma parsing |
| `expected/resources.json` | Expected output including a weight extension |
| `expected/issues.json` | No errors and no warnings are expected |
| `scenario.test.ts` | Verification of detection, date order, aliases, Unicode and traces |

## What this scenario proves

- Delimiter sniffing detects `;` (confidence 0.9) — no manual conversion step.
- `17.02.1990` → `1990-02-17` because the mapping declares `DD.MM.YYYY`; ambiguous
  dates are rejected rather than guessed (`AMBIGUOUS_DATE_FORMAT`).
- `w`/`m` map through explicit `params.codes` aliases instead of degrading to `unknown`.
- `72,5` → `72.5` via `decimalSeparator: ","`.
- Names survive: `Müller`, `Ñúñez`, `李` — no mojibake, and none of them appear in traces.
- The weight is written as a FHIR extension (`source-weight-kg`), not as a
  non-standard property.

## Reproduction

```bash
# Human-readable inspection of the source
node packages/cli/dist/bin.js inspect scenarios/04-international-formats/data/patients-intl.csv

# Transform, writing FHIR resources to a file
node packages/cli/dist/bin.js transform scenarios/04-international-formats/data/patients-intl.csv \
  --mapping scenarios/04-international-formats/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --out out/04-international-formats.json

# Export a run bundle (no patient data inside) and reproduce the run byte-for-byte
node packages/cli/dist/bin.js transform scenarios/04-international-formats/data/patients-intl.csv \
  --mapping scenarios/04-international-formats/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --run-bundle out/04-international-formats.bundle.json --out out/04-international-formats.json
node packages/cli/dist/bin.js reproduce out/04-international-formats.bundle.json --input scenarios/04-international-formats/data/patients-intl.csv
```

```bash
# The verification test for this scenario
node --import tsx --test "scenarios/04-international-formats/scenario.test.ts"
```


## Limitations

- Encoding detection falls back to Windows-1252 for legacy exports, but this file
  is UTF-8; a Windows-1252 fixture is covered by adapter unit tests instead.
- Clinical *coding* is not translated between locales; only value formats are.
