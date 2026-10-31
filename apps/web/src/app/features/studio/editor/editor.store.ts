import { computed, signal } from "@angular/core";
import type { Signal } from "@angular/core";
import type { MappingDefinition, MappingRule, ValidationIssue } from "@healthbridge/shared-types";
import type { MappingValidationResult } from "@healthbridge/shared-types";
import type { ApiClient } from "../../../core/api-client";
import type {
  ApiProblem,
  MappingDraftView,
  MappingPreviewResponse,
  PublishMappingResponse,
} from "../../../core/api-types";
import {
  addRule as addRuleToSpec,
  blankSpec,
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  createHistory,
  hasBlockingIssue,
  isDirty,
  localChecks,
  moveRule as moveRuleInSpec,
  newRule,
  parseSpec,
  pushEdit,
  redo as redoHistory,
  removeRule as removeRuleFromSpec,
  setParam as setParamInSpec,
  undo as undoHistory,
  updateRule as updateRuleInSpec,
} from "./editor.logic";
import type { EditHistory, RulePatch } from "./editor.logic";

export const AUTOSAVE_DELAY_MS = 800;

/** The part of `ApiClient` the editor uses. Tests can pass a fake with just these methods. */
export type EditorApi = Pick<
  ApiClient,
  "getMappingDraft" | "saveMappingDraft" | "discardMappingDraft" | "publishMapping" | "previewMapping"
>;

