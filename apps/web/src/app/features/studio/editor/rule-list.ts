import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from "@angular/core";
import type { MappingRule } from "@healthbridge/shared-types";

export interface RuleMove {
  readonly ruleId: string;
  readonly toIndex: number;
}

/**
 * Ordered list of mapping rules. Selection, add, remove and reorder are emitted as events; the
 * editor store owns the draft.
 *
 * Reordering works with native HTML drag and drop and, identically, with buttons: each row can be
 * dragged onto another row, and the labelled Move up / Move down buttons are the keyboard path.
 * `readOnly` hides every edit control and disables dragging for published-version views.
 */
@Component({
  selector: "hb-rule-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section #region class="rule-list" aria-label="Mapping rules" tabindex="-1">
      @if (!readOnly()) {
        <p class="meta" style="margin: 0 0 var(--space-2)">
          Drag a rule, or use Move up and Move down. The buttons are the keyboard path.
        </p>
      }
      <div class="actions">
        <h3>Rules ({{ rules().length }})</h3>
        @if (!readOnly()) {
          <button class="small" type="button" (click)="add.emit()">Add rule</button>
        }
      </div>
      @if (rules().length === 0) {
        <p class="meta">This mapping has no rules yet.</p>
      } @else {
        <ul>
          @for (rule of rules(); track rule.id; let i = $index; let first = $first; let last = $last) {
            <li
              [attr.data-selected]="rule.id === selectedId() ? 'true' : null"
              [attr.data-dragover]="dragOverIndex() === i ? 'true' : null"
              [attr.draggable]="readOnly() ? null : 'true'"
              (dragstart)="onDragStart($event, rule.id)"
              (dragover)="onDragOver($event, i)"
              (drop)="onDrop($event, i)"
              (dragend)="onDragEnd()"
            >
              @if (!readOnly()) {
                <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
              }
              <button
                #ruleSelect
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
              @if (dragOverIndex() === i) {
                <span class="meta"> (drop here)</span>
              }
              @if (!readOnly()) {
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
              }
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
  public readonly readOnly = input(false);

  public readonly selectRule = output<string>();
  public readonly add = output<void>();
  public readonly remove = output<string>();
  public readonly move = output<RuleMove>();

  protected readonly draggingId = signal<string | null>(null);
  protected readonly dragOverIndex = signal<number | null>(null);

  private readonly region = viewChild<ElementRef<HTMLElement>>("region");
  private readonly selectButtons = viewChildren<ElementRef<HTMLButtonElement>>("ruleSelect");

  /** Focuses the select button of one row, or the list region when the rule is gone. */
  public focusRule(ruleId: string): void {
    const index = this.rules().findIndex((rule) => rule.id === ruleId);
    const button = index >= 0 ? this.selectButtons()[index] : undefined;
    if (button !== undefined) {
      button.nativeElement.focus();
      return;
    }
    this.region()?.nativeElement.focus();
  }

  protected onDragStart(event: DragEvent, ruleId: string): void {
    if (this.readOnly()) {
      event.preventDefault();
      return;
    }
    this.draggingId.set(ruleId);
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", ruleId);
    }
  }

  protected onDragOver(event: DragEvent, index: number): void {
    if (this.readOnly() || this.draggingId() === null) return;
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "move";
    }
    this.dragOverIndex.set(index);
  }

  protected onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    const ruleId = this.draggingId() ?? event.dataTransfer?.getData("text/plain") ?? "";
    this.onDragEnd();
    if (this.readOnly() || ruleId === "") return;
    this.move.emit({ ruleId, toIndex: index });
  }

  protected onDragEnd(): void {
    this.draggingId.set(null);
    this.dragOverIndex.set(null);
  }
}
