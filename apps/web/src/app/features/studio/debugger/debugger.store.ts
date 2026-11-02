import { Injectable, computed, inject, signal } from "@angular/core";
import type { Signal } from "@angular/core";
import { forkJoin } from "rxjs";
import type { ValidationIssue } from "@healthbridge/shared-types";
import { ApiClient } from "../../../core/api-client";
import type { ApiProblem, Mapping, Run } from "../../../core/api-types";
import {
  NO_FILTER,
  buildExport,
  buildTimeline,
  describeTraceAvailability,
  filterEvents,
  mergeIssues,
  stageSummary as summarizeStages,
} from "./trace.logic";
import type {
  DebuggerEvent,
  DebuggerFilter,
  MergedIssue,
  StageSummary,
  TraceAvailability,
  TraceExport,
} from "./trace.logic";
import {
  findNextBreakpoint,
  findNextErrorIndex,
  findNextRecordIndex,
} from "./breakpoints.logic";
import type { Breakpoint } from "./breakpoints.logic";

/**
 * Page-scoped store for the stored-trace debugger.
 *
 * There is no live mode here: traces are read once from storage, and a manual refresh re-reads
 * the rows. `load` fetches the run, its exact mapping version (`getMapping(run.mappingId)`) and
 * the stored rows/issues; `refreshTraces` only re-reads rows. A monotonic request token makes
 * late responses from a superseded request harmless, and every failure becomes the
 * `ApiProblem` the standard error panel renders. Prior data is never discarded by an error.
 */
@Injectable()
export class DebuggerStore {
  private readonly api = inject(ApiClient);

  private readonly runSignal = signal<Run | null>(null);
  private readonly mappingSignal = signal<Mapping | null>(null);
  private readonly eventsSignal = signal<DebuggerEvent[]>([]);
  private readonly issuesSignal = signal<ValidationIssue[]>([]);
  private readonly filterSignal = signal<DebuggerFilter>(NO_FILTER);
  private readonly loadingSignal = signal(false);
  private readonly problemSignal = signal<ApiProblem | null>(null);
  private readonly selectedSeqSignal = signal<number | null>(null);

  private readonly breakpointsSignal = signal<Breakpoint[]>([]);
  private readonly offFilterNoticeSignal = signal<{ seq: number; label: string } | null>(null);

  private requestToken = 0;
  private loadedRunId: string | null = null;

  public readonly run: Signal<Run | null> = this.runSignal.asReadonly();
  public readonly mapping: Signal<Mapping | null> = this.mappingSignal.asReadonly();
  public readonly events: Signal<DebuggerEvent[]> = this.eventsSignal.asReadonly();
  public readonly issues: Signal<ValidationIssue[]> = this.issuesSignal.asReadonly();
  public readonly filter: Signal<DebuggerFilter> = this.filterSignal.asReadonly();
  public readonly loading: Signal<boolean> = this.loadingSignal.asReadonly();
  public readonly problem: Signal<ApiProblem | null> = this.problemSignal.asReadonly();
  public readonly selectedSeq: Signal<number | null> = this.selectedSeqSignal.asReadonly();

  public readonly breakpoints: Signal<Breakpoint[]> = this.breakpointsSignal.asReadonly();
  public readonly offFilterNotice: Signal<{ seq: number; label: string } | null> =
    this.offFilterNoticeSignal.asReadonly();

  public readonly breakpointSeqs: Signal<Set<number>> = computed(() => {
    const set = new Set<number>();
    for (const bp of this.breakpointsSignal()) {
      if (bp.enabled && bp.kind === "seq") {
        set.add(Number(bp.value));
      }
    }
    return set;
  });

  public readonly selected: Signal<DebuggerEvent | null> = computed(() => {
    const seq = this.selectedSeqSignal();
    if (seq === null) return null;
    return this.filtered().find((event) => event.seq === seq) ?? null;
  });

