import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Subject, of, throwError } from "rxjs";
import type { Observable } from "rxjs";
import type { MappingDefinition, MappingValidationResult } from "@healthbridge/shared-types";
import type { ApiProblem, Mapping, MappingDraftView, PublishMappingResponse } from "../src/app/core/api-types";
import { AUTOSAVE_DELAY_MS, MappingEditorStore } from "../src/app/features/studio/editor/editor.store";
import type { EditorApi } from "../src/app/features/studio/editor/editor.store";

type SaveInput = { spec: unknown; revision: number; baseVersion?: number };

const validResult: MappingValidationResult = {
  isValid: true,
  issues: [],
  counts: { fatal: 0, error: 0, warning: 0, information: 0 },
};

const baseSpec = (): MappingDefinition => ({
  id: "lab",
  name: "lab",
  version: "1.0.0",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  rules: [
    { id: "rule-1", sourcePath: "a", targetPath: "x", transform: "identity" },
    { id: "rule-2", sourcePath: "b", targetPath: "y", transform: "trim" },
  ],
});

const withSource = (spec: MappingDefinition, sourcePath: string): MappingDefinition => ({
  ...spec,
  rules: spec.rules.map((rule, index) => (index === 0 ? { ...rule, sourcePath } : rule)),
});

const draftView = (revision: number, spec: unknown = baseSpec(), baseVersion?: number): MappingDraftView => ({
  draft: {
    name: "lab",
    revision,
    ...(baseVersion === undefined ? {} : { baseVersion }),
    spec,
    specChecksum: "checksum",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  latest: null,
  validation: validResult,
});

const latestMapping = (version: number): Mapping => ({
  id: "mapping-1",
  workspaceId: "ws-1",
  name: "lab",
  version,
  spec: baseSpec(),
  specChecksum: "checksum",
  sourceFormat: "csv",
  targetFormat: "fhir-r4",
  createdAt: "2026-10-30T00:00:00.000Z",
});

const problem = (status: number, code: string, details?: unknown): ApiProblem => ({
  status,
  code,
  message: code,
  ...(details === undefined ? {} : { details }),
});

const conflict = (currentRevision?: number): ApiProblem =>
  problem(409, "DRAFT_CONFLICT", currentRevision === undefined ? undefined : { currentRevision });

class FakeApi implements EditorApi {
  public getCalls: string[] = [];
  public saveCalls: Array<{ name: string; input: SaveInput }> = [];
  public publishCalls: Array<{ name: string; revision: number }> = [];

  public onGet: (name: string) => Observable<MappingDraftView> = () => of(draftView(3));
  public onSave: (name: string, input: SaveInput) => Observable<MappingDraftView> = (_name, input) =>
    of(draftView(input.revision + 1, input.spec));
  public onPublish: (name: string, revision: number) => Observable<PublishMappingResponse> = () =>
    of({ mapping: latestMapping(4), created: true, validation: validResult });

  public getMappingDraft(name: string): Observable<MappingDraftView> {
    this.getCalls.push(name);
    return this.onGet(name);
  }

  public saveMappingDraft(name: string, input: SaveInput): Observable<MappingDraftView> {
    this.saveCalls.push({ name, input });
    return this.onSave(name, input);
  }

  public publishMapping(name: string, revision: number): Observable<PublishMappingResponse> {
    this.publishCalls.push({ name, revision });
    return this.onPublish(name, revision);
  }

  public previewMapping(): Observable<never> {
    return throwError(() => problem(500, "UNUSED_IN_THESE_TESTS"));
  }
}

class FakeClock {
  public time = 0;
  public delays: number[] = [];
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  public readonly now = (): number => this.time;

  public readonly setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.delays.push(ms);
    this.callbacks.set(id, callback);
    return id;
  };

  public readonly clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };

  public get pending(): number {
    return this.callbacks.size;
  }

  /** Runs every scheduled timer once, as if the debounce delay had passed. */
  public fire(): void {
    const due = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of due) callback();
  }
}

