import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsonPipe } from "@angular/common";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import { AuthStore } from "../../core/auth.store";
import type { ApiProblem, Run, RunResourcesResponse, RunTracesResponse } from "../../core/api-types";
import type { ValidationIssue } from "@healthbridge/shared-types";
import { ErrorPanel, EmptyState, LoadingState, StatusChip } from "../../ui/primitives";
import {
  elapsedBetween,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelative,
  isTerminalStatus,
  pluralize,
} from "../../core/format";
import { openSse, type SseConnectionState, type SseHandle } from "../../core/sse";

type Tab = "overview" | "issues" | "resources" | "traces" | "bundle";

const TAB_VALUES: readonly Tab[] = ["overview", "issues", "resources", "traces", "bundle"];

/** A `?tab=` value is only honoured when it names a real panel. */
function isTab(value: string): value is Tab {
  return (TAB_VALUES as readonly string[]).includes(value);
}

/**
 * Run detail: the lifecycle, the problems, the output, and live progress.
 *
 * Live updates use `fetch` + `ReadableStream` (`core/sse.ts`) because `EventSource` cannot send
 * the API key. The stream is closed on navigation, on sign-out and when the run reaches a
 * terminal state; the fallback is a 2 s poll, so a buffering proxy degrades instead of hanging.
 */
