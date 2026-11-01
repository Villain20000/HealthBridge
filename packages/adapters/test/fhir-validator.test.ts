import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  FHIR_VALIDATOR_ADAPTER_ID,
  FHIR_VALIDATOR_ADAPTER_VERSION,
  FHIR_VALIDATOR_ENV_URL,
  FhirValidatorError,
  FhirValidatorFormatAdapter,
  assertFhirValidatorAllowedUrl,
  clampFhirValidatorTimeoutMs,
  parseFhirValidatorOutcome,
  resolveFhirValidatorEndpoint,
  resolveValidateUrl,
  validateResourceWithExternalValidator,
} from "../src/fhir-validator.js";
import { runAdapterConformance } from "../src/kit.js";
import type { MedicalFormatAdapter } from "@healthbridge/core";
import type { InputDescriptor, MedicalDataEnvelope, ParseContext, ValidationIssue } from "@healthbridge/shared-types";

// ---------------------------------------------------------------------------
// In-process loopback HTTP stub (no external network; 127.0.0.1 only).
// Speaks the documented validate protocol: POST a resource, answer with an
// OperationOutcome. `{"id":"bad-*"}` resources get one simulated error.
// ---------------------------------------------------------------------------

interface StubState {
  server: http.Server;
  port: number;
  hits: Array<{ method?: string; url: string; body: string }>;
}

let stub: StubState;

function outcome(issues: Array<Record<string, unknown>>): string {
  return JSON.stringify({ resourceType: "OperationOutcome", issue: issues });
}

function startStub(): Promise<StubState> {
  const state = { server: undefined as unknown as http.Server, port: 0, hits: [] as StubState["hits"] };
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      state.hits.push({ method: req.method, url: rawUrl, body });
      const json = (status: number, text: string): void => {
        res.writeHead(status, { "Content-Type": "application/fhir+json" });
        res.end(text);
      };
      if (req.method !== "POST") {
        json(405, outcome([{ severity: "error", code: "processing", diagnostics: "stub expects POST" }]));
        return;
      }
      if (url.pathname.startsWith("/slow")) {
        setTimeout(() => json(200, outcome([])), 400);
        return;
      }
      if (url.pathname.startsWith("/boom")) {
        json(500, outcome([{ severity: "error", code: "processing", diagnostics: "simulated fire" }]));
        return;
      }
      if (url.pathname.startsWith("/not-outcome")) {
        json(200, JSON.stringify({ resourceType: "Patient", id: "p1" }));
        return;
      }
      if (!url.pathname.endsWith("/$validate")) {
        json(404, outcome([{ severity: "error", code: "not-found", diagnostics: "stub: not a $validate URL" }]));
        return;
      }
      let resource: Record<string, unknown> = {};
      try {
        resource = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json(400, outcome([{ severity: "error", code: "invalid", diagnostics: "stub: body is not JSON" }]));
        return;
      }
      if (typeof resource.id === "string" && resource.id.startsWith("bad-")) {
        json(
          200,
          outcome([
            {
              severity: "error",
              code: "invalid",
              diagnostics: "simulated: Observation.status is missing",
              expression: ["Observation.status"],
            },
          ]),
        );
        return;
      }
      json(200, outcome([]));
    });
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

function withCleanEnv(body: () => void | Promise<void>): () => void | Promise<void> {
  return async () => {
    const saved = process.env[FHIR_VALIDATOR_ENV_URL];
    delete process.env[FHIR_VALIDATOR_ENV_URL];
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env[FHIR_VALIDATOR_ENV_URL];
      else process.env[FHIR_VALIDATOR_ENV_URL] = saved;
    }
  };
}