/** Injectable clock and timers so Node tests can drive autosave without waiting. */
export interface EditorStoreOptions {
  debounceMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

/** Top-level spec fields the editor lets the author change. `id` and `name` follow the mapping name. */
export type SpecField = "version" | "sourceFormat" | "targetFormat";

export interface DraftConflict {
  /** The revision the server reported, or null when the response did not include one. */
  currentRevision: number | null;
}

function readCurrentRevision(problem: ApiProblem): number | null {
  const details = problem.details;
  if (typeof details !== "object" || details === null) return null;
  const revision = (details as { currentRevision?: unknown }).currentRevision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

function isDraftConflict(problem: ApiProblem): boolean {
  return problem.status === 409 && problem.code === "DRAFT_CONFLICT";
}

/**
 * Page-scoped store for the mapping editor.
 *
 * Autosave is explicit rather than an effect: every committed edit marks the draft `dirty` and
 * restarts an 800 ms timer, and `flush()` sends the draft. Only one save is in flight at a time.
 * On success the store adopts the revision from the response and keeps the edits made while the
 * request was out. A 409 `DRAFT_CONFLICT` stops autosave and is never retried silently: the author
 * either reloads the server draft or overwrites it. Network and server errors leave the draft dirty
 * so the author can retry.
 *
 * The server's validation response is authoritative. `localIssues` are quick checks for feedback
 * while typing and are labelled as such in the UI.
 */
export class MappingEditorStore {
  private readonly api: EditorApi;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly startTimer: (callback: () => void, ms: number) => unknown;
  private readonly stopTimer: (handle: unknown) => void;

  private readonly nameSignal = signal<string | null>(null);
  private loadToken = 0;
  private saveToken = 0;
  private publishToken = 0;
  private discardToken = 0;
  private previewToken = 0;
  private inFlight = false;
  private timer: unknown = null;
  /** Resolvers for `flushAndSettle()` calls waiting on a save or a conflict. */
  private readonly settleWaiters: Array<(settled: boolean) => void> = [];

  private readonly historySignal = signal<EditHistory | null>(null);
  private readonly baseSpecSignal = signal<MappingDefinition | null>(null);
  private readonly revisionSignal = signal(0);
  private readonly baseVersionSignal = signal<number | undefined>(undefined);
  private readonly saveStateSignal = signal<SaveState>("idle");
  private readonly saveProblemSignal = signal<ApiProblem | null>(null);
  private readonly validationSignal = signal<MappingValidationResult | null>(null);
  private readonly selectedRuleIdSignal = signal<string | null>(null);
  private readonly conflictSignal = signal<DraftConflict | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly problemSignal = signal<ApiProblem | null>(null);
  private readonly unreadableSignal = signal(false);
  private readonly announcementSignal = signal("");

  private readonly publishingSignal = signal(false);
  private readonly publishProblemSignal = signal<ApiProblem | null>(null);
  private readonly publishedSignal = signal<PublishMappingResponse | null>(null);

  private readonly discardingSignal = signal(false);
  private readonly discardProblemSignal = signal<ApiProblem | null>(null);

  private readonly previewingSignal = signal(false);
  private readonly previewSignal = signal<MappingPreviewResponse | null>(null);
  private readonly previewProblemSignal = signal<ApiProblem | null>(null);

  public readonly loading: Signal<boolean> = this.loadingSignal.asReadonly();
  /** Set when loading the draft failed. */
  public readonly problem: Signal<ApiProblem | null> = this.problemSignal.asReadonly();
  /** True when the stored spec is not a shape the editor can work on. */
  public readonly unreadable: Signal<boolean> = this.unreadableSignal.asReadonly();

  public readonly saveState: Signal<SaveState> = this.saveStateSignal.asReadonly();
  /** Set when the last save failed for a reason other than a conflict. */
  public readonly saveProblem: Signal<ApiProblem | null> = this.saveProblemSignal.asReadonly();
  public readonly conflict: Signal<DraftConflict | null> = this.conflictSignal.asReadonly();
  public readonly revision: Signal<number> = this.revisionSignal.asReadonly();
  public readonly baseVersion: Signal<number | undefined> = this.baseVersionSignal.asReadonly();
  /** Result of the server's validation of the last saved draft. */
  public readonly validation: Signal<MappingValidationResult | null> = this.validationSignal.asReadonly();
  public readonly selectedRuleId: Signal<string | null> = this.selectedRuleIdSignal.asReadonly();
  /** Text for an `aria-live` region. */
  public readonly announcement: Signal<string> = this.announcementSignal.asReadonly();

  public readonly publishing: Signal<boolean> = this.publishingSignal.asReadonly();
  public readonly publishProblem: Signal<ApiProblem | null> = this.publishProblemSignal.asReadonly();
  public readonly lastPublished: Signal<PublishMappingResponse | null> = this.publishedSignal.asReadonly();

  public readonly discarding: Signal<boolean> = this.discardingSignal.asReadonly();
  /** Set when discarding the server draft failed for a reason other than a conflict. */
  public readonly discardProblem: Signal<ApiProblem | null> = this.discardProblemSignal.asReadonly();

  public readonly previewing: Signal<boolean> = this.previewingSignal.asReadonly();
  public readonly preview: Signal<MappingPreviewResponse | null> = this.previewSignal.asReadonly();
  public readonly previewProblem: Signal<ApiProblem | null> = this.previewProblemSignal.asReadonly();

  public readonly spec: Signal<MappingDefinition | null> = computed(() => this.historySignal()?.present ?? null);
  public readonly baseSpec: Signal<MappingDefinition | null> = this.baseSpecSignal.asReadonly();

  public readonly selectedRule: Signal<MappingRule | null> = computed(() => {
    const spec = this.spec();
    const id = this.selectedRuleIdSignal();
    if (spec === null || id === null) return null;
    return spec.rules.find((rule) => rule.id === id) ?? null;
  });

  public readonly canUndo: Signal<boolean> = computed(() => {
    const history = this.historySignal();
    return history !== null && historyCanUndo(history);
  });

  public readonly canRedo: Signal<boolean> = computed(() => {
    const history = this.historySignal();
    return history !== null && historyCanRedo(history);
  });

  /** True when the working spec differs from the last saved or loaded spec. */
  public readonly dirty: Signal<boolean> = computed(() => {
    const spec = this.spec();
    return spec !== null && isDirty(spec, this.baseSpecSignal());
  });

  /** Quick client-side checks. Not a substitute for the server's validation. */
  public readonly localIssues: Signal<ValidationIssue[]> = computed(() => {
    const spec = this.spec();
    return spec === null ? [] : localChecks(spec);
  });

  public readonly hasLocalBlockingIssue: Signal<boolean> = computed(() => hasBlockingIssue(this.localIssues()));

  /** True when the server's last validation found fatal or error issues. Warnings never block. */
  public readonly hasServerBlockingIssue: Signal<boolean> = computed(() => {
    const validation = this.validationSignal();
    return validation !== null && (validation.counts.fatal > 0 || validation.counts.error > 0);
  });

  /** Publishing needs a saved draft, so it waits for any pending edit or conflict. */
  public readonly canPublish: Signal<boolean> = computed(
    () =>
      this.spec() !== null &&
      this.saveStateSignal() === "saved" &&
      this.revisionSignal() > 0 &&
      this.conflictSignal() === null &&
      this.problemSignal() === null &&
      !this.publishingSignal() &&
      !this.loadingSignal() &&
      !this.discardingSignal() &&
      !this.hasServerBlockingIssue(),
  );

  /** A server draft exists, nothing else is running, and the spec is editable. */
  public readonly canDiscard: Signal<boolean> = computed(
    () =>
      this.nameSignal() !== null &&
      this.spec() !== null &&
      this.revisionSignal() > 0 &&
      this.saveStateSignal() !== "saving" &&
      this.conflictSignal() === null &&
      this.problemSignal() === null &&
      !this.publishingSignal() &&
      !this.loadingSignal() &&
      !this.discardingSignal(),
  );

  public constructor(api: EditorApi, options: EditorStoreOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DELAY_MS;
    this.now = options.now ?? (() => Date.now());
    this.startTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.stopTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Cancels the autosave timer and makes in-flight responses harmless. Call when the page is destroyed. */
  public dispose(): void {
    this.clearTimer();
    this.inFlight = false;
    this.saveToken++;
    this.loadToken++;
    this.publishToken++;
    this.discardToken++;
    this.previewToken++;
    this.publishingSignal.set(false);
    this.discardingSignal.set(false);
    this.previewingSignal.set(false);
    this.resolveSettleWaiters(false);
  }

  /* ------------------------------------------------------------------------ */
  /* Loading                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Loads the draft for `name`, or the latest version when no draft exists. Errors never throw. */
  public load(name: string): void {
    if (this.nameSignal() !== name) {
      this.publishedSignal.set(null);
      this.publishProblemSignal.set(null);
    }
    this.nameSignal.set(name);
    this.discardProblemSignal.set(null);
    this.resetForLoad();

    const token = ++this.loadToken;
    this.loadingSignal.set(true);
    this.problemSignal.set(null);

    this.api.getMappingDraft(name).subscribe({
      next: (view) => {
        if (token !== this.loadToken) return;
        this.adoptView(name, view);
        this.loadingSignal.set(false);
      },
      error: (error: ApiProblem) => {
        if (token !== this.loadToken) return;
        this.problemSignal.set(error);
        this.loadingSignal.set(false);
      },
    });
  }

  private resetForLoad(): void {
    this.clearTimer();
    this.saveToken++;
    this.discardToken++;
    this.previewToken++;
    this.inFlight = false;
    this.discardingSignal.set(false);
    this.conflictSignal.set(null);
    this.saveProblemSignal.set(null);
    this.previewSignal.set(null);
    this.previewProblemSignal.set(null);
    this.previewingSignal.set(false);
    this.resolveSettleWaiters(false);
  }

  private adoptView(name: string, view: MappingDraftView): void {
    const draft = view.draft;
    const source: unknown = draft !== null ? draft.spec : (view.latest?.spec ?? undefined);
    const spec = source === undefined ? blankSpec(name) : parseSpec(source);

    this.revisionSignal.set(draft?.revision ?? 0);
    this.baseVersionSignal.set(draft !== null ? draft.baseVersion : view.latest?.version);
    this.validationSignal.set(view.validation);
    this.saveStateSignal.set(draft !== null ? "saved" : "idle");

    if (spec === null) {
      this.unreadableSignal.set(true);
      this.historySignal.set(null);
      this.baseSpecSignal.set(null);
      this.selectedRuleIdSignal.set(null);
      return;
    }

    this.unreadableSignal.set(false);
    this.historySignal.set(createHistory(spec));
    this.baseSpecSignal.set(spec);
    this.selectedRuleIdSignal.set(spec.rules[0]?.id ?? null);
  }

  /* ------------------------------------------------------------------------ */
  /* Edits                                                                    */
  /* ------------------------------------------------------------------------ */

  public selectRule(ruleId: string | null): void {
    this.selectedRuleIdSignal.set(ruleId);
  }

  public addRule(index?: number): void {
    const history = this.historySignal();
    if (history === null) return;
    const rule = newRule(history.present);
    this.commit(addRuleToSpec(history.present, rule, index));
    this.selectedRuleIdSignal.set(rule.id);
  }

  public removeRule(ruleId: string): void {
    const history = this.historySignal();
    if (history === null) return;
    const index = history.present.rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return;

    const next = removeRuleFromSpec(history.present, ruleId);
    this.commit(next);
    if (this.selectedRuleIdSignal() === ruleId) {
      this.selectedRuleIdSignal.set(next.rules[Math.min(index, next.rules.length - 1)]?.id ?? null);
    }
  }

  public moveRule(ruleId: string, toIndex: number): void {
    const history = this.historySignal();
    if (history === null) return;
    this.commit(moveRuleInSpec(history.present, ruleId, toIndex));
  }

  /** A patch that touches one field is keyed by it, so rapid typing in that field becomes one undo step. */
  public updateRule(ruleId: string, patch: RulePatch): void {
    const history = this.historySignal();
    if (history === null) return;
    const fields = Object.keys(patch);
    const key = fields.length === 1 ? `${ruleId}.${fields[0]}` : undefined;
    this.commit(updateRuleInSpec(history.present, ruleId, patch), key);
  }

  public setParam(ruleId: string, param: string, value: unknown): void {
    const history = this.historySignal();
    if (history === null) return;
    this.commit(setParamInSpec(history.present, ruleId, param, value), `${ruleId}.params.${param}`);
  }

  public updateField(field: SpecField, value: string): void {
    const history = this.historySignal();
    if (history === null) return;
    this.commit({ ...history.present, [field]: value }, `spec.${field}`);
  }

  /** Replaces the working spec after an import: history resets and the draft becomes dirty. */
  public replaceSpec(spec: MappingDefinition): void {
    if (this.historySignal() === null || this.editingLocked()) return;
    this.historySignal.set(createHistory(spec));
    this.selectedRuleIdSignal.set(spec.rules[0]?.id ?? null);
    this.announce("Imported mapping definition.");
    this.afterChange();
  }

  public undo(): void {
    const history = this.historySignal();
    if (history === null || this.editingLocked()) return;
    this.historySignal.set(undoHistory(history));
    this.keepSelectionValid();
    this.afterChange();
  }

  public redo(): void {
    const history = this.historySignal();
    if (history === null || this.editingLocked()) return;
    this.historySignal.set(redoHistory(history));
    this.keepSelectionValid();
    this.afterChange();
  }

  private editingLocked(): boolean {
    return this.publishingSignal() || this.loadingSignal() || this.discardingSignal();
  }

  private commit(next: MappingDefinition, key?: string): void {
    const history = this.historySignal();
    if (history === null || this.editingLocked()) return;

    const now = this.now();
    const updated = pushEdit(history, next, key === undefined ? { now } : { key, now });
    if (updated === history) return;
    this.historySignal.set(updated);
    this.afterChange();
  }

  private keepSelectionValid(): void {
    const spec = this.spec();
    const id = this.selectedRuleIdSignal();
    if (spec === null || id === null) return;
    if (!spec.rules.some((rule) => rule.id === id)) {
      this.selectedRuleIdSignal.set(spec.rules[0]?.id ?? null);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Autosave                                                                 */
  /* ------------------------------------------------------------------------ */

  private afterChange(): void {
    // A conflict stops autosave until the author resolves it, and a request in flight
    // reschedules itself when it returns.
    if (this.conflictSignal() !== null || this.inFlight) return;

    if (!this.dirty()) {
      this.clearTimer();
      this.saveStateSignal.set(this.revisionSignal() > 0 ? "saved" : "idle");
      return;
    }

    this.saveStateSignal.set("dirty");
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = this.startTimer(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.stopTimer(this.timer);
      this.timer = null;
    }
  }

  /** Saves the draft now. Does nothing while a save is in flight or a conflict is unresolved. */
  public flush(): void {
    this.clearTimer();
    if (this.conflictSignal() !== null) return;
    this.send(false);
  }

  /**
   * Saves pending changes and resolves once the draft is clean.
   *
   * Resolves true when the draft is clean and no save is in flight (including the case where
   * there was nothing to save). Resolves false when a conflict is open, a save fails, or the
   * store is disposed while waiting. A pending debounce timer is flushed immediately, and edits
   * made during a save are flushed again before the promise settles.
   */
  public flushAndSettle(): Promise<boolean> {
    this.clearTimer();

    if (this.conflictSignal() !== null) return Promise.resolve(false);
    if (this.saveStateSignal() === "error" && !this.dirty()) return Promise.resolve(false);

    const pending =
      this.dirty() || this.inFlight || this.saveStateSignal() === "saving" || this.saveStateSignal() === "error";
    if (!pending) return Promise.resolve(true);

    const settled = new Promise<boolean>((resolve) => {
      this.settleWaiters.push(resolve);
    });

    if (!this.inFlight) {
      if (!this.dirty()) {
        // `saving`/`error` without a request or unsaved edits cannot make progress.
        this.resolveSettleWaiters(false);
        return settled;
      }
      const token = this.saveToken;
      this.send(false, true);
      if (!this.inFlight && this.saveToken === token) this.resolveSettleWaiters(false);
    }

    return settled;
  }

  private resolveSettleWaiters(settled: boolean): void {
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve(settled);
  }

  /** Called after a save succeeds or fails: continue flushing while dirty, or settle. */
  private settleAfterSave(): void {
    if (this.settleWaiters.length === 0) return;

    if (this.conflictSignal() !== null || this.saveStateSignal() === "error") {
      this.resolveSettleWaiters(false);
      return;
    }

    if (this.dirty()) {
      this.clearTimer();
      const token = this.saveToken;
      this.send(false, true);
      if (!this.inFlight && this.saveToken === token) this.resolveSettleWaiters(false);
      return;
    }

    this.resolveSettleWaiters(true);
  }

  private send(force: boolean, allowWhilePublishing = false): void {
    const name = this.nameSignal();
    const history = this.historySignal();
    if (name === null || history === null || this.inFlight || (this.publishingSignal() && !allowWhilePublishing)) {
      return;
    }

    const sent = history.present;
    if (!force && !isDirty(sent, this.baseSpecSignal())) return;

    const token = ++this.saveToken;
    const baseVersion = this.baseVersionSignal();
    const input = {
      spec: sent,
      revision: this.revisionSignal(),
      ...(baseVersion === undefined ? {} : { baseVersion }),
    };

    this.inFlight = true;
    this.saveProblemSignal.set(null);
    this.saveStateSignal.set("saving");

    this.api.saveMappingDraft(name, input).subscribe({
      next: (view) => {
        if (token !== this.saveToken) return;
        this.inFlight = false;

        const draft = view.draft;
        if (draft === null) {
          this.saveProblemSignal.set({
            status: 0,
            code: "DRAFT_MISSING",
            message: "The server did not return the saved draft.",
          });
          this.saveStateSignal.set("error");
          this.settleAfterSave();
          return;
        }

        this.revisionSignal.set(draft.revision);
        this.baseSpecSignal.set(sent);
        this.validationSignal.set(view.validation);

        // Edits made while the request was out are still unsaved: send them next.
        if (this.dirty()) {
          this.saveStateSignal.set("dirty");
          this.schedule();
        } else {
          this.saveStateSignal.set("saved");
        }
        this.settleAfterSave();
      },
      error: (error: ApiProblem) => {
        if (token !== this.saveToken) return;
        this.inFlight = false;

        if (isDraftConflict(error)) {
          this.conflictSignal.set({ currentRevision: readCurrentRevision(error) });
          this.saveStateSignal.set("conflict");
          this.announce("The draft was changed elsewhere. Reload the server draft or overwrite it.");
          this.resolveSettleWaiters(false);
          return;
        }

        this.saveProblemSignal.set(error);
        this.saveStateSignal.set("error");
        this.resolveSettleWaiters(false);
      },
    });
  }

  /** Retries after a network or server error. */
  public retrySave(): void {
    if (this.saveStateSignal() !== "error") return;
    this.saveStateSignal.set("dirty");
    this.flush();
  }

  /* ------------------------------------------------------------------------ */
  /* Conflict resolution                                                      */
  /* ------------------------------------------------------------------------ */

  /** Throws away local edits and history and loads the server's draft. */
  public reloadServerDraft(): void {
    const name = this.nameSignal();
    if (name === null || this.conflictSignal() === null) return;
    this.announce("Reloaded the server draft. Local changes were discarded.");
    this.load(name);
  }

  /** Saves the local spec over the server's draft, using the server's current revision. */
  public overwrite(): void {
    const name = this.nameSignal();
    const conflict = this.conflictSignal();
    if (name === null || conflict === null || this.inFlight) return;

    if (conflict.currentRevision !== null) {
      this.overwriteAt(conflict.currentRevision);
      return;
    }

    // The conflict response had no revision, so ask the server for it.
    const token = ++this.saveToken;
    this.inFlight = true;
    this.saveStateSignal.set("saving");
    this.api.getMappingDraft(name).subscribe({
      next: (view) => {
        if (token !== this.saveToken) return;
        this.inFlight = false;
        this.overwriteAt(view.draft?.revision ?? 0);
      },
      error: (error: ApiProblem) => {
        if (token !== this.saveToken) return;
        this.inFlight = false;
        this.saveProblemSignal.set(error);
        this.saveStateSignal.set("conflict");
      },
    });
  }

  private overwriteAt(revision: number): void {
    this.revisionSignal.set(revision);
    this.conflictSignal.set(null);
    this.saveProblemSignal.set(null);
    this.announce("Overwriting the server draft with your changes.");
    this.send(true);
  }

  /* ------------------------------------------------------------------------ */
  /* Publish and preview                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Publishes the draft. Pending edits are saved first; the server validates the saved draft
   * again and can refuse. The POST starts synchronously when there is nothing to save.
   */
  public publish(): void {
    const name = this.nameSignal();
    if (
      name === null ||
      this.spec() === null ||
      this.publishingSignal() ||
      this.loadingSignal() ||
      this.discardingSignal() ||
      this.problemSignal() !== null ||
      this.conflictSignal() !== null
    ) {
      return;
    }

    const pendingChanges =
      this.dirty() || this.inFlight || this.saveStateSignal() === "saving" || this.saveStateSignal() === "error";

    if (!pendingChanges) {
      if (this.hasServerBlockingIssue() || this.revisionSignal() <= 0) return;
      this.startPublish(name);
      return;
    }

    const token = ++this.publishToken;
    this.publishingSignal.set(true);
    this.publishProblemSignal.set(null);

    void this.flushAndSettle().then((settled) => {
      if (token !== this.publishToken) return;

      if (!settled) {
        this.publishingSignal.set(false);
        this.announce("The draft could not be saved, so it was not published.");
        return;
      }
      if (this.hasServerBlockingIssue()) {
        this.publishingSignal.set(false);
        this.announce("The server validation found errors, so the draft was not published.");
        return;
      }
      if (this.revisionSignal() <= 0) {
        this.publishingSignal.set(false);
        return;
      }
      this.startPublish(name);
    });
  }

  private startPublish(name: string): void {
    const token = ++this.publishToken;
    this.publishingSignal.set(true);
    this.publishProblemSignal.set(null);

    this.api.publishMapping(name, this.revisionSignal()).subscribe({
      next: (result) => {
        if (token !== this.publishToken) return;
        this.publishingSignal.set(false);
        this.publishedSignal.set(result);
        this.announce(`Published version ${result.mapping.version}.`);
        this.load(name);
      },
      error: (error: ApiProblem) => {
        if (token !== this.publishToken) return;
        this.publishingSignal.set(false);
        if (isDraftConflict(error)) {
          this.conflictSignal.set({ currentRevision: readCurrentRevision(error) });
          this.saveStateSignal.set("conflict");
          this.announce("The draft was changed elsewhere. Reload the server draft or overwrite it.");
          return;
        }
        this.publishProblemSignal.set(error);
      },
    });
  }

  /**
   * Discards the server draft, keeping the latest published version. The saved revision is sent
   * so a newer draft written by someone else is never destroyed.
   */
  public discard(): void {
    const name = this.nameSignal();
    if (name === null || !this.canDiscard()) return;

    this.clearTimer();
    const token = ++this.discardToken;
    this.discardingSignal.set(true);
    this.discardProblemSignal.set(null);

    this.api.discardMappingDraft(name, this.revisionSignal()).subscribe({
      next: () => {
        if (token !== this.discardToken) return;
        this.discardingSignal.set(false);
        this.announce("Draft discarded.");
        this.load(name);
      },
      error: (error: ApiProblem) => {
        if (token !== this.discardToken) return;
        this.discardingSignal.set(false);

        if (isDraftConflict(error)) {
          this.conflictSignal.set({ currentRevision: readCurrentRevision(error) });
          this.saveStateSignal.set("conflict");
          this.announce("The draft was changed elsewhere. Reload the server draft or overwrite it.");
          return;
        }

        this.discardProblemSignal.set(error);
      },
    });
  }

  /** Runs the current working spec against one stored asset. Nothing is written. */
  public runPreview(assetId: string, maxRecords?: number): void {
    const spec = this.spec();
    if (spec === null) return;

    const token = ++this.previewToken;
    this.previewingSignal.set(true);
    this.previewProblemSignal.set(null);

    const input = { spec, assetId, ...(maxRecords === undefined ? {} : { maxRecords }) };
    this.api.previewMapping(input).subscribe({
      next: (result) => {
        if (token !== this.previewToken) return;
        this.previewSignal.set(result);
        this.previewingSignal.set(false);
      },
      error: (error: ApiProblem) => {
        if (token !== this.previewToken) return;
        this.previewProblemSignal.set(error);
        this.previewingSignal.set(false);
      },
    });
  }

  private announce(message: string): void {
    this.announcementSignal.set(message);
  }
}