@Component({
  selector: "hb-run-detail",
  standalone: true,
  imports: [RouterLink, StatusChip, ErrorPanel, EmptyState, LoadingState, JsonPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1 class="mono" style="font-size: 17px">{{ runId() }}</h1>
        <p>
          @if (run(); as current) {
            Created {{ relative(current.createdAt) }} · engine {{ current.engineVersion }}
            @if (current.adapterId) {
              · adapter {{ current.adapterId }}
            }
          }
        </p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        @if (run(); as current) {
          @if (!isTerminal(current.status)) {
            <button type="button" class="small danger" (click)="cancel()" [disabled]="acting()">Cancel run</button>
          }
          <button type="button" class="small" (click)="replay()" [disabled]="acting()">Replay</button>
        }
        <a class="button small" routerLink="/runs">Back to runs</a>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && !run()) {
      <hb-loading label="Loading run…" />
    }

    @if (run(); as current) {
      <div class="grid cols-4">
        <div class="card">
          <div class="stat">
            <span class="label">Status</span>
            <span class="value" style="font-size: 15px"><hb-status-chip [status]="current.status" /></span>
            <span class="hint">{{ liveLabel() }}</span>
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Records</span>
            <span class="value">{{ current.recordsSucceeded }}/{{ current.recordsProcessed }}</span>
            <span class="hint">{{ current.recordsFailed }} rejected</span>
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Duration</span>
            <span class="value" style="font-size: 15px">{{ duration(current) }}</span>
            <span class="hint">{{ current.startedAt ? "from startedAt" : "not started yet" }}</span>
          </div>
        </div>
        <div class="card">
          <div class="stat">
            <span class="label">Validation</span>
            <span class="value" style="font-size: 15px">{{ validationLabel(current) }}</span>
            <span class="hint">{{ issueCount() }} issues loaded</span>
          </div>
        </div>
      </div>

      @if (current.error; as error) {
        <p class="error-panel" style="margin-top: 16px">
          <strong>{{ error.message }}</strong>
          <span class="code"> {{ error.code }}</span>
        </p>
      }

      <div class="toolbar" style="margin-top: 16px" role="tablist" aria-label="Run sections">
        @for (entry of tabs; track entry.value) {
          <button
            type="button"
            class="small"
            role="tab"
            [id]="'run-tab-' + entry.value"
            [attr.aria-controls]="tab() === entry.value ? 'run-panel-' + entry.value : null"
            [class.primary]="tab() === entry.value"
            [attr.aria-selected]="tab() === entry.value"
            [attr.tabindex]="tab() === entry.value ? 0 : -1"
            (click)="selectTab(entry.value)"
            (keydown)="onTabKeydown($event, entry.value)"
          >
            {{ entry.label }}
          </button>
        }
      </div>

      @switch (tab()) {
        @case ("overview") {
          <section
            class="card"
            role="tabpanel"
            id="run-panel-overview"
            [attr.aria-labelledby]="'run-tab-overview'"
            tabindex="0"
          >
            <h2>Lifecycle</h2>
            <dl class="kv">
              <dt>Queued</dt>
              <dd>{{ stamp(current.createdAt) }}</dd>
              <dt>Started</dt>
              <dd>{{ stamp(current.startedAt) }}</dd>
              <dt>Finished</dt>
              <dd>{{ stamp(current.finishedAt) }}</dd>
              <dt>Asset</dt>
              <dd class="mono">{{ current.assetId }}</dd>
              <dt>Mapping</dt>
              <dd class="mono">{{ current.mappingId }}</dd>
              <dt>Input checksum</dt>
              <dd class="mono">{{ current.inputChecksum ?? "—" }}</dd>
              <dt>Output checksum</dt>
              <dd class="mono">{{ current.outputChecksum ?? "—" }}</dd>
              @if (current.options) {
                <dt>Options</dt>
                <dd class="mono">{{ current.options | json }}</dd>
              }
            </dl>

            <div style="margin-top: 16px">
              <h3>Stored-trace debugger</h3>
              <p class="card-sub">
                Replay this run's stored trace events with filters, declared rule provenance and diffs. The debugger
                reads stored rows and never attaches to a live run.
              </p>
              <a class="button small" [routerLink]="['/studio/debugger', current.id]">Open stored-trace debugger</a>
            </div>
          </section>
        }

        @case ("issues") {
          <section
            class="card"
            role="tabpanel"
            id="run-panel-issues"
            [attr.aria-labelledby]="'run-tab-issues'"
            tabindex="0"
          >
            <h2>Validation issues</h2>
            <p class="card-sub">
              Problems the engine reported for this run, with the record index and field path where known.
            </p>
            @if (issues().length === 0) {
              <hb-empty title="No issues reported" message="The run produced no validation problems." />
            } @else {
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Code</th>
                      <th>Message</th>
                      <th>Record</th>
                      <th>Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (issue of issues(); track issue.recordIndex + "-" + issue.code + "-" + issue.path) {
                      <tr>
                        <td>
                          <span class="chip" [class]="severityClass(issue.severity)">{{ issue.severity }}</span>
                        </td>
                        <td class="mono">{{ issue.code }}</td>
                        <td>{{ issue.message }}</td>
                        <td class="num">{{ issue.recordIndex ?? "—" }}</td>
                        <td class="mono">{{ issue.path ?? "—" }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (rejected().length > 0) {
                <p class="card-sub" style="margin-top: 12px">
                  {{ rejected().length }} record(s) were rejected outright.
                </p>
              }
            }
          </section>
        }

        @case ("resources") {
          <section
            class="card"
            role="tabpanel"
            id="run-panel-resources"
            [attr.aria-labelledby]="'run-tab-resources'"
            tabindex="0"
          >
            <h2>Generated resources</h2>
            @if (resources(); as payload) {
              @if (payload.omitted) {
                <p class="banner">
                  {{ payload.note ?? "The output exceeded the server's stored-result limit." }}
                  The counts and checksums above are still exact.
                </p>
              }
              @if (payload.resources.length === 0) {
                <hb-empty title="No resources stored" message="Nothing was exported for this run." />
              } @else {
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Resource type</th>
                        <th>Id</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (resource of payload.resources; track $index) {
                        <tr>
                          <td class="num">{{ $index + 1 }}</td>
                          <td>{{ resource.resourceType }}</td>
                          <td class="mono">{{ resource.id ?? "—" }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <div class="pager">
                  {{ pluralize(payload.resources.length, "resource") }} shown{{
                    payload.bytes ? " · " + humanBytes(payload.bytes) : ""
                  }}
                </div>
              }
            } @else {
              <hb-loading label="Loading resources…" />
            }
          </section>
        }

        @case ("traces") {
          <section
            class="card"
            role="tabpanel"
            id="run-panel-traces"
            [attr.aria-labelledby]="'run-tab-traces'"
            tabindex="0"
          >
            <h2>Traces</h2>
            @if (traces(); as payload) {
              @if (payload.traces.length === 0) {
                <hb-empty title="No traces stored" message="This run produced no trace events." />
              } @else {
                <p class="card-sub">{{ payload.count }} events · redacted payloads per ADR-0002/0003</p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th class="num">#</th>
                        <th>Stage</th>
                        <th>Step</th>
                        <th>Status</th>
                        <th>Redaction</th>
                        <th>At</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (trace of payload.traces; track trace.seq) {
                        <tr>
                          <td class="num">{{ trace.seq }}</td>
                          <td>{{ trace.stage }}</td>
                          <td>{{ trace.stepName ?? "—" }}</td>
                          <td>{{ trace.status ?? "—" }}</td>
                          <td class="subtle">{{ trace.payload?.["redactionState"] ?? "—" }}</td>
                          <td class="subtle">{{ trace.createdAt?.slice(11, 19) ?? "—" }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            } @else {
              <hb-loading label="Loading traces…" />
            }
          </section>
        }

        @case ("bundle") {
          <section
            class="card"
            role="tabpanel"
            id="run-panel-bundle"
            [attr.aria-labelledby]="'run-tab-bundle'"
            tabindex="0"
          >
            <h2>Reproducibility bundle</h2>
            <p class="card-sub">The stored envelope that <code>healthbridge reproduce</code> replays byte-for-byte.</p>
            @if (bundle(); as payload) {
              <pre>{{ payload | json }}</pre>
            } @else {
              <hb-loading label="Loading bundle…" />
            }
          </section>
        }
      }
    }
  `,
  styles: `
    /* The global button hover rule outranks button.primary, so a hovered selected tab would
       otherwise lose its accent background and render white text on a light surface. */
    .toolbar button.primary:hover:not(:disabled) {
      background: var(--accent);
      border-color: var(--accent);
      filter: brightness(1.08);
    }
  `,
})
export class RunDetailPage {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tabs: Array<{ value: Tab; label: string }> = [
    { value: "overview", label: "Overview" },
    { value: "issues", label: "Issues" },
    { value: "resources", label: "Resources" },
    { value: "traces", label: "Traces" },
    { value: "bundle", label: "Bundle" },
  ];

  protected readonly runId = signal(this.route.snapshot.paramMap.get("id") ?? "");
  protected readonly run = signal<Run | null>(null);
  protected readonly tab = signal<Tab>("overview");
  protected readonly loading = signal(true);
  protected readonly acting = signal(false);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly issues = signal<ValidationIssue[]>([]);
  protected readonly rejected = signal<unknown[]>([]);
  protected readonly resources = signal<RunResourcesResponse | null>(null);
  protected readonly traces = signal<RunTracesResponse | null>(null);
  protected readonly bundle = signal<Record<string, unknown> | null>(null);
  protected readonly live = signal<SseConnectionState>("connecting");

  private stream?: SseHandle;
  private pollTimer?: ReturnType<typeof setInterval>;

  protected readonly issueCount = computed(() => this.issues().length);
  protected readonly liveLabel = computed(() => {
    const state = this.live();
    switch (state) {
      case "open":
        return "live (SSE)";
      case "connecting":
        return "connecting…";
      case "reconnecting":
        return "reconnecting…";
      case "unauthorized":
        return "stream refused — poll only";
      default:
        return "not streaming";
    }
  });

  constructor() {
    // A deep link may name the panel to show; an unknown value stays on the default overview.
    const requested = this.route.snapshot.queryParamMap.get("tab");
    if (requested !== null && isTab(requested)) this.tab.set(requested);

    this.reload();

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const next = params.get("tab");
      if (next === null || !isTab(next) || next === this.tab()) return;
      this.tab.set(next);
      this.loadTab(next);
    });

    this.destroyRef.onDestroy(() => this.teardown());
  }

  protected reload(): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.getRun(this.runId()).subscribe({
      next: (run) => {
        this.run.set(run);
        this.loading.set(false);
        this.startLive(run);
        if (this.tab() === "resources" && !this.resources()) this.loadResources();
        if (this.tab() === "traces" && !this.traces()) this.loadTraces();
        if (this.tab() === "bundle" && !this.bundle()) this.loadBundle();
        if (this.issues().length === 0) this.loadIssues();
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  /**
   * Tabs fetch on first view. Rendering a permanent spinner because a lazy load was never
   * triggered is the kind of "looks broken" state the console must not have.
   *
   * The URL mirrors the panel with `replaceUrl`, so Back leaves the page instead of walking
   * through every tab the operator visited. The query-param subscription no-ops when the tab
   * already matches, so this navigation cannot loop.
   */
  protected selectTab(tab: Tab): void {
    this.tab.set(tab);
    this.loadTab(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === "overview" ? null : tab },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  /** Arrow keys, Home and End move between tabs; every other key is left to the browser. */
  protected onTabKeydown(event: KeyboardEvent, value: Tab): void {
    const values = this.tabs.map((entry) => entry.value);
    const index = values.indexOf(value);
    let next: Tab;
    switch (event.key) {
      case "ArrowLeft":
        next = values[(index - 1 + values.length) % values.length];
        break;
      case "ArrowRight":
        next = values[(index + 1) % values.length];
        break;
      case "Home":
        next = values[0];
        break;
      case "End":
        next = values[values.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    this.selectTab(next);
    queueMicrotask(() => document.getElementById("run-tab-" + next)?.focus());
  }

  private loadTab(tab: Tab): void {
    if (tab === "resources" && !this.resources()) this.loadResources();
    if (tab === "traces" && !this.traces()) this.loadTraces();
    if (tab === "bundle" && !this.bundle()) this.loadBundle();
  }

  protected loadResources(): void {
    this.api.getRunResources(this.runId()).subscribe({
      next: (payload) => this.resources.set(payload),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected loadTraces(): void {
    this.api.getRunTraces(this.runId()).subscribe({
      next: (payload) => this.traces.set(payload),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected loadBundle(): void {
    this.api.getRunBundle(this.runId()).subscribe({
      next: (payload) => this.bundle.set(payload as unknown as Record<string, unknown>),
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected cancel(): void {
    this.acting.set(true);
    this.api.cancelRun(this.runId()).subscribe({
      next: (run) => {
        this.acting.set(false);
        this.run.set(run);
      },
      error: (error: ApiProblem) => {
        this.acting.set(false);
        this.problem.set(error);
      },
    });
  }

  protected replay(): void {
    this.acting.set(true);
    this.api.replayRun(this.runId()).subscribe({
      next: (run) => {
        this.acting.set(false);
        void this.router.navigate(["/runs", run.id]);
      },
      error: (error: ApiProblem) => {
        this.acting.set(false);
        this.problem.set(error);
      },
    });
  }

  protected duration(run: Run): string {
    return formatDuration(elapsedBetween(run.startedAt, run.finishedAt));
  }

  protected validationLabel(run: Run): string {
    if (!run.validation) return "—";
    return run.validation.isValid ? "valid" : "invalid";
  }

  protected stamp(iso?: string | null): string {
    return iso ? formatDateTime(iso) : "—";
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected severityClass(severity: string): string {
    if (severity === "fatal" || severity === "error") return "danger";
    if (severity === "warning") return "warn";
    return "info";
  }

  protected readonly pluralize = pluralize;
  protected readonly humanBytes = formatBytes;
  protected readonly isTerminal = isTerminalStatus;

  private loadIssues(): void {
    this.api.getRunIssues(this.runId()).subscribe({
      next: (payload) => {
        this.issues.set(payload.issues);
        this.rejected.set(payload.rejected);
      },
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  /** Opens the stream for a non-terminal run, and stops it as soon as the run settles. */
  private startLive(run: Run): void {
    if (isTerminalStatus(run.status)) {
      this.teardown();
      this.live.set("closed");
      return;
    }
    if (this.stream) return;

    const key = this.auth.apiKey();
    if (!key) {
      this.live.set("closed");
      return;
    }

    this.stream = openSse({
      url: this.api.runEventsUrl(run.id),
      apiKey: key,
      onState: (state) => this.live.set(state),
      onFrame: (frame) => {
        if (
          frame.event === "snapshot" ||
          frame.event === "status" ||
          frame.event === "done" ||
          frame.event === "error"
        ) {
          try {
            const payload = JSON.parse(frame.data) as { run?: Run } | Run;
            const next = (payload as { run?: Run }).run ?? (payload as Run);
            if (next?.status) {
              this.run.set(next);
              if (isTerminalStatus(next.status)) {
                this.teardown();
                this.live.set("closed");
                this.loadIssues();
                if (this.tab() === "resources") this.loadResources();
              }
            }
          } catch {
            // A frame we cannot parse is not worth breaking the stream over.
          }
        }
      },
    });

    // Poll anyway: a proxy that buffers SSE would otherwise leave the page stale.
    this.pollTimer = setInterval(() => {
      this.api.getRun(this.runId()).subscribe({
        next: (current) => {
          this.run.set(current);
          if (isTerminalStatus(current.status)) {
            this.teardown();
            this.live.set("closed");
          }
        },
        error: () => undefined,
      });
    }, 2_000);
  }

  private teardown(): void {
    this.stream?.close();
    this.stream = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