function setup(onGet?: (name: string) => Observable<MappingDraftView>) {
  const api = new FakeApi();
  if (onGet !== undefined) api.onGet = onGet;
  const clock = new FakeClock();
  const store = new MappingEditorStore(api, {
    debounceMs: AUTOSAVE_DELAY_MS,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  store.load("lab");
  return { api, clock, store };
}

describe("MappingEditorStore loading", () => {
  it("adopts a stored draft as saved and selects the first rule", () => {
    const { store } = setup(() => of(draftView(3, baseSpec(), 2)));
    assert.equal(store.loading(), false);
    assert.equal(store.revision(), 3);
    assert.equal(store.baseVersion(), 2);
    assert.equal(store.saveState(), "saved");
    assert.equal(store.selectedRuleId(), "rule-1");
    assert.equal(store.dirty(), false);
    assert.deepEqual(store.validation(), validResult);
  });

  it("starts from the latest version when no draft exists", () => {
    const { store } = setup(() => of({ draft: null, latest: latestMapping(5), validation: null }));
    assert.equal(store.revision(), 0);
    assert.equal(store.baseVersion(), 5);
    assert.equal(store.saveState(), "idle");
    assert.notEqual(store.spec(), null);
  });

  it("starts from a blank spec when the mapping has no draft and no version", () => {
    const { store } = setup(() => of({ draft: null, latest: null, validation: null }));
    assert.equal(store.revision(), 0);
    assert.equal(store.baseVersion(), undefined);
    assert.notEqual(store.spec(), null);
    assert.equal(store.unreadable(), false);
  });

  it("flags a spec it cannot edit as unreadable", () => {
    const { store } = setup(() => of(draftView(1, { rules: "not-an-array" })));
    assert.equal(store.unreadable(), true);
    assert.equal(store.spec(), null);
  });

  it("reports a load failure without throwing", () => {
    const { store } = setup(() => throwError(() => problem(404, "MAPPING_NOT_FOUND")));
    assert.equal(store.problem()?.code, "MAPPING_NOT_FOUND");
    assert.equal(store.loading(), false);
    assert.equal(store.spec(), null);
  });
});

describe("MappingEditorStore autosave", () => {
  it("marks the draft dirty and saves once after the debounce", () => {
    const { api, clock, store } = setup(() => of(draftView(3, baseSpec(), 2)));

    store.updateRule("rule-1", { sourcePath: "alpha" });
    assert.equal(store.saveState(), "dirty");
    assert.equal(store.dirty(), true);
    assert.equal(clock.pending, 1);
    assert.deepEqual(clock.delays, [AUTOSAVE_DELAY_MS]);
    assert.equal(api.saveCalls.length, 0);

    clock.fire();
    assert.equal(api.saveCalls.length, 1);
    assert.equal(api.saveCalls[0]?.name, "lab");
    assert.equal(api.saveCalls[0]?.input.revision, 3);
    assert.equal(api.saveCalls[0]?.input.baseVersion, 2);
    assert.deepEqual(api.saveCalls[0]?.input.spec, withSource(baseSpec(), "alpha"));

    assert.equal(store.saveState(), "saved");
    assert.equal(store.revision(), 4);
    assert.equal(store.dirty(), false);
  });

  it("restarts the timer on each edit so a burst produces one save", () => {
    const { api, clock, store } = setup();

    store.updateRule("rule-1", { sourcePath: "a1" });
    store.updateRule("rule-1", { sourcePath: "a12" });
    store.updateRule("rule-1", { sourcePath: "a123" });
    assert.equal(clock.pending, 1);

    clock.fire();
    assert.equal(api.saveCalls.length, 1);
    assert.deepEqual(api.saveCalls[0]?.input.spec, withSource(baseSpec(), "a123"));
  });

  it("sends revision 0 and the latest version for a first save", () => {
    const { api, clock, store } = setup(() => of({ draft: null, latest: latestMapping(5), validation: null }));

    store.updateRule("rule-1", { sourcePath: "alpha" });
    clock.fire();

    assert.equal(api.saveCalls[0]?.input.revision, 0);
    assert.equal(api.saveCalls[0]?.input.baseVersion, 5);
    assert.equal(store.revision(), 1);
    assert.equal(store.saveState(), "saved");
  });

  it("sends only one save at a time and follows up with edits made in flight", () => {
    const { api, clock, store } = setup();
    const first = new Subject<MappingDraftView>();
    api.onSave = () => first;

    store.updateRule("rule-1", { sourcePath: "one" });
    clock.fire();
    assert.equal(store.saveState(), "saving");

    store.updateRule("rule-1", { sourcePath: "two" });
    assert.equal(clock.pending, 0);
    assert.equal(api.saveCalls.length, 1);

    api.onSave = (_name, input) => of(draftView(input.revision + 1, input.spec));
    first.next(draftView(4, withSource(baseSpec(), "one")));

    assert.equal(store.revision(), 4);
    assert.equal(store.saveState(), "dirty");
    assert.equal(clock.pending, 1);

    clock.fire();
    assert.equal(api.saveCalls.length, 2);
    assert.equal(api.saveCalls[1]?.input.revision, 4);
    assert.deepEqual(api.saveCalls[1]?.input.spec, withSource(baseSpec(), "two"));
    assert.equal(store.saveState(), "saved");
    assert.equal(store.revision(), 5);
  });

  it("returns to saved and cancels the timer when undo restores the saved spec", () => {
    const { api, clock, store } = setup();

    store.updateRule("rule-1", { sourcePath: "alpha" });
    assert.equal(store.canUndo(), true);
    assert.equal(clock.pending, 1);

    store.undo();
    assert.equal(store.dirty(), false);
    assert.equal(store.saveState(), "saved");
    assert.equal(clock.pending, 0);
    assert.equal(api.saveCalls.length, 0);
    assert.equal(store.canRedo(), true);
  });

  it("keeps the draft dirty after a server error and saves again on retry", () => {
    const { api, clock, store } = setup();
    api.onSave = () => throwError(() => problem(503, "UNAVAILABLE"));

    store.updateRule("rule-1", { sourcePath: "alpha" });
    clock.fire();
    assert.equal(store.saveState(), "error");
    assert.equal(store.saveProblem()?.code, "UNAVAILABLE");
    assert.equal(store.dirty(), true);
    assert.equal(clock.pending, 0);

    api.onSave = (_name, input) => of(draftView(input.revision + 1, input.spec));
    store.retrySave();
    assert.equal(api.saveCalls.length, 2);
    assert.equal(store.saveState(), "saved");
    assert.equal(store.saveProblem(), null);
  });

  it("treats a save response without a draft as an error", () => {
    const { api, clock, store } = setup();
    api.onSave = () => of({ draft: null, latest: null, validation: null });

    store.updateRule("rule-1", { sourcePath: "alpha" });
    clock.fire();
    assert.equal(store.saveState(), "error");
    assert.equal(store.saveProblem()?.code, "DRAFT_MISSING");
  });

  it("ignores a response that arrives after dispose", () => {
    const { api, clock, store } = setup();
    const pending = new Subject<MappingDraftView>();
    api.onSave = () => pending;

    store.updateRule("rule-1", { sourcePath: "alpha" });
    clock.fire();
    store.dispose();
    pending.next(draftView(9));

    assert.equal(store.revision(), 3);
    assert.equal(store.saveState(), "saving");
  });

  it("cancels a scheduled save on dispose", () => {
    const { api, clock, store } = setup();
    store.updateRule("rule-1", { sourcePath: "alpha" });
    assert.equal(clock.pending, 1);

    store.dispose();
    assert.equal(clock.pending, 0);
    assert.equal(api.saveCalls.length, 0);
  });
});

describe("MappingEditorStore conflicts", () => {
  function conflicted(currentRevision?: number) {
    const ctx = setup();
    ctx.api.onSave = () => throwError(() => conflict(currentRevision));
    ctx.store.updateRule("rule-1", { sourcePath: "mine" });
    ctx.clock.fire();
    return ctx;
  }

  it("stops autosave on a 409 DRAFT_CONFLICT and records the server revision", () => {
    const { api, clock, store } = conflicted(7);
    assert.equal(store.saveState(), "conflict");
    assert.equal(store.conflict()?.currentRevision, 7);
    assert.equal(store.canPublish(), false);

    store.updateRule("rule-1", { sourcePath: "mine too" });
    assert.equal(clock.pending, 0);
    assert.equal(store.saveState(), "conflict");

    store.flush();
    assert.equal(api.saveCalls.length, 1);
  });

  it("overwrites with the revision the server reported", () => {
    const { api, store } = conflicted(7);
    api.onSave = (_name, input) => of(draftView(input.revision + 1, input.spec));

    store.overwrite();
    assert.equal(api.saveCalls.length, 2);
    assert.equal(api.saveCalls[1]?.input.revision, 7);
    assert.deepEqual(api.saveCalls[1]?.input.spec, withSource(baseSpec(), "mine"));
    assert.equal(store.conflict(), null);
    assert.equal(store.saveState(), "saved");
    assert.equal(store.revision(), 8);
  });

  it("asks the server for its revision when the conflict response had none", () => {
    const { api, store } = conflicted();
    assert.equal(store.conflict()?.currentRevision, null);
    api.onGet = () => of(draftView(9));
    api.onSave = (_name, input) => of(draftView(input.revision + 1, input.spec));

    store.overwrite();
    assert.equal(api.getCalls.length, 2);
    assert.equal(api.saveCalls[1]?.input.revision, 9);
    assert.equal(store.saveState(), "saved");
    assert.equal(store.revision(), 10);
  });

  it("discards local edits when the author reloads the server draft", () => {
    const { api, store } = conflicted(7);
    api.onGet = () => of(draftView(7, withSource(baseSpec(), "theirs")));

    store.reloadServerDraft();
    assert.equal(store.conflict(), null);
    assert.equal(store.saveState(), "saved");
    assert.equal(store.revision(), 7);
    assert.equal(store.spec()?.rules[0]?.sourcePath, "theirs");
    assert.equal(store.dirty(), false);
    assert.equal(store.canUndo(), false);
  });
});

describe("MappingEditorStore publish", () => {
  it("publishes the saved revision and reloads the draft", () => {
    const { api, store } = setup(() => of(draftView(3)));
    assert.equal(store.canPublish(), true);

    store.publish();
    assert.deepEqual(api.publishCalls, [{ name: "lab", revision: 3 }]);
    assert.equal(store.lastPublished()?.mapping.version, 4);
    assert.equal(store.publishing(), false);
    assert.equal(api.getCalls.length, 2);
    assert.equal(store.announcement(), "Published version 4.");
  });

  it("does not publish while edits are unsaved", () => {
    const { api, store } = setup();
    store.updateRule("rule-1", { sourcePath: "alpha" });
    assert.equal(store.canPublish(), false);

    store.publish();
    assert.equal(api.publishCalls.length, 0);
  });

  it("keeps the draft publishable and shows the problem when the server refuses", () => {
    const { api, store } = setup();
    api.onPublish = () => throwError(() => problem(422, "MAPPING_INVALID"));

    store.publish();
    assert.equal(store.publishProblem()?.code, "MAPPING_INVALID");
    assert.equal(store.publishing(), false);
    assert.equal(store.lastPublished(), null);
    assert.equal(store.canPublish(), true);
  });

  it("moves to the conflict state when publishing hits a stale revision", () => {
    const { api, store } = setup();
    api.onPublish = () => throwError(() => conflict(6));

    store.publish();
    assert.equal(store.saveState(), "conflict");
    assert.equal(store.conflict()?.currentRevision, 6);
    assert.equal(store.publishProblem(), null);
  });
});
