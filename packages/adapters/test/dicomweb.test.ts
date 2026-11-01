import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  DICOMWEB_ADAPTER_ID,
  DICOMWEB_ADAPTER_VERSION,
  DicomWebAdapter,
  DicomWebError,
  applyDicomWebQidoOptions,
  assertDicomWebAllowedUrl,
  buildQidoSearchUrl,
  classifyDicomWebUrl,
  dicomJsonFirstValue,
  extractDicomWebIdentifiers,
  isDicomWebPrivateHost,
  isDicomWebPrivateHostLiteral,
  normalizeDicomWebAllowedHosts,
  parseDicomWebFrameList,
  redactDicomWebUrlForLog,
  refuseDicomWebStow,
  uidsFromDicomWebPath,
} from "../src/dicomweb.js";
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
  lastQido: { limit: string | null; offset: string | null; modality: string | null; includefield: string[]; fuzzymatching: string | null } | null;
}

let stub: StubState;

const INSTANCE_SENTINEL = "INSTANCE-PIXEL-SENTINEL-7c41-never-inline";
const FRAMES_SENTINEL = "FRAMES-PIXEL-SENTINEL-9f3c-never-inline";

function qidoDataset(studyUid: string, modality: string, patient: string): Record<string, unknown> {
  return {
    "0020000D": { vr: "UI", Value: [studyUid] },
    "00080060": { vr: "CS", Value: [modality] },
    "00100010": { vr: "PN", Value: [{ Alphabetic: patient }] },
  };
}

function metadataDataset(study: string, series: string, sop: string, modality: string): Record<string, unknown> {
  return {
    "0020000D": { vr: "UI", Value: [study] },
    "0020000E": { vr: "UI", Value: [series] },
    "00080018": { vr: "UI", Value: [sop] },
    "00080060": { vr: "CS", Value: [modality] },
  };
}

const QIDO_DATA: Array<Record<string, unknown>> = [
  qidoDataset("1.2.3.1", "CT", "Synthetic^One"),
  qidoDataset("1.2.3.2", "MR", "Synthetic^Two"),
  qidoDataset("1.2.3.3", "CT", "Synthetic^Three"),
];

const METADATA_DATA: Array<Record<string, unknown>> = [
  metadataDataset("1.2.3.1", "1.2.3.1.1", "1.2.3.1.1.1", "CT"),
  metadataDataset("1.2.3.1", "1.2.3.1.1", "1.2.3.1.1.2", "CT"),
];

