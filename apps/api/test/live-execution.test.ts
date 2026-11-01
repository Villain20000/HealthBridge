import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixtureJson, startApi, waitForRun, type ApiClient, type TestApi } from "./harness.js";

/**
 * Live pausable execution over HTTP.
 *
 * What is real: the worker transforms in bounded chunks, persists a
 * checkpoint (stage + record index + checksums) on the run row at every
 * chunk, honours pause at chunk boundaries while keeping the run `running`
 * (pause is not cancel), and resumes byte-identically. Static replay paths
 * are exercised to prove they are untouched and never labelled live.
 */

const IMPORTED_AT = "2024-01-01T00:00:00.000Z";

function bigPatients(rows: number): Buffer {
  const lines = ["patient_id,family_name,given_name,sex,birth_date,mrn,city"];
  for (let i = 1; i <= rows; i++) {
    lines.push(`P${String(i).padStart(5, "0")},Family${i},Given${i},M,1990-01-15,MRN-${i},Lagos`);
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

const smallPatients = Buffer.from(
  [
    "patient_id,family_name,given_name,sex,birth_date,mrn,city",
    "H001,Okonkwo,Chidi,female,1990-02-17,MRN-1001,Lagos",
    "H002,Silva,Ana,M,1985-11-03,MRN-1002,Sao Paulo",
  ].join("\n"),
  "utf-8",
);

interface Checkpoint {
  runId: string;
  stage: string;
  recordIndex: number;
  recordsProcessed: number;
  recordsTotal?: number;
  inputChecksum?: string;
  outputChecksumSoFar?: string;
  importedAt: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  status: string;
  progress?: { stage?: string; recordsProcessed?: number };
  summary?: { checkpoint?: Checkpoint };
  outputChecksum?: string;
}

describe("Live pausable execution", () => {
  let api: TestApi;
  let owner: ApiClient;

  before(async () => {
    api = await startApi();
    const bootstrap = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Live Clinic", slug: "live-clinic" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(bootstrap.status, 201, bootstrap.raw);
    owner = api.client(bootstrap.body.apiKey.key);
  });

  after(async () => {
    await api.close();
  });

  async function createMapping(name: string): Promise<string> {
    const spec = fixtureJson("scenarios", "01-hospital-patient-migration", "mapping", "patient.json");
    const response = await owner.request<{ mapping: { id: string } }>("POST", "/api/v1/mappings", {
      body: { name, spec, targetResourceType: "Patient" },
    });
    assert.equal(response.status, 201, response.raw);
    return response.body.mapping.id;
  }

  async function upload(filename: string, bytes: Buffer): Promise<string> {
    const response = await owner.request<{ asset: { id: string } }>(
      "POST",
      `/api/v1/assets?filename=${filename}`,
      { raw: bytes, headers: { "content-type": "text/csv" } },
    );
    assert.equal(response.status, 201, response.raw);
    return response.body.asset.id;
  }

  async function createRun(assetId: string, mappingId: string): Promise<string> {
    const response = await owner.request<{ run: { id: string } }>("POST", "/api/v1/runs", {
      body: { assetId, mappingId, options: { importedAt: IMPORTED_AT } },
    });
    assert.equal(response.status, 202, response.raw);
    return response.body.run.id;
  }

  async function getRun(runId: string): Promise<RunRow> {
    const response = await owner.request<{ run: RunRow }>("GET", `/api/v1/runs/${runId}`);
    assert.equal(response.status, 200, response.raw);
    return response.body.run;
  }

  it("pauses a live run, keeps its checkpoint, and resumes byte-identically", async () => {
    const mappingId = await createMapping("live-patient-mapping");
    const assetId = await upload("live-patients.csv", bigPatients(2000));

    // Pause immediately: with 2000 rows the worker is still in its chunk loop,
    // so the request lands mid-run. Retry against a fresh run if one ever wins
    // the race and finishes first.
    let runId = "";
    let observedPaused = false;
    for (let attempt = 0; attempt < 3 && !observedPaused; attempt++) {
      runId = await createRun(assetId, mappingId);
      const pause = await owner.request<{ run: RunRow; note: string }>("POST", `/api/v1/runs/${runId}/pause`);
      assert.equal(pause.status, 200, pause.raw);
      assert.ok(typeof pause.body.note === "string" && pause.body.note.length > 0);

      const deadline = Date.now() + 15_000;
      for (;;) {
        const run = await getRun(runId);
        if (run.progress?.stage === "paused") {
          observedPaused = true;
          break;
        }
        if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(run.status)) break;
        if (Date.now() > deadline) throw new Error(`run ${runId} never reached paused state`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(observedPaused, true, "the pause request landed while the run was live");

    const paused = await getRun(runId);
    assert.equal(paused.status, "running", "pause is not cancel: the status stays running");
    const checkpoint = paused.summary?.checkpoint;
    assert.ok(checkpoint, "a paused run keeps its checkpoint on the row");
    assert.equal(checkpoint.runId, runId);
    assert.ok(checkpoint.recordIndex > 0, "the checkpoint is past the first chunk");
    assert.equal(checkpoint.recordsTotal, 2000);
    assert.match(String(checkpoint.inputChecksum), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(checkpoint.outputChecksumSoFar), /^sha256:[0-9a-f]{64}$/);
    assert.equal(checkpoint.importedAt, IMPORTED_AT);

    // Pausing twice is a conflict, not a silent no-op.
    const again = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/pause`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");

    // An identical run that is never paused is the byte-identity oracle.
    const oracleId = await createRun(assetId, mappingId);
    const resumed = await owner.request("POST", `/api/v1/runs/${runId}/resume`);
    assert.equal(resumed.status, 200, resumed.raw);

    const finished = await waitForRun(owner, runId);
    assert.ok(["completed", "completed_with_warnings"].includes(finished.status), JSON.stringify(finished.status));
    const oracle = await waitForRun(owner, oracleId);
    assert.ok(["completed", "completed_with_warnings"].includes(oracle.status));

    const [resumedResources, oracleResources] = await Promise.all([
      owner.request<{ resources: unknown[] }>("GET", `/api/v1/runs/${runId}/resources`),
      owner.request<{ resources: unknown[] }>("GET", `/api/v1/runs/${oracleId}/resources`),
    ]);
    assert.equal(resumedResources.status, 200, resumedResources.raw);
    assert.equal(oracleResources.status, 200, oracleResources.raw);
    assert.deepEqual(resumedResources.body.resources, oracleResources.body.resources);

    const [resumedRow, oracleRow] = await Promise.all([getRun(runId), getRun(oracleId)]);
    assert.equal(resumedRow.outputChecksum, oracleRow.outputChecksum, "resume is byte-identical");
    assert.equal(
      (resumedRow.summary as { checkpoint?: unknown } | undefined)?.checkpoint,
      undefined,
      "a finished run carries no checkpoint",
    );

    // Neither pause nor resume is valid once the run is done.
    const latePause = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/pause`);
    assert.equal(latePause.status, 409);
    const lateResume = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/resume`);
    assert.equal(lateResume.status, 409);
    assert.equal(lateResume.body.error.code, "CONFLICT");
  });

  it("returns 409 when a run is not pausable and 404 for unknown runs", async () => {
    const mappingId = await createMapping("live-409-mapping");
    const assetId = await upload("tiny.csv", smallPatients);
    const runId = await createRun(assetId, mappingId);
    const finished = await waitForRun(owner, runId);
    assert.ok(["completed", "completed_with_warnings"].includes(finished.status));

    const pause = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/pause`);
    assert.equal(pause.status, 409);
    assert.equal(pause.body.error.code, "CONFLICT");

    const resume = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/resume`);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error.code, "CONFLICT");

    const missingPause = await owner.request<{ error: { code: string } }>("POST", "/api/v1/runs/run_missing/pause");
    assert.equal(missingPause.status, 404);
    assert.equal(missingPause.body.error.code, "NOT_FOUND");

    const missingResume = await owner.request<{ error: { code: string } }>(
      "POST",
      "/api/v1/runs/run_missing/resume",
    );
    assert.equal(missingResume.status, 404);
    assert.equal(missingResume.body.error.code, "NOT_FOUND");
  });

  it("refuses resume on a run that was never paused", async () => {
    const mappingId = await createMapping("live-never-paused-mapping");
    const assetId = await upload("never-paused.csv", bigPatients(1500));
    const runId = await createRun(assetId, mappingId);

    // Whether the run is still going or just finished, it is not paused.
    const resume = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/resume`);
    assert.equal(resume.status, 409, resume.raw);
    assert.equal(resume.body.error.code, "CONFLICT");

    await waitForRun(owner, runId);
  });

  it("cancelled runs drop their checkpoint and cannot resume", async () => {
    const mappingId = await createMapping("live-cancel-mapping");
    const assetId = await upload("cancel.csv", smallPatients);
    const runId = await createRun(assetId, mappingId);

    const cancel = await owner.request("POST", `/api/v1/runs/${runId}/cancel`);
    if (cancel.status === 202) {
      const run = await waitForRun(owner, runId);
      assert.equal(run.status, "cancelled");
      assert.equal(
        (run.summary as { checkpoint?: unknown } | undefined)?.checkpoint,
        undefined,
        "cancelled runs do not keep a checkpoint",
      );
    } else {
      // The tiny run finished before the cancel landed; it is still terminal.
      assert.equal(cancel.status, 409, cancel.raw);
    }

    const resume = await owner.request<{ error: { code: string } }>("POST", `/api/v1/runs/${runId}/resume`);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error.code, "CONFLICT");
  });

  it("static replay still works and is never labelled live", async () => {
    const mappingId = await createMapping("live-replay-mapping");
    const assetId = await upload("replay.csv", smallPatients);
    const runId = await createRun(assetId, mappingId);
    await waitForRun(owner, runId);

    const replay = await owner.request<{ run: { id: string }; replayedFrom: string }>(
      "POST",
      `/api/v1/runs/${runId}/replay`,
    );
    assert.equal(replay.status, 202, replay.raw);
    assert.equal(replay.body.replayedFrom, runId);
    assert.ok(!replay.raw.toLowerCase().includes("live"), "static replay must never be labelled live");

    const replayed = await waitForRun(owner, replay.body.run.id);
    assert.ok(["completed", "completed_with_warnings"].includes(replayed.status));
  });
});
