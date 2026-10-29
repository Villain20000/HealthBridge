# Troubleshooting

## `healthbridge doctor` reports `degraded`

- **Node < 22** — upgrade; the project requires Node 22+ and uses modern `node:test` and `TextDecoder` behaviour.
- **Self-test fails** — run `npm run build` first if you use the TypeScript sources, then re-run `doctor`.
- **Adapter `ok: false`** — a plugin threw during `health()`. Remove the plugin and bisect.

## `MySQL persistence was selected but the 'mysql2' package is not installed`

The driver is a declared dependency of `@healthbridge/persistence`; a stale
`node_modules` (for example after pulling a branch that added it) produces this.
Run `npm ci` at the repository root, then restart. The process deliberately refuses
to boot rather than falling back to in-memory storage, because that fallback would
silently discard patient data at the first restart.

## `MySQL 8.0 or newer is required` / `MariaDB is not supported`

The check runs at boot, before any migration, and names the boundary: the schema pins the
MySQL 8 collation `utf8mb4_0900_ai_ci` and the job queue claims work with `FOR UPDATE SKIP
LOCKED`. Both are MySQL 8.0+. Point `DATABASE_URL` at MySQL 8.0+ (8.4 recommended), or unset
it to run in demo mode.

## A run stays `queued` and `run_jobs` stays `pending`

- `run_jobs.status = 'pending'` with `available_at` in the future is a retry backoff, not a
  stall — check `last_error`.
- `claimed` with an old `claimed_at` means the worker died; it becomes claimable again once
  `HEALTHBRIDGE_QUEUE_VISIBILITY_MS` passes (default 5 minutes).
- Nothing claimed at all: check that the API actually polls (`queue.mode` in `/healthz` should
  be `durable` in database mode) and that the process did not crash during migrations.

## Database mode: connection refused or `ER_NO_REFERENCED_ROW_2`

- `ER_ACCESS_DENIED_ERROR` / `ECONNREFUSED` — check `DATABASE_URL` and that the server
  accepts TCP on that port; `docker compose -f docker/compose.demo.yaml up mysql` gives
  a known-good local instance.
- `ER_NO_REFERENCED_ROW_2` on a hand-written insert — `runs.mapping_id` and
  `runs.asset_id` are foreign keys; create the mapping and asset rows first, or use the
  API so the repository orders the writes.
- Migrations run at boot; a failed migration stops the process with the failing
  statement in the log, which is the intended behaviour.

## `No adapter accepted input` / exit code 4

- Check `healthbridge formats inspect <file>` to see candidate confidences.
- Extensionless files need content that sniffs as delimited or JSON-shaped.
- Force an adapter with `--adapter csv-adapter`.

## Rows are merged or shifted

`Delimiter detection confidence is low` means the file is inconsistent (e.g. a comma inside an unquoted field). Fix the export or pass an explicit delimiter through the adapter option (`context.options.delimiter` in the SDK).

## Accented characters are corrupted

The file is not valid UTF-8 and was decoded as Windows-1252. Re-export as UTF-8, or pre-convert with an explicit encoding step; per-adapter encoding override is not exposed on the CLI yet.

## Dates are rejected with `AMBIGUOUS_DATE_FORMAT`

`03/04/2024` cannot be interpreted safely. Set the mapping rule's `params.inputFormat` to `DD/MM/YYYY` or `MM/DD/YYYY`. This is deliberate: guessing silently corrupts birth dates.

## `DUPLICATE_RESOURCE_ID` warning

Two records produced the same `resourceType/id`. Either the source contains duplicates (see the `broken-dates` demo profile) or the mapping points at a non-unique column.

## `LOW_MAPPING_COVERAGE` / `DOMAIN_MISMATCH`

Almost always the wrong mapping for the data — for example running the patient mapping over a laboratory export. Use the mapping designed for that domain.

## Output objects look empty

Required fields were missing and the record was rejected. Inspect `rejectedRecords[].issues` — records are never silently dropped, so the reason is always present.

## `npm test` cannot resolve `@healthbridge/...`

Run from the repository root after `npm ci` (workspaces link the packages), or set `TSX_TSCONFIG_PATH=tsconfig.base.json` when invoking the test runner manually.

## Traces are blank / values masked

That is redaction working. Use `debug.payloadMode: "full"` locally with synthetic data if you need raw values; never persist raw traces.

## Non-reproducible runs

`healthbridge reproduce bundle.json --input data.csv` exits `3` when the output checksum
differs from the recorded run. Common causes, in order of likelihood:

1. **Missing `--imported-at`.** The provenance timestamp is part of every resource. Without a
   pinned value each run has a different `importedAt` and therefore a different checksum.
   Export bundles with `--imported-at` and always reproduce with the bundle's value (the CLI does
   this automatically, because the bundle stores it).
2. **Mapping drift.** The bundle embeds the mapping snapshot; if you edited the mapping file,
   reproduce still uses the snapshot. A checksum difference means the *engine* or an adapter
   changed, not your file.
3. **Engine or adapter upgrade.** Adapters declare versions and the bundle records them.
   After an upgrade a checksum change is expected and is the signal to review output diffs.
4. **Different input bytes.** `reproduce` reports `Input checksum: MISMATCH` and exits `2`.
   Line-ending or encoding changes (CRLF vs LF, UTF-8 BOM) change the checksum even when the
   parsed rows look identical.
5. **Platform-dependent formatting.** Numbers and dates are formatted by the engine, not the
   platform, so locale should not matter — if it does, that is a bug worth reporting.

Bundles never contain patient data: they carry the input checksum, mapping snapshot, versions
and options only. Sharing a bundle is safe; sharing the input file is a data-protection decision.
