import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, Run } from "../../core/api-types";
import type { ValidationIssue } from "@healthbridge/shared-types";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";
import { pluralize } from "../../core/format";
import {
  SKIPPED_VERDICT,
  issuesForLevel,
  levelTone,
  normaliseLevels,
  normaliseReportIssues,
  partitionIssues,
  severityTone,
  skippedNotice,
  summariseLevels,
  verdictLabel,
  type PartitionedIssues,
  type StoredValidationReport,
  type ValidationLevelView,
} from "./validation-centre.logic";

/**
 * Validation Centre: read-only rendering of a run's stored validation report.
 *
 * Reads `run.validation.levels` from `GET /runs/:id` and the stored problem list from
 * `GET /runs/:id/issues`. It never submits, re-executes, replays or cancels anything — the
 * only actions are Refresh (re-reads the same stored rows) and navigation links. Stored
 * results are labelled as stored; nothing here is a live execution.
 */
@Component({
  selector: "hb-validation-centre",
  standalone: true,
  imports: [RouterLink, ErrorPanel, EmptyState, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1 style="font-size: 17px">Validation Centre</h1>
        <p>
          Stored validation results for run <span class="mono">{{ runId() }}</span> · read-only. This page never
          re-executes validation and never replays the run.
        </p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <a class="button small" [routerLink]="['/runs', runId()]">Back to run detail</a>
        <a class="button small" routerLink="/runs">All runs</a>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && !run()) {
      <hb-loading label="Loading validation results…" />
    }

    @if (run(); as current) {
      @if (levels().length === 0) {
        <hb-empty
          title="No validation report stored"
          message="This run finished without a stored validation report, so there are no levels to show."
        />
      } @else {
        <div class="grid cols-4">
          <div class="card">
            <div class="stat">
              <span class="label">Verdict</span>
              <span class="value" style="font-size: 15px">
                <span class="chip" [class]="verdictTone()">{{ verdict() }}</span>
              </span>
              <span class="hint">{{ standard() }}</span>
            </div>
          </div>
          <div class="card">
            <div class="stat">
              <span class="label">Levels executed</span>
              <span class="value">{{ summary().executed }}/{{ summary().total }}</span>
              <span class="hint">{{ summary().skipped }} skipped</span>
            </div>
          </div>
          <div class="card">
            <div class="stat">
              <span class="label">Issues at executed levels</span>
              <span class="value">{{ partitioned().levelIssues.length + partitioned().earlierIssues.length }}</span>
              <span class="hint">{{ rejectedCount() }} records rejected outright</span>
            </div>
          </div>
          <div class="card">
            <div class="stat">
              <span class="label">Run status</span>
              <span class="value" style="font-size: 15px">{{ current.status }}</span>
              <span class="hint">stored result, not a live execution</span>
            </div>
          </div>
        </div>

        <div style="height: 16px"></div>

        @for (level of levels(); track level.level) {
          <section class="card" style="margin-bottom: 16px" [attr.aria-labelledby]="'vc-level-' + level.level">
            <h2 [id]="'vc-level-' + level.level">Level {{ level.level }} — {{ level.name }}</h2>
            <p class="card-sub">
              <span class="chip" [class]="tone(level.status)"> {{ levelLabel(level.status) }} </span>
              @if (level.validator) {
                <span class="subtle">
                  · validator <span class="mono">{{ level.validator }}</span></span
                >
              }
            </p>

            @if (level.status === "skipped") {
              <p class="banner" role="note">
                <strong>{{ skippedVerdict }}</strong> {{ skippedNotice(level) }}
              </p>
            } @else {
              @if (level.level === 1 || level.level === 2) {
                <p class="card-sub">
                  Source-structural and mapping-definition findings are reported together — the engine does not tag them
                  per level, so both levels reference this shared list rather than splitting it by guesswork.
                </p>
              }
              @if (issuesFor(level).length === 0) {
                <hb-empty
                  [title]="'No issues at level ' + level.level"
                  message="The executed checks at this level reported no problems."
                />
              } @else {
                <div class="table-wrap">
                  <table [attr.aria-label]="'Issues at validation level ' + level.level">
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
                      @for (issue of issuesFor(level); track issueKeyOf(issue)) {
                        <tr>
                          <td>
                            <span class="chip" [class]="severityClass(issue.severity)">{{ issue.severity }}</span>
                          </td>
                          <td class="mono">{{ issue.code }}</td>
                          <td>{{ issue.message }}</td>
                          <td class="num">{{ issue.recordIndex ?? "—" }}</td>
                          <td class="mono">{{ issue.path ?? issue.location ?? "—" }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <div class="pager">{{ pluralize(issuesFor(level).length, "issue") }} at this level</div>
              }
            }
          </section>
        }

        <p class="subtle">
          Levels 4–6 (profile, terminology, referential-integrity) execute only when a validator or provider is injected
          (Phase F opt-ins: MIABIS validators, external FHIR validator, operator-supplied code tables). Without them
          they are reported as skipped — not run, never passed. Full problem list, including rejected records, stays on
          the
          <a
            [routerLink]="['/runs', runId()]"
            [queryParams]="{ tab: 'issues' }"
            style="text-decoration: underline; text-underline-offset: 2px"
            >run detail issues tab</a
          >.
        </p>
      }
    }
  `,
})
export class ValidationCentrePage {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly runId = signal(this.route.snapshot.paramMap.get("runId") ?? "");
  protected readonly run = signal<Run | null>(null);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly allIssues = signal<ValidationIssue[]>([]);
  protected readonly rejectedCount = signal(0);

  protected readonly skippedVerdict = SKIPPED_VERDICT;
  protected readonly skippedNotice = skippedNotice;
  protected readonly pluralize = pluralize;

  private readonly report = computed((): StoredValidationReport | null => {
    const current = this.run();
    if (!current || !isReport(current.validation)) return null;
    return current.validation;
  });

  protected readonly levels = computed<ValidationLevelView[]>(() => normaliseLevels(this.report()));
  protected readonly summary = computed(() => summariseLevels(this.levels()));
  protected readonly verdict = computed(() => verdictLabel(this.report()?.isValid));
  protected readonly standard = computed(() => {
    const standard = this.report()?.standard;
    return typeof standard === "string" && standard.trim().length > 0 ? standard : "unknown standard";
  });
  protected readonly verdictTone = computed(() => {
    switch (this.verdict()) {
      case "valid":
        return "ok";
      case "invalid":
        return "danger";
      default:
        return "muted";
    }
  });

  protected readonly partitioned = computed<PartitionedIssues>(() =>
    partitionIssues(this.allIssues(), normaliseReportIssues(this.report())),
  );

  constructor() {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.getRun(this.runId()).subscribe({
      next: (run) => {
        this.run.set(run);
        this.loading.set(false);
        this.loadIssues();
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  private loadIssues(): void {
    this.api.getRunIssues(this.runId()).subscribe({
      next: (payload) => {
        this.allIssues.set(payload.issues);
        this.rejectedCount.set(payload.rejected.length);
      },
      error: (error: ApiProblem) => this.problem.set(error),
    });
  }

  protected issuesFor(level: ValidationLevelView): ValidationIssue[] {
    return issuesForLevel(level, this.partitioned());
  }

  protected issueKeyOf(issue: ValidationIssue): string {
    return `${issue.recordIndex ?? ""}-${issue.code}-${issue.path ?? ""}-${issue.message}`;
  }

  protected levelLabel(status: ValidationLevelView["status"]): string {
    return status === "executed" ? "Executed" : "Skipped";
  }

  protected tone(status: ValidationLevelView["status"]): string {
    return levelTone(status);
  }

  protected severityClass(severity: string): string {
    return severityTone(severity);
  }
}

/** The web `Run` type narrows `validation`; the stored report carries the full levels model. */
function isReport(value: unknown): value is StoredValidationReport {
  return typeof value === "object" && value !== null;
}
