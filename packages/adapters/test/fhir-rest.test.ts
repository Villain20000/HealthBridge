import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  FHIR_REST_ADAPTER_ID,
  FHIR_REST_ADAPTER_VERSION,
  FhirRestFormatAdapter,
  assertAllowedUrl,
  extractFhirResources,
  fetchCapabilityStatement,
  isPrivateHost,
  isPrivateHostLiteral,
  normalizeAllowedHosts,
  redactUrlForLog,
} from "../src/fhir-rest.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// In-process loopback HTTP stub (no external network; 127.0.0.1 only)
// ---------------------------------------------------------------------------

interface StubState {
  server: http.Server;
  port: number;
  hits: string[];
  lastElements: string | null;
}

let stub: StubState;

function patient(id: string): Record<string, unknown> {
  return { resourceType: "Patient", id, name: [{ family: "Synthetic", given: ["Test"] }] };
}

function searchBundle(base: string, entries: Array<Record<string, unknown>>, next?: string): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "searchset",
    total: entries.length,
    link: [
      { relation: "self", url: `${base}/fhir/Patient` },
      ...(next ? [{ relation: "next", url: next }] : []),
    ],
    entry: entries.map((resource) => ({ resource })),
  });
}

function startStub(): Promise<StubState> {
  // NOTE: the handler mutates this same object (no spreading: spreading would
  // snapshot `lastElements` by value and the test would never see updates).
  const state = { server: undefined as unknown as http.Server, port: 0, hits: [] as string[], lastElements: null as string | null };
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    state.hits.push(rawUrl);
    const url = new URL(rawUrl, "http://127.0.0.1");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (status: number, text: string): void => {
      res.writeHead(status, { "Content-Type": "application/fhir+json" });
      res.end(text);
    };
    if (url.pathname === "/metadata" || url.pathname.endsWith("/metadata")) {
      json(
        200,
        JSON.stringify({ resourceType: "CapabilityStatement", status: "active", fhirVersion: "4.0.1" }),
      );
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => json(200, JSON.stringify(patient("slow-1"))), 400);
      return;
    }
    if (url.pathname === "/boom") {
      json(500, JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error" }] }));
      return;
    }
    if (url.pathname === "/fhir/Patient") {
      state.lastElements = url.searchParams.get("_elements");
      if (url.searchParams.get("page") === "2") {
        // Second page: one resource plus one entry without a resource
        // (exercises the BUNDLE_ENTRY_WITHOUT_RESOURCE structural path).
        const payload = JSON.parse(searchBundle(base, [patient("p3")], undefined)) as Record<string, unknown>;
        (payload.entry as Array<Record<string, unknown>>).push({ search: { mode: "match" } });
        json(200, JSON.stringify(payload));
        return;
      }
      json(200, searchBundle(base, [patient("p1"), patient("p2")], `${base}/fhir/Patient?page=2`));
      return;
    }
    json(404, JSON.stringify({ resourceType: "OperationOutcome" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      state.server = server;
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function contextFor(
  adapter: MedicalFormatAdapter,
  options?: Record<string, unknown>,
  maxRecords?: number,
): ParseContext {
  return { adapterId: adapter.id, adapterVersion: adapter.version, options, maxRecords };
}

async function collect(
  adapter: MedicalFormatAdapter,
  input: InputDescriptor,
  context: ParseContext,
): Promise<{ envelopes: MedicalDataEnvelope[]; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const envelopes: MedicalDataEnvelope[] = [];
  for await (const envelope of adapter.parse(input, { ...context, onIssue: (issue) => issues.push(issue) })) {
    envelopes.push(envelope);
  }
  return { envelopes, issues };
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function structured(envelope: MedicalDataEnvelope): Record<string, unknown> {
  assert.equal(envelope.content.kind, "structured");
  return (envelope.content as { kind: "structured"; data: Record<string, unknown> }).data;
}

describe("fhir-rest adapter", () => {
  before(async () => {
    stub = await startStub();
  });

  after(() => {
    stub.server.close();
  });

  test("satisfies the shared conformance contract with zero failures", async () => {
    const failures = await runAdapterConformance(new FhirRestFormatAdapter());
    assert.deepEqual(failures, []);
  });

  test("manifest is honestly metadata-only with no FHIR transform claim", () => {
    const manifest = new FhirRestFormatAdapter().getManifest();
    assert.equal(manifest.format, "fhir-rest");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.equal(new FhirRestFormatAdapter().id, FHIR_REST_ADAPTER_ID);
    assert.equal(new FhirRestFormatAdapter().version, FHIR_REST_ADAPTER_VERSION);
  });

  test("detect() matches FHIR REST URL shapes and never file payloads", async () => {
    const adapter = new FhirRestFormatAdapter();
    const base = `http://127.0.0.1:${stub.port}`;
    assert.equal(await adapter.score({ id: "u-patient", uri: `${base}/fhir/Patient?name=x` }), 0.85);
    assert.equal(await adapter.score({ id: "u-meta", uri: "https://fhir.example.org/fhir/metadata" }), 0.85);
    assert.equal(await adapter.score({ id: "u-base", uri: "https://hapi.example.org/baseR4/Observation" }), 0.85);
    assert.equal(await adapter.score({ id: "u-type", uri: "https://fhir.example.org/api/Patient/123" }), 0.8);
    assert.equal(await adapter.detect({ id: "u-detect", uri: `${base}/fhir/Patient` }), true);

    // Never file payloads: FHIR content without a URL scores zero.
    assert.equal(
      await adapter.score({
        id: "file-fhir",
        filename: "kit.fhir.json",
        contentString: JSON.stringify({ resourceType: "Patient", id: "kit-p1" }),
      }),
      0,
    );
    assert.equal(
      await adapter.score({
        id: "file-bundle",
        filename: "bundle.json",
        contentString: JSON.stringify({ resourceType: "Bundle", entry: [] }),
      }),
      0,
    );
    // Non-FHIR URLs, wrong schemes and garbage score zero without throwing.
    assert.equal(await adapter.score({ id: "u-csv", uri: "https://example.org/files/data.csv" }), 0);
    assert.equal(await adapter.score({ id: "u-ftp", uri: "ftp://example.org/fhir/Patient" }), 0);
    assert.equal(await adapter.score({ id: "u-garbage", uri: "not a url" }), 0);
    assert.equal(await adapter.score({ id: "u-none" }), 0);
    assert.equal(await adapter.detect({ id: "u-none-detect" }), false);
  });

  test("parse() searches with next-link paging into canonical envelopes", async () => {
    const adapter = new FhirRestFormatAdapter();
    const input: InputDescriptor = { id: "rest-pages", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 10 }),
    );
    assert.equal(envelopes.length, 3);
    assert.deepEqual(envelopes.map((e) => e.id), ["p1", "p2", "p3"]);
    for (const [index, envelope] of envelopes.entries()) {
      assert.equal(envelope.domain, "clinical");
      assert.equal(envelope.source.format, "fhir-rest");
      assert.equal(envelope.source.formatVersion, "4.0.1");
      assert.ok(envelope.source.checksum?.startsWith("sha256:"), "checksum required");
      assert.equal(envelope.provenance.adapterId, FHIR_REST_ADAPTER_ID);
      assert.equal(envelope.provenance.recordIndex, index);
      assert.equal(structured(envelope).resourceType, "Patient");
      assert.equal((envelope.metadata as Record<string, unknown>).requestHost, "127.0.0.1");
    }
    // Same structural path as the file adapter: the resourceless entry warns.
    assert.ok(codes(issues).includes("BUNDLE_ENTRY_WITHOUT_RESOURCE"));
    // Loopback was explicitly allowlisted, so the logged warning fires.
    assert.ok(codes(issues).includes("FHIR_REST_PRIVATE_HOST_ALLOWED"));
  });

  test("parse() respects the maxPages bound with an explicit warning", async () => {
    const adapter = new FhirRestFormatAdapter();
    const input: InputDescriptor = { id: "rest-bound", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 1 }),
    );
    assert.equal(envelopes.length, 2);
    assert.ok(codes(issues).includes("FHIR_REST_PAGE_LIMIT"));
  });

  test("parse() respects maxRecords across pages", async () => {
    const adapter = new FhirRestFormatAdapter();
    const input: InputDescriptor = { id: "rest-max", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` };
    const { envelopes } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 10 }, 1),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].provenance.recordIndex, 0);
  });

  test("parse() sends _elements support to the server", async () => {
    const adapter = new FhirRestFormatAdapter();
    stub.lastElements = null;
    const input: InputDescriptor = { id: "rest-el", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` };
    const { envelopes } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 1, elements: ["id", "name"] }),
    );
    assert.equal(envelopes.length, 2);
    assert.equal(stub.lastElements, "id,name");
    assert.deepEqual((envelopes[0].metadata as Record<string, unknown>).elements, ["id", "name"]);
  });

  test("parse() refuses non-allowlisted hosts (default-deny) without network", async () => {
    const adapter = new FhirRestFormatAdapter();
    const before = stub.hits.length;
    const input: InputDescriptor = { id: "rest-deny", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` };
    const { envelopes, issues } = await collect(adapter, input, contextFor(adapter, { allowedHosts: [] }));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_REST_ALLOWLIST_REFUSED"));
    assert.equal(stub.hits.length, before, "refused requests must never hit the network");

    const other = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["fhir.example.org"] }),
    );
    assert.equal(other.envelopes.length, 0);
    assert.ok(codes(other.issues).includes("FHIR_REST_ALLOWLIST_REFUSED"));
    assert.equal(stub.hits.length, before);
  });

  test("parse() refuses non-http(s) schemes", async () => {
    const adapter = new FhirRestFormatAdapter();
    const { envelopes, issues } = await collect(
      adapter,
      { id: "rest-scheme", uri: "ftp://127.0.0.1/fhir/Patient" },
      contextFor(adapter, { allowedHosts: ["127.0.0.1"] }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_REST_SCHEME_BLOCKED"));
  });

  test("parse() times out and keeps query values out of messages", async () => {
    const adapter = new FhirRestFormatAdapter();
    const secret = "SuperSecretPatientValue";
    const input: InputDescriptor = {
      id: "rest-timeout",
      uri: `http://127.0.0.1:${stub.port}/slow?name=${secret}`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 50, maxPages: 2 }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_REST_TIMEOUT"));
    for (const issue of issues) {
      assert.ok(!issue.message.includes(secret), `timeout message leaks query value: ${issue.message}`);
      assert.ok(!issue.message.includes("/slow?name="), `timeout message leaks raw query: ${issue.message}`);
    }
  });

  test("parse() reports HTTP errors with status only (no body, no query values)", async () => {
    const adapter = new FhirRestFormatAdapter();
    const secret = "AnotherSecretValue";
    const input: InputDescriptor = {
      id: "rest-boom",
      uri: `http://127.0.0.1:${stub.port}/boom?name=${secret}`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_REST_HTTP_ERROR"));
    const message = issues.find((i) => i.code === "FHIR_REST_HTTP_ERROR")?.message ?? "";
    assert.ok(message.includes("500"), "status code is actionable and safe to include");
    assert.ok(!message.includes(secret), "error message must not carry query values");
    assert.ok(!message.includes("OperationOutcome"), "response bodies never appear in errors");
  });

  test("parse() without a URL reports an issue instead of throwing", async () => {
    const adapter = new FhirRestFormatAdapter();
    const { envelopes, issues } = await collect(adapter, { id: "rest-nourl" }, contextFor(adapter, {}));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_REST_MISSING_URL"));
  });

  test("fetchCapabilityStatement retrieves the CapabilityStatement", async () => {
    const { statement, warnings } = await fetchCapabilityStatement(`http://127.0.0.1:${stub.port}/fhir`, {
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 5000,
    });
    assert.equal(statement.resourceType, "CapabilityStatement");
    assert.equal(statement.fhirVersion, "4.0.1");
    assert.ok(warnings.some((w) => w.includes("127.0.0.1")), "loopback allowlist warning is logged");
  });

  test("fetchCapabilityStatement refuses non-allowlisted hosts with redacted errors", async () => {
    const secret = "CapabilitySecretValue";
    await assert.rejects(
      fetchCapabilityStatement(`http://127.0.0.1:${stub.port}/fhir?name=${secret}`, { allowedHosts: [] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match((error as Error).message, /allowedHosts|default-deny/);
        assert.ok(!(error as Error).message.includes(secret), "refusal must not echo query values");
        return true;
      },
    );
  });

  test("inspect() is network-free and redacts query values", async () => {
    const adapter = new FhirRestFormatAdapter();
    const secret = "InspectSecretValue";
    const before = stub.hits.length;
    const inspection = await adapter.inspect({
      id: "rest-inspect",
      uri: `http://127.0.0.1:${stub.port}/fhir/Patient?name=${secret}&_elements=id,name`,
    });
    assert.equal(stub.hits.length, before, "inspect must not open sockets");
    assert.equal(inspection.format, "fhir-rest");
    assert.equal(inspection.domain, "clinical");
    assert.equal(inspection.status, "metadata-only");
    const text = (inspection.warnings ?? []).join("\n");
    assert.ok(!text.includes(secret), "inspect warnings must not carry query values");
    assert.ok(text.includes("values redacted"), "redaction is stated");
    assert.ok(text.includes("resourceType: Patient"));
  });

  test("health() reports ok with a details string", async () => {
    const result = await new FhirRestFormatAdapter().health();
    assert.equal(result.ok, true);
    assert.equal(typeof result.details, "string");
    assert.ok(result.details.includes(FHIR_REST_ADAPTER_ID));
  });

  test("SSRF helpers: allowlist normalisation, private hosts, redaction", async () => {
    assert.deepEqual(normalizeAllowedHosts(["FHIR.Example.org:443/path", "127.0.0.1", 42, ""]), [
      "fhir.example.org",
      "127.0.0.1",
    ]);
    assert.deepEqual(normalizeAllowedHosts(undefined), []);
    assert.equal(isPrivateHostLiteral("localhost"), true);
    assert.equal(isPrivateHostLiteral("127.0.0.1"), true);
    assert.equal(isPrivateHostLiteral("10.1.2.3"), true);
    assert.equal(isPrivateHostLiteral("172.16.5.4"), true);
    assert.equal(isPrivateHostLiteral("172.32.0.1"), false);
    assert.equal(isPrivateHostLiteral("192.168.0.9"), true);
    assert.equal(isPrivateHostLiteral("::1"), true);
    assert.equal(isPrivateHostLiteral("fhir.example.org"), false);
    assert.equal(await isPrivateHost("127.0.0.1"), true);
    assert.equal(await isPrivateHost("localhost"), true);
    assert.equal(redactUrlForLog("https://fhir.example.org/Patient?name=Secret&birthdate=2000-01-01"), "https://fhir.example.org/Patient?<query redacted>");
    assert.equal(redactUrlForLog("not a url"), "unparseable-url");
    assert.throws(() => assertAllowedUrl("ftp://x/fhir/Patient", ["x"]), /only http and https/);
    assert.throws(() => assertAllowedUrl("https://evil.example/fhir/Patient", []), /allowedHosts/);
  });

  test("extractFhirResources follows the file-adapter structural path", () => {
    const bundle = {
      resourceType: "Bundle",
      entry: [{ resource: { resourceType: "Patient", id: "a" } }, { search: {} }],
    };
    const parsed = extractFhirResources(bundle);
    assert.equal(parsed.resources.length, 1);
    assert.ok(codes(parsed.issues).includes("BUNDLE_ENTRY_WITHOUT_RESOURCE"));
    assert.equal(parsed.nextLink, undefined);

    const withNext = extractFhirResources({
      resourceType: "Bundle",
      entry: [],
      link: [{ relation: "next", url: "https://fhir.example.org/Patient?page=2" }],
    });
    assert.equal(withNext.nextLink, "https://fhir.example.org/Patient?page=2");

    const single = extractFhirResources({ resourceType: "Observation", id: "o1" });
    assert.equal(single.resources.length, 1);

    const bad = extractFhirResources({ noType: true });
    assert.equal(bad.resources.length, 0);
    assert.ok(codes(bad.issues).includes("FHIR_REST_UNEXPECTED_PAYLOAD"));
  });
});
