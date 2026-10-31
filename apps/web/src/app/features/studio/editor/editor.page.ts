import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { combineLatest } from "rxjs";
import type { MappingDefinition, RuleCondition } from "@healthbridge/shared-types";
import { ApiClient } from "../../../core/api-client";
import type { ApiProblem, Asset, Mapping, MappingDiffResponse } from "../../../core/api-types";
import { formatBytes } from "../../../core/format";
import { isMappingSlug } from "../../../core/navigation";
import { ErrorPanel, LoadingState } from "../../../ui/primitives";
import { MappingEditorStore } from "./editor.store";
import type { SpecField } from "./editor.store";
import { parseSpec } from "./editor.logic";
import { IssueList } from "./issue-list";
import { PreviewPanel } from "./preview-panel";
import { RuleForm } from "./rule-form";
import { RuleList } from "./rule-list";
import type { RuleMove } from "./rule-list";
import { SaveStatus } from "./save-status";
import { VersionDiff } from "./version-diff";
import type { HasUnsavedChanges } from "./unsaved-changes.guard";

let nextPageId = 0;

type EditorMode = "edit" | "readonly";

interface VersionOption {
  readonly value: string;
  readonly label: string;
}

const POSITIVE_INTEGER_PATTERN = /^\d+$/;
const PREVIEW_LIMIT_DEFAULT = 100;
const PREVIEW_LIMIT_INITIAL = 25;

/**
 * Mapping editor.
 *
 * `/studio/mappings/:name` edits the server-side draft; `?version=N` opens one published version
 * read-only and never asks for the draft. The store owns autosave, undo/redo, conflict handling,
 * publishing and previews; this page wires it to the child components, the preview asset picker,
 * the version diff and import/export. The store is provided per page, so leaving the page
 * discards it.
 *
 * Angular reuses this component on param-only navigation, so the page watches both `paramMap` and
 * `queryParamMap`, dedupes on the route key, resets all page state on a real change, and blocks
 * switching to another mapping (or mode) while the draft is dirty by restoring the previous URL.
 */
