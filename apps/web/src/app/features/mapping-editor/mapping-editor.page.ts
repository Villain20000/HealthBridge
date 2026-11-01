import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Mapping } from "../../core/api-types";
import { formatRelative } from "../../core/format";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";
import {
  NO_LOCAL_EXECUTION,
  VALIDATE_ON_SAVE,
  assetSummaryFromRecord,
  blankRule,
  blockingIssueCount,
  mappingNameFromSpec,
  moveRow,
  rulesFromSpec,
  severityTone,
  sourceFieldsFromRows,
  specRulesFromRows,
  targetFieldsFromRows,
  targetResourceTypeFromSpec,
  validateEditorRows,
  versionsFromResponse,
  type AssetSummary,
  type EditorRule,
  type VersionView,
} from "./mapping-editor.logic";

/**
 * Mapping studio slice: a read-only schema explorer plus a keyboard-complete rule
 * table and a read-only version history with save-as-new-version.
 *
 * Read-only except for the draft: schema panels render stored rows, versions render
 * `GET /mappings/:name/versions`, and saving posts the existing `POST /mappings`
 * endpoint (the same name yields the next immutable version). Nothing here executes
 * a mapping against patient data — there is no local execution path, only
 * {@link VALIDATE_ON_SAVE}.
 */
@Component({
  selector: "hb-mapping-editor",
  standalone: true,
  imports: [FormsModule, RouterLink, EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Mapping editor</h1>
        <p>
          Draft rules for <span class="mono">{{ mappingName() || "…" }}</span>
          @if (mappingVersion() !== null) {
            <span> · v{{ mappingVersion() }}</span>
          }
          · read-only sources, keyboard-complete table.
        </p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <a class="button small" routerLink="/mappings">All mappings</a>
      </div>
    </div>

    <div class="banner" role="note" style="margin-bottom: 16px">{{ noExecution }}</div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && rows() === null) {
      <hb-loading label="Loading stored mapping…" />
    } @else if (rows() === null) {
      <hb-empty
        title="No mapping stored"
        message="The stored mapping spec is missing or malformed, so there is nothing to edit."
      />
    } @else {
      <div class="grid cols-2" style="margin-bottom: 16px">
        <section class="card" aria-labelledby="source-schema-heading">
          <h2 id="source-schema-heading">Source schema</h2>
          <p class="card-sub">
            Read-only. Asset identity from the stored asset row; fields from the rules being edited.
          </p>
          @if (asset(); as summary) {
            <dl class="kv">
              <dt>File</dt>
              <dd class="mono">{{ summary.filename }}</dd>
              <dt>Format</dt>
              <dd>{{ summary.sourceFormat }} · {{ summary.domain }}</dd>
              <dt>Size</dt>
              <dd>{{ summary.sizeBytes }} bytes</dd>
            </dl>
          } @else {
            <p class="subtle">
              No asset selected — open this editor with an <span class="mono">?assetId=</span> query.
            </p>
          }
          @if (sourceFields().length === 0) {
            <p class="subtle">No source fields referenced yet.</p>
          } @else {
            <ul class="fields">
              @for (field of sourceFields(); track field) {
                <li class="mono">{{ field }}</li>
              }
            </ul>
          }
        </section>

        <section class="card" aria-labelledby="target-schema-heading">
          <h2 id="target-schema-heading">Target schema</h2>
          <p class="card-sub">Read-only. Target paths from the rules being edited, under the declared resource.</p>
          <p>
            Resource type:
            <strong class="mono">{{ targetResource() ?? "undecided" }}</strong>
          </p>
          @if (targetFields().length === 0) {
            <p class="subtle">No target fields written yet.</p>
          } @else {
            <ul class="fields">
              @for (field of targetFields(); track field) {
                <li class="mono">{{ field }}</li>
              }
            </ul>
          }
        </section>
      </div>

      <section class="card" style="margin-bottom: 16px" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Rules</h2>
        <p class="card-sub">
          Every control is keyboard-operable; rows reorder with Move up / Move down — there is no drag-and-drop.
          Conditions are a JSON array of <span class="mono">when</span> clauses.
        </p>
        @if (currentRows().length === 0) {
          <hb-empty title="No rules in this draft" message="Add the first rule to start the draft." />
        } @else {
          <div class="table-wrap">
            <table class="rules-table" aria-label="Mapping rules">
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th>Rule id</th>
                  <th>Source path</th>
                  <th>Target path</th>
                  <th>Transform</th>
                  <th>Default value</th>
                  <th>Required</th>
                  <th>When (JSON)</th>
                  <th><span class="visually-hidden">Row actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of currentRows(); track row.id; let i = $index) {
                  <tr>
                    <td class="num">{{ i + 1 }}</td>
                    <td>
                      <input
                        [attr.aria-label]="'Rule id row ' + (i + 1)"
                        [ngModel]="row.id"
                        (ngModelChange)="setField(i, 'id', $event)"
                        autocomplete="off"
                      />
                    </td>
                    <td>
                      <input
                        [attr.aria-label]="'Source path row ' + (i + 1)"
                        [ngModel]="row.sourcePath"
                        (ngModelChange)="setField(i, 'sourcePath', $event)"
                        autocomplete="off"
                        class="mono"
                      />
                    </td>
                    <td>
                      <input
                        [attr.aria-label]="'Target path row ' + (i + 1)"
                        [ngModel]="row.targetPath"
                        (ngModelChange)="setField(i, 'targetPath', $event)"
                        autocomplete="off"
                        class="mono"
                      />
                    </td>
                    <td>
                      <input
                        [attr.aria-label]="'Transform row ' + (i + 1)"
                        [ngModel]="row.transform"
                        (ngModelChange)="setField(i, 'transform', $event)"
                        autocomplete="off"
                        list="transform-options"
                        class="mono"
                      />
                    </td>
                    <td>
                      <input
                        [attr.aria-label]="'Default value row ' + (i + 1)"
                        [ngModel]="row.defaultText"
                        (ngModelChange)="setField(i, 'defaultText', $event)"
                        autocomplete="off"
                        class="mono"
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        [attr.aria-label]="'Required row ' + (i + 1)"
                        [ngModel]="row.required"
                        (ngModelChange)="setField(i, 'required', $event)"
                        style="width: auto"
                      />
                    </td>
                    <td>
                      <input
                        [attr.aria-label]="'Conditions row ' + (i + 1)"
                        [ngModel]="row.whenJson"
                        (ngModelChange)="setField(i, 'whenJson', $event)"
                        autocomplete="off"
                        class="mono"
                      />
                    </td>
                    <td class="right nowrap">
                      <button type="button" class="small" (click)="move(i, -1)" [disabled]="i === 0">Move up</button>
                      <button
                        type="button"
                        class="small"
                        (click)="move(i, 1)"
                        [disabled]="i === currentRows().length - 1"
                      >
                        Move down
                      </button>
                      <button type="button" class="small danger" (click)="removeRow(i)">Delete</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <div class="toolbar" style="margin-top: 12px">
          <button type="button" class="small" (click)="addRow()">Add rule</button>
          <span class="subtle">{{ currentRows().length }} {{ currentRows().length === 1 ? "rule" : "rules" }}</span>
        </div>
        <datalist id="transform-options">
          @for (name of transforms; track name) {
            <option [value]="name"></option>
          }
        </datalist>
      </section>

      <section class="card" style="margin-bottom: 16px" aria-labelledby="validation-heading">
        <h2 id="validation-heading">Client-side checks</h2>
        <p class="card-sub">
          Static validation of every edit, using the same issue codes the engine reports. Advisory only —
          {{ validateOnSave }}
        </p>
        @if (issues().length === 0) {
          <hb-empty title="No issues" message="The draft passes the client-side checks." />
        } @else {
          <div class="table-wrap">
            <table aria-label="Draft validation issues">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Message</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                @for (issue of issues(); track $index) {
                  <tr>
                    <td>
                      <span class="chip" [class]="tone(issue.severity)">{{ issue.code }}</span>
                    </td>
                    <td>{{ issue.message }}</td>
                    <td class="mono">{{ issue.ruleId ?? "—" }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pager">{{ blockingCount() }} blocking · warnings never block saving</div>
        }
      </section>

      <section class="card" style="margin-bottom: 16px" aria-labelledby="save-heading">
        <h2 id="save-heading">Save as new version</h2>
        <p class="card-sub">{{ validateOnSave }}</p>
        <div class="grid cols-2">
          <div class="field">
            <label for="editor-save-name">Mapping name</label>
            <input id="editor-save-name" [(ngModel)]="saveName" autocomplete="off" />
          </div>
          <div class="field">
            <label for="editor-save-target">Target resource type</label>
            <input id="editor-save-target" [(ngModel)]="saveTarget" autocomplete="off" />
          </div>
        </div>
        @if (saveProblem(); as issue) {
          <hb-error [problem]="issue" />
          <div style="height: 12px"></div>
        }
        @if (savedVersion(); as saved) {
          <p role="status">
            Saved <strong class="mono">{{ saved.name }} v{{ saved.version }}</strong>
            <span class="chip ok">saved</span>
          </p>
        }
        <button
          type="button"
          class="primary"
          (click)="save()"
          [disabled]="saving() || saveName.trim().length === 0 || currentRows().length === 0"
        >
          {{ saving() ? "Saving…" : "Save as new version" }}
        </button>
      </section>

      <section class="card" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Version history</h2>
        <p class="card-sub">Read-only. Versions are immutable; saving above appends the next one.</p>
        @if (versions().length === 0) {
          <hb-empty title="No versions stored" message="The version list is empty or malformed." />
        } @else {
          <div class="table-wrap">
            <table aria-label="Mapping version history">
              <thead>
                <tr>
                  <th class="num">Version</th>
                  <th>Checksum</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (entry of versions(); track entry.id) {
                  <tr>
                    <td class="num">v{{ entry.version }}</td>
                    <td class="mono">{{ entry.specChecksum || "—" }}</td>
                    <td class="subtle">{{ relative(entry.createdAt) }}</td>
                    <td class="right">
                      @if (entry.id === mappingId()) {
                        <span class="chip info">open</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
  styles: `
    .fields {
      list-style: none;
      margin: var(--space-2) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      max-height: 260px;
      overflow: auto;
    }

    .fields li {
      padding: 2px 0;
      border-bottom: 1px dotted var(--border);
    }

    td.right {
      text-align: right;
      white-space: nowrap;
    }

    td input:not([type="checkbox"]),
    td select {
      min-width: 130px;
      padding: 5px 8px;
      font-size: 12.5px;
    }

    .subtle {
      color: var(--text-muted);
      font-size: 12.5px;
    }

    .kv dd {
      overflow-wrap: anywhere;
      min-width: 0;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    /* Narrow screens: an auto-layout table sizes to its widest row and that width
       inflates the document scrollable overflow past table-wrap, failing the
       390 px viewport check. Fixed layout caps the table at its container while
       the cell controls keep their desktop sizing and scroll inside the wrapper. */
    @media (max-width: 700px) {
      table.rules-table {
        table-layout: fixed;
        width: 100%;
      }
    }
  `,
})
export class MappingEditorPage {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly noExecution = NO_LOCAL_EXECUTION;
  protected readonly validateOnSave = VALIDATE_ON_SAVE;
  protected readonly transforms = [
    "identity",
    "uppercase",
    "lowercase",
    "trim",
    "parse_date_iso",
    "format_gender_fhir",
    "concat",
    "split",
    "number_to_string",
    "string_to_number",
    "default_value",
    "to_reference",
    "codeable_concept",
    "convert_units",
  ];

  protected readonly mappingId = signal(this.route.snapshot.paramMap.get("mappingId") ?? "");
  protected readonly assetId = signal(this.route.snapshot.queryParamMap.get("assetId") ?? "");
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly mappingName = signal("");
  protected readonly mappingVersion = signal<number | null>(null);
  protected readonly targetResource = signal<string | null>(null);
  protected readonly rows = signal<EditorRule[] | null>(null);
  protected readonly versions = signal<VersionView[]>([]);
  protected readonly asset = signal<AssetSummary | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveProblem = signal<ApiProblem | null>(null);
  protected readonly savedVersion = signal<Mapping | null>(null);

  protected saveName = "";
  protected saveTarget = "";

  private originalSpec: Record<string, unknown> = {};

  protected readonly currentRows = computed(() => this.rows() ?? []);
  protected readonly issues = computed(() => validateEditorRows(this.currentRows()));
  protected readonly blockingCount = computed(() => blockingIssueCount(this.issues()));
  protected readonly sourceFields = computed(() => sourceFieldsFromRows(this.currentRows()));
  protected readonly targetFields = computed(() => targetFieldsFromRows(this.currentRows()));

  constructor() {
    this.reload();
  }

  protected reload(): void {
    const id = this.mappingId();
    this.loading.set(true);
    this.problem.set(null);
    this.savedVersion.set(null);
    if (id.trim().length === 0) {
      this.rows.set(null);
      this.loading.set(false);
      return;
    }
    this.api.getMapping(id).subscribe({
      next: (mapping) => {
        const spec = mapping.spec as Record<string, unknown> | null | undefined;
        this.originalSpec = typeof spec === "object" && spec !== null && !Array.isArray(spec) ? { ...spec } : {};
        this.rows.set(rulesFromSpec(mapping.spec));
        this.mappingName.set(mappingNameFromSpec(mapping.spec) ?? mapping.name);
        this.mappingVersion.set(mapping.version);
        this.targetResource.set(targetResourceTypeFromSpec(mapping.spec));
        this.saveName = mapping.name;
        this.saveTarget = targetResourceTypeFromSpec(mapping.spec) ?? "";
        this.loading.set(false);
        this.loadVersions(mapping.name);
        this.loadAsset();
      },
      error: (error: ApiProblem) => {
        this.rows.set(null);
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  protected addRow(): void {
    const current = this.currentRows();
    let candidate = `r${current.length + 1}`;
    const taken = new Set(current.map((row) => row.id));
    let suffix = current.length + 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `r${suffix}`;
    }
    this.rows.set([...current, blankRule(candidate)]);
  }

  protected removeRow(index: number): void {
    const current = this.currentRows();
    if (index < 0 || index >= current.length) return;
    this.rows.set(current.filter((_, position) => position !== index));
  }

  protected move(index: number, delta: number): void {
    this.rows.set(moveRow(this.currentRows(), index, index + delta));
  }

  protected setField(index: number, field: "required", value: boolean): void;
  protected setField(
    index: number,
    field: "id" | "sourcePath" | "targetPath" | "transform" | "defaultText" | "whenJson",
    value: string,
  ): void;
  protected setField(index: number, field: keyof EditorRule, value: string | boolean): void {
    const current = this.currentRows();
    const row = current[index];
    if (!row) return;
    const next = [...current];
    next[index] = { ...row, [field]: value };
    this.rows.set(next);
  }

  protected save(): void {
    const name = this.saveName.trim();
    if (name.length === 0 || this.currentRows().length === 0 || this.saving()) return;
    this.saving.set(true);
    this.saveProblem.set(null);
    const spec = { ...this.originalSpec, rules: specRulesFromRows(this.currentRows()) };
    const target = this.saveTarget.trim();
    this.api.createMapping({ name, spec, targetResourceType: target.length > 0 ? target : undefined }).subscribe({
      next: (mapping) => {
        this.saving.set(false);
        this.savedVersion.set(mapping);
        this.loadVersions(name);
      },
      error: (error: ApiProblem) => {
        this.saving.set(false);
        this.saveProblem.set(error);
      },
    });
  }

  protected tone(severity: string): string {
    return severityTone(severity);
  }

  protected relative(iso: string): string {
    if (typeof iso !== "string" || iso.length === 0) return "—";
    try {
      return formatRelative(iso);
    } catch {
      return iso;
    }
  }

  private loadVersions(name: string): void {
    if (name.trim().length === 0) return;
    this.api.listMappingVersions(name).subscribe({
      next: (payload) => this.versions.set(versionsFromResponse(payload)),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  private loadAsset(): void {
    const id = this.assetId();
    if (id.trim().length === 0) return;
    this.api.getAsset(id).subscribe({
      next: (asset) => this.asset.set(assetSummaryFromRecord(asset)),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }
}
