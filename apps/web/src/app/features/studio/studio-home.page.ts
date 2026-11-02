import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Asset, Mapping, Run } from "../../core/api-types";
import { formatBytes, formatRelative } from "../../core/format";
import { EmptyState, ErrorPanel, LoadingState, PlannedCard, StatusChip } from "../../ui/primitives";

/**
 * Studio home.
 *
 * The landing screen for stored-trace debugging and the tools around it. Every list shows the
 * five most recent records from the API — never a total, because the API has no aggregate
 * endpoint and a count built from one page would be a lie. Planned cards state what the API
 * cannot do yet; recent runs link to the stored-trace debugger at `/studio/debugger/:runId`.
 */
@Component({
  selector: "hb-studio-home",
  standalone: true,
  imports: [RouterLink, StatusChip, EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Studio</h1>
        <p>Stored-trace debugging and the tools around it. Nothing here starts or attaches to a run.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="refresh()" [disabled]="loading()">Refresh</button>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" />
      <div style="height: 16px"></div>
    }

    @if (loading()) {
      <hb-loading label="Reading recent runs, mappings and assets…" />
    } @else if (!problem()) {
      <div class="grid cols-2">
        <section class="card" aria-labelledby="studio-runs-heading">
          <h2 id="studio-runs-heading">Recent runs</h2>
          <p class="card-sub">The five most recent runs in this workspace.</p>

          @if (runs().length === 0) {
            <hb-empty title="No runs yet" message="Submit a run and it will appear here." />
          } @else {
            <div class="table-wrap">
              <table>
                <caption class="sr-only">
                  Most recent runs
                </caption>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Debugger</th>
                  </tr>
                </thead>
                <tbody>
                  @for (run of runs(); track run.id) {
                    <tr>
                      <td class="mono">
                        <a [routerLink]="['/runs', run.id]">{{ run.id }}</a>
                      </td>
                      <td><hb-status-chip [status]="run.status" /></td>
                      <td class="subtle">{{ relative(run.createdAt) }}</td>
                      <td>
                        <a
                          [routerLink]="['/studio/debugger', run.id]"
                          [attr.aria-label]="'Open stored-trace debugger for run ' + run.id"
                          >Open</a
                        >
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <div class="row" style="margin-top: 12px">
            <a routerLink="/runs">All runs</a>
          </div>
        </section>

        <section class="card" aria-labelledby="studio-mappings-heading">
          <h2 id="studio-mappings-heading">Recent mappings</h2>
          <p class="card-sub">The five most recently created mappings.</p>

          @if (mappings().length === 0) {
            <hb-empty title="No mappings yet" message="Create a mapping and it will appear here." />
          } @else {
            <div class="table-wrap">
              <table>
                <caption class="sr-only">
                  Most recent mappings
                </caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Target format</th>
                  </tr>
                </thead>
                <tbody>
                  @for (mapping of mappings(); track mapping.id) {
                    <tr>
                      <td class="mono">
                        <a [routerLink]="['/studio/mappings', mapping.name]">{{ mapping.name }}</a>
                      </td>
                      <td>v{{ mapping.version }}</td>
                      <td class="mono">{{ mapping.targetFormat }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <div class="row" style="margin-top: 12px">
            <a routerLink="/mappings">All mappings</a>
          </div>
        </section>

        <section class="card" aria-labelledby="studio-assets-heading">
          <h2 id="studio-assets-heading">Recent assets</h2>
          <p class="card-sub">The five most recently uploaded assets.</p>

          @if (assets().length === 0) {
            <hb-empty title="No assets yet" message="Upload an asset and it will appear here." />
          } @else {
            <div class="table-wrap">
              <table>
                <caption class="sr-only">
                  Most recent assets
                </caption>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Source format</th>
                    <th>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  @for (asset of assets(); track asset.id) {
                    <tr>
                      <td class="mono">{{ asset.filename }}</td>
                      <td>{{ bytes(asset.sizeBytes) }}</td>
                      <td class="mono">{{ asset.sourceFormat }}</td>
                      <td class="subtle">{{ relative(asset.createdAt) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <div class="row" style="margin-top: 12px">
            <a routerLink="/assets">All assets</a>
          </div>
        </section>
      </div>
    }

    <section aria-labelledby="studio-tools-heading" style="margin-top: 24px">
      <h2 id="studio-tools-heading">Studio tools</h2>
      <p class="card-sub">Active development, validation, and debugging utilities.</p>
      <div class="grid cols-3" style="margin-top: 16px">
        <div class="card">
          <h3>Validation Centre</h3>
          <p class="card-sub" style="margin-top: 8px">
            Inspect FHIR resource validation, conformance profiles, and multi-level clinical checks per run.
          </p>
          <div class="row" style="margin-top: 16px">
            @if (runs().length > 0) {
              <a class="button small primary" [routerLink]="['/validation-centre', runs()[0].id]">
                Latest run ({{ runs()[0].id.slice(0, 8) }}…)
              </a>
            }
            <a class="button small" routerLink="/runs">Browse runs</a>
          </div>
        </div>

        <div class="card">
          <h3>Data Lineage</h3>
          <p class="card-sub" style="margin-top: 8px">
            Trace source fields to target FHIR resources with execution and provenance graphs.
          </p>
          <div class="row" style="margin-top: 16px">
            @if (runs().length > 0) {
              <a class="button small primary" [routerLink]="['/lineage', runs()[0].id]">
                Latest run ({{ runs()[0].id.slice(0, 8) }}…)
              </a>
            }
            <a class="button small" routerLink="/runs">Browse runs</a>
          </div>
        </div>

        <div class="card">
          <h3>Mapping & Rules Editor</h3>
          <p class="card-sub" style="margin-top: 8px">
            Edit schema transformations, inspect schema fields, and preview FHIR mappings live.
          </p>
          <div class="row" style="margin-top: 16px">
            @if (mappings().length > 0) {
              <a class="button small primary" [routerLink]="['/studio/mappings', mappings()[0].name]">
                Edit {{ mappings()[0].name }}
              </a>
            }
            <a class="button small" routerLink="/mappings">All mappings</a>
          </div>
        </div>
      </div>
    </section>
  `,
})
export class StudioHomePage {
  private readonly api = inject(ApiClient);

  protected readonly runs = signal<Run[]>([]);
  protected readonly assets = signal<Asset[]>([]);
  protected readonly mappings = signal<Mapping[]>([]);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);

  constructor() {
    this.refresh();
  }

  protected refresh(): void {
    this.loading.set(true);
    this.problem.set(null);

    forkJoin({
      runs: this.api.listRuns({ limit: 5 }),
      assets: this.api.listAssets(5),
      mappings: this.api.listMappings(5),
    }).subscribe({
      next: (result) => {
        this.runs.set(result.runs.items);
        this.assets.set(result.assets.items);
        this.mappings.set(result.mappings.items);
        this.loading.set(false);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected bytes(value: number): string {
    return formatBytes(value);
  }
}
