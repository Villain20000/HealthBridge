import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from "@angular/core";
import type { DebuggerFilter } from "./trace.logic";

/**
 * Filters for the stored trace. Every control emits a patch; the page owns the applied filter
 * (and the search debounce), so this component never fetches or filters anything itself.
 */
@Component({
  selector: "hb-debugger-filters",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="filters" role="group" aria-label="Trace filters">
      <p class="hint">Filters are combined with AND.</p>

      <div class="grid">
        <div class="field">
          <label for="dbg-stage">Stage</label>
          <select id="dbg-stage" [value]="filter().stage ?? ''" (change)="onStageChange($event)">
            <option value="" [selected]="filter().stage === null">All stages</option>
            @for (stage of stages(); track stage) {
              <option [value]="stage" [selected]="filter().stage === stage">{{ stage }}</option>
            }
          </select>
        </div>

        <div class="field">
          <label for="dbg-status">Status</label>
          <select id="dbg-status" [value]="filter().status ?? ''" (change)="onStatusChange($event)">
            <option value="" [selected]="filter().status === null">All statuses</option>
            @for (status of statuses(); track status) {
              <option [value]="status" [selected]="filter().status === status">{{ status }}</option>
            }
          </select>
        </div>

        <div class="field">
          <label for="dbg-record">Record index (0-based)</label>
          <input
            id="dbg-record"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            placeholder="Any record"
            [value]="recordValue()"
            (change)="onRecordChange($event)"
          />
          <p class="help">0 is the first record.</p>
        </div>

        <div class="field">
          <label for="dbg-rule">Rule id</label>
          <input
            id="dbg-rule"
            type="text"
            placeholder="Any rule"
            [value]="rule() ?? ''"
            (input)="onRuleInput($event)"
          />
        </div>

        <div class="field">
          <label for="dbg-q">Search steps, paths, codes and messages</label>
          <input
            id="dbg-q"
            type="search"
            placeholder="Search stored events"
            [value]="query()"
            (input)="onQueryInput($event)"
          />
        </div>

        <div class="field">
          <label class="checkbox" for="dbg-only">
            <input
              id="dbg-only"
              type="checkbox"
              [checked]="filter().onlyIssues"
              (change)="onOnlyIssuesChange($event)"
            />
            <span>Only events with issues</span>
          </label>
        </div>
      </div>

      <div class="actions">
        <button type="button" class="small" [disabled]="filteredCount() === 0" (click)="jumpFirst.emit()">
          Jump to first match
        </button>
        <button type="button" class="small" (click)="onClear()">Clear filters</button>
      </div>

      <p class="status subtle" role="status" aria-live="polite">
        Showing {{ filteredCount() }} of {{ totalCount() }} stored events.
      </p>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .filters {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .hint {
      margin: 0;
      color: var(--text-muted);
      font-size: 12.5px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: var(--space-2) var(--space-3);
    }

    .field {
      margin-bottom: 0;
      min-width: 0;
    }

    .checkbox {
      margin-bottom: 0;
      padding-top: 21px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .status {
      margin: 0;
      font-size: 12.5px;
    }

    @media (max-width: 700px) {
      .grid {
        grid-template-columns: 1fr;
      }

      .checkbox {
        padding-top: 0;
      }
    }
  `,
})
export class DebuggerFilters {
  public readonly filter = input.required<DebuggerFilter>();
  public readonly stages = input<string[]>([]);
  public readonly statuses = input<string[]>([]);
  public readonly filteredCount = input(0);
  public readonly totalCount = input(0);
  public readonly filterChange = output<Partial<DebuggerFilter>>();
  public readonly jumpFirst = output<void>();
  public readonly clear = output<void>();

  /**
   * Mirrors `filter().q` so an external change (back/forward, clear) updates the field while the
   * user's in-flight typing is not overwritten by the stale applied value.
   */
  protected readonly query = linkedSignal(() => this.filter().q);

  /** Same idea for the rule id; emitted trimmed, but the field keeps exactly what was typed. */
  protected readonly rule = linkedSignal<string | null>(() => this.filter().rule);

  protected readonly recordValue = computed(() => {
    const record = this.filter().record;
    return record === null ? "" : String(record);
  });

  protected onStageChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.filterChange.emit({ stage: value === "" ? null : value });
  }

  protected onStatusChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.filterChange.emit({ status: value === "" ? null : value });
  }

  protected onRecordChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    // Number inputs report "" for unparseable text such as "1e" or "."; that is not "empty".
    if (input.validity.badInput) {
      input.value = this.recordValue();
      return;
    }

    const raw = input.value.trim();
    if (raw === "") {
      input.value = "";
      this.filterChange.emit({ record: null });
      return;
    }

    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) {
      this.filterChange.emit({ record: parsed });
      return;
    }

    // Rejected input never reaches the filter; put the applied value back in the field.
    input.value = this.recordValue();
  }

  protected onRuleInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.rule.set(value);
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next !== this.filter().rule) this.filterChange.emit({ rule: next });
  }

  protected onQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.filterChange.emit({ q: value });
  }

  protected onOnlyIssuesChange(event: Event): void {
    this.filterChange.emit({ onlyIssues: (event.target as HTMLInputElement).checked });
  }

  protected onClear(): void {
    // The store's q may already be empty (typed but not yet applied), so reset the local
    // mirrors before emitting; otherwise clearing inside the debounce window leaves stale text.
    this.query.set("");
    this.rule.set(null);
    this.clear.emit();
  }
}
