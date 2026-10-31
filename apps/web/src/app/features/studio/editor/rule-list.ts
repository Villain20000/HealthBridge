import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import type { MappingRule } from "@healthbridge/shared-types";

export interface RuleMove {
  readonly ruleId: string;
  readonly toIndex: number;
}

/**
 * Ordered list of mapping rules. Selection, add, remove and reorder are emitted as events; the
 * editor store owns the draft. Reordering uses buttons so it works without a pointer.
 */
@Component({
  selector: "hb-rule-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rule-list" aria-label="Mapping rules">
      <div class="actions">
        <h3>Rules ({{ rules().length }})</h3>
        <button class="small" type="button" (click)="add.emit()">Add rule</button>
      </div>
      @if (rules().length === 0) {
        <p class="meta">This mapping has no rules yet.</p>
      } @else {
        <ul>
          @for (rule of rules(); track rule.id; let i = $index; let first = $first; let last = $last) {
            <li [attr.data-selected]="rule.id === selectedId() ? 'true' : null">
              <button
                class="rule-select"
                type="button"
                [attr.aria-current]="rule.id === selectedId() ? 'true' : null"
                (click)="selectRule.emit(rule.id)"
              >
                <span class="mono">{{ rule.sourcePath || "(no source)" }}</span>
                <span aria-hidden="true"> → </span>
                <span class="mono">{{ rule.targetPath || "(no target)" }}</span>
                <span class="meta"> · {{ rule.transform }}</span>
              </button>
              <button
                class="small"
                type="button"
                [disabled]="first"
                [attr.aria-label]="'Move rule ' + (i + 1) + ' up'"
                (click)="move.emit({ ruleId: rule.id, toIndex: i - 1 })"
              >
                Up
              </button>
              <button
                class="small"
                type="button"
                [disabled]="last"
                [attr.aria-label]="'Move rule ' + (i + 1) + ' down'"
                (click)="move.emit({ ruleId: rule.id, toIndex: i + 1 })"
              >
                Down
              </button>
              <button
                class="small"
                type="button"
                [attr.aria-label]="'Remove rule ' + (i + 1)"
                (click)="remove.emit(rule.id)"
              >
                Remove
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class RuleList {
  public readonly rules = input<readonly MappingRule[]>([]);
  public readonly selectedId = input<string | null>(null);

  public readonly selectRule = output<string>();
  public readonly add = output<void>();
  public readonly remove = output<string>();
  public readonly move = output<RuleMove>();
}
