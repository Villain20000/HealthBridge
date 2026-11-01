# Security foundations (Phase F: test suite + benchmarks)

> Short-form notes for the executable security foundations. The binding
> policy (reporting, supported versions, auth, uploads, non-goals) lives in
> [SECURITY.md](../SECURITY.md).

## Security test suite

`packages/adapters/test/security.test.ts` (15 tests, run with
`node scripts/run-tests.mjs packages/adapters/test/security.test.ts`)
pins the behaviour below against **current** code. Fixtures live in
`scripts/security-fixtures/` (see its README for shapes and rationale).

- **XXE / entity expansion refused** — `xxe-cda-bomb.xml` (CDA with external
  `SYSTEM` entity) and `entity-expansion-bomb.xml` (billion-laughs-shaped):
  the kit guard throws `UnsafeXmlError`, `xml-cda` `inspect`/`parse` reject,
  `detect` returns `false`. Entities are never expanded.
- **Oversized input refused** — `oversized-cdata.xml` (> 1 MiB with CDATA):
  refused with the documented 1 MiB CDATA limit; small CDATA stays accepted.
- **Oversized CSV bounded** — `oversized-records.csv` (5 000 rows): full
  parse yields all rows, `maxRecords: 100` yields exactly 100 (top-level
  `ParseContext.maxRecords`, honoured by every built-in adapter).
- **Bomb-shaped structure scanned safely** — `nested-structure-bomb.xml`
  (2000-deep nesting + 20 000 siblings): completes with one envelope and
  reported `maxDepth: 2002` / `elementCount: 22003`, no fatal issue, no throw.
- **Malformed inputs report issues, never throw** — malformed JSON
  (`MALFORMED_JSON`/fatal), bad NDJSON line (`MALFORMED_NDJSON_LINE`),
  ragged CSV (`RAGGED_ROW` on `envelope.parseIssues`, extras under `__extra`),
  unbalanced XML (`XML_UNBALANCED_TAGS`), empty XML (`XML_EMPTY_INPUT`),
  unterminated CSV quote (inspect warning).

## Documented limits (enforced)

| Limit | Value | Enforcement |
|---|---|---|
| `<!DOCTYPE` / `<!ENTITY` | any occurrence (scanned head) | `assertSafeXml` → `UnsafeXmlError` |
| CDATA + input size | > 1 MiB | `assertSafeXml` → `UnsafeXmlError` ("Oversized CDATA section refused") |
| XML tag scan | 500 000 tags (`MAX_SCANNED_TAGS`) | truncation flag + `XML_TRUNCATED_SCAN` warning |
| CDA section preview | 500 chars (`MAX_SECTION_PREVIEW_CHARS`) | bounded preview |
| Records materialised | `maxRecords` (adapter/SDK/pipeline/CLI) | exact bound |
| Object / upload bytes | 64 MiB default (`HEALTHBRIDGE_MAX_UPLOAD_BYTES`, storage `DEFAULT_MAX_OBJECT_BYTES`) | API + storage layers |

## Known gaps (reported, not changed here)

- No adapter-level byte cap: plain oversized CSV/JSON buffers fully in memory
  — bound with `maxRecords` until streaming parse lands (ROADMAP Phase C/F).
- `SECURITY.md` still says "No XML parsing exists yet, so XXE is not
  currently reachable" — stale since the `xml-cda` adapter landed; it should
  point at the kit XXE guard instead.
- `ENTITY` detection covers the first 64 KiB; the hand-rolled scanner never
  expands entities regardless, but the guard's window should be documented as
  exact in `SECURITY.md`.
