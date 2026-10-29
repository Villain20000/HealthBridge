# Scenario 3 — Broken hospital data

**Domain:** clinical · **Status:** works end-to-end, verified by test · **Data:** synthetic only

This is deliberately bad data: an unmapped local gender code, a missing family
name, an unparseable date, an impossible calendar date (`1990-02-30`) and a
duplicate patient identifier.

## Files

| File | Purpose |
|---|---|
| `data/broken-patients.csv` | 4 rows, 2 of which cannot be exported |
| `mapping/patient.json` | Same patient mapping, with `birth_date` marked `required` |
| `expected/resources.json` | The 2 rows that survive |
| `expected/issues.json` | Expected counters and issue codes |
| `scenario.test.ts` | Verification of rejection, reasons, duplicates and the PHI guard |

## Expected result

| Outcome | Value |
|---|---|
| Records processed | 4 |
| Records succeeded | 2 |
| Records failed | 2 (indexes 1 and 3) |
| Status | `completed_with_warnings` |
| Issue codes | `GENDER_CODE_UNMAPPED`, `INVALID_DATE_FORMAT`, `DUPLICATE_RESOURCE_ID` |

Key behaviour: a rejected record is **never dropped silently**. It appears in
`rejectedRecords[]` with its issues, and the duplicate resource id is reported as
a warning rather than deduplicated behind your back.

## Reproduction

```bash
# Human-readable inspection of the source
node packages/cli/dist/bin.js inspect scenarios/03-broken-hospital-data/data/broken-patients.csv

# Transform, writing FHIR resources to a file
node packages/cli/dist/bin.js transform scenarios/03-broken-hospital-data/data/broken-patients.csv \
  --mapping scenarios/03-broken-hospital-data/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --out out/03-broken-hospital-data.json

# Export a run bundle (no patient data inside) and reproduce the run byte-for-byte
node packages/cli/dist/bin.js transform scenarios/03-broken-hospital-data/data/broken-patients.csv \
  --mapping scenarios/03-broken-hospital-data/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --run-bundle out/03-broken-hospital-data.bundle.json --out out/03-broken-hospital-data.json
node packages/cli/dist/bin.js reproduce out/03-broken-hospital-data.bundle.json --input scenarios/03-broken-hospital-data/data/broken-patients.csv
```

```bash
# The verification test for this scenario
node --import tsx --test "scenarios/03-broken-hospital-data/scenario.test.ts"
```


`--fail-on warning` turns the degraded run into exit code `3`, which is what CI
should use.

## Limitations

- Row-level rejection is reported, but there is no quarantine file or partial
  repair workflow yet.
- The duplicate is reported, not resolved; entity resolution is out of scope.
