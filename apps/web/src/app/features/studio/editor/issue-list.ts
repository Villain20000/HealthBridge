import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { IssueSeverity, ValidationIssue } from "@healthbridge/shared-types";

const SEVERITY_ORDER: Record<IssueSeverity, number> = { fatal: 0, error: 1, warning: 2, information: 3 };

/**
 * Validation issues, most severe first. Severity is written out as text so it never relies on
 * colour alone. `source` says whether the list is the server's verdict or a local quick check.
 */
@Component({
  selector: "hb-issue-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="issue-list" [attr.aria-label]="heading()">
      <h3>{{ heading() }}</h3>
      @if (sorted().length === 0) {
        <p>{{ emptyText() }}</p>
      } @else {
        <ul>
          @for (issue of sorted(); track $index) {
            <li [attr.data-severity]="issue.severity">
              <strong>{{ issue.severity }}</strong>
              <span class="code mono">{{ issue.code }}</span>
              <span>{{ issue.message }}</span>
              @if (issue.path || issue.location) {
                <span class="meta mono">{{ issue.path ?? issue.location }}</span>
              }
              @if (issue.advice) {
                <span class="meta">{{ issue.advice }}</span>
              }
              @if (issue.ruleId; as ruleId) {
                <button class="small" type="button" (click)="selectRule.emit(ruleId)">Go to rule</button>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class IssueList {
  public readonly issues = input<readonly ValidationIssue[]>([]);
  public readonly heading = input("Issues");
  public readonly emptyText = input("No issues.");

  public readonly selectRule = output<string>();

  protected readonly sorted = computed(() =>
    [...this.issues()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
  );
}
