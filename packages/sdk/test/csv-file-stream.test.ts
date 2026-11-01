import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HealthBridge, HealthBridgeError, MappingDefinition } from "@healthbridge/sdk";
import { readCsvTable, buildCsvRecords } from "@healthbridge/adapters";
import { streamCsvFileBatches, transformCsvFileStreamed } from "../src/csv-file-stream.js";

const repoRoot = path.resolve(__dirname, "../../..");
const csvPath = path.join(repoRoot, "datasets", "synthetic-patients.csv");
const mapping = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "examples", "patient-mapping.json"), "utf-8"),
) as MappingDefinition;

const NASTY_CSV = [
  "patient_id,first_name,last_name,gender,birth_date,ssn,extra",
  'P101,"Doe, Jane",Smith,F,1990-11-23,999-12-3456,',
  "P102,John,Smith,M,1985-04-12,999-65-4321,ragged-cell-a,ragged-cell-b",
  'P103,"Multi',
  'line",Brown,M,1978-01-30,999-88-7766,',
].join("\r\n");

function writeTemp(name: string, content: string | Buffer): string {
  const file = path.join(os.tmpdir(), `hb-stream-${process.pid}-${name}`);
  fs.writeFileSync(file, content);
  return file;
}

describe("streamCsvFileBatches", () => {
  test("yields the same records as the buffered parse, even with tiny chunks", async () => {
    const file = writeTemp("nasty.csv", NASTY_CSV);
    try {
      const seen: Array<{ data: unknown; lineNumber: number }> = [];
      let headers: string[] = [];
      let delimiter = "";
      let encoding = "";
      for await (const batch of streamCsvFileBatches(file, { batchSize: 2, chunkBytes: 11 })) {
        headers = batch.headers;
        delimiter = batch.delimiter;
        encoding = batch.encoding;
        for (const record of batch.records) seen.push({ data: record.data, lineNumber: record.lineNumber });
      }
      assert.deepEqual(headers, ["patient_id", "first_name", "last_name", "gender", "birth_date", "ssn", "extra"]);
      assert.equal(delimiter, ",");
      assert.equal(encoding, "utf-8");

      const table = readCsvTable({ contentString: NASTY_CSV });
      const { records } = buildCsvRecords(table);
      assert.deepEqual(
        seen,
        records.map((r) => ({ data: r.data, lineNumber: r.lineNumber })),
      );
      // Ragged rows and multiline cells survive the stream.
      assert.ok(seen.some((r) => (r.data as Record<string, unknown>)["first_name"] === "Multi\r\nline"));
      const ragged = seen.find((r) => (r.data as Record<string, unknown>)["patient_id"] === "P102");
      assert.ok(Array.isArray((ragged?.data as Record<string, unknown>)["__extra"]));
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("reports the BOM encoding label and strips it from content", async () => {
    const file = writeTemp(
      "bom.csv",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n1,2\n", "utf-8")]),
    );
    try {
      const batches = [];
      for await (const batch of streamCsvFileBatches(file, { chunkBytes: 5 })) {
        batches.push(batch);
      }
      assert.equal(batches.length, 1);
      assert.equal(batches[0]?.encoding, "utf-8-bom");
      assert.deepEqual(batches[0]?.headers, ["a", "b"]);
      assert.deepEqual(
        batches[0]?.records.map((r) => r.data),
        [{ a: "1", b: "2" }],
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("honours maxRecords by stopping file reads early", async () => {
    const file = writeTemp("max.csv", NASTY_CSV);
    try {
      let count = 0;
      for await (const batch of streamCsvFileBatches(file, { batchSize: 1, maxRecords: 2, chunkBytes: 13 })) {
        count += batch.records.length;
      }
      assert.equal(count, 2);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("a missing file raises INPUT_NOT_FOUND", async () => {
    await assert.rejects(
      (async () => {
        for await (const _ of streamCsvFileBatches(path.join(os.tmpdir(), "hb-no-such-file.csv"))) {
          // consume
        }
      })(),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "INPUT_NOT_FOUND",
    );
  });
});

describe("transformCsvFileStreamed", () => {
  const importedAt = "2024-01-01T00:00:00.000Z";

  test("matches the buffered SDK transform on output, coverage and checksums", async () => {
    const bridge = new HealthBridge();
    const direct = await bridge.transform({ input: csvPath, mapping, importedAt });

    const batches: Array<{ batchIndex: number; resources: unknown[] }> = [];
    const streamed = await transformCsvFileStreamed({
      filePath: csvPath,
      mapping,
      importedAt,
      batchSize: 1,
      chunkBytes: 29,
      onBatch: (batch) => {
        batches.push({ batchIndex: batch.batchIndex, resources: batch.resources });
      },
    });

    assert.deepEqual(streamed.output, direct.output);
    assert.deepEqual(streamed.coverage, direct.coverage);
    assert.deepEqual(streamed.rejectedRecords, direct.rejectedRecords);
    assert.deepEqual(streamed.dataLoss, direct.dataLoss);
    assert.deepEqual(streamed.validation, direct.validation);
    assert.equal(streamed.status, direct.status);
    assert.equal(streamed.inputChecksum, direct.inputChecksum);
    assert.equal(streamed.outputChecksum, direct.outputChecksum);
    assert.deepEqual(
      batches.map((b) => b.batchIndex),
      [0, 1, 2],
    );
    assert.deepEqual(
      batches.flatMap((b) => b.resources),
      streamed.output,
    );
  });

  test("works without a batch callback and reports the same checksums twice", async () => {
    const first = await transformCsvFileStreamed({ filePath: csvPath, mapping, importedAt });
    const second = await transformCsvFileStreamed({ filePath: csvPath, mapping, importedAt });
    assert.equal(first.outputChecksum, second.outputChecksum);
    assert.equal(first.inputChecksum, second.inputChecksum);
    assert.deepEqual(first.output, second.output);
  });

  test("an aborted signal cancels with the documented code", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      transformCsvFileStreamed({ filePath: csvPath, mapping, signal: controller.signal }),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "CANCELLED",
    );
  });

  test("a missing file raises INPUT_NOT_FOUND", async () => {
    await assert.rejects(
      transformCsvFileStreamed({ filePath: path.join(os.tmpdir(), "hb-no-such-file.csv"), mapping }),
      (error: unknown) => error instanceof HealthBridgeError && error.code === "INPUT_NOT_FOUND",
    );
  });
});
