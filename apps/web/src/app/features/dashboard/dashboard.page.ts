import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Health, Run, RunStatus, VersionInfo } from "../../core/api-types";
import { HealthCards } from "./health-cards";
import { EmptyState, ErrorPanel, LoadingState, StatusChip } from "../../ui/primitives";
import { formatBytes, formatRelative } from "../../core/format";

const STATUSES: RunStatus[] = ["queued", "running", "completed_with_warnings", "completed", "failed"];

/**
 * Dashboard: server facts, capability limits, and what actually happened recently.
 *
 * Counts are capped pages, labelled as such. The API has no aggregate endpoint, and inventing
 * a total by summing pages would be a lie the moment a workspace has more than 100 runs.
 */
@Component({
  selector: "hb-dashboard",
  standalone: true,
  imports: [RouterLink, HealthCards, StatusChip, ErrorPanel, EmptyState, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p>Live state of the API, its limits, and the most recent transformations.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="refresh()" [disabled]="loading()">Refresh</button>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="refresh()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && !health()) {
      <hb-loading label="Reading server state…" />
    }

    @if (health(); as h) {
      <hb-health-cards [health]="h" [version]="version()" />

      <div class="grid cols-4" style="margin-top: 16px">
        @for (row of countRows(); track row.status) {
          <div class="card">
            <div class="stat">
              <span class="label">{{ row.label }}</span>
              <span class="value">{{ row.value }}{{ row.capped ? "+" : "" }}</span>
              <span class="hint">{{ row.scanned > 0 ? "from the most recent " + row.scanned : "none recorded" }}</span>
            </div>
          </div>
        }
      </div>
    }

    <section class="card" style="margin-top: 16px" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent runs</h2>
      @if (recent().length === 0 && !loading()) {
        <hb-empty title="No runs yet" message="Upload an asset and submit a run to see it here.">
          <a routerLink="/runs" class="button" style="margin-top: 12px; display: inline-block">Go to runs</a>
        </hb-empty>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th class="num">Records</th>
                <th class="num">Failed</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              @for (run of recent(); track run.id) {
                <tr>
                  <td class="mono">
                    <a [routerLink]="['/runs', run.id]">{{ run.id }}</a>
                  </td>
                  <td><hb-status-chip [status]="run.status" /></td>
                  <td class="num">{{ run.recordsSucceeded }}/{{ run.recordsProcessed }}</td>
                  <td class="num">{{ run.recordsFailed }}</td>
                  <td class="subtle">{{ relative(run.createdAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class DashboardPage {
  private readonly api = inject(ApiClient);

  protected readonly health = signal<Health | null>(null);
  protected readonly version = signal<VersionInfo | null>(null);
  protected readonly recent = signal<Run[]>([]);
  protected readonly counts = signal<Record<string, { count: number; scanned: number; capped: boolean }>>({});
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);

  protected readonly countRows = computed(() =>
    STATUSES.map((status) => {
      const entry = this.counts()[status];
      return {
        status,
        label: labelFor(status),
        value: entry?.count ?? 0,
        scanned: entry?.scanned ?? 0,
        capped: entry?.capped ?? false,
      };
    }),
  );

  constructor() {
    this.refresh();
  }

  protected refresh(): void {
    this.loading.set(true);
    this.problem.set(null);

    this.api.health().subscribe({
      next: (health) => this.health.set(health),
      error: (error: ApiProblem) => this.problem.set(error),
    });
    this.api.version().subscribe({ next: (version) => this.version.set(version), error: () => undefined });
    this.api.listRuns({ limit: 10 }).subscribe({
      next: (page) => this.recent.set(page.items),
      error: (error: ApiProblem) => this.problem.set(error),
    });

    let pending = STATUSES.length;
    for (const status of STATUSES) {
      this.api.listRuns({ status, limit: 100 }).subscribe({
        next: (page) => {
          this.counts.update((current) => ({
            ...current,
            [status]: { count: page.items.length, scanned: page.items.length, capped: Boolean(page.nextCursor) },
          }));
          pending -= 1;
          if (pending === 0) this.loading.set(false);
        },
        error: (error: ApiProblem) => {
          this.problem.set(error);
          pending -= 1;
          if (pending === 0) this.loading.set(false);
        },
      });
    }
    if (STATUSES.length === 0) this.loading.set(false);
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected bytes(value: number): string {
    return formatBytes(value);
  }
}

function labelFor(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "completed_with_warnings":
      return "With warnings";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}
