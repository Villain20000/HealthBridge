import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { JsonPipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Asset, Mapping, Pipeline } from "../../core/api-types";
import { formatDateTime, formatRelative } from "../../core/format";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";

/**
 * Pipelines: a named mapping + engine options, and the run it produces.
 *
 * There is no separate execution path. "Run pipeline" submits a normal run with the
 * pipeline's mapping and config, and lands on that run. That is what the API does, so that is
 * what the UI shows — no simulated pipeline runtime.
 */
@Component({
  selector: "hb-pipelines-page",
  standalone: true,
  imports: [FormsModule, JsonPipe, EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-head">
      <div>
        <h1>Pipelines</h1>
        <p class="muted">
          A pipeline pins a mapping and its engine options. Running one submits a normal run and takes you to it.
        </p>
      </div>
      <div class="row">
        <button type="button" class="ghost" (click)="reload()" [disabled]="loading()">Refresh</button>
        <button type="button" (click)="createOpen.set(!createOpen())">
          {{ createOpen() ? "Close" : "New pipeline" }}
        </button>
      </div>
    </header>

    <hb-error [problem]="problem()" (retry)="reload()" />

    @if (createOpen()) {
      <section class="card" aria-labelledby="create-pipeline">
        <h2 id="create-pipeline">New pipeline</h2>
        <p class="hint">The name is a slug (letters, digits, dashes). Config is engine options as JSON.</p>
        <div class="field">
          <label for="pipeline-name">Name</label>
          <input id="pipeline-name" name="name" [(ngModel)]="draft.name" placeholder="nightly-patient-import" />
        </div>
        <div class="field">
          <label for="pipeline-mapping">Mapping</label>
          <select id="pipeline-mapping" name="mappingId" [(ngModel)]="draft.mappingId">
            <option value="">Select a mapping…</option>
            @for (mapping of mappings(); track mapping.id) {
              <option [value]="mapping.id">{{ mapping.name }} · {{ mapping.id }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="pipeline-config">Config (JSON, optional)</label>
          <textarea
            id="pipeline-config"
            name="config"
            rows="3"
            [(ngModel)]="draft.config"
            placeholder='{"maxRecords": 1000}'
          ></textarea>
        </div>
        <div class="row">
          <button type="button" (click)="create()" [disabled]="creating() || !draft.name || !draft.mappingId">
            {{ creating() ? "Creating…" : "Create pipeline" }}
          </button>
          @if (createProblem()) {
            <span class="faint">{{ createProblem()!.code }} · request {{ createProblem()!.requestId }}</span>
          }
        </div>
        @if (createProblem()) {
          <hb-error [problem]="createProblem()" />
        }
      </section>
    }

    @if (loading() && items().length === 0) {
      <hb-loading label="Loading pipelines…" />
    } @else if (problem() && items().length === 0) {
      <hb-empty title="Pipelines unavailable" [message]="problem()!.message" />
    } @else if (items().length === 0) {
      <hb-empty
        title="No pipelines yet"
        message="Create one from an existing mapping to make a repeatable operation."
      />
    } @else {
      <section class="card" aria-labelledby="pipeline-list">
        <h2 id="pipeline-list">Catalogue</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Pipeline</th>
                <th scope="col">Mapping</th>
                <th scope="col">Options</th>
                <th scope="col">Created</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (pipeline of items(); track pipeline.id) {
                <tr>
                  <td>
                    <strong>{{ pipeline.name }}</strong
                    ><br /><span class="mono faint">{{ pipeline.id }}</span>
                  </td>
                  <td class="mono">{{ pipeline.mappingId }}</td>
                  <td class="mono">{{ pipeline.config ? (pipeline.config | json) : "—" }}</td>
                  <td [title]="formatDateTime(pipeline.createdAt)">{{ formatRelative(pipeline.createdAt) }}</td>
                  <td class="right">
                    <button
                      type="button"
                      class="ghost"
                      (click)="runOpen.set(runOpen() === pipeline.id ? null : pipeline.id)"
                      [attr.aria-expanded]="runOpen() === pipeline.id"
                    >
                      {{ runOpen() === pipeline.id ? "Cancel" : "Run" }}
                    </button>
                  </td>
                </tr>
                @if (runOpen() === pipeline.id) {
                  <tr>
                    <td colspan="5">
                      <div class="run-panel">
                        <div class="field">
                          <label [for]="'asset-' + pipeline.id">Asset</label>
                          <select
                            [id]="'asset-' + pipeline.id"
                            [(ngModel)]="runAssetId"
                            [name]="'asset-' + pipeline.id"
                          >
                            <option value="">Select an asset…</option>
                            @for (asset of assets(); track asset.id) {
                              <option [value]="asset.id">{{ asset.filename }} · {{ asset.id }}</option>
                            }
                          </select>
                        </div>
                        <button type="button" (click)="run(pipeline)" [disabled]="running() || !runAssetId">
                          {{ running() ? "Submitting…" : "Submit run" }}
                        </button>
                        @if (runProblem()) {
                          <hb-error [problem]="runProblem()" />
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
        @if (nextCursor()) {
          <button type="button" class="ghost" (click)="loadMore()" [disabled]="loading()">Load more</button>
        }
      </section>
    }
  `,
  styles: [
    `
      .run-panel {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: end;
        padding: 8px 0;
      }
      .run-panel .field {
        margin: 0;
        min-width: 260px;
      }
      .right {
        text-align: right;
      }
    `,
  ],
})
export class PipelinesPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly items = signal<Pipeline[]>([]);
  protected readonly mappings = signal<Mapping[]>([]);
  protected readonly assets = signal<Asset[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly problem = signal<ApiProblem | null>(null);

  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createProblem = signal<ApiProblem | null>(null);
  protected readonly draft = { name: "", mappingId: "", config: "" };

  protected readonly runOpen = signal<string | null>(null);
  protected readonly runAssetId = signal("");
  protected readonly running = signal(false);
  protected readonly runProblem = signal<ApiProblem | null>(null);

  protected readonly formatDateTime = formatDateTime;
  protected readonly formatRelative = formatRelative;

  constructor() {
    this.reload();
    this.api.listMappings(100).subscribe({ next: (page) => this.mappings.set(page.items), error: () => undefined });
    this.api.listAssets(100).subscribe({ next: (page) => this.assets.set(page.items), error: () => undefined });
  }

  protected reload(): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.listPipelines(50).subscribe({
      next: (page) => {
        this.items.set(page.items);
        this.nextCursor.set(page.nextCursor ?? null);
        this.loading.set(false);
      },
      error: (problem: ApiProblem) => {
        this.problem.set(problem);
        this.loading.set(false);
      },
    });
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor) return;
    this.loading.set(true);
    this.api.listPipelines(50, cursor).subscribe({
      next: (page) => {
        this.items.update((current) => [...current, ...page.items]);
        this.nextCursor.set(page.nextCursor ?? null);
        this.loading.set(false);
      },
      error: (problem: ApiProblem) => {
        this.problem.set(problem);
        this.loading.set(false);
      },
    });
  }

  protected create(): void {
    this.creating.set(true);
    this.createProblem.set(null);

    let config: Record<string, unknown> | undefined;
    if (this.draft.config.trim()) {
      try {
        config = JSON.parse(this.draft.config) as Record<string, unknown>;
      } catch {
        this.creating.set(false);
        this.createProblem.set({
          code: "INVALID_CONFIG",
          message: "Config must be a JSON object.",
          status: 0,
          requestId: "client",
        });
        return;
      }
    }

    this.api.createPipeline({ name: this.draft.name.trim(), mappingId: this.draft.mappingId, config }).subscribe({
      next: () => {
        this.creating.set(false);
        this.createOpen.set(false);
        this.draft.name = "";
        this.draft.mappingId = "";
        this.draft.config = "";
        this.reload();
      },
      error: (problem: ApiProblem) => {
        this.creating.set(false);
        this.createProblem.set(problem);
      },
    });
  }

  protected run(pipeline: Pipeline): void {
    const assetId = this.runAssetId();
    if (!assetId) return;
    this.running.set(true);
    this.runProblem.set(null);
    // A deterministic key per (pipeline, asset) makes a double click idempotent instead of
    // creating a second run.
    const key = `pipeline:${pipeline.id}:${assetId}`;
    this.api.createRun({ assetId, mappingId: pipeline.mappingId, options: pipeline.config }, key).subscribe({
      next: ({ run }) => {
        this.running.set(false);
        void this.router.navigate(["/runs", run.id]);
      },
      error: (problem: ApiProblem) => {
        this.running.set(false);
        this.runProblem.set(problem);
      },
    });
  }
}
