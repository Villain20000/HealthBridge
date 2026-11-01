#!/usr/bin/env node
/**
 * HealthBridge OS transform benchmark (Phase F foundations).
 *
 * Measures transform throughput of the real TransformationPipeline over a
 * deterministic synthetic CSV plus every scenario dataset, and writes a JSON
 * report. Metrics per case: records, elapsedMs, records/sec, peak RSS (via
 * process.memoryUsage, sampled), peak heap, status and output checksum.
 *
 * Run:  node --import tsx scripts/benchmark.mjs [--records 10000] [--seed 20240117] [--out <path>] [--cases a,b]
 * Env:  TSX_TSCONFIG_PATH=tsconfig.tsx.json (same as scripts/run-tests.mjs)
 *
 * Determinism: fixed PRNG seed for the synthetic CSV and a fixed importedAt
 * anchor, so output checksums are stable across runs on any machine.
 * Throughput numbers are machine-dependent and must be read as relative.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TransformationPipeline } from "../packages/transformation-engine/src/index.ts";
import { ENGINE_VERSION } from "../packages/shared-types/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SEED = 20240117;
const IMPORTED_AT = "2024-01-01T00:00:00.000Z";

/** Deterministic PRNG (mulberry32) — no Math.random anywhere in measured paths. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILY = ["Okonkwo", "Smith", "Garcia", "Muller", "Rossi", "Dubois", "Tanaka", "Silva", "Novak", "Haddad"];
const GIVEN = ["Chidi", "Jane", "Maria", "Jurgen", "Luca", "Amina", "Kenji", "Paulo", "Elena", "Omar"];
const SEX = ["M", "F", "male", "female"];

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** Deterministic patient CSV matching the scenario-01 mapping columns. */
function generatePatientsCsv(recordCount, seed) {
  const rand = mulberry32(seed);
  const lines = ["patient_id,family_name,given_name,sex,birth_date,mrn"];
  for (let i = 0; i < recordCount; i++) {
    const year = 1950 + Math.floor(rand() * 55);
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    lines.push(
      [
        `P${100000 + i}`,
        FAMILY[Math.floor(rand() * FAMILY.length)],
        GIVEN[Math.floor(rand() * GIVEN.length)],
        SEX[Math.floor(rand() * SEX.length)],
        `${year}-${pad(month)}-${pad(day)}`,
        `MRN-${i}`,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf-8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

/** Sample RSS/heap on an interval; returns { stop, peak }. */
function startMemorySampler(intervalMs = 5) {
  const peak = { rss: 0, heapUsed: 0 };
  const timer = setInterval(() => {
    const sample = process.memoryUsage();
    if (sample.rss > peak.rss) peak.rss = sample.rss;
    if (sample.heapUsed > peak.heapUsed) peak.heapUsed = sample.heapUsed;
  }, intervalMs);
  timer.unref?.();
  return {
    peak,
    stop() {
      clearInterval(timer);
      const sample = process.memoryUsage();
      if (sample.rss > peak.rss) peak.rss = sample.rss;
      if (sample.heapUsed > peak.heapUsed) peak.heapUsed = sample.heapUsed;
    },
  };
}

async function measure(pipeline, name, input, mapping) {
  const sampler = startMemorySampler();
  const started = process.hrtime.bigint();
  const result = await pipeline.execute({ input, mapping, importedAt: IMPORTED_AT });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  sampler.stop();
  const records = result.recordsProcessed;
  return {
    name,
    records,
    recordsSucceeded: result.recordsSucceeded,
    recordsFailed: result.recordsFailed,
    status: result.status,
    targetResourceType: result.targetResourceType,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    recordsPerSec: elapsedMs > 0 ? Math.round((records / (elapsedMs / 1000)) * 100) / 100 : 0,
    peakRssBytes: sampler.peak.rss,
    peakRssMB: Math.round((sampler.peak.rss / 1048576) * 100) / 100,
    peakHeapUsedBytes: sampler.peak.heapUsed,
    outputChecksum: result.outputChecksum,
  };
}

function parseArgs(argv) {
  const args = { records: 10000, seed: DEFAULT_SEED, out: undefined, cases: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--records") args.records = Number(argv[++i]);
    else if (flag === "--seed") args.seed = Number(argv[++i]);
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--cases") args.cases = argv[++i].split(",").map((s) => s.trim());
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node --import tsx scripts/benchmark.mjs [--records N] [--seed N] [--out path] [--cases a,b]");
    console.log("Cases: synthetic-csv, s01-patients, s02-observations, s02-diagnostic-report, s03-broken, s04-intl");
    return;
  }

  const pipeline = new TransformationPipeline();
  const patientMapping = readJson("scenarios/01-hospital-patient-migration/mapping/patient.json");

  // Warmup (unmeasured): stabilise JIT before the timed cases.
  await pipeline.execute({
    input: { id: "warmup", filename: "warmup.csv", contentString: generatePatientsCsv(500, args.seed) },
    mapping: patientMapping,
    importedAt: IMPORTED_AT,
  });

  const wanted = new Set(args.cases ?? []);
  const all = [
    {
      name: "synthetic-csv",
      run: () =>
        measure(
          pipeline,
          "synthetic-csv",
          {
            id: "bench-synth",
            filename: `synthetic-${args.records}.csv`,
            contentString: generatePatientsCsv(args.records, args.seed),
          },
          patientMapping,
        ),
    },
    {
      name: "s01-patients",
      run: () =>
        measure(
          pipeline,
          "s01-patients",
          {
            id: "bench-s01",
            filename: "patients.csv",
            contentString: readText("scenarios/01-hospital-patient-migration/data/patients.csv"),
          },
          patientMapping,
        ),
    },
    {
      name: "s02-observations",
      run: () =>
        measure(
          pipeline,
          "s02-observations",
          {
            id: "bench-s02",
            filename: "lab-results.csv",
            contentString: readText("scenarios/02-laboratory-interop/data/lab-results.csv"),
          },
          readJson("scenarios/02-laboratory-interop/mapping/observation.json"),
        ),
    },
    {
      name: "s02-diagnostic-report",
      run: () =>
        measure(
          pipeline,
          "s02-diagnostic-report",
          {
            id: "bench-s02dr",
            filename: "lab-results.csv",
            contentString: readText("scenarios/02-laboratory-interop/data/lab-results.csv"),
          },
          readJson("scenarios/02-laboratory-interop/mapping/diagnostic-report.json"),
        ),
    },
    {
      name: "s03-broken",
      run: () =>
        measure(
          pipeline,
          "s03-broken",
          {
            id: "bench-s03",
            filename: "broken-patients.csv",
            contentString: readText("scenarios/03-broken-hospital-data/data/broken-patients.csv"),
          },
          readJson("scenarios/03-broken-hospital-data/mapping/patient.json"),
        ),
    },
    {
      name: "s04-intl",
      run: () =>
        measure(
          pipeline,
          "s04-intl",
          {
            id: "bench-s04",
            filename: "patients-intl.csv",
            contentString: readText("scenarios/04-international-formats/data/patients-intl.csv"),
          },
          readJson("scenarios/04-international-formats/mapping/patient.json"),
        ),
    },
  ];

  const cases = [];
  for (const candidate of all) {
    if (wanted.size > 0 && !wanted.has(candidate.name)) continue;
    cases.push(await candidate.run());
  }

  const totalRecords = cases.reduce((sum, c) => sum + c.records, 0);
  const totalElapsedMs = cases.reduce((sum, c) => sum + c.elapsedMs, 0);
  const report = {
    tool: "healthbridge-benchmark",
    version: 1,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    engineVersion: ENGINE_VERSION,
    seed: args.seed,
    importedAt: IMPORTED_AT,
    syntheticRecords: args.records,
    cases,
    totals: {
      records: totalRecords,
      elapsedMs: Math.round(totalElapsedMs * 100) / 100,
      recordsPerSec: totalElapsedMs > 0 ? Math.round((totalRecords / (totalElapsedMs / 1000)) * 100) / 100 : 0,
    },
  };

  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const outPath = args.out ?? path.join(ROOT, "benchmark-results", `benchmark-${stamp}.json`);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2) + "\n");

  console.log("case                    records  elapsedMs  rec/s    peakRSS(MB)  status");
  console.log("----------------------  -------  ---------  -------  -----------  ----------------------");
  for (const c of cases) {
    console.log(
      `${c.name.padEnd(22)}  ${String(c.records).padStart(7)}  ${String(c.elapsedMs).padStart(9)}  ${String(c.recordsPerSec).padStart(7)}  ${String(c.peakRssMB).padStart(11)}  ${c.status}`,
    );
  }
  console.log(`\nreport: ${path.resolve(outPath)}`);
}

await main();
