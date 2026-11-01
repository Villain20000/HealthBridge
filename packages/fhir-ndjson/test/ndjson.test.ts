import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FhirNdjsonFormatAdapter } from "@healthbridge/fhir-ndjson";
import { AdapterRegistry } from "@healthbridge/core";
import { FhirJsonFormatAdapter, createBuiltInAdapters, runAdapterConformance } from "@healthbridge/adapters";

const NDJSON = [
  '{"resourceType":"Patient","id":"p1"}',
  '{"resourceType":"Observation","id":"o1"}',
  '{"resourceType":"Patient","id":"p2"}',
].join("\n");

const SINGLE_PATIENT = JSON.stringify({ resourceType: "Patient", id: "p1" });

describe("FhirNdjsonFormatAdapter", () => {
  test("parses NDJSON lines into envelopes with provenance and checksum", async () => {
    const adapter = new FhirNdjsonFormatAdapter();
    const envelopes = [];
    for await (const envelope of adapter.parse(
      { id: "nd-1", filename: "resources.ndjson", contentString: NDJSON },
      { adapterId: adapter.id, adapterVersion: adapter.version },
    )) {
      envelopes.push(envelope);
    }
    assert.equal(envelopes.length, 3);
    assert.deepEqual(
      envelopes.map((envelope) => (envelope.content.data as Record<string, unknown>).resourceType),
      ["Patient", "Observation", "Patient"],
    );
    assert.match(String(envelopes[0].source.checksum), /^sha256:[a-f0-9]{64}$/);
    assert.equal(envelopes[0].provenance.sourceLocation, "$[0]");
    assert.equal(envelopes[0].provenance.adapterId, "fhir-r4-ndjson-adapter");
    // Payload format is unchanged from the pre-split adapter so downstream
    // pipeline output stays byte-identical.
    assert.equal(envelopes[0].source.format, "fhir-r4-json");
    assert.deepEqual(envelopes[1].metadata, { resourceType: "Observation" });
  });

  test("reports malformed lines instead of silently dropping them", async () => {
    const adapter = new FhirNdjsonFormatAdapter();
    const input = {
      id: "nd-2",
      filename: "resources.ndjson",
      contentString: '{"resourceType":"Patient","id":"p1"}\n{broken json}\n{"resourceType":"Observation","id":"o1"}\n',
    };
    const issues: string[] = [];
    const envelopes = [];
    for await (const envelope of adapter.parse(input, {
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      onIssue: (issue) => issues.push(issue.code),
    })) {
      envelopes.push(envelope);
    }
    assert.equal(envelopes.length, 2);
    assert.deepEqual(issues, ["MALFORMED_NDJSON_LINE"]);
  });

  test("scores .ndjson files highest and cedes single-resource JSON to the JSON adapter", async () => {
    const adapter = new FhirNdjsonFormatAdapter();
    assert.equal(await adapter.score({ id: "nd-3", filename: "resources.ndjson", contentString: NDJSON }), 0.95);
    assert.equal(await adapter.score({ id: "nd-4", filename: "bundle.ndjson", contentString: SINGLE_PATIENT }), 0.95);
    assert.equal(await adapter.score({ id: "nd-5", filename: "feed.txt", contentString: NDJSON }), 0.9);
    assert.equal(await adapter.score({ id: "nd-6", filename: "patient.json", contentString: SINGLE_PATIENT }), 0);
    assert.equal(await adapter.score({ id: "nd-7", filename: "data.json", contentString: '{"a":1}' }), 0);
  });

  test("inspection reports type counts and encoding", async () => {
    const adapter = new FhirNdjsonFormatAdapter();
    const inspection = await adapter.inspect({ id: "nd-8", filename: "resources.ndjson", contentString: NDJSON });
    assert.equal(inspection.format, "fhir-r4-ndjson");
    assert.equal(inspection.recordCount, 3);
    assert.ok(inspection.warnings?.some((warning) => warning.includes("Patient: 2")));
    assert.ok(inspection.warnings?.some((warning) => warning.includes("Observation: 1")));
  });

  test("satisfies the shared adapter conformance contract", async () => {
    const failures = await runAdapterConformance(new FhirNdjsonFormatAdapter());
    assert.deepEqual(failures, []);
  });

  test("built-in registry routes NDJSON to the new adapter and single JSON to the JSON adapter", async () => {
    const registry = new AdapterRegistry();
    for (const adapter of createBuiltInAdapters()) registry.register(adapter);

    const ndjsonBest = await registry.detectAdapter({
      id: "nd-9",
      filename: "resources.ndjson",
      contentString: NDJSON,
    });
    assert.equal(ndjsonBest?.id, "fhir-r4-ndjson-adapter");

    const ndjsonCandidates = await registry.detect({ id: "nd-10", filename: "feed.txt", contentString: NDJSON });
    assert.equal(ndjsonCandidates[0]?.adapterId, "fhir-r4-ndjson-adapter");
    assert.equal(ndjsonCandidates[0]?.confidence, 0.9);

    const jsonBest = await registry.detectAdapter({
      id: "nd-11",
      filename: "patient.json",
      contentString: SINGLE_PATIENT,
    });
    assert.equal(jsonBest?.id, "fhir-r4-json-adapter");
  });

  test("a mislabeled .ndjson file holding a single resource still parses (pre-split behavior)", async () => {
    const adapter = new FhirNdjsonFormatAdapter();
    const envelopes = [];
    for await (const envelope of adapter.parse(
      { id: "nd-12b", filename: "single.ndjson", contentString: SINGLE_PATIENT },
      { adapterId: adapter.id, adapterVersion: adapter.version },
    )) {
      envelopes.push(envelope);
    }
    assert.equal(envelopes.length, 1);
    assert.equal((envelopes[0].content.data as Record<string, unknown>).id, "p1");
  });

  test("the JSON adapter no longer claims .ndjson inputs", async () => {
    const json = new FhirJsonFormatAdapter();
    assert.equal(await json.score({ id: "nd-12", filename: "resources.ndjson", contentString: NDJSON }), 0);
    assert.equal(await json.score({ id: "nd-13", filename: "patient.json", contentString: SINGLE_PATIENT }), 0.9);
  });
});
