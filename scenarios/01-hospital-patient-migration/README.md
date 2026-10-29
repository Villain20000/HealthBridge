# Scenario 1 — Hospital patient migration (CSV → FHIR R4 Patient)

**Domain:** clinical · **Status:** works end-to-end, verified by test · **Data:** synthetic only

A hospital exports a flat patient table. The mapping turns each row into a valid
FHIR R4 `Patient`, including local MRN identifiers and a declared local
identifier system.

## Files

| File | Purpose |
|---|---|
| `data/patients.csv` | 3 synthetic rows (`patient_id,family_name,given_name,sex,birth_date,mrn,city`) |
| `mapping/patient.json` | Declarative mapping to `Patient` (array paths, `default_value`, `format_gender_fhir`, `parse_date_iso`) |
| `expected/resources.json` | Expected clinical projection of the output (provenance extension stripped) |
| `expected/issues.json` | No errors and no warnings are expected |
| `scenario.test.ts` | Verification: output, validation levels, provenance, reproducibility, PHI guard |

## Expected result

3 resources, 3 succeeded, 0 failed, `completed`, `validation.isValid = true`.
`city` is deliberately unmapped: it shows up in `coverage.unmappedSourceFields`
(63 % coverage) instead of disappearing silently.

## Reproduction

```bash
# Human-readable inspection of the source
node packages/cli/dist/bin.js inspect scenarios/01-hospital-patient-migration/data/patients.csv

# Transform, writing FHIR resources to a file
node packages/cli/dist/bin.js transform scenarios/01-hospital-patient-migration/data/patients.csv \
  --mapping scenarios/01-hospital-patient-migration/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --out out/01-hospital-patient-migration.json

# Export a run bundle (no patient data inside) and reproduce the run byte-for-byte
node packages/cli/dist/bin.js transform scenarios/01-hospital-patient-migration/data/patients.csv \
  --mapping scenarios/01-hospital-patient-migration/mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z \
  --run-bundle out/01-hospital-patient-migration.bundle.json --out out/01-hospital-patient-migration.json
node packages/cli/dist/bin.js reproduce out/01-hospital-patient-migration.bundle.json --input scenarios/01-hospital-patient-migration/data/patients.csv
```

```bash
# The verification test for this scenario
node --import tsx --test "scenarios/01-hospital-patient-migration/scenario.test.ts"
```


## Limitations

- No terminology service: `identifier.system` is a declared local URN, not a resolved OID.
- `city` is not mapped to `Patient.address` in this scenario.
