import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { HealthBridge } from "@healthbridge/sdk";
import { loadConfig, loadTestConfig } from "../src/config.js";
import { normaliseAndValidate } from "../src/common/mapping-spec.js";
import { fixture, fixtureJson, startApi, type ApiClient, type TestApi } from "./harness.js";

/**
 * Mapping preview over HTTP: the response bounds, the "no side effects" rule,
 * the exact audit metadata, scope/limit enforcement and CORS preflight.
 */

interface PreviewBody {
  validation: { isValid: boolean; issues: unknown[] };
  preview: {
    adapter: { id: string; version: string; format: string };
    recordsProcessed: number;
    recordsSucceeded: number;
    recordsRejected: number;
    issues: unknown[];
    rejected: Array<Record<string, unknown>>;
    sample: unknown[];
    validation: { isValid: boolean };
    truncated: boolean;
    omitted: string[];
    bytes: number;
  };
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  statusCode: number;
}

interface AuditBody {
  events: Array<{ action: string; targetId?: string; metadata?: Record<string, unknown> }>;
}

const PREVIEW_PATH = "/api/v1/mappings/preview";
const FIXTURE_SPEC = ["scenarios", "01-hospital-patient-migration", "mapping", "patient.json"];
const FIXTURE_CSV = ["scenarios", "01-hospital-patient-migration", "data", "patients.csv"];

async function provision(api: TestApi, slug: string): Promise<ApiClient> {
  const response = await api
    .client()
    .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
      body: { name: `Preview ${slug}`, slug },
      headers: { "x-bootstrap-token": "test-bootstrap-token" },
    });
  assert.equal(response.status, 201, response.raw);
  return api.client(response.body.apiKey.key);
}

async function uploadCsv(
  owner: ApiClient,
  filename = "patients.csv",
  bytes: Buffer = fixture(...FIXTURE_CSV),
): Promise<{ id: string; sizeBytes: number }> {
  const response = await owner.request<{ asset: { id: string; sizeBytes: number } }>(
    "POST",
    `/api/v1/assets?filename=${filename}`,
    { raw: bytes, headers: { "content-type": "text/csv" } },
  );
  assert.equal(response.status, 201, response.raw);
  return response.body.asset;
}

