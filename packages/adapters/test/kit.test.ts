import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeXml, createBuiltInAdapters, runAdapterConformance, UnsafeXmlError } from "@healthbridge/adapters";

describe("adapter kit", () => {
  test("every built-in adapter satisfies the shared conformance contract", async () => {
    for (const adapter of createBuiltInAdapters()) {
      const failures = await runAdapterConformance(adapter);
      assert.deepEqual(failures, [], `${adapter.id} broke the contract: ${failures.join("; ")}`);
    }
  });

  test("the XXE guard refuses DOCTYPE and ENTITY payloads", () => {
    assert.throws(
      () => assertSafeXml(`<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`),
      UnsafeXmlError,
    );
    assert.throws(() => assertSafeXml(`<root><!ENTITY lol "x"></root>`), UnsafeXmlError);
    assert.doesNotThrow(() => assertSafeXml(`<ClinicalDocument><title>summary</title></ClinicalDocument>`));
  });
});