function startStub(): Promise<StubState> {
  const state = { server: undefined as unknown as http.Server, port: 0, hits: [] as string[], lastQido: null as StubState["lastQido"] };
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    state.hits.push(rawUrl);
    const url = new URL(rawUrl, "http://127.0.0.1");
    const path = url.pathname;
    const json = (status: number, text: string): void => {
      res.writeHead(status, { "Content-Type": "application/dicom+json" });
      res.end(text);
    };
    // QIDO-shaped special cases (paths contain /studies so the adapter treats
    // them as searches and actually fetches; generic /slow etc. would classify
    // as unknown-operation and never hit the network).
    if (path === "/dicomweb/studies/slow") {
      setTimeout(() => json(200, JSON.stringify(QIDO_DATA)), 400);
      return;
    }
    if (path === "/dicomweb/studies/boom") {
      res.writeHead(500, { "Content-Type": "application/dicom+json" });
      res.end(JSON.stringify({ unexpected: "OperationOutcome-body-must-stay-redacted" }));
      return;
    }
    if (path === "/dicomweb/studies/badjson") {
      res.writeHead(200, { "Content-Type": "application/dicom+json" });
      res.end("this is not json{{{");
      return;
    }
    if (path === "/dicomweb/studies/asobject") {
      json(200, JSON.stringify({ not: "an-array" }));
      return;
    }
    if (path === "/dicomweb/studies/redir") {
      res.writeHead(302, { Location: "/dicomweb/studies" });
      res.end();
      return;
    }
    if (path.endsWith("/metadata")) {
      json(200, JSON.stringify(METADATA_DATA));
      return;
    }
    if (path.includes("/frames/")) {
      const bytes = Buffer.from(`DICOM-FRAMES ${FRAMES_SENTINEL} binary-payload`, "utf-8");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      res.end(bytes);
      return;
    }
    if (/\/instances\/[^/]+\/?$/.test(path)) {
      const bytes = Buffer.from(`DICOM-INSTANCE ${INSTANCE_SENTINEL} binary-payload`, "utf-8");
      res.writeHead(200, { "Content-Type": "application/dicom", "Content-Length": bytes.length });
      res.end(bytes);
      return;
    }
    if (path.includes("/studies")) {
      state.lastQido = {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        modality: url.searchParams.get("Modality"),
        includefield: url.searchParams.getAll("includefield"),
        fuzzymatching: url.searchParams.get("fuzzymatching"),
      };
      const limitRaw = Number(url.searchParams.get("limit") ?? "100");
      const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
      const modality = url.searchParams.get("Modality");
      let rows = QIDO_DATA;
      if (modality) rows = rows.filter((d) => (dicomJsonFirstValue(d, "00080060") ?? "") === modality);
      json(200, JSON.stringify(rows.slice(offset, offset + limit)));
      return;
    }
    json(404, JSON.stringify([]));
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

describe("dicomweb adapter", () => {
  before(async () => {
    stub = await startStub();
  });

  after(() => {
    stub.server.close();
  });

  test("satisfies the shared conformance contract with zero failures", async () => {
    const failures = await runAdapterConformance(new DicomWebAdapter());
    assert.deepEqual(failures, []);
  });

  test("manifest is honestly metadata-only with no FHIR transform claim", () => {
    const manifest = new DicomWebAdapter().getManifest();
    assert.equal(manifest.format, "dicomweb");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.equal(new DicomWebAdapter().id, DICOMWEB_ADAPTER_ID);
    assert.equal(new DicomWebAdapter().version, DICOMWEB_ADAPTER_VERSION);
    const limits = (manifest.limitations ?? []).join("\n");
    assert.match(limits, /STOW-RS/i);
    assert.match(limits, /read-only/i);
    assert.match(limits, /never inlined|byte counts only/i);
  });

  test("detect() matches DICOMweb /studies URL shapes and never file payloads", async () => {
    const adapter = new DicomWebAdapter();
    const base = `http://127.0.0.1:${stub.port}`;
    assert.equal(await adapter.score({ id: "u-studies", uri: `${base}/dicomweb/studies` }), 0.85);
    assert.equal(await adapter.score({ id: "u-series", uri: `${base}/dicomweb/studies/1.2.3/series` }), 0.85);
    assert.equal(
      await adapter.score({ id: "u-meta", uri: `${base}/dicomweb/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1/metadata` }),
      0.85,
    );
    assert.equal(
      await adapter.score({ id: "u-frames", uri: `${base}/dicomweb/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.1/frames/1` }),
      0.85,
    );
    assert.equal(await adapter.detect({ id: "u-detect", uri: `${base}/dicomweb/studies?Modality=CT` }), true);

    // Never file payloads: DICOM bytes or JSON without a URL score zero.
    assert.equal(
      await adapter.score({ id: "file-dcm", filename: "image.dcm", contentString: "DICM-binary-payload" }),
      0,
    );
    assert.equal(
      await adapter.score({
        id: "file-json",
        filename: "qido.json",
        contentString: JSON.stringify([{ "0020000D": { vr: "UI", Value: ["1.2.3"] } }]),
      }),
      0,
    );
    // Non-DICOMweb URLs, wrong schemes and garbage score zero without throwing.
    assert.equal(await adapter.score({ id: "u-fhir", uri: `${base}/fhir/Patient` }), 0);
    assert.equal(await adapter.score({ id: "u-csv", uri: "https://example.org/files/data.csv" }), 0);
    assert.equal(await adapter.score({ id: "u-ftp", uri: "ftp://example.org/dicomweb/studies" }), 0);
    assert.equal(await adapter.score({ id: "u-garbage", uri: "not a url" }), 0);
    assert.equal(await adapter.score({ id: "u-none" }), 0);
    assert.equal(await adapter.detect({ id: "u-none-detect" }), false);
  });

  test("classifyDicomWebUrl distinguishes QIDO and WADO shapes", () => {
    const base = `http://127.0.0.1:${stub.port}/dicomweb`;
    assert.equal(classifyDicomWebUrl(`${base}/studies`), "qido-studies");
    assert.equal(classifyDicomWebUrl(`${base}/studies?Modality=CT`), "qido-studies");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/series`), "qido-series");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/series/1.2/instances`), "qido-instances");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/metadata`), "wado-metadata");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/series/1.2/instances/1.2.3/metadata`), "wado-metadata");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/series/1.2/instances/1.2.3`), "wado-instance");
    assert.equal(classifyDicomWebUrl(`${base}/studies/1.2.3/series/1.2/instances/1.2.3/frames/1,2`), "wado-frames");
    assert.equal(classifyDicomWebUrl("https://example.org/fhir/Patient"), "unknown");
    assert.equal(classifyDicomWebUrl("not a url"), "unknown");
    assert.equal(classifyDicomWebUrl("ftp://example.org/dicomweb/studies"), "unknown");
  });

  test("buildQidoSearchUrl builds study/series/instance URLs with paging", () => {
    const base = `http://127.0.0.1:${stub.port}/dicomweb`;
    const studies = buildQidoSearchUrl({ baseUrl: base, level: "studies", limit: 2, filters: { Modality: "CT" } });
    const parsed = new URL(studies);
    assert.equal(parsed.pathname, "/dicomweb/studies");
    assert.equal(parsed.searchParams.get("limit"), "2");
    assert.equal(parsed.searchParams.get("Modality"), "CT");

    const series = buildQidoSearchUrl({ baseUrl: base, level: "series", studyInstanceUID: "1.2.3", limit: 5 });
    assert.ok(series.includes("/studies/1.2.3/series"));

    const instances = buildQidoSearchUrl({
      baseUrl: base,
      level: "instances",
      studyInstanceUID: "1.2.3",
      seriesInstanceUID: "1.2.4",
      offset: 10,
      includefield: ["StudyInstanceUID"],
      fuzzymatching: true,
    });
    const pi = new URL(instances);
    assert.equal(pi.searchParams.get("offset"), "10");
    assert.deepEqual(pi.searchParams.getAll("includefield"), ["StudyInstanceUID"]);
    assert.equal(pi.searchParams.get("fuzzymatching"), "true");

    assert.throws(() => buildQidoSearchUrl({ baseUrl: "not a url", level: "studies" }), DicomWebError);
    assert.throws(() => buildQidoSearchUrl({ baseUrl: base, level: "series" }), /studyInstanceUID/);
    assert.throws(
      () => buildQidoSearchUrl({ baseUrl: base, level: "instances", studyInstanceUID: "1.2.3" }),
      /seriesInstanceUID/,
    );
  });

  test("parse() runs QIDO search with limit/offset paging into envelopes", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = { id: "qido-pages", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies?limit=2` };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 10 }),
    );
    assert.equal(envelopes.length, 3);
    assert.deepEqual(envelopes.map((e) => e.id), ["1.2.3.1", "1.2.3.2", "1.2.3.3"]);
    for (const [index, envelope] of envelopes.entries()) {
      assert.equal(envelope.domain, "imaging");
      assert.equal(envelope.source.format, "dicomweb");
      assert.equal(envelope.source.formatVersion, "PS3.18");
      assert.ok(envelope.source.checksum?.startsWith("sha256:"), "checksum required");
      assert.equal(envelope.provenance.adapterId, DICOMWEB_ADAPTER_ID);
      assert.equal(envelope.provenance.recordIndex, index);
      assert.ok(typeof envelope.provenance.sourceLocation === "string");
      const data = structured(envelope);
      assert.ok("0020000D" in data, "DICOM JSON dataset carried structurally");
      assert.equal((envelope.metadata as Record<string, unknown>).requestHost, "127.0.0.1");
    }
    assert.ok(codes(issues).includes("DICOMWEB_PRIVATE_HOST_ALLOWED"));
  });

  test("parse() respects the maxPages bound with an explicit warning", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = { id: "qido-bound", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies?limit=2` };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 1 }),
    );
    assert.equal(envelopes.length, 2);
    assert.ok(codes(issues).includes("DICOMWEB_PAGE_LIMIT"));
  });

  test("parse() respects maxRecords across pages", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = { id: "qido-max", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies?limit=2` };
    const { envelopes } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000, maxPages: 10 }, 1),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].provenance.recordIndex, 0);
  });

  test("parse() builds QIDO query parameters from options when the URL lacks them", async () => {
    const adapter = new DicomWebAdapter();
    stub.lastQido = null;
    const input: InputDescriptor = { id: "qido-opts", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies` };
    const { envelopes } = await collect(
      adapter,
      input,
      contextFor(adapter, {
        allowedHosts: ["127.0.0.1"],
        timeoutMs: 5000,
        maxPages: 1,
        limit: 2,
        modality: "MR",
        includefield: ["StudyInstanceUID"],
        fuzzymatching: true,
      }),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(stub.lastQido?.limit, "2");
    assert.equal(stub.lastQido?.modality, "MR");
    assert.deepEqual(stub.lastQido?.includefield, ["StudyInstanceUID"]);
    assert.equal(stub.lastQido?.fuzzymatching, "true");
    // Explicit URLs win: options must not overwrite a URL-set Modality.
    stub.lastQido = null;
    const explicit: InputDescriptor = {
      id: "qido-explicit",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies?Modality=CT`,
    };
    await collect(adapter, explicit, contextFor(adapter, { allowedHosts: ["127.0.0.1"], modality: "MR", maxPages: 1 }));
    assert.equal(stub.lastQido?.modality, "CT");
    // Pure helper form merges the same way.
    const merged = applyDicomWebQidoOptions(`http://127.0.0.1:${stub.port}/dicomweb/studies`, { modality: "CT" });
    assert.equal(new URL(merged).searchParams.get("Modality"), "CT");
  });

  test("parse() retrieves WADO-RS metadata as per-instance envelopes", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = {
      id: "wado-meta",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/1.2.3.1/metadata`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 2);
    assert.deepEqual(envelopes.map((e) => e.id), ["1.2.3.1.1.1", "1.2.3.1.1.2"]);
    for (const envelope of envelopes) {
      assert.equal(envelope.content.kind, "structured");
      assert.ok(envelope.source.checksum?.startsWith("sha256:"));
      assert.equal((envelope.metadata as Record<string, unknown>).operation, "wado-metadata");
    }
    assert.ok(!codes(issues).includes("DICOMWEB_PAGE_LIMIT"));
  });

  test("parse() records WADO-RS instance bytes as a binary reference only", async () => {
    const adapter = new DicomWebAdapter();
    const secret = "InstanceQuerySecret";
    const input: InputDescriptor = {
      id: "wado-inst",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/1.2.3.1/series/1.2.3.1.1/instances/1.2.3.1.1.1?label=${secret}`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 1);
    const envelope = envelopes[0];
    assert.equal(envelope.content.kind, "binary-reference");
    const ref = envelope.content as { kind: "binary-reference"; uri: string; mediaType: string; sizeBytes?: number };
    assert.equal(ref.mediaType, "application/dicom");
    assert.ok((ref.sizeBytes ?? 0) > 0);
    assert.equal(envelope.id, "1.2.3.1.1.1");
    assert.ok(envelope.source.checksum?.startsWith("sha256:"));
    assert.equal((envelope.metadata as Record<string, unknown>).pixelBytesInlined, false);
    // Pixel bytes NEVER enter envelopes, issues or traces: the sentinel must be absent.
    const dumped = JSON.stringify({ envelopes, issues });
    assert.ok(!dumped.includes(INSTANCE_SENTINEL), "instance bytes must never be inlined");
    assert.ok(!dumped.includes(secret), "query values must not leak into envelopes/issues");
    // The reference URI strips the query so PHI cannot ride along.
    assert.ok(!ref.uri.includes(secret), "binary-reference URI must not carry query values");
    assert.ok(!ref.uri.includes("?"), "binary-reference URI carries path only");
  });

  test("parse() records WADO-RS frames as a binary reference with frame metadata", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = {
      id: "wado-frames",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/1.2.3.1/series/1.2.3.1.1/instances/1.2.3.1.1.1/frames/1,2`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].content.kind, "binary-reference");
    const meta = envelopes[0].metadata as Record<string, unknown>;
    assert.equal(meta.operation, "wado-frames");
    assert.deepEqual(meta.frameList, ["1", "2"]);
    assert.equal(meta.frameCount, 2);
    assert.deepEqual(parseDicomWebFrameList(input.uri as string), ["1", "2"]);
    const dumped = JSON.stringify({ envelopes, issues });
    assert.ok(!dumped.includes(FRAMES_SENTINEL), "frame bytes must never be inlined");
  });

  test("STOW-RS store intent is explicitly refused without network", async () => {
    const adapter = new DicomWebAdapter();
    const input: InputDescriptor = { id: "stow", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies` };
    for (const options of [{ stow: true }, { operation: "stow" }, { operation: "store" }, { method: "POST" }]) {
      const before = stub.hits.length;
      const { envelopes, issues } = await collect(adapter, input, contextFor(adapter, { allowedHosts: ["127.0.0.1"], ...options }));
      assert.equal(envelopes.length, 0);
      assert.ok(codes(issues).includes("DICOMWEB_STOW_REFUSED"), `options ${JSON.stringify(options)} must refuse`);
      assert.equal(stub.hits.length, before, "refused stores must never hit the network");
    }
    assert.throws(() => refuseDicomWebStow(), (error: unknown) => {
      assert.ok(error instanceof DicomWebError);
      assert.equal((error as DicomWebError).code, "DICOMWEB_STOW_REFUSED");
      return true;
    });
  });

  test("parse() refuses non-allowlisted hosts (default-deny) without network", async () => {
    const adapter = new DicomWebAdapter();
    const before = stub.hits.length;
    const input: InputDescriptor = { id: "deny", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies` };
    const { envelopes, issues } = await collect(adapter, input, contextFor(adapter, { allowedHosts: [] }));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_ALLOWLIST_REFUSED"));
    assert.equal(stub.hits.length, before, "refused requests must never hit the network");

    const other = await collect(adapter, input, contextFor(adapter, { allowedHosts: ["pacs.example.org"] }));
    assert.equal(other.envelopes.length, 0);
    assert.ok(codes(other.issues).includes("DICOMWEB_ALLOWLIST_REFUSED"));
    assert.equal(stub.hits.length, before);
  });

  test("parse() refuses non-http(s) schemes", async () => {
    const adapter = new DicomWebAdapter();
    const { envelopes, issues } = await collect(
      adapter,
      { id: "scheme", uri: "ftp://127.0.0.1/dicomweb/studies" },
      contextFor(adapter, { allowedHosts: ["127.0.0.1"] }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_SCHEME_BLOCKED"));
  });

  test("parse() reports unknown URL shapes without network claims", async () => {
    const adapter = new DicomWebAdapter();
    const before = stub.hits.length;
    const { envelopes, issues } = await collect(
      adapter,
      { id: "unknown-op", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` },
      contextFor(adapter, { allowedHosts: ["127.0.0.1"] }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_UNKNOWN_OPERATION"));
    assert.equal(stub.hits.length, before);
  });

  test("parse() times out and keeps query values out of messages", async () => {
    const adapter = new DicomWebAdapter();
    const secret = "SuperSecretPatientValue";
    const input: InputDescriptor = {
      id: "timeout",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/slow?PatientName=${secret}`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 50, maxPages: 2 }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_TIMEOUT"));
    for (const issue of issues) {
      assert.ok(!issue.message.includes(secret), `timeout message leaks query value: ${issue.message}`);
      assert.equal(issue.offendingValue, undefined, "offendingValue must never carry request content");
    }
  });

  test("parse() reports HTTP errors with status only (no body, no query values)", async () => {
    const adapter = new DicomWebAdapter();
    const secret = "AnotherSecretValue";
    const input: InputDescriptor = {
      id: "boom",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/boom?PatientName=${secret}`,
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_HTTP_ERROR"));
    const message = issues.find((i) => i.code === "DICOMWEB_HTTP_ERROR")?.message ?? "";
    assert.ok(message.includes("500"), "status code is actionable and safe to include");
    assert.ok(!message.includes(secret), "error message must not carry query values");
    assert.ok(!message.includes("OperationOutcome"), "response bodies never appear in errors");
  });

  test("parse() reports invalid JSON, unexpected payloads and redirects without leaking bodies", async () => {
    const adapter = new DicomWebAdapter();
    const secret = "PayloadSecretValue";
    const opts = { allowedHosts: ["127.0.0.1"], timeoutMs: 5000 };
    const badJson = await collect(
      adapter,
      { id: "bad-json", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/badjson?PatientName=${secret}` },
      contextFor(adapter, opts),
    );
    assert.equal(badJson.envelopes.length, 0);
    assert.ok(codes(badJson.issues).includes("DICOMWEB_INVALID_JSON"));
    assert.ok(!badJson.issues[0].message.includes(secret));

    const obj = await collect(
      adapter,
      { id: "object", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/asobject` },
      contextFor(adapter, opts),
    );
    assert.equal(obj.envelopes.length, 0);
    assert.ok(codes(obj.issues).includes("DICOMWEB_UNEXPECTED_PAYLOAD"));

    const redir = await collect(
      adapter,
      { id: "redir", uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/redir` },
      contextFor(adapter, opts),
    );
    assert.equal(redir.envelopes.length, 0);
    assert.ok(codes(redir.issues).includes("DICOMWEB_REDIRECT_REFUSED"));
  });

  test("parse() without a URL reports an issue instead of throwing", async () => {
    const adapter = new DicomWebAdapter();
    const { envelopes, issues } = await collect(adapter, { id: "nourl" }, contextFor(adapter, {}));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("DICOMWEB_MISSING_URL"));
  });

  test("inspect() is network-free and redacts query values", async () => {
    const adapter = new DicomWebAdapter();
    const secret = "InspectSecretValue";
    const before = stub.hits.length;
    const inspection = await adapter.inspect({
      id: "inspect",
      uri: `http://127.0.0.1:${stub.port}/dicomweb/studies/1.2.3/series/1.2/instances/1.2.3/frames/1?PatientName=${secret}`,
    });
    assert.equal(stub.hits.length, before, "inspect must not open sockets");
    assert.equal(inspection.format, "dicomweb");
    assert.equal(inspection.domain, "imaging");
    assert.equal(inspection.status, "metadata-only");
    const text = (inspection.warnings ?? []).join("\n");
    assert.ok(!text.includes(secret), "inspect warnings must not carry query values");
    assert.ok(text.includes("values redacted"), "redaction is stated");
    assert.ok(text.includes("wado-frames"));
  });

  test("health() reports ok with a details string", async () => {
    const result = await new DicomWebAdapter().health();
    assert.equal(result.ok, true);
    assert.equal(typeof result.details, "string");
    assert.ok(result.details.includes(DICOMWEB_ADAPTER_ID));
  });

  test("SSRF helpers: allowlist normalisation, private hosts, redaction", async () => {
    assert.deepEqual(normalizeDicomWebAllowedHosts(["PACS.Example.org:443/path", "127.0.0.1", 42, ""]), [
      "pacs.example.org",
      "127.0.0.1",
    ]);
    assert.deepEqual(normalizeDicomWebAllowedHosts(undefined), []);
    assert.equal(isDicomWebPrivateHostLiteral("localhost"), true);
    assert.equal(isDicomWebPrivateHostLiteral("127.0.0.1"), true);
    assert.equal(isDicomWebPrivateHostLiteral("10.1.2.3"), true);
    assert.equal(isDicomWebPrivateHostLiteral("172.16.5.4"), true);
    assert.equal(isDicomWebPrivateHostLiteral("172.32.0.1"), false);
    assert.equal(isDicomWebPrivateHostLiteral("192.168.0.9"), true);
    assert.equal(isDicomWebPrivateHostLiteral("::1"), true);
    assert.equal(isDicomWebPrivateHostLiteral("pacs.example.org"), false);
    assert.equal(await isDicomWebPrivateHost("127.0.0.1"), true);
    assert.equal(await isDicomWebPrivateHost("localhost"), true);
    assert.equal(
      redactDicomWebUrlForLog("https://pacs.example.org/dicomweb/studies?PatientName=Secret&Modality=CT"),
      "https://pacs.example.org/dicomweb/studies?<query redacted>",
    );
    assert.equal(redactDicomWebUrlForLog("not a url"), "unparseable-url");
    assert.throws(() => assertDicomWebAllowedUrl("ftp://x/dicomweb/studies", ["x"]), /only http and https/);
    assert.throws(() => assertDicomWebAllowedUrl("https://evil.example/dicomweb/studies", []), /allowedHosts/);
  });

  test("DICOM JSON helpers extract identifiers without throwing", () => {
    const dataset = metadataDataset("1.2.3.1", "1.2.3.1.1", "1.2.3.1.1.1", "CT");
    assert.equal(dicomJsonFirstValue(dataset, "0020000D"), "1.2.3.1");
    assert.equal(dicomJsonFirstValue(dataset, "00080060"), "CT");
    assert.equal(dicomJsonFirstValue({}, "0020000D"), undefined);
    assert.equal(dicomJsonFirstValue(null, "0020000D"), undefined);
    assert.deepEqual(extractDicomWebIdentifiers(dataset), {
      studyInstanceUID: "1.2.3.1",
      seriesInstanceUID: "1.2.3.1.1",
      sopInstanceUID: "1.2.3.1.1.1",
      modality: "CT",
    });
    assert.deepEqual(uidsFromDicomWebPath("https://pacs.example/dicomweb/studies/1.2.3/series/1.4/instances/1.6"), {
      studyInstanceUID: "1.2.3",
      seriesInstanceUID: "1.4",
      sopInstanceUID: "1.6",
    });
    assert.deepEqual(uidsFromDicomWebPath("not a url"), {});
  });
});