  public readonly filtered: Signal<DebuggerEvent[]> = computed(() =>
    filterEvents(this.eventsSignal(), this.filterSignal()),
  );

  public readonly filteredCount: Signal<number> = computed(() => this.filtered().length);

  /** Deliberately over the unfiltered timeline: a summary must describe the stored run. */
  public readonly stageSummary: Signal<StageSummary> = computed(() => summarizeStages(this.eventsSignal()));

  public readonly mergedIssues: Signal<MergedIssue[]> = computed(() =>
    mergeIssues(this.issuesSignal(), this.eventsSignal()),
  );

  public readonly availability: Signal<TraceAvailability | null> = computed(() => {
    const run = this.runSignal();
    return run === null ? null : describeTraceAvailability(run.status, this.eventsSignal().length);
  });

  public readonly hasLoaded: Signal<boolean> = computed(() => this.runSignal() !== null);

  /** Loads one run and everything the debugger reads for it. Errors never throw at the caller. */
  public load(runId: string): void {
    const token = ++this.requestToken;
    this.loadingSignal.set(true);
    this.problemSignal.set(null);
    this.loadedRunId = runId;

    let loadedBps: Breakpoint[] = [];
    try {
      if (typeof sessionStorage !== "undefined") {
        const cached = sessionStorage.getItem(`healthbridge:debugger:bp:${runId}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            loadedBps = parsed;
          }
        }
      }
    } catch {}
    this.breakpointsSignal.set(loadedBps);

    this.api.getRun(runId).subscribe({
      next: (run) => {
        if (token !== this.requestToken) return;

        forkJoin({
          traces: this.api.getRunTraces(runId),
          issues: this.api.getRunIssues(runId),
          // The run's exact mapping version, never a name lookup or the latest version.
          mapping: this.api.getMapping(run.mappingId),
        }).subscribe({
          next: (result) => {
            if (token !== this.requestToken) return;

            const events = buildTimeline(result.traces.traces);
            this.runSignal.set(run);
            this.mappingSignal.set(result.mapping);
            this.eventsSignal.set(events);
            this.issuesSignal.set(result.issues.issues);
            this.selectDefault(events);
            this.loadingSignal.set(false);
          },
          error: (error: ApiProblem) => {
            if (token !== this.requestToken) return;
            this.problemSignal.set(error);
            this.loadingSignal.set(false);
          },
        });
      },
      error: (error: ApiProblem) => {
        if (token !== this.requestToken) return;
        this.problemSignal.set(error);
        this.loadingSignal.set(false);
      },
    });
  }

  /** Re-reads only the stored rows of the loaded run; run, issues and mapping stay as loaded. */
  public refreshTraces(): void {
    const runId = this.loadedRunId;
    if (runId === null) return;

    const token = ++this.requestToken;
    this.loadingSignal.set(true);
    this.problemSignal.set(null);

    this.api.getRunTraces(runId).subscribe({
      next: (result) => {
        if (token !== this.requestToken) return;
        const events = buildTimeline(result.traces);
        this.eventsSignal.set(events);
        this.selectDefault(events);
        this.loadingSignal.set(false);
      },
      error: (error: ApiProblem) => {
        if (token !== this.requestToken) return;
        this.problemSignal.set(error);
        this.loadingSignal.set(false);
      },
    });
  }

  private persistBreakpoints(bps: Breakpoint[]): void {
    if (this.loadedRunId && typeof sessionStorage !== "undefined") {
      try {
        sessionStorage.setItem(`healthbridge:debugger:bp:${this.loadedRunId}`, JSON.stringify(bps));
      } catch {}
    }
  }

  public toggleSeqBreakpoint(seq: number): void {
    const current = this.breakpointsSignal();
    const existingIdx = current.findIndex((bp) => bp.kind === "seq" && Number(bp.value) === seq);
    let next: Breakpoint[];
    if (existingIdx >= 0) {
      next = current.filter((_, idx) => idx !== existingIdx);
    } else {
      const newBp: Breakpoint = {
        id: `bp-seq-${seq}-${Date.now().toString(36)}`,
        kind: "seq",
        enabled: true,
        value: seq,
      };
      next = [...current, newBp];
    }
    this.breakpointsSignal.set(next);
    this.persistBreakpoints(next);
  }

  public addBreakpoint(bp: Omit<Breakpoint, "id">): void {
    const newBp: Breakpoint = {
      ...bp,
      id: `bp-${bp.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    };
    const next = [...this.breakpointsSignal(), newBp];
    this.breakpointsSignal.set(next);
    this.persistBreakpoints(next);
  }

  public removeBreakpoint(id: string): void {
    const next = this.breakpointsSignal().filter((bp) => bp.id !== id);
    this.breakpointsSignal.set(next);
    this.persistBreakpoints(next);
  }

  public toggleBreakpoint(id: string): void {
    const next = this.breakpointsSignal().map((bp) => (bp.id === id ? { ...bp, enabled: !bp.enabled } : bp));
    this.breakpointsSignal.set(next);
    this.persistBreakpoints(next);
  }

  public stepOver(): void {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const idx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);
    if (idx >= 0 && idx < visible.length - 1) {
      this.selectIndex(idx + 1);
    } else if (idx === -1 && visible.length > 0) {
      this.selectIndex(0);
    }
  }

  public stepBack(): void {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const idx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);
    if (idx > 0) {
      this.selectIndex(idx - 1);
    }
  }

  public continueToBreakpoint(): boolean {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const currentVisibleIdx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);

    const nextVisibleIdx = findNextBreakpoint(visible, currentVisibleIdx, this.breakpointsSignal(), "forward");
    if (nextVisibleIdx >= 0) {
      this.selectIndex(nextVisibleIdx);
      return true;
    }

    const all = this.eventsSignal();
    const currentAllIdx = selected === null ? -1 : all.findIndex((e) => e.seq === selected);
    const nextAllIdx = findNextBreakpoint(all, currentAllIdx, this.breakpointsSignal(), "forward");
    if (nextAllIdx >= 0) {
      const match = all[nextAllIdx];
      this.offFilterNoticeSignal.set({
        seq: match.seq,
        label: `Breakpoint match at event #${match.seq} (${match.stage}) is hidden by current filters.`,
      });
    }
    return false;
  }

