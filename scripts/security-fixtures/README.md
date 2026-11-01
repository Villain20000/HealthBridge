# Security fixtures (Phase F security-suite foundations)

Static hostile/malformed inputs consumed by
`packages/adapters/test/security.test.ts`. Every fixture is asserted against
**current** engine behaviour — fixtures the code already refuses, plus
malformed inputs the code already reports as issues. No fixture here requires
an engine change.

| Fixture | Shape | Expected behaviour (current code) |
|---|---|---|
| `xxe-cda-bomb.xml` | CDA `ClinicalDocument` with `<!DOCTYPE>` + external `SYSTEM` entity (`file:///etc/passwd`) | **Refused.** `assertSafeXml` throws `UnsafeXmlError`; `xml-cda` `inspect`/`parse` reject; `detect` returns `false`. Entity never expanded. |
| `entity-expansion-bomb.xml` | "Billion laughs"-shaped `<!ENTITY>` chain (3 levels, small on purpose) | **Refused** the same way. The guard fires on the *declaration*, so the fixture never needs to be large. |
| `nested-structure-bomb.xml` | 2000-deep nesting + 20 000 sibling `<reading/>` elements (~0.9 MiB, no entities/CDATA) | **Scanned, not refused.** Completes with 1 envelope; metadata reports `maxDepth: 2002`, `elementCount: 22003`; no fatal issue, no throw, no expansion. Exercises the `MAX_SCANNED_TAGS` (500 000) path without tripping it. |
| `oversized-cdata.xml` | CDA-shaped with a ~1.1 MiB `<![CDATA[ … ]]>` section (file > 1 MiB) | **Refused.** Kit guard: CDATA payload over 1 MiB throws `UnsafeXmlError` ("Oversized CDATA section refused"). Pins the documented 1 MiB CDATA limit. |
| `oversized-records.csv` | 5 000 deterministic patient rows (scenario-01 columns) | **Bounded, not refused.** Full parse yields all 5 000 envelopes; `maxRecords: 100` yields exactly 100. There is deliberately **no** adapter-level byte cap (CSVs buffer in memory) — the bound is `maxRecords`, plus the 64 MiB API/storage upload limits one layer up. |

## Documented limits these fixtures pin

- Kit XXE guard: any `<!DOCTYPE` (first 4 KiB) or `<!ENTITY` (first 64 KiB)
  → `UnsafeXmlError`. Small CDATA (< 1 MiB) is accepted.
- Kit oversize guard: CDATA section present **and** input > 1 MiB
  → `UnsafeXmlError`.
- XML scanner cap: `MAX_SCANNED_TAGS = 500 000` → `truncated: true` plus an
  `XML_TRUNCATED_SCAN` warning (lower-bound counts), never OOM-by-design.
- Section preview cap: `MAX_SECTION_PREVIEW_CHARS = 500`.
- `maxRecords` (adapter `ParseContext` / SDK / pipeline option) bounds the
  number of materialised envelopes.

## Known gaps (reported, not fixed here)

- No adapter-level byte-size cap: an oversized plain CSV/JSON is fully
  buffered (only the API/storage layers enforce the 64 MiB default). Until
  streaming parse lands (ROADMAP Phase C/F), bound large inputs with
  `maxRecords` (`--maxRecords` on the CLI).
- `ENTITY` detection scans the first 64 KiB; a declaration past that offset
  would not be caught by the kit guard (the scanner still never expands
  entities — it is a hand-rolled tag walk, not a DOM parser).
