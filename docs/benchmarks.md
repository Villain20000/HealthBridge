# Benchmarks (Phase F foundations)

`scripts/benchmark.mjs` measures transform throughput of the real
`TransformationPipeline` — no mocks, no fabricated data — over a
deterministic synthetic CSV plus every scenario dataset, and writes a JSON
report. It exists to make performance regressions visible, not to set records.

## How to run

```sh
node --import tsx scripts/benchmark.mjs [--records 10000] [--seed 20240117] [--out <path>] [--cases a,b]
```

- Requires the same env as the test runner (`TSX_TSCONFIG_PATH=tsconfig.tsx.json`).
- Cases: `synthetic-csv`, `s01-patients`, `s02-observations`,
  `s02-diagnostic-report`, `s03-broken`, `s04-intl`. `--cases` runs a subset.
- Default report path: `benchmark-results/benchmark-<timestamp>.json`
  (directory is created on demand; reports are run output, not source).

## What it measures

| Metric | Meaning |
|---|---|
| `records` | `result.recordsProcessed` for the case |
| `elapsedMs` | Wall time of one `pipeline.execute()` (after an unmeasured 500-row warmup) |
| `recordsPerSec` | `records / (elapsedMs / 1000)` |
| `peakRssBytes` / `peakRssMB` | Peak whole-process RSS, sampled every 5 ms during the case |
| `peakHeapUsedBytes` | Peak V8 heap over the same window |
| `status`, `outputChecksum` | Pipeline outcome; checksum proves byte-identical output |

## Determinism

The synthetic CSV comes from a seeded PRNG (`mulberry32`, default seed
`20240117`) and every case uses the fixed `importedAt` anchor
`2024-01-01T00:00:00.000Z` (same as `scenarios/harness.ts`). Re-runs with the
same seed produce identical `outputChecksum` values. Throughput (`rec/s`,
RSS) is machine-dependent — compare runs on the same machine only.

## Latest results (reference machine, run 2026-10-31)

`node v24.22.1`, default seed, `--records 10000`. A repeat run produced
identical output checksums on all six cases.

| Case | Records | Elapsed (ms) | Rec/s | Peak RSS (MB) | Status |
|---|---|---|---|---|---|
| `synthetic-csv` | 10000 | 1060.92 | 9425.78 | 242.18 | completed |
| `s01-patients` | 3 | 2.31 | 1300.67 | 243.04 | completed |
| `s02-observations` | 3 | 2.99 | 1003.01 | 244.66 | completed |
| `s02-diagnostic-report` | 3 | 1.72 | 1739.23 | 245.94 | completed_with_warnings |
| `s03-broken` | 4 | 2.98 | 1343.63 | 247.48 | completed_with_warnings |
| `s04-intl` | 3 | 1.85 | 1623.55 | 247.68 | completed |

Read these as: the engine sustains roughly **9.4k records/s** on
patient-shaped CSV on this machine; scenario-sized inputs complete in single
milliseconds (their `rec/s` is startup-dominated noise, useful only as a
smoke signal). Peak RSS (~240 MB whole-process) is dominated by the Node/tsx
runtime and the registered adapters, not by the records — use it for
relative comparison between runs, not as a per-record cost.

## Limitations (honest)

- Inputs are fully buffered in memory (streaming CSV parse is still open in
  ROADMAP Phase C/F); do not extrapolate these numbers to 100k+ row files
  without also watching RSS, and prefer `--records` scaling runs for that.
- Single-threaded, single-process: no concurrency or API-queue behaviour is
  measured here — that belongs to the queue/API suites.
- Not clinically validated: throughput says nothing about mapping
  correctness; pair benchmark runs with `node scripts/run-tests.mjs`.