  public jumpToNextError(): boolean {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const currentVisibleIdx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);

    const nextVisibleIdx = findNextErrorIndex(visible, currentVisibleIdx, "forward");
    if (nextVisibleIdx >= 0) {
      this.selectIndex(nextVisibleIdx);
      return true;
    }

    const all = this.eventsSignal();
    const currentAllIdx = selected === null ? -1 : all.findIndex((e) => e.seq === selected);
    const nextAllIdx = findNextErrorIndex(all, currentAllIdx, "forward");
    if (nextAllIdx >= 0) {
      const match = all[nextAllIdx];
      this.offFilterNoticeSignal.set({
        seq: match.seq,
        label: `Next error at event #${match.seq} (${match.stage}) is hidden by current filters.`,
      });
    }
    return false;
  }

  public jumpToPrevError(): boolean {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const currentVisibleIdx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);

    const nextVisibleIdx = findNextErrorIndex(visible, currentVisibleIdx, "backward");
    if (nextVisibleIdx >= 0) {
      this.selectIndex(nextVisibleIdx);
      return true;
    }

    const all = this.eventsSignal();
    const currentAllIdx = selected === null ? -1 : all.findIndex((e) => e.seq === selected);
    const nextAllIdx = findNextErrorIndex(all, currentAllIdx, "backward");
    if (nextAllIdx >= 0) {
      const match = all[nextAllIdx];
      this.offFilterNoticeSignal.set({
        seq: match.seq,
        label: `Previous error at event #${match.seq} (${match.stage}) is hidden by current filters.`,
      });
    }
    return false;
  }

  public jumpToNextRecord(): boolean {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const currentVisibleIdx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);

    const nextVisibleIdx = findNextRecordIndex(visible, currentVisibleIdx, "forward");
    if (nextVisibleIdx >= 0) {
      this.selectIndex(nextVisibleIdx);
      return true;
    }
    return false;
  }

  public jumpToPrevRecord(): boolean {
    this.clearOffFilterNotice();
    const visible = this.filtered();
    const selected = this.selectedSeqSignal();
    const currentVisibleIdx = selected === null ? -1 : visible.findIndex((e) => e.seq === selected);

    const nextVisibleIdx = findNextRecordIndex(visible, currentVisibleIdx, "backward");
    if (nextVisibleIdx >= 0) {
      this.selectIndex(nextVisibleIdx);
      return true;
    }
    return false;
  }

  public jumpToOffFilterMatch(): void {
    const notice = this.offFilterNoticeSignal();
    if (notice) {
      this.clearFilter();
      this.selectSeq(notice.seq);
      this.clearOffFilterNotice();
    }
  }

  public clearOffFilterNotice(): void {
    this.offFilterNoticeSignal.set(null);
  }

  /**
   * Merges a filter patch. Any non-query change re-clamps the selection so the detail pane
   * never shows an event the list no longer contains; `q` is left to the page's debounce.
   */
  public setFilter(patch: Partial<DebuggerFilter>): void {
    const previous = this.filterSignal();
    const next: DebuggerFilter = {
      stage: patch.stage !== undefined ? patch.stage : previous.stage,
      status: patch.status !== undefined ? patch.status : previous.status,
      record: patch.record !== undefined ? patch.record : previous.record,
      rule: patch.rule !== undefined ? patch.rule : previous.rule,
      q: patch.q !== undefined ? patch.q : previous.q,
      onlyIssues: patch.onlyIssues !== undefined ? patch.onlyIssues : previous.onlyIssues,
    };
    this.filterSignal.set(next);

    const nonQueryChanged =
      next.stage !== previous.stage ||
      next.status !== previous.status ||
      next.record !== previous.record ||
      next.rule !== previous.rule ||
      next.onlyIssues !== previous.onlyIssues;
    if (nonQueryChanged) this.clampSelection();
  }

  public clearFilter(): void {
    this.filterSignal.set(NO_FILTER);
    this.clampSelection();
  }

  public selectSeq(seq: number | null): void {
    this.selectedSeqSignal.set(seq);
  }

  /** Selects by index into the filtered list; an out-of-range index clears the selection. */
  public selectIndex(index: number): void {
    const event = this.filtered()[index];
    this.selectedSeqSignal.set(event ? event.seq : null);
  }

  public jumpToFirstMatch(): boolean {
    const first = this.filtered()[0];
    this.selectedSeqSignal.set(first ? first.seq : null);
    return first !== undefined;
  }

  public exportPayload(generatedAt?: string): TraceExport | null {
    const run = this.runSignal();
    if (run === null) return null;
    return buildExport(run.id, this.filtered(), this.filterSignal(), generatedAt ?? new Date().toISOString());
  }

  /** Keeps the selection when the refreshed timeline still has it, else picks the first event. */
  private selectDefault(events: DebuggerEvent[]): void {
    const current = this.selectedSeqSignal();
    if (current !== null && events.some((event) => event.seq === current)) return;
    this.selectedSeqSignal.set(events.length > 0 ? events[0].seq : null);
  }

  private clampSelection(): void {
    const selected = this.selectedSeqSignal();
    if (selected === null) return;

    const visible = this.filtered();
    if (visible.some((event) => event.seq === selected)) return;
    this.selectedSeqSignal.set(visible.length > 0 ? visible[0].seq : null);
  }
}
