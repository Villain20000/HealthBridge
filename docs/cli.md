# CLI reference

```
healthbridge <command> [options]
```

Executable: `node packages/cli/dist/bin.js` (or `healthbridge` when installed globally).

## Reproducible runs

`transform` can export a **run bundle** — a self-describing JSON descriptor that contains
the mapping, adapter and engine versions, options and checksums. It never contains
patient data.

```bash
healthbridge transform patients.csv --mapping mapping/patient.json \
  --imported-at 2024-01-01T00:00:00.000Z --run-bundle run.bundle.json --out patients.fhir.json

healthbridge reproduce run.bundle.json --input patients.csv            # exit 0 = byte-identical
healthbridge reproduce run.bundle.json --input patients.csv --json     # machine-readable result
```

`--imported-at` pins the provenance timestamp; without it every run is internally
consistent but timestamps differ, so the output checksum changes.

`reproduce` semantics:

| Situation | Exit code |
|---|---|
| Output checksum matches the bundle | 0 |
| Output differs (engine/mapping/platform change) | 3 |
| Input checksum differs from the bundle (wrong file) | 2 |
| Bundle or input missing/unparseable | 2 |

## Exit codes (contract — covered by tests)

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error (unknown command, missing flag, bad standard) |
| 2 | Invalid input (file missing, unparsable JSON, invalid `--delimiter`/`--encoding` value, undecodable bytes) |
| 3 | Validation failed (`validate`, or `--fail-on warning`) |
| 4 | Adapter error (no adapter, run failed) |
| 5 | Internal error (environment self-test failed) |
| 6 | Cancelled (reserved) |

## Commands

### `doctor [--json]`
Probes Node version, platform, registered adapters (`health()`), and runs a real CSV → mapping → trace self-test. Returns 5 when degraded. Never prints hard-coded "healthy".

### `init [--dir <path>] [--force]`
Creates `healthbridge.config.json` and `mappings/patient.json`. Refuses to overwrite an existing config without `--force`.

### `formats list [--json]`
Table (or JSON manifests) of format, version, honest status and capability flags.

### `formats inspect <file> [--json]`
Detection candidates with confidences plus the schema summary.

### `inspect <file> [--json] [--adapter <id>] [--max-records <n>] [--delimiter <d>] [--encoding <enc>]`
Schema, inferred types, nullability, warnings (encoding, delimiter confidence, ragged rows, duplicate headers).

### `transform <file> [options]`
| Option | Meaning |
|---|---|
| `--mapping <file.json\|file.yaml>` | Mapping definition (default: built-in patient mapping) |
| `--adapter <id>` | Force an adapter instead of auto-detection |
| `--max-records <n>` | Limit processed records |
| `--out <file>` | Write output instead of printing it |
| `--format json\|ndjson` | Output serialisation (default `json`) |
| `--json` | Print the full result envelope (coverage, issues, data loss, traces) |
| `--fail-on warning` | Exit 3 on `completed_with_warnings` |
| `--delimiter <d>` | Override CSV delimiter: `,` (comma), `;` (semicolon), `tab`, `\|` (pipe). Auto-detection is the default (see below) |
| `--encoding <enc>` | Override input encoding: `utf-8`, `utf-16le`, `windows-1252`. Auto-detection is the default (see below) |

Use `-` instead of a file to read the dataset from stdin. Prints a one-line summary to stderr: `status=… records=x/y coverage=z% unmapped=n rejected=n run=…`.

### `validate <file> [--standard fhir-r4] [--json]`
Structural FHIR R4 checks. Prints which levels ran. Exit 3 when invalid.

### `trace show <file> [--json]`
Accepts a run export (`transform --json`) or an exported trace report. Prints a timeline table.

### `demo generate --profile broken-dates [--seed 42] [--records 25] [--out file.csv]`
Deterministic synthetic data with invalid dates, ambiguous dates, duplicate/blank ids and mixed gender codes. Same seed ⇒ byte-identical output.

### `plugins list` · `examples list`
Adapters in use, and bundled examples/datasets. Third-party adapters are privileged code — see `SECURITY.md`.

