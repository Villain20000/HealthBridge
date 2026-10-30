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
            this.loadedRunId = runId;
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
