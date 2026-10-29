/**
 * Minimal SDK example — runs offline, no database, no account.
 *
 *   npx tsx examples/run-sdk-example.ts
 */
import { HealthBridge } from "@healthbridge/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

async function runExample() {
  const bridge = new HealthBridge();

  const csvPath = path.join(process.cwd(), "datasets", "synthetic-patients.csv");
  const mappingPath = path.join(process.cwd(), "examples", "patient-mapping.json");
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  // Inputs can be file paths (streamed from disk) or inline payloads.
  const result = await bridge.transform({ input: csvPath, mapping });

  console.log("Status:", result.status);
  console.log("Processed:", result.recordsProcessed, "Succeeded:", result.recordsSucceeded);
  console.log("Coverage:", `${result.coverage.coveragePercentage}%`);
  console.log("Data lossless:", result.dataLoss.isLossless);
  console.log("Run id:", result.runId, "Input checksum:", result.inputChecksum);
  console.log("\nFHIR R4 Patient resources:");
  console.log(JSON.stringify(result.output, null, 2));

  if (result.coverage.unmappedSourceFields.length > 0) {
    console.log("\nUnmapped source fields (preserved in the report, never silently dropped):");
    for (const field of result.coverage.unmappedSourceFields) console.log(` - ${field}`);
  }

  console.log("\nTrace events (redacted):");
  for (const trace of result.traces) {
    console.log(` ${trace.stage?.padEnd(16)} ${trace.stepName.padEnd(28)} ${trace.status}`);
  }

  console.log("\nReplaying the same run:");
  const replayed = await bridge.replay(result.runId);
  console.log("Replay output identical:", JSON.stringify(replayed.output) === JSON.stringify(result.output));

  // A run bundle is a data-free descriptor: mapping snapshot, versions, checksums.
  const bundle = bridge.createRunBundle(result.runId);
  console.log("\nRun bundle (safe to share — no patient data inside):");
  console.log(
    JSON.stringify(
      {
        bundleVersion: bundle.bundleVersion,
        engineVersion: bundle.engineVersion,
        traceProtocolVersion: bundle.traceProtocolVersion,
        adapter: bundle.adapter,
        input: bundle.input,
        expected: bundle.expected,
      },
      null,
      2,
    ),
  );

  const outcome = await bridge.reproduce(bundle, csvPath);
  console.log(`\nReproduced from bundle: ${outcome.matches} (${outcome.actualChecksum})`);
}

runExample().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
