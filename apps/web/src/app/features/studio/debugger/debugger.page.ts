import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import type { Signal } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Params } from "@angular/router";
import { formatRelative } from "../../../core/format";
import { EmptyState, ErrorPanel, LoadingState, StatusChip } from "../../../ui/primitives";
import { DebuggerExport } from "./debugger-export";
import { DebuggerFilters } from "./debugger-filters";
import { DebuggerStore } from "./debugger.store";
import { EventDetail } from "./event-detail";
import { RecordPanel } from "./record-panel";
import { TRACE_STAGES } from "./trace.logic";
import type { DebuggerEvent, DebuggerFilter, TraceExport } from "./trace.logic";
import { TraceTimeline } from "./trace-timeline";

/** `?record=` and `?event=` are only accepted as non-negative integers. */
function indexParam(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Stored-trace debugger.
 *
 * Every row on this page comes from `DebuggerStore`, which reads stored traces once and offers
 * a manual refresh. The page never opens a stream, never polls and never attaches to a run:
 * there is no live mode here, and the header says so. Filters live in the URL (debounced for
 * `q`) and selections are written with `replaceUrl` so Back leaves the debugger.
 */
@Component({
  selector: "hb-debugger-page",
  standalone: true,
  imports: [
    RouterLink,
    StatusChip,
    ErrorPanel,
    EmptyState,
    LoadingState,
    TraceTimeline,
    DebuggerFilters,
    EventDetail,
    RecordPanel,
    DebuggerExport,
  ],
  providers: [DebuggerStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1 class="mono">{{ runId() }}</h1>
        <p>
          <strong>Stored trace replay — not live execution.</strong>
          Reads stored rows only; it never attaches to a running run.
        </p>
        @if (store.run(); as run) {
          <p class="subtle">
            <hb-status-chip [status]="run.status" /> · created {{ relative(run.createdAt) }}
            @if (run.adapterId) {
              · adapter {{ run.adapterId }}
            }
            @if (store.mapping(); as mapping) {
              · mapping v{{ mapping.version }}
            }
          </p>
        }
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="refresh()" [disabled]="store.loading()">Refresh traces</button>
        <a class="button small" [routerLink]="['/runs', runId()]">Run detail</a>
        <a class="button small" routerLink="/studio">Back to Studio</a>
      </div>
    </div>

    @if (store.problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
    }

    @if (store.loading() && !store.hasLoaded()) {
      <hb-loading label="Reading the stored trace…" />
    }

    @if (store.availability(); as availability) {
      @if (availability.kind !== "settled") {
        <p class="banner" role="status">
          {{ availability.message }}
          @if (availability.kind === "partial") {
            <button type="button" class="small" (click)="refresh()" [disabled]="store.loading()">Refresh traces</button>
          }
        </p>
      }
    }

    @if (store.events().length > 0) {
      <section class="card" aria-labelledby="dbg-stage-summary">
        <h2 id="dbg-stage-summary">Stage summary</h2>
        <p class="card-sub">Counts every stored event, not only the filtered ones.</p>
        <div class="table-wrap">
          <table>
            <caption class="sr-only">
              Stage summary across all stored events
            </caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Events</th>
              </tr>
            </thead>
            <tbody>
              @for (entry of store.stageSummary().stages; track entry.stage) {
                <tr>
                  <td class="mono">{{ entry.stage }}</td>
                  <td class="num">{{ entry.count }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="card-sub summary-line">
          All stored events: {{ store.stageSummary().total }} · with issues: {{ store.stageSummary().withIssues }} ·
          warnings: {{ store.stageSummary().warnings }} · errors:
          {{ store.stageSummary().errors }}
        </p>
      </section>

      <section class="card" aria-labelledby="dbg-filters-heading">
        <h2 id="dbg-filters-heading">Filters</h2>
        <hb-debugger-filters
          [filter]="store.filter()"
          [stages]="stageOptions()"
          [statuses]="statusOptions()"
          [filteredCount]="store.filteredCount()"
          [totalCount]="store.stageSummary().total"
          (filterChange)="onFilterChange($event)"
          (jumpFirst)="jumpToFirstMatch()"
          (clear)="clearFilters()"
        />
      </section>

      <div class="toolbar" role="group" aria-label="Event navigation">
        <button type="button" class="small" (click)="previous()" [disabled]="!canPrevious()">Previous event</button>
        <button type="button" class="small" (click)="next()" [disabled]="!canNext()">Next event</button>
      </div>

      <div class="debugger-grid">
        <section class="card" aria-labelledby="dbg-timeline-heading">
          <h2 id="dbg-timeline-heading">Timeline</h2>
          <p class="card-sub">Filtered events, in stored sequence order.</p>
          <hb-trace-timeline
            [events]="store.filtered()"
            [selectedSeq]="store.selectedSeq()"
            (selectSeq)="store.selectSeq($event)"
          />
        </section>

        <section class="card detail-card">
          @if (store.selected(); as current) {
            <hb-event-detail [event]="current" [mappingSpec]="mappingSpec()" />
          } @else {
            <hb-empty
              title="No event selected"
              message="Select an event in the timeline to see its payload and rule provenance."
            />
          }
        </section>
      </div>

      <section class="card">
        <hb-record-panel [resources]="resources()" [event]="store.selected()" />
      </section>

      <section class="card">
        <hb-debugger-export [payload]="exportPayload()" />
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .page-header .actions {
      flex-wrap: wrap;
    }

    hb-error {
      display: block;
      margin-bottom: var(--space-3);
    }

    .banner {
      margin: 0 0 var(--space-3);
    }

    .banner button {
      margin-left: var(--space-2);
    }

    section.card {
      margin-bottom: var(--space-3);
    }

    .summary-line {
      margin: var(--space-3) 0 0;
    }

    .toolbar {
      margin-top: var(--space-3);
      margin-bottom: var(--space-3);
    }

    .debugger-grid {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
      margin-bottom: var(--space-3);
    }

    .debugger-grid > * {
      min-width: 0;
    }

    .debugger-grid section.card {
      margin-bottom: 0;
    }

    .detail-card {
      min-width: 0;
    }

    @media (max-width: 900px) {
      .debugger-grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class DebuggerPage {
  protected readonly store = inject(DebuggerStore);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly runId = signal(this.route.snapshot.paramMap.get("runId") ?? "");

  private qTimer?: ReturnType<typeof setTimeout>;
  private reconciled = false;

  protected readonly stageOptions: Signal<string[]> = computed(() => {
    const seen = new Set<string>();
    for (const event of this.store.events()) seen.add(event.stage);

    const known = new Set<string>(TRACE_STAGES);
    const ordered = [...TRACE_STAGES].filter((stage) => seen.has(stage));
    const extra = [...seen]
      .filter((stage) => !known.has(stage))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const stages = [...ordered, ...extra];
    // A deep-linked filter must stay visible in its select even when no stored row uses it.
    const active = this.store.filter().stage;
    return active !== null && !stages.includes(active) ? [...stages, active] : stages;
  });

  protected readonly statusOptions: Signal<string[]> = computed(() => {
    const seen = new Set<string>();
    for (const event of this.store.events()) seen.add(event.status);
    const statuses = [...seen].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    // Same rule for a deep-linked status the stored rows do not contain.
    const active = this.store.filter().status;
    return active !== null && !statuses.includes(active) ? [...statuses, active] : statuses;
  });

  protected readonly mappingSpec = computed<unknown>(() => this.store.mapping()?.spec ?? null);

  protected readonly resources = computed<unknown[]>(() => this.store.run()?.result?.resources ?? []);

  protected readonly exportPayload = computed<TraceExport | null>(() => this.store.exportPayload());

  protected readonly selectedIndex = computed(() => {
    const seq = this.store.selectedSeq();
    if (seq === null) return -1;
    return this.store.filtered().findIndex((event: DebuggerEvent) => event.seq === seq);
  });

  protected readonly canPrevious = computed(() => this.selectedIndex() > 0);

  protected readonly canNext = computed(() => {
    const index = this.selectedIndex();
    return index >= 0 && index < this.store.filtered().length - 1;
  });

  public constructor() {
    const query = this.route.snapshot.queryParamMap;
    const eventSeq = indexParam(query.get("event"));

    this.store.setFilter({
      stage: trimmedOrNull(query.get("stage")),
      status: trimmedOrNull(query.get("status")),
      record: indexParam(query.get("record")),
      rule: trimmedOrNull(query.get("rule")),
      q: query.get("q") ?? "",
      onlyIssues: query.get("only") === "issues",
    });
    this.store.selectSeq(eventSeq);
    this.store.load(this.runId());

    // One-shot deep-link reconciliation: a selected seq that the filters exclude becomes the
    // first filtered event, so `?event=` and `?stage=` cannot disagree after the first load.
    effect(() => {
      if (this.reconciled) return;
      if (!this.store.hasLoaded() || this.store.loading()) return;
      this.reconciled = true;

      const seq = this.store.selectedSeq();
      const filtered = this.store.filtered();
      if (seq === null || filtered.some((event) => event.seq === seq)) return;
      const first = filtered[0];
      if (first !== undefined) this.store.selectSeq(first.seq);
    });

    // The URL is the only durable view state. `replaceUrl` keeps Back at the page boundary.
    effect(() => {
      const filter = this.store.filter();
      const selectedSeq = this.store.selectedSeq();
      const params: Params = {};
      if (selectedSeq !== null) params["event"] = selectedSeq;
      if (filter.record !== null) params["record"] = filter.record;
      if (filter.rule !== null) params["rule"] = filter.rule;
      if (filter.stage !== null) params["stage"] = filter.stage;
      if (filter.status !== null) params["status"] = filter.status;
      if (filter.q.length > 0) params["q"] = filter.q;
      if (filter.onlyIssues) params["only"] = "issues";

      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: params,
        replaceUrl: true,
      });
    });

    this.destroyRef.onDestroy(() => {
      if (this.qTimer !== undefined) clearTimeout(this.qTimer);
    });
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected refresh(): void {
    if (this.store.hasLoaded()) {
      this.store.refreshTraces();
    } else {
      this.store.load(this.runId());
    }
  }

  protected reload(): void {
    this.store.load(this.runId());
  }

  /** `q` is the only debounced filter; every other patch applies immediately. */
  protected onFilterChange(patch: Partial<DebuggerFilter>): void {
    if (patch.q !== undefined) {
      const q = patch.q;
      if (this.qTimer !== undefined) clearTimeout(this.qTimer);
      this.qTimer = setTimeout(() => {
        this.qTimer = undefined;
        this.store.setFilter({ q });
      }, 150);
      return;
    }

    this.store.setFilter(patch);
  }

  protected clearFilters(): void {
    if (this.qTimer !== undefined) {
      clearTimeout(this.qTimer);
      this.qTimer = undefined;
    }
    this.store.clearFilter();
  }

  protected jumpToFirstMatch(): void {
    this.store.jumpToFirstMatch();
  }

  protected previous(): void {
    const index = this.selectedIndex();
    if (index > 0) this.store.selectIndex(index - 1);
  }

  protected next(): void {
    const index = this.selectedIndex();
    if (index >= 0 && index < this.store.filtered().length - 1) this.store.selectIndex(index + 1);
  }
}
