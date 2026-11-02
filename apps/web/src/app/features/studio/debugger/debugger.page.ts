import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import type { Signal } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { Params } from "@angular/router";
import { formatRelative } from "../../../core/format";
import { EmptyState, ErrorPanel, LoadingState, StatusChip } from "../../../ui/primitives";
import { BreakpointsPanel } from "./breakpoints-panel";
import { DebuggerExport } from "./debugger-export";
import { DebuggerFilters } from "./debugger-filters";
import { DebuggerToolbar } from "./debugger-toolbar";
import { DebuggerStore } from "./debugger.store";
import { EventDetail } from "./event-detail";
import { Provenance } from "./provenance";
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
 * Three-Pane Stored-Trace Transformation Debugger.
 *
 * Left Pane: Timeline with gutter breakpoint toggles, Breakpoints Manager, Filters & Stage Summary.
 * Center Pane: Execution Toolbar (F5, F10, Shift+F10, Jump Error), Event Payload JSON trees, Resource/Snippet Diffs.
 * Right Pane: Rule Provenance with condition evaluation ([observed] vs [inferred]), Issues & Export.
 *
 * Every row comes from `DebuggerStore`, which reads stored traces once and offers manual refresh.
 * It strictly reads stored trace rows and never attaches to a live run.
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
    DebuggerToolbar,
    BreakpointsPanel,
    TraceTimeline,
    DebuggerFilters,
    EventDetail,
    Provenance,
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
      <hb-debugger-toolbar
        [canPrevious]="canPrevious()"
        [canNext]="canNext()"
        [hasBreakpoints]="store.breakpoints().length > 0"
        [currentIndex]="selectedIndex()"
        [totalCount]="store.filteredCount()"
        [offFilterNotice]="store.offFilterNotice()"
        (continue)="store.continueToBreakpoint()"
        (stepOver)="store.stepOver()"
        (stepBack)="store.stepBack()"
        (jumpNextError)="store.jumpToNextError()"
        (jumpPrevError)="store.jumpToPrevError()"
        (jumpNextRecord)="store.jumpToNextRecord()"
        (jumpPrevRecord)="store.jumpToPrevRecord()"
        (jumpOffFilter)="store.jumpToOffFilterMatch()"
        (clearOffFilter)="store.clearOffFilterNotice()"
      />

      <div class="debugger-three-pane">
        <!-- PANE 1: Navigation & Traps -->
        <div class="pane left-pane">
          <section class="card" aria-labelledby="dbg-timeline-heading">
            <div class="pane-card-header">
              <h2 id="dbg-timeline-heading">Timeline</h2>
              <span class="subtle mono">{{ store.filteredCount() }} / {{ store.stageSummary().total }}</span>
            </div>
            <p class="card-sub">Filtered events in sequence order. Click gutter to toggle breakpoints.</p>
            <hb-trace-timeline
              [events]="store.filtered()"
              [selectedSeq]="store.selectedSeq()"
              [breakpointSeqs]="store.breakpointSeqs()"
              (selectSeq)="store.selectSeq($event)"
              (toggleBreakpoint)="store.toggleSeqBreakpoint($event)"
            />
          </section>

          <hb-breakpoints-panel
            [breakpoints]="store.breakpoints()"
            (add)="store.addBreakpoint($event)"
            (remove)="store.removeBreakpoint($event)"
            (toggle)="store.toggleBreakpoint($event)"
          />

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

          <section class="card" aria-labelledby="dbg-stage-summary">
            <h2 id="dbg-stage-summary">Stage summary</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Stage</th>
                    <th scope="col">Count</th>
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
              Total: {{ store.stageSummary().total }} · with issues: {{ store.stageSummary().withIssues }} · errors:
              {{ store.stageSummary().errors }}
            </p>
          </section>
        </div>

        <!-- PANE 2: Payload & Envelopes -->
        <div class="pane center-pane">
          <section class="card detail-card">
            @if (store.selected(); as current) {
              <hb-event-detail [event]="current" [mappingSpec]="mappingSpec()" />
            } @else {
              <hb-empty
                title="No event selected"
                message="Select an event in the timeline or use stepping controls."
              />
            }
          </section>

          <section class="card">
            <hb-record-panel [resources]="resources()" [event]="store.selected()" />
          </section>
        </div>

        <!-- PANE 3: Provenance & Rules -->
        <div class="pane right-pane">
          <section class="card">
            @if (store.selected(); as current) {
              <hb-provenance [event]="current" [mappingSpec]="mappingSpec()" />
            } @else {
              <hb-empty
                title="No provenance available"
                message="Select an event to inspect declared rule provenance and condition evaluation."
              />
            }
          </section>

          <section class="card">
            <hb-debugger-export [payload]="exportPayload()" />
          </section>
        </div>
      </div>
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

    .pane-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-1);
    }

    .pane-card-header h2 {
      margin: 0;
    }

    .debugger-three-pane {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr) 360px;
      gap: var(--space-3);
      align-items: start;
      margin-bottom: var(--space-3);
    }

    .pane {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 0;
    }

    .pane section.card {
      margin-bottom: 0;
    }

    .summary-line {
      margin: var(--space-2) 0 0;
    }

    @media (max-width: 1280px) {
      .debugger-three-pane {
        grid-template-columns: 320px minmax(0, 1fr);
      }
      .right-pane {
        grid-column: 1 / -1;
      }
    }

    @media (max-width: 900px) {
      .debugger-three-pane {
        grid-template-columns: 1fr;
      }
      .right-pane {
        grid-column: auto;
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
    const active = this.store.filter().stage;
    return active !== null && !stages.includes(active) ? [...stages, active] : stages;
  });

  protected readonly statusOptions: Signal<string[]> = computed(() => {
    const seen = new Set<string>();
    for (const event of this.store.events()) seen.add(event.status);
    const statuses = [...seen].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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

  @HostListener("window:keydown", ["$event"])
  protected onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName?.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") {
      return;
    }

    if (event.key === "F5") {
      event.preventDefault();
      this.store.continueToBreakpoint();
    } else if (event.key === "F10" && !event.shiftKey) {
      event.preventDefault();
      this.store.stepOver();
    } else if (event.key === "F10" && event.shiftKey) {
      event.preventDefault();
      this.store.stepBack();
    } else if (event.key === "F9") {
      event.preventDefault();
      const current = this.store.selected();
      if (current) {
        this.store.toggleSeqBreakpoint(current.seq);
      }
    } else if (event.altKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      this.store.jumpToNextError();
    }
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
    this.store.stepBack();
  }

  protected next(): void {
    this.store.stepOver();
  }
}
