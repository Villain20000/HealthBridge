import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HealthBridge, HealthBridgeError, MappingDefinition, RunBundle } from "@healthbridge/sdk";

const repoRoot = path.resolve(__dirname, "../../..");
const csvPath = path.join(repoRoot, "datasets", "synthetic-patients.csv");
const mappingPath = path.join(repoRoot, "examples", "patient-mapping.json");
const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8")) as MappingDefinition;

function bridge() {
  return new HealthBridge();
}

describe("run bundles", () => {
  test("a bundle never embeds patient data but identifies the input by checksum", async () => {
    const b = bridge();
    const result = await b.transform({ input: csvPath, mapping });
    const bundle = b.createRunBundle(result.runId);
    const serialised = JSON.stringify(bundle);

    assert.equal(bundle.bundleVersion, "1");
    assert.match(bundle.input.checksum ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(bundle.expected.outputChecksum, result.outputChecksum);
    assert.equal(bundle.expected.validationValid, true);
    assert.ok(bundle.mapping, "mapping snapshot must be embedded");

    // The payload itself must not travel with the bundle.
    const rawCsv = fs.readFileSync(csvPath, "utf-8");
    const firstFamily = rawCsv.split(/\r?\n/)[1].split(",")[2];
    assert.ok(!serialised.includes(firstFamily), "bundle must not contain source values");
    assert.ok(!serialised.includes(rawCsv.slice(0, 40)));
  });

  test("reproduces byte-identically even when the run had no fixed --imported-at", async () => {
    const b = bridge();
    const result = await b.transform({ input: csvPath, mapping });
    const bundle = b.createRunBundle(result.runId);

    const outcome = await b.reproduce(bundle, csvPath);
    assert.equal(outcome.inputChecksumMatches, true);
    assert.equal(outcome.actualChecksum, result.outputChecksum);
    assert.equal(outcome.matches, true);
  });

  test("detects divergence when the payload changes", async () => {
    const b = bridge();
    const result = await b.transform({ input: csvPath, mapping });
    const bundle = b.createRunBundle(result.runId);

    const tampered = path.join(os.tmpdir(), `hb-tampered-${process.pid}.csv`);
    const altered = fs.readFileSync(csvPath, "utf-8").replace("John", "Jon");
    fs.writeFileSync(tampered, altered, "utf-8");
    try {
      const outcome = await b.reproduce(bundle, tampered);
      assert.equal(outcome.matches, false, "changed input must not be reported as reproduced");
      assert.notEqual(outcome.actualChecksum, bundle.expected.outputChecksum);
    } finally {
      fs.rmSync(tampered, { force: true });
    }
  });

  test("a bundle is plain JSON and survives a round trip", async () => {
    const b = bridge();
    const result = await b.transform({ input: csvPath, mapping, importedAt: "2024-01-01T00:00:00.000Z" });
    const bundle = b.createRunBundle(result.runId);
    const restored = JSON.parse(JSON.stringify(bundle)) as RunBundle;

    const outcome = await bridge().reproduce(restored, csvPath);
    assert.equal(outcome.matches, true);
  });

  test("reproduce uses the bundle's mapping snapshot, not the file on disk", async () => {
    const b = bridge();
    const narrow: MappingDefinition = {
      ...mapping,
      rules: mapping.rules.filter((r) => r.targetPath !== "birthDate"),
    };
    const result = await b.transform({ input: csvPath, mapping: narrow });
    const bundle = b.createRunBundle(result.runId);

    assert.ok(
      (bundle.mapping as MappingDefinition).rules.every((r) => r.targetPath !== "birthDate"),
      "bundle must carry the mapping actually used",
    );
    const outcome = await b.reproduce(bundle, csvPath);
    assert.equal(outcome.matches, true);
  });
});

describe("SDK error taxonomy", () => {
  test("missing input is categorised as an input error", async () => {
    const b = bridge();
    await assert.rejects(
      () => b.transform({ input: "does-not-exist.csv", mapping }),
      (error: unknown) => {
        assert.ok(error instanceof HealthBridgeError);
        assert.equal(error.code, "INPUT_NOT_FOUND");
        assert.equal(error.category, "input");
        return true;
      },
    );
  });

  test("replaying an unknown run fails with a usage error", async () => {
    const b = bridge();
    await assert.rejects(
      () => b.replay("run-does-not-exist"),
      (error: unknown) => (error as HealthBridgeError).code === "RUN_NOT_FOUND",
    );
  });

  test("input checksum is stable across runs", async () => {
    const b = bridge();
    const a = await b.transform({ input: csvPath, mapping });
    const c = await b.transform({ input: csvPath, mapping });
    assert.equal(a.inputChecksum, c.inputChecksum);
    assert.equal(a.inputChecksum, b.createRunBundle(a.runId).input.checksum);
  });
});
