import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HealthBridge, HealthBridgeError, MappingDefinition } from "@healthbridge/sdk";

const repoRoot = path.resolve(__dirname, "../../..");
const csvPath = path.join(repoRoot, "datasets", "synthetic-patients.csv");
const mapping = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples", "patient-mapping.json"), "utf-8")) as MappingDefinition;

describe("sdk transformStream", () => {
  test("yields every output resource with progress and a shared runId", async () => {
    const bridge = new HealthBridge();
    const importedAt = "2024-01-01T00:00:00.000Z";
    const seen: unknown[] = [];
    const progress: Array<{ emitted: number; total: number }> = [];
    let runId = "";
    for await (const item of bridge.transformStream({
      input: csvPath,
      mapping,
      importedAt,
      onProgress: (p) => {
        progress.push({ emitted: p.emitted, total: p.total });
        runId = p.runId;
      },
    })) {
      seen.push(item.resource);
      assert.equal(item.runId, runId || item.runId);
      runId = item.runId;
    }
    const direct = await bridge.transform({ input: csvPath, mapping, importedAt });
    assert.equal(seen.length, direct.output.length);
    assert.deepEqual(seen, direct.output);
    assert.equal(progress.at(-1)?.emitted, direct.output.length);
    assert.equal(progress.at(-1)?.total, direct.output.length);
  });

  test("an aborted signal cancels the stream with the documented code", async () => {
    const bridge = new HealthBridge();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      (async () => {
        for await (const _ of bridge.transformStream({ input: csvPath, mapping, signal: controller.signal })) {
          // consume
        }
      })(),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "CANCELLED",
    );
  });
});


