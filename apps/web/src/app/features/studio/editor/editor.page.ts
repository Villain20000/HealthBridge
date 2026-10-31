import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { ApiClient } from "../../../core/api-client";
import type { ApiProblem, Asset } from "../../../core/api-types";
import { formatBytes } from "../../../core/format";
import { ErrorPanel, LoadingState } from "../../../ui/primitives";
import { MappingEditorStore } from "./editor.store";
import type { SpecField } from "./editor.store";
import { IssueList } from "./issue-list";
import { PreviewPanel } from "./preview-panel";
import { RuleForm } from "./rule-form";
import { RuleList } from "./rule-list";
import { SaveStatus } from "./save-status";
import type { HasUnsavedChanges } from "./unsaved-changes.guard";

let nextPageId = 0;

/**
 * Mapping editor.
 *
 * Edits the server-side draft of one mapping (`/studio/editor/:name`). The store owns autosave,
 * undo/redo, conflict handling, publishing and previews; this page wires it to the child
 * components and to the asset picker used by the preview. The store is provided per page, so
 * leaving the page discards it.
 */
@Component({
  selector: "hb-mapping-editor-page",
  standalone: true,
  imports: [RouterLink, ErrorPanel, LoadingState, RuleList, RuleForm, IssueList, PreviewPanel, SaveStatus],
  providers: [{ provide: MappingEditorStore, useFactory: () => new MappingEditorStore(inject(ApiClient)) }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Mapping editor</h1>
        <p>
          Editing the draft of <span class="mono">{{ name() }}</span
          >. Changes are saved automatically as a draft.
        </p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="store.undo()" [disabled]="!store.canUndo()">Undo</button>
        <button type="button" class="small" (click)="store.redo()" [disabled]="!store.canRedo()">Redo</button>
        <button type="button" class="small" (click)="store.publish()" [disabled]="!canPublish()">
          {{ store.publishing() ? "Publishing…" : "Publish" }}
        </button>
        <a class="button small" routerLink="/studio">Back to Studio</a>
      </div>
    </div>

    <div class="sr-only" role="status" aria-live="polite">{{ store.announcement() }}</div>

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
            (add)="store.addRule()"
            (remove)="store.removeRule($event)"
            (move)="store.moveRule($event.ruleId, $event.toIndex)"
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
  `,
})
export class MappingEditorPage implements HasUnsavedChanges {
  protected readonly store = inject(MappingEditorStore);
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly id = `hb-editor-${nextPageId++}`;
  protected readonly name = signal("");

  protected readonly assets = signal<readonly Asset[]>([]);
  protected readonly assetsLoading = signal(false);
  protected readonly assetsProblem = signal<ApiProblem | null>(null);
  protected readonly assetId = signal("");

  protected readonly canPublish = computed(() => this.store.canPublish() && !this.store.hasLocalBlockingIssue());
  protected readonly canPreview = computed(
    () =>
      this.assetId() !== "" &&
      this.store.spec() !== null &&
      !this.store.previewing() &&
      !this.store.hasLocalBlockingIssue(),
  );

  public constructor() {
    this.destroyRef.onDestroy(() => this.store.dispose());

    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const name = params.get("name") ?? "";
      this.name.set(name);
      if (name !== "") {
        this.store.load(name);
      }
    });

    this.loadAssets();
  }

  /** Read by `unsavedChangesGuard` before the route is left. */
  public hasUnsavedChanges(): boolean {
    return this.store.dirty();
  }

  protected reload(): void {
    const name = this.name();
    if (name !== "") {
      this.store.load(name);
    }
  }

  protected loadAssets(): void {
    this.assetsLoading.set(true);
    this.assetsProblem.set(null);
    this.api
      .listAssets(50)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.assets.set(page.items);
          if (!page.items.some((asset) => asset.id === this.assetId())) {
            this.assetId.set("");
          }
          this.assetsLoading.set(false);
        },
        error: (problem: ApiProblem) => {
          this.assetsProblem.set(problem);
          this.assetsLoading.set(false);
        },
      });
  }

  protected onField(field: SpecField, event: Event): void {
    this.store.updateField(field, (event.target as HTMLInputElement).value);
  }

  protected onAsset(event: Event): void {
    this.assetId.set((event.target as HTMLSelectElement).value);
  }

  protected runPreview(): void {
    const assetId = this.assetId();
    if (assetId !== "") {
      this.store.runPreview(assetId);
    }
  }

  protected bytes(size: number): string {
    return formatBytes(size);
  }
}