@Component({
  selector: "hb-mapping-editor-page",
  standalone: true,
  imports: [RouterLink, ErrorPanel, LoadingState, RuleList, RuleForm, IssueList, PreviewPanel, SaveStatus, VersionDiff],
  providers: [{ provide: MappingEditorStore, useFactory: () => new MappingEditorStore(inject(ApiClient)) }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Mapping editor</h1>
        @if (mode() === "edit") {
          <p>
            Editing the draft of <span class="mono">{{ name() }}</span
            >. Changes are saved automatically as a draft.
          </p>
        } @else {
          <p>Published versions are read-only in the Studio.</p>
        }
      </div>
      <div class="actions">
        @if (mode() === "edit") {
          @if (!invalidName()) {
            <button type="button" class="small" (click)="undo()" [disabled]="!store.canUndo()">Undo</button>
            <button type="button" class="small" (click)="redo()" [disabled]="!store.canRedo()">Redo</button>
            <button type="button" class="small" (click)="publish()" [disabled]="!canPublishNow()">
              {{ store.publishing() ? "Publishing…" : "Publish" }}
            </button>
            <button
              type="button"
              class="small"
              (click)="exportJson()"
              [disabled]="store.publishing() || store.spec() === null"
            >
              Export JSON
            </button>
            <button
              type="button"
              class="small"
              (click)="importInput.click()"
              [disabled]="store.publishing() || store.loading() || store.spec() === null"
            >
              Import JSON
            </button>
            <input #importInput hidden type="file" accept="application/json" (change)="onImport($event)" />
          }
        } @else {
          <a class="button small" [routerLink]="['/studio/mappings', name()]">Edit latest</a>
        }
        <a class="button small" routerLink="/studio">Back to Studio</a>
      </div>
    </div>

    <div class="sr-only" role="status" aria-live="polite">{{ pageAnnouncement() }}</div>
    <div class="sr-only" role="status" aria-live="polite">{{ store.announcement() }}</div>

    @if (draftStatusLabel(); as label) {
      <p class="card-sub">{{ label }}</p>
    }

    @if (mode() === "edit" && store.hasServerBlockingIssue()) {
      <p class="meta" role="note">
        The last server validation found {{ blockingIssueCount() }} blocking issue(s). Fix them before publishing.
      </p>
    }

    @if (invalidName()) {
      <p class="banner" role="alert">This mapping name is not valid.</p>
    }
    @if (invalidVersion()) {
      <p class="banner" role="alert">Version must be a positive whole number.</p>
    }
    @if (routeNotice(); as notice) {
      <p class="banner" role="alert">{{ notice }}</p>
    }
    @if (importProblem(); as message) {
      <p class="banner" role="alert">{{ message }}</p>
    }

    @if (leaveTarget() !== null) {
      <div class="banner" role="alert">
        <p style="margin: 0 0 var(--space-2)"><strong>Your latest changes could not be saved.</strong></p>
        <div class="actions">
          <button type="button" class="small" (click)="retryLeave()">Retry save</button>
          <button type="button" class="small" (click)="discardAndLeave()">Discard and leave</button>
        </div>
      </div>
    }

    @if (mode() === "readonly" && !invalidName() && !invalidVersion()) {
      @if (readOnlyProblem(); as issue) {
        <hb-error [problem]="issue" [showRetry]="true" (retry)="retryReadOnly()" />
      }
      @if (readOnlyLoading()) {
        <hb-loading label="Loading the published version…" />
      }
      @if (readOnlyMissing()) {
        <p class="banner" role="alert">Version {{ readOnlyVersionNumber() }} was not found for this mapping.</p>
      }
      @if (readOnlyVersion(); as mapping) {
        <p class="banner" role="note">Read-only published version {{ mapping.version }} — not editable.</p>
        <section class="card" [attr.aria-labelledby]="id + '-readonly-heading'">
          <h2 id="{{ id }}-readonly-heading">Published mapping</h2>
          <dl class="kv">
            <dt>Mapping</dt>
            <dd class="mono">{{ mapping.name }}</dd>
            <dt>Version</dt>
            <dd>v{{ mapping.version }}</dd>
            <dt>Source format</dt>
            <dd class="mono">{{ mapping.sourceFormat }}</dd>
            <dt>Target format</dt>
            <dd class="mono">{{ mapping.targetFormat }}</dd>
          </dl>

          <h3 style="margin-top: var(--space-4)">Rules</h3>
          @if (readOnlySpec(); as versionSpec) {
            @if (versionSpec.rules.length === 0) {
              <p class="meta">This version has no rules.</p>
            } @else {
              <ul>
                @for (rule of versionSpec.rules; track rule.id) {
                  <li style="margin-bottom: var(--space-3)">
                    <div class="row">
                      <span class="mono">{{ rule.sourcePath || "(no source)" }}</span>
                      <span aria-hidden="true">→</span>
                      <span class="mono">{{ rule.targetPath || "(no target)" }}</span>
                      <span class="meta">· {{ rule.transform }}</span>
                    </div>
                    @if (rule.description) {
                      <p class="meta">{{ rule.description }}</p>
                    }
                    @if ((rule.when ?? []).length > 0) {
                      <p class="meta">Conditions:</p>
                      <ul>
                        @for (condition of rule.when ?? []; track $index) {
                          <li class="meta">{{ conditionText(condition) }}</li>
                        }
                      </ul>
                    }
                  </li>
                }
              </ul>
            }
          } @else {
            <p class="meta">The stored version is not in a shape the editor can display.</p>
          }
        </section>
      }
    }

    @if (mode() === "edit" && !invalidName()) {
      @if (store.problem(); as issue) {
        <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      }

      @if (store.loading()) {
        <hb-loading label="Loading the draft…" />
      }

      @if (store.unreadable()) {
        <p class="banner" role="alert">
          The stored draft is not in a shape the editor can work on, so it was left untouched.
        </p>
      }

      @if (store.spec(); as spec) {
        <section class="card" [attr.aria-labelledby]="id + '-status-heading'">
          <h2 id="{{ id }}-status-heading">Draft status</h2>
          <hb-save-status
            [state]="store.saveState()"
            [revision]="store.revision()"
            [problem]="store.saveProblem()"
            [conflict]="store.conflict()"
            (retry)="store.retrySave()"
            (reload)="store.reloadServerDraft()"
            (overwrite)="store.overwrite()"
          />

          <div class="row" style="margin-top: 8px">
            <button
              type="button"
              class="small"
              (click)="discardConfirm.set(true)"
              [disabled]="!store.canDiscard() || discardConfirm()"
            >
              Discard draft
            </button>
          </div>

          @if (discardConfirm()) {
            <div class="banner" role="group" aria-label="Discard draft confirmation" style="margin-top: var(--space-3)">
              <p style="margin: 0 0 var(--space-2)">Discard the server draft? The latest published version is kept.</p>
              <div class="actions">
                <button type="button" class="small" (click)="confirmDiscard()" [disabled]="store.discarding()">
                  {{ store.discarding() ? "Discarding…" : "Discard draft" }}
                </button>
                <button type="button" class="small" (click)="discardConfirm.set(false)">Cancel</button>
              </div>
            </div>
          }

          @if (store.discardProblem(); as issue) {
            <hb-error [problem]="issue" />
          }

          @if (store.publishProblem(); as issue) {
            <hb-error [problem]="issue" />
          }

          @if (store.lastPublished(); as published) {
            <p class="banner" role="status">
              @if (published.created) {
                Published {{ published.mapping.name }} as version {{ published.mapping.version }}.
              } @else {
                {{ published.mapping.name }} version {{ published.mapping.version }} already matches this draft.
              }
              @if (published.draftRetained) {
                The draft could not be removed and is still available.
              }
              <a routerLink="/mappings">All mappings</a>
            </p>
          }
        </section>

        <section class="card" [attr.aria-labelledby]="id + '-fields-heading'">
          <h2 id="{{ id }}-fields-heading">Mapping</h2>
          <div class="grid cols-3">
            <div class="field">
              <label for="{{ id }}-version">Version</label>
              <input
                id="{{ id }}-version"
                type="text"
                autocomplete="off"
                [value]="spec.version"
                (input)="onField('version', $event)"
              />
            </div>
            <div class="field">
              <label for="{{ id }}-source">Source format</label>
              <input
                id="{{ id }}-source"
                type="text"
                autocomplete="off"
                [value]="spec.sourceFormat"
                (input)="onField('sourceFormat', $event)"
              />
            </div>
            <div class="field">
              <label for="{{ id }}-target">Target format</label>
              <input
                id="{{ id }}-target"
                type="text"
                autocomplete="off"
                [value]="spec.targetFormat"
                (input)="onField('targetFormat', $event)"
              />
            </div>
          </div>
        </section>

        <div class="grid cols-2">
          <section class="card" [attr.aria-labelledby]="id + '-rules-heading'">
            <h2 id="{{ id }}-rules-heading">Rules</h2>
            <hb-rule-list
              [rules]="spec.rules"
              [selectedId]="store.selectedRuleId()"
              (selectRule)="store.selectRule($event)"
              (add)="onAddRule()"
              (remove)="onRemoveRule($event)"
              (move)="onMoveRule($event)"
            />
          </section>

          <section class="card" [attr.aria-labelledby]="id + '-rule-heading'">
            <h2 id="{{ id }}-rule-heading">Rule details</h2>
            @if (store.selectedRule(); as rule) {
              <hb-rule-form
                [rule]="rule"
                (ruleChange)="store.updateRule(rule.id, $event)"
                (paramChange)="store.setParam(rule.id, $event.key, $event.value)"
              />
            } @else {
              <p class="subtle">Select a rule to edit it.</p>
            }
          </section>
        </div>

        <div class="grid cols-2">
          <section class="card" [attr.aria-labelledby]="id + '-local-heading'">
            <h2 id="{{ id }}-local-heading">Local checks</h2>
            <p class="card-sub">Quick checks in the browser. The server validates again on save.</p>
            <hb-issue-list
              heading="Local checks"
              emptyText="No local issues."
              [issues]="store.localIssues()"
              (selectRule)="store.selectRule($event)"
            />
          </section>

          <section class="card" [attr.aria-labelledby]="id + '-server-heading'">
            <h2 id="{{ id }}-server-heading">Server validation</h2>
            <p class="card-sub">Result for the last saved draft.</p>
            @if (store.validation(); as validation) {
              <hb-issue-list
                heading="Server validation"
                emptyText="The server found no issues."
                [issues]="validation.issues"
                (selectRule)="store.selectRule($event)"
              />
            } @else {
              <p class="subtle">Nothing has been validated yet.</p>
            }
          </section>
        </div>

        <section class="card" [attr.aria-labelledby]="id + '-preview-heading'">
          <h2 id="{{ id }}-preview-heading">Preview</h2>
          <p class="card-sub">Run the current draft against a stored asset. Nothing is written.</p>

          @if (assetsProblem(); as issue) {
            <hb-error [problem]="issue" [showRetry]="true" (retry)="loadAssets()" />
          }

          <div class="row">
            <div class="field">
              <label for="{{ id }}-asset">Asset</label>
              <select id="{{ id }}-asset" (change)="onAsset($event)" [disabled]="assetsLoading()">
                <option value="" [selected]="assetId() === ''">
                  {{
                    assetsLoading()
                      ? "Loading assets…"
                      : assets().length === 0
                        ? "No assets available"
                        : "Choose an asset"
                  }}
                </option>
                @for (asset of assets(); track asset.id) {
                  <option [value]="asset.id" [selected]="asset.id === assetId()">
                    {{ asset.filename }} · {{ bytes(asset.sizeBytes) }}
                  </option>
                }
              </select>
            </div>
            <div class="field">
              <label for="{{ id }}-record-limit">Record limit</label>
              <input
                id="{{ id }}-record-limit"
                type="number"
                min="1"
                step="1"
                [attr.max]="maxPreviewRecords()"
                [value]="recordLimitInput()"
                (input)="onRecordLimit($event)"
              />
              @if (recordLimitProblem(); as message) {
                <p class="meta" role="alert">{{ message }}</p>
              }
            </div>
            <button type="button" (click)="runPreview()" [disabled]="!canPreview()">
              {{ store.previewing() ? "Running preview…" : "Run preview" }}
            </button>
          </div>

          <hb-preview-panel
            [result]="store.preview()"
            [previewing]="store.previewing()"
            [problem]="store.previewProblem()"
            (selectRule)="store.selectRule($event)"
          />
        </section>
      }

      <section class="card" [attr.aria-labelledby]="id + '-diff-heading'">
        <h2 id="{{ id }}-diff-heading">Version diff</h2>
        <p class="card-sub">
          Compare a published version, the latest version or the current draft. The server computes the differences.
        </p>

        @if (versionsProblem(); as issue) {
          <hb-error [problem]="issue" [showRetry]="true" (retry)="loadVersions()" />
        }

        <div class="row">
          <div class="field">
            <label for="{{ id }}-diff-from">From</label>
            <select id="{{ id }}-diff-from" (change)="diffFrom.set(selectValue($event))">
              <option value="latest" [selected]="diffFrom() === 'latest'">latest</option>
              <option value="draft" [selected]="diffFrom() === 'draft'">draft</option>
              @for (option of versionOptions(); track option.value) {
                <option [value]="option.value" [selected]="diffFrom() === option.value">{{ option.label }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="{{ id }}-diff-to">To</label>
            <select id="{{ id }}-diff-to" (change)="diffTo.set(selectValue($event))">
              <option value="latest" [selected]="diffTo() === 'latest'">latest</option>
              <option value="draft" [selected]="diffTo() === 'draft'">draft</option>
              @for (option of versionOptions(); track option.value) {
                <option [value]="option.value" [selected]="diffTo() === option.value">{{ option.label }}</option>
              }
            </select>
          </div>
          <button type="button" (click)="compareVersions()" [disabled]="diffLoading() || versionsLoading()">
            Compare versions
          </button>
        </div>

        <hb-version-diff
          [response]="diffResponse()"
          [loading]="diffLoading()"
          [problem]="diffProblem()"
          [fromLabel]="diffFromLabel()"
          [toLabel]="diffToLabel()"
        />
      </section>
    }
  `,
})
export class MappingEditorPage implements HasUnsavedChanges {
  protected readonly store = inject(MappingEditorStore);
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ruleList = viewChild(RuleList);

  protected readonly id = `hb-editor-${nextPageId++}`;
  protected readonly name = signal("");
  protected readonly mode = signal<EditorMode>("edit");

  protected readonly invalidName = signal(false);
  protected readonly invalidVersion = signal(false);
  protected readonly routeNotice = signal<string | null>(null);
  protected readonly pageAnnouncement = signal("");
  protected readonly importProblem = signal<string | null>(null);

  protected readonly leaveTarget = signal<string | null>(null);
  protected readonly discardConfirm = signal(false);

  protected readonly assets = signal<readonly Asset[]>([]);
  protected readonly assetsLoading = signal(false);
  protected readonly assetsProblem = signal<ApiProblem | null>(null);
  protected readonly assetId = signal("");

  protected readonly maxPreviewRecords = signal(PREVIEW_LIMIT_DEFAULT);
  protected readonly recordLimitInput = signal(String(PREVIEW_LIMIT_INITIAL));
  private readonly previewLimitReady = signal(false);

  protected readonly readOnlyVersion = signal<Mapping | null>(null);
  protected readonly readOnlyVersionNumber = signal<number | null>(null);
  protected readonly readOnlyLoading = signal(false);
  protected readonly readOnlyProblem = signal<ApiProblem | null>(null);
  protected readonly readOnlyMissing = signal(false);

  protected readonly versions = signal<readonly Mapping[]>([]);
  protected readonly versionsLoading = signal(false);
  protected readonly versionsProblem = signal<ApiProblem | null>(null);
  protected readonly diffFrom = signal("latest");
  protected readonly diffTo = signal("draft");
  protected readonly diffResponse = signal<MappingDiffResponse | null>(null);
  protected readonly diffLoading = signal(false);
  protected readonly diffProblem = signal<ApiProblem | null>(null);
  protected readonly diffFromLabel = signal("");
  protected readonly diffToLabel = signal("");

  /** A route change the page asked for after the author chose "Discard and leave" / "Retry save". */
  private allowLeave = false;
  private currentKey: string | null = null;
  private stableUrl = "";
  private pendingRejectKey: string | null = null;
  private discardRequested = false;
  private healthRequested = false;
  private limitTouched = false;
  private lastPublishedSeen: unknown = null;
  private versionToken = 0;
  private versionListToken = 0;
  private assetsToken = 0;
  private diffToken = 0;

  protected readonly canPublishNow = computed(
    () =>
      this.store.spec() !== null &&
      (this.store.revision() > 0 || this.store.dirty()) &&
      this.store.problem() === null &&
      this.store.conflict() === null &&
      !this.store.publishing() &&
      !this.store.loading() &&
      !this.store.discarding() &&
      !this.store.hasServerBlockingIssue() &&
      !this.store.hasLocalBlockingIssue(),
  );

  protected readonly canPreview = computed(
    () =>
      this.previewLimitReady() &&
      this.assetId() !== "" &&
      this.recordLimit() !== null &&
      this.store.spec() !== null &&
      !this.store.previewing() &&
      !this.store.hasLocalBlockingIssue(),
  );

  protected readonly recordLimit = computed<number | null>(() => {
    const text = this.recordLimitInput().trim();
    if (!POSITIVE_INTEGER_PATTERN.test(text)) return null;
    const value = Number(text);
    return value >= 1 && value <= this.maxPreviewRecords() ? value : null;
  });

  protected readonly recordLimitProblem = computed<string | null>(() => {
    const text = this.recordLimitInput().trim();
    if (text.length === 0) return "Enter a record limit of at least 1.";
    if (!POSITIVE_INTEGER_PATTERN.test(text)) return "The record limit must be a whole number.";
    const value = Number(text);
    if (value < 1) return "The record limit must be at least 1.";
    if (value > this.maxPreviewRecords()) return `The record limit cannot exceed ${this.maxPreviewRecords()}.`;
    return null;
  });

  protected readonly blockingIssueCount = computed(() => {
    const validation = this.store.validation();
    return validation === null ? 0 : validation.counts.fatal + validation.counts.error;
  });

  protected readonly draftStatusLabel = computed<string | null>(() => {
    if (this.mode() !== "edit" || this.store.loading() || this.store.spec() === null) return null;
    if (this.store.revision() > 0 || this.store.saveState() === "conflict") return null;
    const baseVersion = this.store.baseVersion();
    return baseVersion === undefined ? "New mapping — not published." : `Editing from v${baseVersion}; no draft yet.`;
  });

  protected readonly readOnlySpec = computed<MappingDefinition | null>(() => {
    const mapping = this.readOnlyVersion();
    return mapping === null ? null : parseSpec(mapping.spec);
  });

  protected readonly versionOptions = computed<readonly VersionOption[]>(() =>
    this.versions().map((mapping) => ({ value: String(mapping.version), label: `v${mapping.version}` })),
  );

  public constructor() {
    this.destroyRef.onDestroy(() => this.store.dispose());

    combineLatest([this.route.paramMap, this.route.queryParamMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([params, query]) => this.applyRoute(params.get("name") ?? "", query.get("version")));

    document.addEventListener("keydown", this.onKeydown);
    this.destroyRef.onDestroy(() => document.removeEventListener("keydown", this.onKeydown));

    // Only dirty drafts warn on a tab close or reload.
    effect((onCleanup) => {
      if (!this.store.dirty()) return;
      const handler = (event: BeforeUnloadEvent): void => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", handler);
      onCleanup(() => window.removeEventListener("beforeunload", handler));
    });

    // A save that succeeds after the leave panel appeared clears the panel.
    effect(() => {
      if (this.leaveTarget() !== null && this.store.saveState() === "saved") {
        this.leaveTarget.set(null);
      }
    });

    // The "open another mapping" notice is only true while the draft is still dirty.
    effect(() => {
      if (this.routeNotice() !== null && !this.store.loading() && !this.store.dirty()) {
        this.routeNotice.set(null);
      }
    });

    // Publishing creates a version, so the diff selectors pick it up.
    effect(() => {
      const published = this.store.lastPublished();
      if (published === null || published === this.lastPublishedSeen) return;
      this.lastPublishedSeen = published;
      if (this.mode() === "edit") this.loadVersions();
    });

    // Close the discard confirmation once the server draft is gone.
    effect(() => {
      if (!this.discardRequested || this.store.discarding()) return;
      if (this.store.discardProblem() !== null || this.store.conflict() !== null) return;
      if (this.store.revision() !== 0) return;
      this.discardRequested = false;
      this.discardConfirm.set(false);
    });
  }

  /** Read by `unsavedChangesGuard` before the route is left. */
  public hasUnsavedChanges(): boolean {
    return this.mode() === "edit" && this.store.dirty();
  }

  /**
   * Flushes pending edits before leaving. When the draft cannot be saved the guard blocks the
   * navigation and the page offers an inline retry/discard choice instead of a browser dialog.
   */
  public async confirmLeave(nextUrl: string): Promise<boolean> {
    if (this.allowLeave) {
      this.allowLeave = false;
      this.leaveTarget.set(null);
      return true;
    }

    const settled = await this.store.flushAndSettle();
    if (settled) {
      this.leaveTarget.set(null);
      return true;
    }

    this.leaveTarget.set(nextUrl);
    return false;
  }

  protected retryLeave(): void {
    const target = this.leaveTarget();
    if (target === null) return;
    void this.store.flushAndSettle().then((settled) => {
      if (!settled) return;
      this.allowLeave = true;
      this.leaveTarget.set(null);
      void this.router.navigateByUrl(target);
    });
  }

  protected discardAndLeave(): void {
    const target = this.leaveTarget();
    if (target === null) return;
    // Local edits are dropped when the next route loads; the server keeps the last saved draft.
    this.allowLeave = true;
    this.leaveTarget.set(null);
    void this.router.navigateByUrl(target);
  }

  private applyRoute(name: string, versionParam: string | null): void {
    const key = `${name}|${versionParam ?? ""}`;
    if (key === this.currentKey) {
      // The redirect back to the stable URL has completed the rejection; clearing the target
      // lets a repeated attempt to the same mapping be rejected (and redirected) again.
      this.pendingRejectKey = null;
      return;
    }

    if (this.currentKey !== null && this.mode() === "edit" && this.store.dirty() && !this.allowLeave) {
      if (this.pendingRejectKey !== key) {
        this.pendingRejectKey = key;
        this.routeNotice.set("Save or discard your changes before opening another mapping.");
        void this.router.navigateByUrl(this.stableUrl, { replaceUrl: true });
      }
      return;
    }
    this.allowLeave = false;

    this.currentKey = key;
    this.pendingRejectKey = null;
    this.stableUrl = `/studio/mappings/${encodeURIComponent(name)}${
      versionParam === null ? "" : `?version=${encodeURIComponent(versionParam)}`
    }`;
    this.name.set(name);
    this.mode.set(versionParam === null ? "edit" : "readonly");
    this.resetPageState();

    if (!isMappingSlug(name)) {
      this.invalidName.set(true);
      return;
    }

    if (versionParam === null) {
      this.store.load(name);
      this.loadVersions();
      this.loadAssets();
      this.loadHealthOnce();
      return;
    }

    if (!POSITIVE_INTEGER_PATTERN.test(versionParam) || Number(versionParam) <= 0) {
      this.invalidVersion.set(true);
      return;
    }

    this.loadReadOnlyVersion(name, Number(versionParam));
  }

  private resetPageState(): void {
    this.invalidName.set(false);
    this.invalidVersion.set(false);
    this.routeNotice.set(null);
    this.pageAnnouncement.set("");
    this.importProblem.set(null);
    this.leaveTarget.set(null);
    this.discardConfirm.set(false);
    this.discardRequested = false;
    this.assetId.set("");
    this.assetsLoading.set(false);
    this.assetsProblem.set(null);
    this.readOnlyVersion.set(null);
    this.readOnlyVersionNumber.set(null);
    this.readOnlyLoading.set(false);
    this.readOnlyProblem.set(null);
    this.readOnlyMissing.set(false);
    this.versions.set([]);
    this.versionsLoading.set(false);
    this.versionsProblem.set(null);
    this.diffResponse.set(null);
    this.diffLoading.set(false);
    this.diffProblem.set(null);
    this.diffFrom.set("latest");
    this.diffTo.set("draft");
    this.diffFromLabel.set("");
    this.diffToLabel.set("");
    this.versionToken++;
    this.versionListToken++;
    this.assetsToken++;
    this.diffToken++;
  }

  private loadReadOnlyVersion(name: string, version: number): void {
    const token = ++this.versionToken;
    this.readOnlyVersionNumber.set(version);
    this.readOnlyLoading.set(true);
    this.readOnlyProblem.set(null);
    this.readOnlyVersion.set(null);
    this.readOnlyMissing.set(false);

    this.api
      .listMappingVersions(name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ versions }) => {
          if (token !== this.versionToken) return;
          const found = versions.find((mapping) => mapping.version === version) ?? null;
          this.readOnlyVersion.set(found);
          this.readOnlyMissing.set(found === null);
          this.readOnlyLoading.set(false);
        },
        error: (problem: ApiProblem) => {
          if (token !== this.versionToken) return;
          this.readOnlyProblem.set(problem);
          this.readOnlyLoading.set(false);
        },
      });
  }

  protected retryReadOnly(): void {
    const version = this.readOnlyVersionNumber();
    const name = this.name();
    if (version !== null && isMappingSlug(name)) {
      this.loadReadOnlyVersion(name, version);
    }
  }

  protected loadVersions(): void {
    const name = this.name();
    if (!isMappingSlug(name)) return;

    const token = ++this.versionListToken;
    this.versionsLoading.set(true);
    this.versionsProblem.set(null);
    this.api
      .listMappingVersions(name)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ versions }) => {
          if (token !== this.versionListToken) return;
          this.versions.set(versions);
          this.versionsLoading.set(false);
        },
        error: (problem: ApiProblem) => {
          if (token !== this.versionListToken) return;
          this.versionsProblem.set(problem);
          this.versionsLoading.set(false);
        },
      });
  }

  protected loadAssets(): void {
    const token = ++this.assetsToken;
    this.assetsLoading.set(true);
    this.assetsProblem.set(null);
    this.api
      .listAssets(50)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          if (token !== this.assetsToken) return;
          this.assets.set(page.items);
          if (!page.items.some((asset) => asset.id === this.assetId())) {
            this.assetId.set("");
          }
          this.assetsLoading.set(false);
        },
        error: (problem: ApiProblem) => {
          if (token !== this.assetsToken) return;
          this.assetsProblem.set(problem);
          this.assetsLoading.set(false);
        },
      });
  }

  private loadHealthOnce(): void {
    if (this.healthRequested) return;
    this.healthRequested = true;
    this.api
      .health()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (health) => {
          const configured = health.limits.maxPreviewRecords;
          const max = Number.isInteger(configured) && configured > 0 ? configured : PREVIEW_LIMIT_DEFAULT;
          this.maxPreviewRecords.set(max);
          if (!this.limitTouched) {
            this.recordLimitInput.set(String(Math.min(PREVIEW_LIMIT_INITIAL, max)));
          } else if (Number(this.recordLimitInput().trim()) > max) {
            this.recordLimitInput.set(String(max));
          }
          this.previewLimitReady.set(true);
        },
        // A failed health request keeps the conservative defaults; the server still enforces its limit.
        error: () => this.previewLimitReady.set(true),
      });
  }

  protected reload(): void {
    const name = this.name();
    if (isMappingSlug(name)) {
      this.store.load(name);
    }
  }

  protected onField(field: SpecField, event: Event): void {
    this.store.updateField(field, (event.target as HTMLInputElement).value);
  }

  protected onAsset(event: Event): void {
    this.assetId.set((event.target as HTMLSelectElement).value);
  }

  protected onRecordLimit(event: Event): void {
    this.limitTouched = true;
    this.recordLimitInput.set((event.target as HTMLInputElement).value);
  }

  protected runPreview(): void {
    const assetId = this.assetId();
    const limit = this.recordLimit();
    if (assetId !== "" && limit !== null) {
      this.store.runPreview(assetId, limit);
    }
  }

  protected publish(): void {
    this.store.publish();
  }

  protected exportJson(): void {
    const spec = this.store.spec();
    if (spec === null) return;
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${this.name()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  protected async onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (file === null) return;

    this.importProblem.set(null);
    let spec: MappingDefinition | null;
    try {
      const text = await file.text();
      spec = parseSpec(JSON.parse(text));
    } catch {
      spec = null;
    } finally {
      // Clearing lets the same file be imported again.
      input.value = "";
    }

    if (spec === null) {
      this.importProblem.set("The file is not a valid mapping definition.");
      return;
    }

    this.store.replaceSpec(spec);
    this.focusRuleSoon(this.store.selectedRuleId());
  }

  protected confirmDiscard(): void {
    this.discardRequested = true;
    this.store.discard();
  }

  protected onAddRule(): void {
    this.store.addRule();
    const id = this.store.selectedRuleId();
    if (id !== null) {
      this.announcePage(`Rule ${id} added.`);
      this.focusRuleSoon(id);
    }
  }

  protected onRemoveRule(ruleId: string): void {
    this.store.removeRule(ruleId);
    this.announcePage(`Rule ${ruleId} removed.`);
    this.focusRuleSoon(this.store.selectedRuleId());
  }

  protected onMoveRule(change: RuleMove): void {
    this.store.moveRule(change.ruleId, change.toIndex);
    this.announcePage(`Rule ${change.ruleId} moved to position ${change.toIndex + 1}.`);
    this.focusRuleSoon(change.ruleId);
  }

  protected undo(): void {
    this.store.undo();
    this.focusRuleSoon(this.store.selectedRuleId());
  }

  protected redo(): void {
    this.store.redo();
    this.focusRuleSoon(this.store.selectedRuleId());
  }

  protected compareVersions(): void {
    const name = this.name();
    if (!isMappingSlug(name)) return;

    const from = this.diffFrom();
    const to = this.diffTo();
    const token = ++this.diffToken;
    this.diffLoading.set(true);
    this.diffProblem.set(null);
    this.diffResponse.set(null);
    this.diffFromLabel.set(this.versionLabel(from));
    this.diffToLabel.set(this.versionLabel(to));

    this.api
      .diffMapping(name, from, to)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (token !== this.diffToken) return;
          this.diffResponse.set(response);
          this.diffLoading.set(false);
        },
        error: (problem: ApiProblem) => {
          if (token !== this.diffToken) return;
          this.diffProblem.set(problem);
          this.diffLoading.set(false);
        },
      });
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected conditionText(condition: RuleCondition): string {
    const value = condition.value === undefined ? "" : ` ${JSON.stringify(condition.value) ?? ""}`;
    return `${condition.path || "(no path)"} ${condition.op}${value}`;
  }

  protected bytes(size: number): string {
    return formatBytes(size);
  }

  private versionLabel(value: string): string {
    return value === "latest" || value === "draft" ? value : `v${value}`;
  }

  private announcePage(message: string): void {
    // A live region ignores a repeated identical string. Clear it in one task and set the message
    // in a later macrotask so change detection renders both states even for identical repeats.
    this.pageAnnouncement.set("");
    setTimeout(() => this.pageAnnouncement.set(message), 0);
  }

  /** Runs after the DOM has the new rule rows or the new selection. */
  private focusRuleSoon(ruleId: string | null): void {
    setTimeout(() => this.ruleList()?.focusRule(ruleId ?? ""), 0);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (this.mode() !== "edit" || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null) {
      return;
    }
    if (!event.ctrlKey && !event.metaKey) return;

    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      this.store.flush();
      return;
    }
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      this.undo();
      return;
    }
    if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      this.redo();
    }
  };
}
