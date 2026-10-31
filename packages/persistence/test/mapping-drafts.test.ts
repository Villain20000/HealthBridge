import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PersistenceError,
  createMemoryRepositories,
  type MappingDraftRecord,
  type Repositories,
} from "@healthbridge/persistence";

const workspaceA = "ws_draft_a";
const workspaceB = "ws_draft_b";
const draftName = "patient-admissions";

function draft(overrides: Partial<Omit<MappingDraftRecord, "revision">> = {}): Omit<MappingDraftRecord, "revision"> {
  return {
    workspaceId: workspaceA,
    name: draftName,
    spec: { id: draftName, rules: [{ id: "r1", sourcePath: "mrn" }] },
    specChecksum: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-05-01T09:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
    ...overrides,
  };
}

function newRepos(): Repositories {
  return createMemoryRepositories();
}

function rejectsWith(code: "CONFLICT" | "INVALID_ARGUMENT"): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PersistenceError, `expected a PersistenceError, got ${String(error)}`);
    assert.equal((error as PersistenceError).code, code);
    return true;
  };
}

function rulesOf(record: MappingDraftRecord): Array<Record<string, unknown>> {
  return (record.spec as { rules: Array<Record<string, unknown>> }).rules;
}

describe("mapping drafts: memory repository", () => {
  test("inserting at revision 0 creates revision 1 and round-trips every field", async () => {
    const repos = newRepos();
    const input = draft({ baseVersion: 2, updatedBy: "key_editor" });

    const created = await repos.mappingDrafts.save(input, 0);

    assert.deepEqual(created, { ...input, revision: 1 });
    assert.deepEqual(await repos.mappingDrafts.get(workspaceA, draftName), created);
  });

  test("updating at the current revision increments it and preserves createdAt", async () => {
    const repos = newRepos();
    const created = await repos.mappingDrafts.save(draft({ baseVersion: 2 }), 0);

    const updated = await repos.mappingDrafts.save(
      draft({
        baseVersion: 3,
        spec: { id: draftName, rules: [{ id: "r2", sourcePath: "family" }] },
        specChecksum: `sha256:${"b".repeat(64)}`,
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-02T10:00:00.000Z",
        updatedBy: "key_reviewer",
      }),
      1,
    );

    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-05-02T10:00:00.000Z");
    assert.equal(updated.baseVersion, 3);
    assert.equal(updated.updatedBy, "key_reviewer");
    assert.equal(updated.specChecksum, `sha256:${"b".repeat(64)}`);
    assert.deepEqual(updated.spec, { id: draftName, rules: [{ id: "r2", sourcePath: "family" }] });
    assert.deepEqual(await repos.mappingDrafts.get(workspaceA, draftName), updated);
  });

  test("a stale save conflicts and leaves the stored draft unchanged", async () => {
    const repos = newRepos();
    await repos.mappingDrafts.save(draft(), 0);
    const atRevisionTwo = await repos.mappingDrafts.save(draft({ baseVersion: 1 }), 1);
    assert.equal(atRevisionTwo.revision, 2);

    await assert.rejects(
      () => repos.mappingDrafts.save(draft({ spec: { id: draftName, rules: [{ id: "stale" }] } }), 1),
      rejectsWith("CONFLICT"),
    );

    const stored = await repos.mappingDrafts.get(workspaceA, draftName);
    assert.deepEqual(stored, atRevisionTwo);
  });

  test("duplicate inserts and updates against an absent draft conflict", async () => {
    const repos = newRepos();
    await repos.mappingDrafts.save(draft(), 0);

    await assert.rejects(() => repos.mappingDrafts.save(draft(), 0), rejectsWith("CONFLICT"));
    await assert.rejects(() => repos.mappingDrafts.save(draft({ name: "never-created" }), 1), rejectsWith("CONFLICT"));
    assert.equal(await repos.mappingDrafts.get(workspaceA, "never-created"), undefined);
  });

  test("negative and non-integer expected revisions are invalid arguments", async () => {
    const repos = newRepos();

    for (const expectedRevision of [-1, -10, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(() => repos.mappingDrafts.save(draft(), expectedRevision), rejectsWith("INVALID_ARGUMENT"));
    }
    for (const expectedRevision of [-1, 0.5, Number.NaN]) {
      await assert.rejects(
        () => repos.mappingDrafts.delete(workspaceA, draftName, expectedRevision),
        rejectsWith("INVALID_ARGUMENT"),
      );
    }
    assert.equal(await repos.mappingDrafts.get(workspaceA, draftName), undefined);
  });

  test("a draft is invisible, unwritable and undeletable from another workspace", async () => {
    const repos = newRepos();
    const created = await repos.mappingDrafts.save(draft(), 0);

    assert.equal(await repos.mappingDrafts.get(workspaceB, draftName), undefined);
    await assert.rejects(
      () => repos.mappingDrafts.save(draft({ workspaceId: workspaceB, spec: { id: draftName, rules: [] } }), 1),
      rejectsWith("CONFLICT"),
    );
    assert.equal(await repos.mappingDrafts.delete(workspaceB, draftName), false);
    assert.deepEqual(await repos.mappingDrafts.get(workspaceA, draftName), created);

    const theirs = await repos.mappingDrafts.save(draft({ workspaceId: workspaceB }), 0);
    assert.equal(theirs.revision, 1);
    assert.equal((await repos.mappingDrafts.get(workspaceA, draftName))?.revision, 1);
    assert.equal((await repos.mappingDrafts.get(workspaceB, draftName))?.revision, 1);
  });

  test("delete removes unconditionally or only at the expected revision", async () => {
    const repos = newRepos();
    await repos.mappingDrafts.save(draft(), 0);

    assert.equal(await repos.mappingDrafts.delete(workspaceA, draftName), true);
    assert.equal(await repos.mappingDrafts.get(workspaceA, draftName), undefined);
    assert.equal(await repos.mappingDrafts.delete(workspaceA, draftName), false);

    await repos.mappingDrafts.save(draft(), 0);
    assert.equal(await repos.mappingDrafts.delete(workspaceA, draftName, 2), false);
    assert.ok(await repos.mappingDrafts.get(workspaceA, draftName));
    assert.equal(await repos.mappingDrafts.delete(workspaceA, draftName, 1), true);
    assert.equal(await repos.mappingDrafts.get(workspaceA, draftName), undefined);
  });

  test("returned specs are structured clones, not live references", async () => {
    const repos = newRepos();
    const input = draft();
    const created = await repos.mappingDrafts.save(input, 0);

    rulesOf(created).push({ id: "mutated-created" });
    (input.spec as { rules: Array<Record<string, unknown>> }).rules.push({ id: "mutated-input" });

    const stored = await repos.mappingDrafts.get(workspaceA, draftName);
    assert.deepEqual(rulesOf(stored!), [{ id: "r1", sourcePath: "mrn" }]);

    rulesOf(stored!).push({ id: "mutated-read" });
    assert.deepEqual(rulesOf((await repos.mappingDrafts.get(workspaceA, draftName))!), [
      { id: "r1", sourcePath: "mrn" },
    ]);
  });
});
