import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Asset, Mapping, Run, RunStatus } from "../../core/api-types";
import { ErrorPanel, EmptyState, LoadingState, StatusChip } from "../../ui/primitives";
import { formatRelative } from "../../core/format";

const FILTERS: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "completed_with_warnings", label: "Warnings" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * Runs: cursor-paged list, status filter, and submission.
 *
 * The Idempotency-Key is generated once per submission attempt and reused when the operator
 * retries after a failure, so a retry returns the original run instead of creating a second
 * one — the behaviour the API documents.
 */
@Component({
  selector: "hb-runs",
  standalone: true,
  imports: [FormsModule, RouterLink, StatusChip, EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Runs</h1>
        <p>Every transformation this workspace has submitted, newest first.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <button type="button" class="small primary" (click)="formOpen.set(!formOpen())">
          {{ formOpen() ? "Close" : "New run" }}
        </button>
      </div>
    </div>

    @if (formOpen()) {
      <section class="card" style="margin-bottom: 16px" aria-labelledby="new-run-heading">
        <h2 id="new-run-heading">Submit a run</h2>
        <p class="card-sub">Runs execute against the asset's stored bytes and the mapping version you pick.</p>

        <div class="grid cols-3">
          <div class="field">
            <label for="run-asset">Asset</label>
            <select id="run-asset" [(ngModel)]="selectedAssetId">
              <option value="">Select an asset…</option>
              @for (asset of assets(); track asset.id) {
                <option [value]="asset.id">{{ asset.filename }} · {{ asset.sourceFormat }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="run-mapping">Mapping</label>
            <select id="run-mapping" [(ngModel)]="selectedMappingId">
              <option value="">Select a mapping…</option>
              @for (mapping of mappings(); track mapping.id) {
                <option [value]="mapping.id">{{ mapping.name }} v{{ mapping.version }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label for="run-max-records">Max records (optional)</label>
            <input id="run-max-records" type="number" min="1" [(ngModel)]="maxRecords" />
            <p class="help">Caps the run for a quick inspection.</p>
          </div>
        </div>

        @if (submitProblem(); as issue) {
          <hb-error [problem]="issue" />
        }

        <div class="row" style="margin-top: 12px">
          <button
            type="button"
            class="primary"
            (click)="submit()"
            [disabled]="submitting() || !selectedAssetId || !selectedMappingId"
          >
            {{ submitting() ? "Submitting…" : "Submit run" }}
          </button>
          @if (idempotencyKey()) {
            <span class="subtle mono" style="font-size: 12px"
              >Idempotency-Key {{ idempotencyKey()!.slice(0, 8) }}…</span
            >
          }
        </div>
      </section>
    }

    <div class="toolbar" role="group" aria-label="Filter by status">
      @for (filter of filters; track filter.value) {
        <button
          type="button"
          class="small"
          [class.primary]="status() === filter.value"
          (click)="changeFilter(filter.value)"
          [attr.aria-pressed]="status() === filter.value"
        >
          {{ filter.label }}
        </button>
      }
      <span class="grow"></span>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && runs().length === 0) {
      <hb-loading label="Loading runs…" />
    } @else if (runs().length === 0) {
      <hb-empty title="No runs match this filter" message="Submit a run, or clear the filter." />
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Asset</th>
              <th class="num">Succeeded</th>
              <th class="num">Failed</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            @for (run of runs(); track run.id) {
              <tr>
                <td class="mono">
                  <a [routerLink]="['/runs', run.id]">{{ run.id }}</a>
                </td>
                <td><hb-status-chip [status]="run.status" /></td>
                <td class="mono">{{ run.assetId }}</td>
                <td class="num">{{ run.recordsSucceeded }}</td>
                <td class="num">{{ run.recordsFailed }}</td>
                <td class="subtle">{{ relative(run.createdAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="pager">
        <button type="button" class="small" (click)="back()" [disabled]="history().length === 0 || loading()">
          Previous
        </button>
        <button type="button" class="small" (click)="next()" [disabled]="!cursor() || loading()">Next</button>
        <span>{{ runs().length }} shown{{ cursor() ? " · more available" : "" }}</span>
      </div>
    }
  `,
})
export class RunsPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly filters = FILTERS;
  protected readonly runs = signal<Run[]>([]);
  protected readonly assets = signal<Asset[]>([]);
  protected readonly mappings = signal<Mapping[]>([]);
  protected readonly status = signal<RunStatus | "all">("all");
  protected readonly cursor = signal<string | undefined>(undefined);
  protected readonly history = signal<Array<string | undefined>>([]);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly submitting = signal(false);
  protected readonly submitProblem = signal<ApiProblem | null>(null);
  protected readonly idempotencyKey = signal<string | null>(null);

  protected selectedAssetId = "";
  protected selectedMappingId = "";
  protected maxRecords: number | null = null;

  protected readonly heading = computed(() => (this.status() === "all" ? "All runs" : `Runs: ${this.status()}`));

  constructor() {
    this.reload();
    this.api.listAssets(100).subscribe({ next: (page) => this.assets.set(page.items), error: () => undefined });
    this.api.listMappings(100).subscribe({ next: (page) => this.mappings.set(page.items), error: () => undefined });
  }

  protected reload(): void {
    this.cursor.set(undefined);
    this.history.set([]);
    this.fetch();
  }

  protected changeFilter(value: RunStatus | "all"): void {
    this.status.set(value);
    this.cursor.set(undefined);
    this.history.set([]);
    this.fetch();
  }

  protected next(): void {
    const cursor = this.cursor();
    if (!cursor) return;
    this.history.update((stack) => [...stack, this.cursor()]);
    this.cursor.set(cursor);
    this.fetch(cursor);
  }

  protected back(): void {
    const stack = [...this.history()];
    const previous = stack.pop();
    this.history.set(stack);
    this.cursor.set(previous);
    this.fetch(previous);
  }

  protected submit(): void {
    // Keep the key across retries so a failed submit does not create a second run.
    const key = this.idempotencyKey() ?? crypto.randomUUID();
    this.idempotencyKey.set(key);
    this.submitting.set(true);
    this.submitProblem.set(null);

    const options = this.maxRecords && this.maxRecords > 0 ? { maxRecords: Number(this.maxRecords) } : undefined;
    this.api.createRun({ assetId: this.selectedAssetId, mappingId: this.selectedMappingId, options }, key).subscribe({
      next: (result) => {
        this.submitting.set(false);
        this.idempotencyKey.set(null);
        this.formOpen.set(false);
        void this.router.navigate(["/runs", result.run.id]);
      },
      error: (error: ApiProblem) => {
        this.submitting.set(false);
        this.submitProblem.set(error);
      },
    });
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.problem.set(null);
    const status = this.status();
    this.api.listRuns({ limit: 25, cursor, status: status === "all" ? undefined : status }).subscribe({
      next: (page) => {
        this.runs.set(page.items);
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }
}
