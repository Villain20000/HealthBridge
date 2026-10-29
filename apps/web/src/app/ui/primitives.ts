import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { ApiProblem } from "../core/api-types";
import { describeProblem } from "../core/api-errors";
import { describeStatus } from "../core/format";

/**
 * Small presentational primitives shared by every screen. They are deliberately dumb so the
 * future Studio can reuse them unchanged (status chips, empty states, planned cards).
 */

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

@Component({
  selector: "hb-status-chip",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="chip" [class]="tone()" [attr.aria-label]="'Status: ' + label()">{{ label() }}</span>`,
})
export class StatusChip {
  public readonly status = input.required<string>();

  protected readonly label = computed(() => describeStatus(this.status()));
  protected readonly tone = computed<Tone>(() => toneForStatus(this.status()));
}

export function toneForStatus(status: string): Tone {
  switch (status) {
    case "completed":
      return "ok";
    case "completed_with_warnings":
      return "warn";
    case "failed":
      return "danger";
    case "cancelled":
      return "muted";
    case "cancelling":
      return "warn";
    case "running":
      return "info";
    case "queued":
      return "muted";
    default:
      return "muted";
  }
}

@Component({
  selector: "hb-empty",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty">
      <h3>{{ title() }}</h3>
      <p class="subtle">{{ message() }}</p>
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  public readonly title = input.required<string>();
  public readonly message = input<string>("");
}

/** An unimplemented capability is stated as such — never a disabled button pretending to work. */
@Component({
  selector: "hb-planned",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="planned">
      <p class="tag">Planned</p>
      <h3>{{ title() }}</h3>
      <p class="subtle">{{ message() }}</p>
    </div>
  `,
})
export class PlannedCard {
  public readonly title = input.required<string>();
  public readonly message = input<string>("");
}

@Component({
  selector: "hb-error",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (problem(); as issue) {
      <div class="error-panel" role="alert">
        <strong>{{ issue.message }}</strong>
        <div class="meta">
          <span class="code">{{ issue.code }}</span>
          @if (issue.requestId) {
            <span>
              · request <code>{{ issue.requestId }}</code></span
            >
          }
          <span> · HTTP {{ issue.status }}</span>
        </div>
        @if (showRetry()) {
          <div style="margin-top: 10px">
            <button class="small" type="button" (click)="retry.emit()">Retry</button>
          </div>
        }
      </div>
    }
  `,
})
export class ErrorPanel {
  public readonly problem = input<ApiProblem | null>(null);
  public readonly showRetry = input(false);
  public readonly retry = output<void>();

  protected describe(issue: ApiProblem): string {
    return describeProblem(issue);
  }
}

@Component({
  selector: "hb-loading",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row" style="padding: 12px 0" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span class="subtle">{{ label() }}</span>
    </div>
  `,
})
export class LoadingState {
  public readonly label = input("Loading…");
}
