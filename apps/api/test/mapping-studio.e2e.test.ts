import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixtureJson, startApi, type ApiClient, type TestApi } from "./harness.js";

/**
 * Mapping studio over HTTP: draft autosave, optimistic revisions, publish,
 * idempotent publish, version diff and scope enforcement.
 */

interface DraftViewBody {
  draft: { name: string; revision: number; specChecksum: string; baseVersion?: number } | null;
  latest: { id: string; version: number } | null;
  validation: { isValid: boolean; counts: Record<string, number> } | null;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  statusCode: number;
}

interface PublishBody {
  mapping: { id: string; version: number };
  created: boolean;
  validation: { isValid: boolean };
  draftRetained?: boolean;
}

interface DiffBody {
  name: string;
  from: string;
  to: string;
  diff: { counts: { added: number; removed: number; changed: number; reordered: number; unchanged: number } };
}

interface MappingBody {
  mapping: {
    id: string;
    version: number;
    spec: unknown;
    specChecksum: string;
    sourceFormat: string;
    targetFormat: string;
    targetResourceType?: string;
  };
}

interface AuditBody {
  events: Array<{
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }>;
}

function draftPath(name: string): string {
  return `/api/v1/mappings/${name}/draft`;
}

describe("mapping studio API", () => {
  let api: TestApi;
  let owner: ApiClient;
  let spec: Record<string, unknown>;

  before(async () => {
    api = await startApi();
    const bootstrap = await api
      .client()
      .request<{ workspace: { id: string }; apiKey: { key: string } }>("POST", "/api/v1/workspaces", {
        body: { name: "Studio Clinic", slug: "studio-clinic" },
        headers: { "x-bootstrap-token": "test-bootstrap-token" },
      });
    assert.equal(bootstrap.status, 201, bootstrap.raw);
    owner = api.client(bootstrap.body.apiKey.key);
    spec = fixtureJson<Record<string, unknown>>(
      "scenarios",
      "01-hospital-patient-migration",
      "mapping",
      "patient.json",
    );
  });

  after(async () => {
    await api.close();
  });

  it("returns an empty view for a name without a draft", async () => {
    const response = await owner.request<DraftViewBody>("GET", draftPath("studio-empty"));
    assert.equal(response.status, 200, response.raw);
    assert.deepEqual(response.body, { draft: null, latest: null, validation: null });
  });

  it("creates, no-ops and rejects stale draft saves", async () => {
    const name = "studio-autosave";

    const created = await owner.request<DraftViewBody>("PUT", draftPath(name), {
      body: { spec, revision: 0 },
    });
    assert.equal(created.status, 200, created.raw);
    assert.equal(created.body.draft?.revision, 1);
    assert.equal(created.body.draft?.name, name);
    assert.equal(created.body.validation?.isValid, true);
    assert.equal(created.body.latest, null);

    const auditAfterCreate = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(auditAfterCreate.status, 200, auditAfterCreate.raw);
    const savedBefore = auditAfterCreate.body.events.filter(
      (entry) => entry.action === "mapping.draft-saved" && entry.targetId === name,
    );
    assert.equal(savedBefore.length, 1);
    const savedEvent = savedBefore[0]!;
    assert.equal(savedEvent.targetType, "mapping-draft");
    assert.equal(savedEvent.targetId, name);
    assert.deepEqual(Object.keys(savedEvent.metadata ?? {}).sort(), [
      "issueCounts",
      "name",
      "revision",
      "specChecksum",
    ]);
    assert.equal("spec" in (savedEvent.metadata ?? {}), false);

    const unchanged = await owner.request<DraftViewBody>("PUT", draftPath(name), {
      body: { spec, revision: 1 },
    });
    assert.equal(unchanged.status, 200, unchanged.raw);
    assert.equal(unchanged.body.draft?.revision, 1);

    const auditAfterNoop = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(auditAfterNoop.status, 200, auditAfterNoop.raw);
    const savedAfter = auditAfterNoop.body.events.filter(
      (entry) => entry.action === "mapping.draft-saved" && entry.targetId === name,
    );
    assert.equal(savedAfter.length, savedBefore.length, "a checksum no-op save must not emit another audit event");

    const stale = await owner.request<ErrorBody>("PUT", draftPath(name), {
      body: { spec, revision: 0 },
    });
    assert.equal(stale.status, 409, stale.raw);
    assert.equal(stale.body.error.code, "DRAFT_CONFLICT");
    assert.equal((stale.body.error.details as { currentRevision: number }).currentRevision, 1);
  });

  it("stores an invalid spec but refuses to publish it", async () => {
    const name = "studio-invalid";

    const seeded = await owner.request<DraftViewBody>("PUT", draftPath(name), {
      body: { spec, revision: 0 },
    });
    assert.equal(seeded.status, 200, seeded.raw);
    assert.equal(seeded.body.draft?.revision, 1);

    const invalid = await owner.request<DraftViewBody>("PUT", draftPath(name), {
      body: { spec: { rules: "nope" }, revision: 1 },
    });
    assert.equal(invalid.status, 200, invalid.raw);
    assert.equal(invalid.body.draft?.revision, 2);
    assert.equal(invalid.body.validation?.isValid, false);

    const publish = await owner.request<ErrorBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 2 },
    });
    assert.equal(publish.status, 422, publish.raw);
    assert.equal(publish.body.error.code, "MAPPING_VALIDATION_FAILED");
    const issues = (publish.body.error.details as { issues?: unknown[] }).issues;
    assert.ok(Array.isArray(issues) && issues.length > 0, "publish must report the blocking issues");

    const stillThere = await owner.request<DraftViewBody>("GET", draftPath(name));
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.draft?.revision, 2, "a failed publish retains the draft");
  });

  it("discards idempotently and rejects a stale expected revision", async () => {
    const name = "studio-discard";

    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec, revision: 0 } });

    const stale = await owner.request<ErrorBody>("DELETE", `${draftPath(name)}?revision=0`);
    assert.equal(stale.status, 409, stale.raw);
    assert.equal(stale.body.error.code, "DRAFT_CONFLICT");
    assert.equal((stale.body.error.details as { currentRevision: number }).currentRevision, 1);

    const deleted = await owner.request("DELETE", `${draftPath(name)}?revision=1`);
    assert.equal(deleted.status, 204, deleted.raw);
    assert.equal(deleted.raw, "");

    const empty = await owner.request<DraftViewBody>("GET", draftPath(name));
    assert.deepEqual(empty.body, { draft: null, latest: null, validation: null });

    const again = await owner.request("DELETE", draftPath(name));
    assert.equal(again.status, 204, again.raw);

    const audit = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(audit.status, 200, audit.raw);
    const discarded = audit.body.events.find(
      (entry) => entry.action === "mapping.draft-discarded" && entry.targetId === name,
    );
    assert.ok(discarded, "discarding a draft must be audited");
    assert.equal(discarded.targetType, "mapping-draft");
    assert.equal(discarded.targetId, name);
    assert.deepEqual(Object.keys(discarded.metadata ?? {}).sort(), ["name", "revision"]);
  });

  it("returns 404 publishing a name without a draft", async () => {
    const response = await owner.request<ErrorBody>("POST", "/api/v1/mappings/studio-no-draft/publish", {
      body: { revision: 0 },
    });
    assert.equal(response.status, 404, response.raw);
    assert.equal(response.body.error.code, "NOT_FOUND");
  });

  it("publishes a draft as an immutable mapping version with exact audit metadata", async () => {
    const name = "studio-published";

    const draft = await owner.request<DraftViewBody>("PUT", draftPath(name), {
      body: { spec, revision: 0 },
    });
    assert.equal(draft.status, 200, draft.raw);

    const published = await owner.request<PublishBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(published.status, 200, published.raw);
    assert.equal(published.body.created, true);
    assert.equal(published.body.mapping.version, 1);
    assert.equal(published.body.validation.isValid, true);

    const draftAfter = await owner.request<DraftViewBody>("GET", draftPath(name));
    assert.deepEqual(draftAfter.body, { draft: null, latest: published.body.mapping, validation: null });

    const audit = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    assert.equal(audit.status, 200, audit.raw);
    const event = audit.body.events.find(
      (entry) => entry.action === "mapping.published" && entry.targetId === published.body.mapping.id,
    );
    assert.ok(event, "publish must be audited against the mapping id");
    const metadata = event.metadata ?? {};
    assert.deepEqual(Object.keys(metadata).sort(), [
      "idempotent",
      "mappingId",
      "name",
      "revision",
      "specChecksum",
      "version",
    ]);
    assert.equal("spec" in metadata, false);
    assert.equal(metadata.name, name);
    assert.equal(metadata.idempotent, false);
  });

  it("treats publishing the latest checksum as an idempotent no-op", async () => {
    const name = "studio-idempotent";

    const created = await owner.request<{ mapping: { id: string; version: number } }>("POST", "/api/v1/mappings", {
      body: { name, spec },
    });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.mapping.version, 1);

    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec, revision: 0 } });

    const published = await owner.request<PublishBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(published.status, 200, published.raw);
    assert.equal(published.body.created, false);
    assert.equal(published.body.mapping.id, created.body.mapping.id);
    assert.equal(published.body.mapping.version, 1);

    const versions = await owner.request<{ versions: unknown[] }>("GET", `/api/v1/mappings/${name}/versions`);
    assert.equal(versions.body.versions.length, 1, "an idempotent publish must not create a version");

    const draftAfter = await owner.request<DraftViewBody>("GET", draftPath(name));
    assert.equal(draftAfter.body.draft, null);

    const audit = await owner.request<AuditBody>("GET", "/api/v1/audit?limit=100");
    const event = audit.body.events.find(
      (entry) => entry.action === "mapping.published" && entry.targetId === created.body.mapping.id,
    );
    assert.ok(event);
    assert.equal(event.metadata?.idempotent, true);
  });

  it("publishes a changed draft as the next mapping version", async () => {
    const name = "studio-versions";

    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec, revision: 0 } });
    const first = await owner.request<PublishBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(first.status, 200, first.raw);
    assert.equal(first.body.mapping.version, 1);

    const changed = structuredClone(spec) as { rules: Array<Record<string, unknown>> } & Record<string, unknown>;
    changed.rules[2]!.targetPath = "name.0.familyName";

    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec: changed, revision: 0 } });
    const second = await owner.request<PublishBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.body.created, true);
    assert.equal(second.body.mapping.version, 2);
  });

  it("derives publish formats from the definition and keeps the draft spec and checksum (R22)", async () => {
    const name = "studio-publish-derivation";
    // v1 deliberately disagrees with the definition on every derived field and has
    // a different spec, so publishing the fixture draft must create (not no-op) v2.
    const seedSpec = structuredClone(spec) as { rules: Array<Record<string, unknown>> } & Record<string, unknown>;
    seedSpec.rules[2]!.targetPath = "name.0.familyName";

    const seeded = await owner.request<MappingBody>("POST", "/api/v1/mappings", {
      body: {
        name,
        spec: seedSpec,
        sourceFormat: "hl7v2",
        targetFormat: "fhir-stu3",
        targetResourceType: "Observation",
      },
    });
    assert.equal(seeded.status, 201, seeded.raw);
    assert.equal(seeded.body.mapping.version, 1);

    const draft = await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec, revision: 0 } });
    assert.equal(draft.status, 200, draft.raw);
    const draftChecksum = draft.body.draft?.specChecksum;
    assert.ok(draftChecksum, "the draft must expose its spec checksum");

    const published = await owner.request<PublishBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(published.status, 200, published.raw);
    assert.equal(published.body.created, true);
    assert.equal(published.body.mapping.version, 2);

    const fetched = await owner.request<MappingBody>("GET", `/api/v1/mappings/${published.body.mapping.id}`);
    assert.equal(fetched.status, 200, fetched.raw);
    assert.equal(fetched.body.mapping.id, published.body.mapping.id);
    assert.equal(fetched.body.mapping.version, 2);
    assert.equal(fetched.body.mapping.sourceFormat, "csv");
    assert.equal(fetched.body.mapping.targetFormat, "fhir-r4");
    assert.equal(fetched.body.mapping.targetResourceType, "Patient");
    assert.deepEqual(fetched.body.mapping.spec, spec);
    assert.equal(fetched.body.mapping.specChecksum, draftChecksum);
  });

  it("diffs latest and draft, accepts a version token, and rejects bad tokens", async () => {
    const name = "studio-diff";

    const created = await owner.request<{ mapping: { version: number } }>("POST", "/api/v1/mappings", {
      body: { name, spec },
    });
    assert.equal(created.status, 201, created.raw);

    const changed = structuredClone(spec) as { rules: Array<Record<string, unknown>> } & Record<string, unknown>;
    changed.rules[2]!.targetPath = "name.0.familyName";
    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec: changed, revision: 0 } });

    const diff = await owner.request<DiffBody>("GET", `/api/v1/mappings/${name}/diff`);
    assert.equal(diff.status, 200, diff.raw);
    assert.equal(diff.body.name, name);
    assert.equal(diff.body.from, "latest");
    assert.equal(diff.body.to, "draft");
    assert.ok(diff.body.diff.counts.changed >= 1, "a changed rule must be reported");

    const versioned = await owner.request<DiffBody>(
      "GET",
      `/api/v1/mappings/${name}/diff?from=${created.body.mapping.version}&to=draft`,
    );
    assert.equal(versioned.status, 200, versioned.raw);
    assert.equal(versioned.body.from, String(created.body.mapping.version));

    const peer = "studio-diff-no-draft";
    await owner.request("POST", "/api/v1/mappings", { body: { name: peer, spec } });
    const missingDraft = await owner.request<ErrorBody>("GET", `/api/v1/mappings/${peer}/diff?from=draft`);
    assert.equal(missingDraft.status, 404, missingDraft.raw);
    assert.equal(missingDraft.body.error.code, "NOT_FOUND");

    const badToken = await owner.request<ErrorBody>("GET", `/api/v1/mappings/${name}/diff?from=nope`);
    assert.equal(badToken.status, 400, badToken.raw);
    assert.equal(badToken.body.error.code, "VALIDATION_FAILED");
    assert.match(badToken.body.error.message, /'from'/);
  });

  it("returns 422 with the invalid diff side and its issues (R15)", async () => {
    const toName = "studio-diff-invalid-to";
    const seededTo = await owner.request("POST", "/api/v1/mappings", { body: { name: toName, spec } });
    assert.equal(seededTo.status, 201, seededTo.raw);
    // The draft endpoint stores invalid specs on purpose, so the 'to' side is broken.
    const invalidDraft = await owner.request<DraftViewBody>("PUT", draftPath(toName), {
      body: { spec: { rules: "nope" }, revision: 0 },
    });
    assert.equal(invalidDraft.status, 200, invalidDraft.raw);

    const invalidTo = await owner.request<ErrorBody>("GET", `/api/v1/mappings/${toName}/diff`);
    assert.equal(invalidTo.status, 422, invalidTo.raw);
    assert.equal(invalidTo.body.error.code, "MAPPING_VALIDATION_FAILED");
    const toDetails = invalidTo.body.error.details as { side?: string; issues?: unknown[] };
    assert.equal(toDetails.side, "to");
    assert.ok(Array.isArray(toDetails.issues) && toDetails.issues.length > 0);

    const fromName = "studio-diff-invalid-from";
    // POST /mappings only requires spec.rules to be an array; it does not run the
    // validator, which is how a stored mapping can be the invalid 'from' side.
    const fromSpec = {
      id: "bad",
      name: fromName,
      version: "1.0.0",
      sourceFormat: "csv",
      targetFormat: "fhir-r4",
      rules: [{ id: "r1" }],
    };
    const seededFrom = await owner.request("POST", "/api/v1/mappings", {
      body: { name: fromName, spec: fromSpec },
    });
    assert.equal(seededFrom.status, 201, seededFrom.raw);
    const validDraft = await owner.request<DraftViewBody>("PUT", draftPath(fromName), {
      body: { spec, revision: 0 },
    });
    assert.equal(validDraft.status, 200, validDraft.raw);

    const invalidFrom = await owner.request<ErrorBody>("GET", `/api/v1/mappings/${fromName}/diff`);
    assert.equal(invalidFrom.status, 422, invalidFrom.raw);
    assert.equal(invalidFrom.body.error.code, "MAPPING_VALIDATION_FAILED");
    const fromDetails = invalidFrom.body.error.details as { side?: string; issues?: unknown[] };
    assert.equal(fromDetails.side, "from");
    assert.ok(Array.isArray(fromDetails.issues) && fromDetails.issues.length > 0);
  });

  it("rejects malformed draft bodies without saving", async () => {
    const name = "studio-body";
    const cases: unknown[] = [
      { spec },
      { spec, revision: "1" },
      { spec, revision: -1 },
      { spec, revision: 0, baseVersion: 0 },
    ];

    for (const body of cases) {
      const response = await owner.request<ErrorBody>("PUT", draftPath(name), { body });
      assert.equal(response.status, 400, `${JSON.stringify(body)} → ${response.raw}`);
      assert.equal(response.body.error.code, "VALIDATION_FAILED");
    }

    const draft = await owner.request<DraftViewBody>("GET", draftPath(name));
    assert.equal(draft.body.draft, null, "no partially validated body may create a draft");
  });

  it("lets a viewer read drafts and diffs but never write or preview", async () => {
    const name = "studio-viewer";
    const issued = await owner.request<{ key: string }>("POST", "/api/v1/keys", {
      body: { name: "studio viewer", role: "viewer" },
    });
    assert.equal(issued.status, 201, issued.raw);
    const viewer = api.client(issued.body.key);

    await owner.request("POST", "/api/v1/mappings", { body: { name, spec } });
    await owner.request<DraftViewBody>("PUT", draftPath(name), { body: { spec, revision: 0 } });

    const draft = await viewer.request<DraftViewBody>("GET", draftPath(name));
    assert.equal(draft.status, 200, draft.raw);
    assert.equal(draft.body.draft?.revision, 1);

    const diff = await viewer.request<DiffBody>("GET", `/api/v1/mappings/${name}/diff`);
    assert.equal(diff.status, 200, diff.raw);

    const write = await viewer.request<ErrorBody>("PUT", draftPath(name), { body: { spec, revision: 1 } });
    assert.equal(write.status, 403, write.raw);
    assert.equal(write.body.error.code, "FORBIDDEN");

    const publish = await viewer.request<ErrorBody>("POST", `/api/v1/mappings/${name}/publish`, {
      body: { revision: 1 },
    });
    assert.equal(publish.status, 403, publish.raw);

    const preview = await viewer.request<ErrorBody>("POST", "/api/v1/mappings/preview", {
      body: { spec, assetId: "as_missing" },
    });
    assert.equal(preview.status, 403, preview.raw);
    assert.equal(preview.body.error.code, "FORBIDDEN");
  });
});
