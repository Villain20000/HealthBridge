/**
 * Per-command help pages, printed by `healthbridge <command> --help`.
 * Each page documents exactly what the command accepts today — no
 * aspirational flags. Exit codes follow the contract in `docs/cli.md`.
 */

import { ENGINE_VERSION } from "@healthbridge/sdk";

const EXIT_LINE =
  "Exit codes: 0 success · 1 usage error · 2 invalid input · 3 validation failed · 4 adapter error · 5 internal error · 6 cancelled.";

const OVERRIDE_NOTES = [
  "--delimiter/--encoding values are validated strictly: anything outside the",
  "listed values exits 2 with actionable advice. Both default to auto-detection",
  "when omitted. Runs that use overrides keep the standard adapter id; re-run",
  "transform with the same flags for byte-identical output (reproduce does not",
  "carry overrides).",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  transform: `healthbridge transform <file|-> [options] — HealthBridge OS ${ENGINE_VERSION}

Transform a medical dataset into FHIR R4 resources (default mapping: built-in patient mapping).

Usage:
  healthbridge transform patients.csv --mapping mapping/patient.json --out patients.fhir.json
  healthbridge transform patients.csv --json
  cat patients.csv | healthbridge transform - --filename pipe.csv

Options:
  --mapping <file.json|yaml>   Mapping definition (default: built-in patient mapping)
  --adapter <id>               Force a specific adapter instead of auto-detection
  --max-records <n>            Limit processed records
  --delimiter <d>              Override CSV delimiter: ',' (comma), ';' (semicolon),
                               'tab' (\\t), '|' (pipe). Auto-detection is the default.
  --encoding <enc>             Override input encoding: utf-8, utf-16le, windows-1252.
                               Auto-detection (BOM sniffing, windows-1252 fallback) is the default.
  --out <file>                 Write output to a file instead of printing it
  --format json|ndjson          Output serialisation (default: json)
  --imported-at <ts>           Pin the provenance timestamp (reproducibility)
  --run-bundle <file>          Write a run bundle (checksums only, never patient data)
  --fail-on warning            Exit 3 on completed_with_warnings
  --json                       Print the full result envelope
  --help                       Show this help

${EXIT_LINE}
${OVERRIDE_NOTES}`,

  inspect: `healthbridge inspect <file> [options] — HealthBridge OS ${ENGINE_VERSION}

Inspect a medical dataset: format, domain, record count, inferred schema and warnings.

Usage:
  healthbridge inspect patients.csv
  healthbridge inspect patients.csv --json --adapter csv-adapter --max-records 100

Options:
  --adapter <id>               Force a specific adapter instead of auto-detection
  --max-records <n>            Limit inspected records
  --delimiter <d>              Record a CSV delimiter override: ',' (comma), ';' (semicolon),
                               'tab' (\\t), '|' (pipe). The schema shown always reflects
                               auto-detection; the override applies at transform/parse time.
  --encoding <enc>             Override input encoding: utf-8, utf-16le, windows-1252.
                               Auto-detection (BOM sniffing, windows-1252 fallback) is the default.
  --json                       Machine-readable inspection result
  --help                       Show this help

${EXIT_LINE}
${OVERRIDE_NOTES}`,

  validate: `healthbridge validate <file> [options] — HealthBridge OS ${ENGINE_VERSION}

Run structural FHIR R4 checks on a resource file. Prints which levels ran.

Usage:
  healthbridge validate patient.json
  healthbridge validate patient.json --json

Options:
  --standard fhir-r4            Validation standard (only fhir-r4 is supported)
  --json                       Machine-readable validation report
  --help                       Show this help

${EXIT_LINE}`,

  formats: `healthbridge formats <list|inspect> [options] — HealthBridge OS ${ENGINE_VERSION}

List registered adapters and their capabilities, or inspect a file for format candidates.

Usage:
  healthbridge formats list --json
  healthbridge formats inspect patients.csv --json

Options:
  --json                       Machine-readable output (manifests or candidates + schema)
  --help                       Show this help

${EXIT_LINE}`,

  doctor: `healthbridge doctor [options] — HealthBridge OS ${ENGINE_VERSION}

Probe the environment (Node version, platform), registered adapters and a real
CSV → mapping → trace self-test. Never prints hard-coded "healthy".

Usage:
  healthbridge doctor
  healthbridge doctor --json

Options:
  --json                       Machine-readable health report
  --help                       Show this help

${EXIT_LINE}`,

  trace: `healthbridge trace show <file> [options] — HealthBridge OS ${ENGINE_VERSION}

Render a timeline table from a run export (transform --json) or an exported
trace report.

Usage:
  healthbridge transform patients.csv --json > run.json
  healthbridge trace show run.json

Options:
  --json                       Print the exported trace report instead of the table
  --help                       Show this help

${EXIT_LINE}`,

  reproduce: `healthbridge reproduce <bundle> [options] — HealthBridge OS ${ENGINE_VERSION}

Re-execute a stored run bundle against an input file and compare checksums.

Usage:
  healthbridge transform patients.csv --run-bundle run.bundle.json --imported-at 2024-01-01T00:00:00.000Z
  healthbridge reproduce run.bundle.json --input patients.csv

Options:
  --input <file>               Input payload (defaults to the bundle's recorded filename
                               next to the bundle; bundles never embed patient data)
  --json                       Machine-readable reproduce result
  --help                       Show this help

${EXIT_LINE}
Note: reproduce does not carry --delimiter/--encoding overrides. To reproduce
an override run byte-identically, re-run transform with the same flags.`,

  demo: `healthbridge demo generate [options] — HealthBridge OS ${ENGINE_VERSION}

Generate deterministic synthetic data (profile broken-dates: invalid dates,
ambiguous dates, blank ids, mixed gender codes). Same seed ⇒ byte-identical output.

Usage:
  healthbridge demo generate --profile broken-dates --seed 7 --records 25 --out demo.csv

Options:
  --profile broken-dates       Synthetic profile (only broken-dates is supported)
  --seed <n>                   Random seed (default: 42)
  --records <n>                Record count (default: 25)
  --out <file>                 Write to a file instead of printing
  --help                       Show this help

${EXIT_LINE}`,
};

/** Return the help page for `primary` (`formats` covers list/inspect), or `undefined`. */
export function getCommandHelp(primary: string, secondary?: string): string | undefined {
  if (primary === "formats") return COMMAND_HELP.formats;
  void secondary;
  return COMMAND_HELP[primary];
}
