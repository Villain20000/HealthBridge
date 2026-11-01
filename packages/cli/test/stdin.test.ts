import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readStdinText, stdinInputDescriptor } from "../src/index.js";

describe("cli stdin", () => {
  test("stdin descriptor carries content without touching the filesystem", () => {
    const descriptor = stdinInputDescriptor("patient_id\nP1\n", "pipe.csv");
    assert.equal(descriptor.filename, "pipe.csv");
    assert.equal(descriptor.contentString, "patient_id\nP1\n");
    assert.equal(descriptor.id, "stdin");
  });

  test("readStdinText drains a stream", async () => {
    const text = await readStdinText(Readable.from(["a,b\n", "1,2\n"]) as unknown as NodeJS.ReadableStream);
    assert.equal(text, "a,b\n1,2\n");
  });
});
