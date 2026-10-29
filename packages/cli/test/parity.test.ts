import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runCli } from "@healthbridge/cli";
import { HealthBridge, MappingDefinition } from "@healthbridge/sdk";
import { readFileSync } from "node:fs";

/**
 * CLI/SDK parity (plan §16): the same input fixture must produce identical
 * normalized output through both entry points. This is the guard against the
 * CLI growing its own transformation semantics.
 */

const scenario = "scenarios/01-hospital-patient-migration";
const dataFile = path.join(scenario, "data", "patients.csv");
const mappingFile = path.join(scenario, "mapping", "patient.json");
const importedAt = "2024-01-01T00:00:00.000Z";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

describe("CLI and SDK parity", () => {
  test("produce identical FHIR output for the same fixture", async () => {
    const sink = capture();
    const exitCode = await runCli(
      ["transform", dataFile, "--mapping", mappingFile, "--json", "--imported-at", importedAt],
      sink.io,
    );
    assert.equal(exitCode, 0, `CLI failed: ${sink.err.join("\n")}`);

    const cliResult = JSON.parse(sink.out.join("\n"));
    const sdkResult = await new HealthBridge().transform({
      input: dataFile,
      mapping: JSON.parse(readFileSync(mappingFile, "utf-8")) as MappingDefinition,
      importedAt,
    });

    assert.deepEqual(cliResult.output, sdkResult.output);
    assert.equal(cliResult.outputChecksum, sdkResult.outputChecksum);
    assert.equal(cliResult.inputChecksum, sdkResult.inputChecksum);
    assert.equal(cliResult.validation.isValid, sdkResult.validation.isValid);
  });

  test("fail with the same exit code the SDK reports as a failure status", async () => {
    const sink = capture();
    const exitCode = await runCli(
      [
        "transform",
        path.join("scenarios/03-broken-hospital-data/data/broken-patients.csv"),
        "--mapping",
        path.join("scenarios/03-broken-hospital-data/mapping/patient.json"),
        "--json",
      ],
      sink.io,
    );
    const result = JSON.parse(sink.out.join("\n"));
    assert.equal(result.status, "completed_with_warnings");
    assert.equal(exitCode, 0);

    // With --fail-on warning the CLI must signal the degraded run.
    const strict = capture();
    const strictExit = await runCli(
      [
        "transform",
        path.join("scenarios/03-broken-hospital-data/data/broken-patients.csv"),
        "--mapping",
        path.join("scenarios/03-broken-hospital-data/mapping/patient.json"),
        "--json",
        "--fail-on",
        "warning",
      ],
      strict.io,
    );
    assert.equal(strictExit, 3);
  });
});