## Mapping definition

```json
{
  "id": "patient-csv-to-fhir",
  "name": "CSV Patient to FHIR R4 Patient",
  "version": "1.1.0",
  "sourceFormat": "csv",
  "targetFormat": "fhir-r4",
  "targetResourceType": "Patient",
  "sourceDomains": ["clinical"],
  "rules": [
    {
      "id": "r1",
      "sourcePath": "patient_id",
      "targetPath": "id",
      "transform": "identity",
      "required": true
    },
    {
      "id": "r2",
      "sourcePath": "birth_date",
      "targetPath": "birthDate",
      "transform": "parse_date_iso",
      "params": { "inputFormat": "DD/MM/YYYY" }
    },
    {
      "id": "r3",
      "sourcePath": "note",
      "targetPath": "note.0.text",
      "transform": "trim",
      "when": [{ "path": "note", "op": "matches", "value": "^keep" }]
    }
  ]
}
```

- Numeric path segments create arrays: `name.0.given.0` → `name[0].given[0]`.
- `required: true` turns a missing value into an `error` issue and rejects the record.
- Unknown transforms, duplicate rule ids and duplicate target paths are caught by mapping validation before execution.
- Never evaluate user JavaScript. Use the fixed transform set.

## Trace report

`transform --json` includes `traces[]` (protocol v1.2). Events carry `stage` (`detect`, `adapter-selection`, `parse`, `mapping`, `export`), `spanId`, adapter/engine versions, `recordIndex`, `sourcePath`, `ruleId`, `status`, `durationMs`, `issues[]` and `redactionState`.

Snippets are redacted by default: direct identifiers (SSN, MRN, national id, phone, e-mail, address, tokens) and quasi-identifiers (names, birth dates, postal codes, city) are masked; clinical codes and quantities are preserved for debugging. Long strings and arrays are truncated. Set the SDK's `debug.payloadMode: "full"` only for local, non-persisted debugging.

## Input overrides (`--delimiter`, `--encoding`)

`transform` and `inspect` accept two optional input overrides. Both are validated
strictly: any other value exits with code 2 and actionable advice. When both
flags are omitted, auto-detection applies (delimiter sniffing; BOM sniffing with
a windows-1252 fallback) — nothing changes for existing commands.

| Flag | Accepted values | What it does |
|---|---|---|
| `--delimiter <d>` | `,` (`comma`), `;` (`semicolon`), `tab` (`\t`), `\|` (`pipe`) | Forces the CSV parser to split on that delimiter. `inspect` still shows the auto-detected schema and adds a `Delimiter override active` warning; `transform` parses with the forced delimiter. |
| `--encoding <enc>` | `utf-8`, `utf-16le`, `windows-1252` | Decodes the file (or stdin) bytes with that encoding before handing text to the engine. Bytes that are invalid in the claimed encoding exit 2. |

```bash
healthbridge transform semicolon.csv --delimiter ';'
healthbridge inspect legacy.csv --encoding windows-1252 --json
cat utf16.csv | healthbridge transform - --encoding utf-16le --json
```

Honest-behavior notes:

- The CLI never rewrites your bytes: `--encoding` only chooses how they are decoded to text.
- Because the engine receives decoded text, the run envelope reports `encoding: utf-8` and the input checksum is computed over the decoded bytes when an override is used.
- Override runs keep the standard adapter id. `reproduce` does not carry overrides: to reproduce an override run byte-identically, re-run `transform` with the same flags.

## Shell completions

```bash
healthbridge completions bash   # append to ~/.bash_completion
healthbridge completions zsh    # save as _healthbridge, then compinit
```

The scripts embed static command/flag lists (including `--delimiter`/`--encoding`
values) and never execute the CLI at completion time. Any other shell exits 1
with usage advice.

## Per-command help

Every workflow command prints its own help page, including options, exit codes
and an example:

```bash
healthbridge transform --help
healthbridge inspect --help
healthbridge validate --help
healthbridge formats --help
healthbridge doctor --help
healthbridge trace --help
healthbridge reproduce --help
healthbridge demo --help
```
