/**
 * Seed data for the end-to-end suite.
 *
 * Everything is created through the public API at the start of a run: a workspace, two CSV
 * assets, two mappings (one reserved for the editor specs), a second version of the run mapping
 * with one extra rule (so the editor's v1→v2 diff compares real published versions) and two
 * completed runs. Tests therefore assert against data the server really produced — there is no
 * fixture JSON on disk describing a UI that was never called.
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

/** The run mapping's second published version: same spec plus one extra rule. */
const MAPPING_V2_SPEC = {
  ...MAPPING_SPEC,
  version: "1.0.1",
  rules: [
    ...MAPPING_SPEC.rules,
    { id: "r7", sourcePath: "given_name", targetPath: "name.0.given.1", transform: "uppercase" },
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

  // A separate mapping for the editor specs: they save drafts and publish new versions, which
  // must not change the mapping that the run and debugger specs read.
  const editorName = `e2e-editor-${slug}`;
  const { payload: editorMapping } = await call("/mappings", {
    method: "POST",
    key,
    body: {
      name: editorName,
      spec: { ...MAPPING_SPEC, id: "e2e-editor", name: "E2E Editor Patient Mapping" },
      targetResourceType: "Patient",
    },
  });

  // A second version of the run mapping, under the same name, so the editor's version diff
  // compares two real published versions. The runs below still pin the v1 mapping id.
  await call(`/mappings/${mapping.mapping.name}/draft`, {
    method: "PUT",
    key,
    body: { spec: MAPPING_V2_SPEC, revision: 0, baseVersion: 1 },
  });
  const { payload: publishedV2 } = await call(`/mappings/${mapping.mapping.name}/publish`, {
    method: "POST",
    key,
    body: { revision: 1 },
  });
  if (publishedV2.mapping?.version !== 2) {
    throw new Error(`expected mapping v2 to publish as version 2, got ${publishedV2.mapping?.version}`);
  }

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
    mappingVersion2Id: publishedV2.mapping.id,
    mappingVersion2Version: 2,
    editorMappingId: editorMapping.mapping.id,
    editorMappingName: editorMapping.mapping.name,
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
