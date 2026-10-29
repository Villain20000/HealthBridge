/**
 * Seed data for the end-to-end suite.
 *
 * Everything is created through the public API at the start of a run: a workspace, two CSV
 * assets, a mapping and a completed run. Tests therefore assert against data the server really
 * produced — there is no fixture JSON on disk describing a UI that was never called.
 *
 * Output: `apps/web/e2e/.state.json` (workspace key, ids, base URL), read-only for the specs.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_FILE = join(import.meta.dirname, "..", ".state.json");

const BASE = process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:4400";
const BOOTSTRAP = process.env["E2E_BOOTSTRAP_TOKEN"] ?? "e2e-bootstrap-token";

const MAPPING_SPEC = {
  id: "e2e-patient",
  name: "E2E CSV Patient to FHIR R4 Patient",
  version: "1.0.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  targetResourceType: "Patient",
  sourceDomains: ["clinical"],
  rules: [
    { id: "r1", sourcePath: "patient_id", targetPath: "id", transform: "identity", required: true },
    {
      id: "r2",
      sourcePath: "__constant.resourceType",
      targetPath: "resourceType",
      transform: "default_value",
      defaultValue: "Patient",
    },
    { id: "r3", sourcePath: "family_name", targetPath: "name.0.family", transform: "identity" },
    { id: "r4", sourcePath: "given_name", targetPath: "name.0.given.0", transform: "trim" },
    { id: "r5", sourcePath: "sex", targetPath: "gender", transform: "format_gender_fhir" },
    { id: "r6", sourcePath: "birth_date", targetPath: "birthDate", transform: "parse_date_iso" },
  ],
};

function patientsCsv(rows) {
  const header = "patient_id,family_name,given_name,sex,birth_date";
  const lines = [];
  for (let index = 0; index < rows; index += 1) {
    const n = String(index + 1).padStart(4, "0");
    lines.push(
      `E2E${n},Family${n},Given${n},${index % 2 === 0 ? "female" : "male"},19${(60 + (index % 30)).toString().slice(-2)}-01-15`,
    );
  }
  return `${header}\n${lines.join("\n")}\n`;
}

async function call(path, { method = "GET", body, key, headers = {}, raw } = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(key ? { "x-api-key": key } : {}),
      ...(raw ? { "content-type": raw } : body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  return { payload, headers: response.headers };
}

async function waitForRun(key, runId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { payload } = await call(`/runs/${runId}`, { key });
    const run = payload.run;
    if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not finish within ${timeoutMs} ms`);
}

async function main() {
  const slug = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { payload: created } = await call("/workspaces", {
    method: "POST",
    body: { name: "E2E Clinic", slug },
    headers: { "x-bootstrap-token": BOOTSTRAP },
  });
  const key = created.apiKey.key;
  const workspace = created.workspace;

  const { payload: mainAsset } = await call("/assets?filename=patients.csv", {
    method: "POST",
    key,
    raw: "text/csv",
    body: patientsCsv(24),
  });

  const { payload: emptyAsset } = await call("/assets?filename=tiny.csv", {
    method: "POST",
    key,
    raw: "text/csv",
    body: "patient_id,family_name,given_name,sex,birth_date\n",
  });

  const { payload: mapping } = await call("/mappings", {
    method: "POST",
    key,
    body: { name: `e2e-patient-${slug}`, spec: MAPPING_SPEC, targetResourceType: "Patient" },
  });

  const { payload: submitted } = await call("/runs", {
    method: "POST",
    key,
    headers: { "idempotency-key": `seed-${slug}` },
    body: { assetId: mainAsset.asset.id, mappingId: mapping.mapping.id },
  });
  const run = await waitForRun(key, submitted.run.id);

  const { payload: secondRunSubmitted } = await call("/runs", {
    method: "POST",
    key,
    headers: { "idempotency-key": `seed-second-${slug}` },
    body: { assetId: emptyAsset.asset.id, mappingId: mapping.mapping.id },
  });
  const secondRun = await waitForRun(key, secondRunSubmitted.run.id);

  const { payload: secondKey } = await call("/keys", {
    method: "POST",
    key,
    headers: { "idempotency-key": `seed-key-${slug}` },
    body: { name: `e2e-viewer-${slug}`, role: "viewer", ttlDays: 1 },
  });

  const state = {
    baseUrl: BASE,
    slug,
    workspace,
    key,
    viewerKey: secondKey.key,
    viewerKeyId: secondKey.apiKey.id,
    assetId: mainAsset.asset.id,
    emptyAssetId: emptyAsset.asset.id,
    mappingId: mapping.mapping.id,
    mappingName: mapping.mapping.name,
    runId: run.id,
    runStatus: run.status,
    secondRunId: secondRun.id,
    secondRunStatus: secondRun.status,
    idempotencyKey: `seed-${slug}`,
    patientRows: 24,
  };

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.stdout.write(`seeded workspace ${slug} · run ${run.id} (${run.status}) · ${BASE}\n`);
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