describe("fhir-validator adapter", () => {
  before(async () => {
    stub = await startStub();
  });

  after(() => {
    stub.server.close();
  });

  test("satisfies the shared conformance contract with zero failures", async () => {
    const failures = await runAdapterConformance(new FhirValidatorFormatAdapter());
    assert.deepEqual(failures, []);
  });

  test("manifest is honestly metadata-only with no FHIR transform claim", () => {
    const manifest = new FhirValidatorFormatAdapter().getManifest();
    assert.equal(manifest.format, "fhir-validator");
    assert.equal(manifest.status, "metadata-only");
    assert.equal(manifest.capabilities.transformToFHIR, false);
    assert.equal(manifest.capabilities.transformMetadataToFHIR, false);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.equal(new FhirValidatorFormatAdapter().id, FHIR_VALIDATOR_ADAPTER_ID);
    assert.equal(new FhirValidatorFormatAdapter().version, FHIR_VALIDATOR_ADAPTER_VERSION);
  });

  test("unconfigured state reports skipped-with-reason, never a pass", withCleanEnv(async () => {
    const result = await validateResourceWithExternalValidator({ resourceType: "Patient", id: "p1" }, { allowedHosts: [] });
    assert.equal(result.status, "skipped");
    assert.equal(result.isValid, false, "a skip must never read as a pass");
    assert.ok(result.reason?.includes(FHIR_VALIDATOR_ENV_URL));
    assert.ok(codes(result.issues).includes("FHIR_VALIDATOR_SKIPPED"));

    const adapter = new FhirValidatorFormatAdapter();
    const { envelopes, issues } = await collect(
      adapter,
      { id: "v-missing", contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }) },
      contextFor(adapter, { allowedHosts: ["127.0.0.1"] }),
    );
    assert.equal(envelopes.length, 0, "skipped validations yield no envelopes");
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_SKIPPED"));
  }));

  test("endpoint resolves from the environment and options win over env", withCleanEnv(async () => {
    assert.equal(resolveFhirValidatorEndpoint({}), undefined);
    process.env[FHIR_VALIDATOR_ENV_URL] = "https://validator.example.org/fhir";
    assert.equal(resolveFhirValidatorEndpoint({}), "https://validator.example.org/fhir");
    assert.equal(
      resolveFhirValidatorEndpoint({ endpoint: "https://other.example.org/fhir" }),
      "https://other.example.org/fhir",
    );
    assert.equal(resolveValidateUrl("https://validator.example.org/fhir"), "https://validator.example.org/fhir/$validate");
    assert.equal(resolveValidateUrl("https://validator.example.org/fhir/"), "https://validator.example.org/fhir/$validate");
    assert.equal(
      resolveValidateUrl("https://validator.example.org/fhir/$validate"),
      "https://validator.example.org/fhir/$validate",
    );
  }));

  test("validate protocol POSTs the resource and parses the OperationOutcome", async () => {
    const base = `http://127.0.0.1:${stub.port}/fhir`;
    const before = stub.hits.length;
    const valid = await validateResourceWithExternalValidator(
      { resourceType: "Patient", id: "p1" },
      { endpoint: base, allowedHosts: ["127.0.0.1"], timeoutMs: 5000 },
    );
    assert.equal(valid.status, "validated");
    assert.equal(valid.isValid, true);
    // Loopback was explicitly allowlisted, so the logged notice travels with
    // the result (mirrors fhir-rest); the validator itself reported no issues.
    assert.deepEqual(
      valid.issues.filter((i) => i.code !== "FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED"),
      [],
    );
    assert.ok(codes(valid.issues).includes("FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED"));
    assert.ok(valid.endpoint?.includes("127.0.0.1"));

    const posted = stub.hits.slice(before).find((hit) => hit.url.endsWith("/$validate"));
    assert.ok(posted, "the client must POST to the $validate operation URL");
    assert.equal(posted?.method, "POST");
    assert.deepEqual(JSON.parse(posted?.body ?? ""), { resourceType: "Patient", id: "p1" });

    const invalid = await validateResourceWithExternalValidator(
      { resourceType: "Observation", id: "bad-1", status: "final" },
      { endpoint: base, allowedHosts: ["127.0.0.1"], timeoutMs: 5000 },
    );
    assert.equal(invalid.status, "validated");
    assert.equal(invalid.isValid, false);
    assert.ok(codes(invalid.issues).includes("EXTERNAL_INVALID"));
    const flagged = invalid.issues.find((i) => i.code === "EXTERNAL_INVALID");
    assert.equal(flagged?.severity, "error");
    assert.match(flagged?.message ?? "", /simulated/);
    assert.equal(flagged?.path, "Observation.status");
  });

  test("parse() carries the verdict on one structural envelope", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const base = `http://127.0.0.1:${stub.port}/fhir`;
    const { envelopes, issues } = await collect(
      adapter,
      { id: "v-ok", contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }) },
      contextFor(adapter, { endpoint: base, allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].id, "p1");
    assert.equal(envelopes[0].source.format, "fhir-validator");
    assert.equal(envelopes[0].source.formatVersion, "4.0.1");
    assert.ok(envelopes[0].source.checksum?.startsWith("sha256:"));
    assert.equal((envelopes[0].metadata as Record<string, unknown>).validated, true);
    assert.equal((envelopes[0].metadata as Record<string, unknown>).validatorHost, "127.0.0.1");
    assert.equal(issues.length, 1, "only the loopback allowlist notice is expected");
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_PRIVATE_HOST_ALLOWED"));

    const bad = await collect(
      adapter,
      { id: "v-bad", contentString: JSON.stringify({ resourceType: "Observation", id: "bad-2" }) },
      contextFor(adapter, { endpoint: base, allowedHosts: ["127.0.0.1"], timeoutMs: 5000 }),
    );
    assert.equal(bad.envelopes.length, 1, "invalid resources are still carried; the verdict travels in issues + metadata");
    assert.equal((bad.envelopes[0].metadata as Record<string, unknown>).validated, false);
    assert.ok(codes(bad.issues).includes("EXTERNAL_INVALID"));
  });

  test("parse() refuses non-allowlisted hosts (default-deny) without network", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const base = `http://127.0.0.1:${stub.port}/fhir`;
    const before = stub.hits.length;
    const input: InputDescriptor = {
      id: "v-deny",
      contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
    };
    const { envelopes, issues } = await collect(adapter, input, contextFor(adapter, { endpoint: base }));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_ALLOWLIST_REFUSED"));
    assert.equal(stub.hits.length, before, "refused requests must never hit the network");
  });

  test("parse() refuses non-http(s) schemes", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const { envelopes, issues } = await collect(
      adapter,
      { id: "v-scheme", contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }) },
      contextFor(adapter, { endpoint: "ftp://127.0.0.1/fhir", allowedHosts: ["127.0.0.1"] }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_SCHEME_BLOCKED"));
  });

  test("parse() times out and keeps query values out of messages", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const secret = "SuperSecretValidatorValue";
    const input: InputDescriptor = {
      id: "v-timeout",
      contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, {
        endpoint: `http://127.0.0.1:${stub.port}/slow?name=${secret}`,
        allowedHosts: ["127.0.0.1"],
        timeoutMs: 50,
      }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_TIMEOUT"));
    for (const issue of issues) {
      assert.ok(!issue.message.includes(secret), `timeout message leaks query value: ${issue.message}`);
    }
  });

  test("parse() reports HTTP errors with status only (no body, no query values)", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const secret = "AnotherValidatorSecret";
    const input: InputDescriptor = {
      id: "v-boom",
      contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }),
    };
    const { envelopes, issues } = await collect(
      adapter,
      input,
      contextFor(adapter, {
        endpoint: `http://127.0.0.1:${stub.port}/boom?name=${secret}`,
        allowedHosts: ["127.0.0.1"],
        timeoutMs: 5000,
      }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_HTTP_ERROR"));
    const message = issues.find((i) => i.code === "FHIR_VALIDATOR_HTTP_ERROR")?.message ?? "";
    assert.ok(message.includes("500"), "status code is actionable and safe to include");
    assert.ok(!message.includes(secret), "error message must not carry query values");
  });

  test("parse() maps non-OperationOutcome 200 payloads to an explicit issue", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const { envelopes, issues } = await collect(
      adapter,
      { id: "v-payload", contentString: JSON.stringify({ resourceType: "Patient", id: "p1" }) },
      contextFor(adapter, {
        endpoint: `http://127.0.0.1:${stub.port}/not-outcome`,
        allowedHosts: ["127.0.0.1"],
        timeoutMs: 5000,
      }),
    );
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_UNEXPECTED_PAYLOAD"));
  });

  test("parse() without a resource reports an issue instead of throwing", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const { envelopes, issues } = await collect(adapter, { id: "v-nores" }, contextFor(adapter, {}));
    assert.equal(envelopes.length, 0);
    assert.ok(codes(issues).includes("FHIR_VALIDATOR_MISSING_RESOURCE"));

    const malformed = await collect(
      adapter,
      { id: "v-malformed", contentString: "{nope" },
      contextFor(adapter, {}),
    );
    assert.equal(malformed.envelopes.length, 0);
    assert.ok(codes(malformed.issues).includes("FHIR_VALIDATOR_INVALID_JSON"));
  });

  test("detect() never claims payloads; score() always 0 without throwing", async () => {
    const adapter = new FhirValidatorFormatAdapter();
    assert.equal(await adapter.score({ id: "s", contentString: JSON.stringify({ resourceType: "Patient" }) }), 0);
    assert.equal(await adapter.score({ id: "s", uri: `http://127.0.0.1:${stub.port}/fhir/Patient` }), 0);
    assert.equal(await adapter.detect({ id: "s", contentString: JSON.stringify({ resourceType: "Patient" }) }), false);
  });

  test("inspect() is network-free and states the skip when unconfigured", withCleanEnv(async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const before = stub.hits.length;
    const inspection = await adapter.inspect({
      id: "v-inspect",
      contentString: JSON.stringify({ resourceType: "Observation", id: "o1" }),
    });
    assert.equal(stub.hits.length, before, "inspect must not open sockets");
    assert.equal(inspection.format, "fhir-validator");
    assert.equal(inspection.domain, "clinical");
    assert.equal(inspection.status, "metadata-only");
    const text = (inspection.warnings ?? []).join("\n");
    assert.ok(text.includes("skipped"), "unconfigured inspect must state the skip");
    assert.ok(text.includes(FHIR_VALIDATOR_ENV_URL));
  }));

  test("health() reports ready-but-idle, misconfiguration, and ready states", withCleanEnv(async () => {
    const adapter = new FhirValidatorFormatAdapter();
    const idle = await adapter.health();
    assert.equal(idle.ok, true);
    assert.ok(idle.details.includes(FHIR_VALIDATOR_ENV_URL));

    process.env[FHIR_VALIDATOR_ENV_URL] = "not a url";
    const bad = await adapter.health();
    assert.equal(bad.ok, false);

    process.env[FHIR_VALIDATOR_ENV_URL] = "gopher://example.org/fhir";
    const scheme = await adapter.health();
    assert.equal(scheme.ok, false);

    process.env[FHIR_VALIDATOR_ENV_URL] = `http://127.0.0.1:${stub.port}/fhir?token=SecretValue`;
    const ready = await adapter.health();
    assert.equal(ready.ok, true);
    assert.ok(ready.details.includes("127.0.0.1"));
    assert.ok(!ready.details.includes("SecretValue"), "health details must not echo query values");
  }));

  test("outcome parsing maps severities, codes and expression paths", () => {
    const empty = parseFhirValidatorOutcome({ resourceType: "OperationOutcome" });
    assert.equal(empty.isValid, true);
    assert.deepEqual(empty.issues, []);

    const mapped = parseFhirValidatorOutcome({
      resourceType: "OperationOutcome",
      issue: [
        { severity: "error", code: "invalid", diagnostics: "bad status", expression: ["Observation.status"] },
        { severity: "warning", code: "not-found", details: { text: "profile missing" } },
      ],
    });
    assert.equal(mapped.isValid, false);
    assert.deepEqual(
      mapped.issues.map((i) => i.code),
      ["EXTERNAL_INVALID", "EXTERNAL_NOT_FOUND"],
    );
    assert.equal(mapped.issues[0].path, "Observation.status");
    assert.equal(mapped.issues[1].message, "profile missing");

    assert.throws(
      () => parseFhirValidatorOutcome({ resourceType: "Patient" }),
      (error: unknown) => error instanceof FhirValidatorError,
    );
    assert.throws(
      () => parseFhirValidatorOutcome(null),
      (error: unknown) =>
        error instanceof FhirValidatorError && error.code === "FHIR_VALIDATOR_UNEXPECTED_PAYLOAD",
    );
  });

  test("SSRF helpers: allowlist enforcement, timeout clamping", () => {
    assert.throws(
      () => assertFhirValidatorAllowedUrl("https://evil.example/fhir/$validate", []),
      (error: unknown) => error instanceof FhirValidatorError && error.code === "FHIR_VALIDATOR_ALLOWLIST_REFUSED",
    );
    assert.throws(
      () => assertFhirValidatorAllowedUrl("ftp://x/fhir/$validate", ["x"]),
      (error: unknown) => error instanceof FhirValidatorError && error.code === "FHIR_VALIDATOR_SCHEME_BLOCKED",
    );
    assert.throws(
      () => assertFhirValidatorAllowedUrl("not a url", []),
      (error: unknown) => error instanceof FhirValidatorError && error.code === "FHIR_VALIDATOR_INVALID_URL",
    );
    assert.ok(assertFhirValidatorAllowedUrl("https://validator.example.org/fhir/$validate", ["validator.example.org"]));
    assert.equal(clampFhirValidatorTimeoutMs(undefined), 8000);
    assert.equal(clampFhirValidatorTimeoutMs(0), 8000);
    assert.equal(clampFhirValidatorTimeoutMs(999999), 120000);
  });
});