describe("mapping preview API", () => {
  let api: TestApi;
  let owner: ApiClient;
  let asset: { id: string; sizeBytes: number };
  let spec: Record<string, unknown>;

  before(async () => {
    api = await startApi();
    owner = await provision(api, "preview-clinic");
    spec = fixtureJson<Record<string, unknown>>(...FIXTURE_SPEC);
    asset = await uploadCsv(owner);
  });

  after(async () => {
    await api.close();
  });

  it("reports the effective preview limits from healthz", async () => {
    const health = await api.client().request<{
      limits: { maxPreviewRecords: number; maxPreviewBytes: number; maxPreviewInputBytes: number };
    }>("GET", "/api/v1/healthz");

    assert.equal(health.status, 200, health.raw);
    assert.equal(health.body.limits.maxPreviewRecords, 25);
    assert.equal(health.body.limits.maxPreviewBytes, 524288);
    assert.equal(health.body.limits.maxPreviewInputBytes, 8388608);
  });

  it("previews the CSV with a record bound and bounded lists", async () => {
    const response = await owner.request<PreviewBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, maxRecords: 2 },
    });

    assert.equal(response.status, 200, response.raw);
    assert.equal(response.body.preview.recordsProcessed, 2);
    assert.equal(response.body.preview.recordsSucceeded, 2);
    assert.equal(response.body.preview.recordsRejected, 0);
    assert.ok(response.body.preview.sample.length <= 10);
    assert.equal(response.body.preview.adapter.id, "csv-adapter");
    assert.equal(response.body.preview.adapter.format, "csv");
    assert.equal(response.body.validation.isValid, true);
    assert.equal(response.body.preview.validation.isValid, true);
    assert.deepEqual(response.body.preview.omitted, []);
    assert.equal(response.body.preview.truncated, false);
    assert.ok(response.body.preview.bytes > 0);
  });

  it("rejects records, strips partialOutput (R16) and caps the rejected list (R24)", async () => {
    // R16: rejected records are returned without their best-effort partial target.
    // R24: recordsRejected is the true count while only 10 rejected records are returned.
    const header = "patient_id,family_name,given_name,sex,birth_date,mrn,city";
    const rows = Array.from(
      { length: 12 },
      (_, index) => `,Family${index + 1},Given${index + 1},female,1990-02-17,MRN-${9000 + index + 1},City${index + 1}`,
    );
    const bytes = Buffer.from(`${header}\n${rows.join("\n")}\n`, "utf-8");
    const rejectingAsset = await uploadCsv(owner, "rejected-patients.csv", bytes);

    // The engine's target validation only reports issues it actually found, and the
    // scenario mapping's clean partial targets produce none. Add one rule that writes
    // an invalid FHIR gender so preview.issues is populated as well as rejected[].issues.
    const rejectingSpec = structuredClone(spec) as {
      rules: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    rejectingSpec.rules.push({
      id: "r9",
      sourcePath: "__constant.gender",
      targetPath: "gender",
      transform: "default_value",
      defaultValue: "not-a-gender-code",
    });

    // Non-vacuity guard: the engine rejects every row with a populated partialOutput,
    // so the absence of partialOutput in the HTTP response is the service's strip.
    const definition = normaliseAndValidate(rejectingSpec).definition;
    assert.ok(definition, "the rejecting preview spec must be valid");
    const engineResult = await new HealthBridge({ keepRunsInMemory: false }).transform({
      input: {
        id: rejectingAsset.id,
        filename: "rejected-patients.csv",
        mimeType: "text/csv",
        buffer: bytes,
        sizeBytes: bytes.byteLength,
      },
      mapping: definition,
      adapterId: "csv-adapter",
      maxRecords: 100,
    });
    const engineRejected = engineResult.rejectedRecords[0];
    assert.ok(engineRejected, "the engine must reject the synthetic rows");
    assert.ok(
      Object.keys(engineRejected.partialOutput).length > 0,
      "the engine partialOutput must be non-empty before the service strips it",
    );

    const response = await owner.request<PreviewBody>("POST", PREVIEW_PATH, {
      body: { spec: rejectingSpec, assetId: rejectingAsset.id, maxRecords: 100 },
    });

    assert.equal(response.status, 200, response.raw);
    assert.equal(response.body.preview.recordsProcessed, 12);
    assert.equal(response.body.preview.recordsSucceeded, 0);
    assert.equal(response.body.preview.recordsRejected, 12);
    assert.equal(response.body.preview.rejected.length, 10);
    assert.equal(response.body.preview.omitted.includes("rejected"), false);
    assert.ok(response.body.preview.issues.length > 0, "blocking issues must be reported");
    for (const entry of response.body.preview.rejected) {
      assert.equal(Object.hasOwn(entry, "partialOutput"), false, "partialOutput must be stripped");
      assert.ok(Array.isArray(entry.issues) && entry.issues.length > 0, "each rejection must carry issues");
    }
    assert.deepEqual(response.body.preview.sample, []);
  });

  it("does not create run or asset rows", async () => {
    const runsBefore = await owner.request<{ runs: unknown[] }>("GET", "/api/v1/runs");
    const assetsBefore = await owner.request<{ assets: unknown[] }>("GET", "/api/v1/assets");

    const response = await owner.request<PreviewBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, maxRecords: 1 },
    });
    assert.equal(response.status, 200, response.raw);

    const runsAfter = await owner.request<{ runs: unknown[] }>("GET", "/api/v1/runs");
    const assetsAfter = await owner.request<{ assets: unknown[] }>("GET", "/api/v1/assets");
    assert.equal(runsAfter.body.runs.length, runsBefore.body.runs.length);
    assert.equal(assetsAfter.body.assets.length, assetsBefore.body.assets.length);
  });

  it("audits only bounded metadata, never the spec or output values", async () => {
    const response = await owner.request<PreviewBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, maxRecords: 1 },
    });
    assert.equal(response.status, 200, response.raw);

    const audit = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(audit.status, 200, audit.raw);
    const event = audit.body.events.find(
      (entry) => entry.action === "mapping.previewed" && entry.targetId === asset.id,
    );
    assert.ok(event, "a successful preview must be audited against the asset");
    const metadata = event.metadata ?? {};
    assert.deepEqual(Object.keys(metadata).sort(), [
      "adapterId",
      "assetId",
      "bytes",
      "maxRecords",
      "recordsFailed",
      "recordsProcessed",
      "rules",
      "truncated",
    ]);

    const serialised = JSON.stringify(metadata);
    for (const value of [
      "hospital-patient-to-fhir",
      "Hospital CSV Patient to FHIR R4 Patient",
      "Okonkwo",
      "Chidi",
      "MRN-1001",
      "H001",
    ]) {
      assert.equal(serialised.includes(value), false, `audit metadata must not contain ${value}`);
    }
  });

  it("does not audit a failed preview (R20)", async () => {
    const auditBefore = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(auditBefore.status, 200, auditBefore.raw);
    const countBefore = auditBefore.body.events.filter((entry) => entry.action === "mapping.previewed").length;

    const invalid = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec: { rules: "nope" }, assetId: asset.id },
    });
    assert.equal(invalid.status, 422, invalid.raw);

    const missing = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: "as_missing" },
    });
    assert.equal(missing.status, 404, missing.raw);

    const auditAfter = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(auditAfter.status, 200, auditAfter.raw);
    const countAfter = auditAfter.body.events.filter((entry) => entry.action === "mapping.previewed").length;
    assert.equal(countAfter, countBefore, "only a successful preview is audited");
  });

  it("validates the spec before looking up the asset", async () => {
    const response = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec: { rules: "nope" }, assetId: "as_does_not_exist" },
    });

    assert.equal(response.status, 422, response.raw);
    assert.equal(response.body.error.code, "MAPPING_VALIDATION_FAILED");
    const issues = (response.body.error.details as { issues?: unknown[] }).issues;
    assert.ok(Array.isArray(issues) && issues.length > 0);
  });

  it("rejects an unknown explicit adapter", async () => {
    const response = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, adapterId: "not-an-adapter" },
    });

    // VALIDATION_FAILED is a 400 in this API's closed error-code table.
    assert.equal(response.status, 400, response.raw);
    assert.equal(response.body.error.code, "VALIDATION_FAILED");
    assert.equal((response.body.error.details as { reason?: string }).reason, "UNKNOWN_ADAPTER");
  });

  it("keeps assets tenant-scoped", async () => {
    const missing = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: "as_missing" },
    });
    assert.equal(missing.status, 404, missing.raw);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    const stranger = await provision(api, "preview-other");
    const foreignAsset = await uploadCsv(stranger, "other.csv");
    const foreign = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: foreignAsset.id },
    });
    assert.equal(foreign.status, 404, foreign.raw);
    assert.equal(foreign.body.error.code, "NOT_FOUND");
  });

  it("clamps oversized maxRecords and rejects zero", async () => {
    const accepted = await owner.request<PreviewBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, maxRecords: 1000 },
    });
    assert.equal(accepted.status, 200, accepted.raw);

    const audit = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    const event = audit.body.events.find(
      (entry) =>
        entry.action === "mapping.previewed" && entry.targetId === asset.id && entry.metadata?.maxRecords === 25,
    );
    assert.ok(event, "the audit records the effective (clamped) record bound");

    const zero = await owner.request<ErrorBody>("POST", PREVIEW_PATH, {
      body: { spec, assetId: asset.id, maxRecords: 0 },
    });
    assert.equal(zero.status, 400, zero.raw);
    assert.equal(zero.body.error.code, "VALIDATION_FAILED");
  });

  it("rejects an asset over the preview input limit with 413", async () => {
    const limited = await startApi({
      limits: { ...loadTestConfig().limits, maxPreviewInputBytes: 10 },
    });
    try {
      const limitedOwner = await provision(limited, "preview-input-limit");
      const limitedAsset = await uploadCsv(limitedOwner);
      const response = await limitedOwner.request<ErrorBody>("POST", PREVIEW_PATH, {
        body: { spec, assetId: limitedAsset.id },
      });

      assert.equal(response.status, 413, response.raw);
      assert.equal(response.body.error.code, "PAYLOAD_TOO_LARGE");
      assert.match(response.body.error.message, /preview input limit/);
    } finally {
      await limited.close();
    }
  });

  it("drops the sample and marks the response truncated over the byte limit", async () => {
    const limited = await startApi({
      limits: { ...loadTestConfig().limits, maxPreviewBytes: 10 },
    });
    try {
      const limitedOwner = await provision(limited, "preview-byte-limit");
      const limitedAsset = await uploadCsv(limitedOwner);
      const response = await limitedOwner.request<PreviewBody>("POST", PREVIEW_PATH, {
        body: { spec, assetId: limitedAsset.id },
      });

      assert.equal(response.status, 200, response.raw);
      assert.equal(response.body.preview.truncated, true);
      assert.ok(response.body.preview.omitted.includes("sample"));
      assert.ok(response.body.preview.bytes > 0);
    } finally {
      await limited.close();
    }
  });

  it("allows PUT in CORS preflight responses", async () => {
    const corsApi = await startApi({ corsOrigins: ["http://console.test"] });
    try {
      const response = await corsApi.client().request("OPTIONS", "/api/v1/mappings/x/draft", {
        headers: {
          origin: "http://console.test",
          "access-control-request-method": "PUT",
        },
      });

      assert.equal(response.status, 204, response.raw);
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /PUT/);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://console.test");
    } finally {
      await corsApi.close();
    }
  });

  it("clamps and defaults maxPreviewRecords at config load", () => {
    const baseEnv = {
      NODE_ENV: "test",
      HEALTHBRIDGE_KEY_PEPPER: "test-pepper-at-least-16-chars",
      HEALTHBRIDGE_BOOTSTRAP_TOKEN: "test-bootstrap-token",
    } as NodeJS.ProcessEnv;

    assert.equal(loadConfig(baseEnv).limits.maxPreviewRecords, 25);
    assert.equal(
      loadConfig({ ...baseEnv, HEALTHBRIDGE_MAX_PREVIEW_RECORDS: "1000" } as NodeJS.ProcessEnv).limits
        .maxPreviewRecords,
      100,
    );
  });
});
