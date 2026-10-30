import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { DiffView } from "../../../ui/diff-view";
import type { DebuggerEvent } from "./trace.logic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resource comparison and input/output snippet diff for one stored event.
 *
 * Resources are run-level array entries, so they are identified by array position — never as
 * "expected" values. The diff is between recorded payloads, not between expectation and result.
 */
@Component({
  selector: "hb-record-panel",
  standalone: true,
  imports: [DiffView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="dbg-compare-heading">
      <h2 id="dbg-compare-heading">Resource and snippet diff</h2>

      <p class="hint">
        Resources are run-level and have no record index; positions are array positions. This is not an
        expected-versus-actual diff.
      </p>

      @if (resources().length >= 2) {
        <div class="selects">
          <div class="field">
            <label for="dbg-resource-a">Resource A</label>
            <select id="dbg-resource-a" [value]="aIndex().toString()" (change)="onAChange($event)">
              @for (resource of resources(); track $index) {
                <option [value]="$index.toString()" [selected]="$index === aIndex()">
                  Resource #{{ $index + 1 }} (array position) — {{ resourceLabel(resource) }}
                </option>
              }
            </select>
          </div>

          <div class="field">
            <label for="dbg-resource-b">Resource B</label>
            <select id="dbg-resource-b" [value]="bIndex().toString()" (change)="onBChange($event)">
              @for (resource of resources(); track $index) {
                <option [value]="$index.toString()" [selected]="$index === bIndex()">
                  Resource #{{ $index + 1 }} (array position) — {{ resourceLabel(resource) }}
                </option>
              }
            </select>
          </div>
        </div>

        <hb-diff-view
          [left]="resources()[aIndex()]"
          [right]="resources()[bIndex()]"
          leftLabel="Resource A"
          rightLabel="Resource B"
        />
      } @else {
        <p class="subtle">Fewer than two resources are stored for this run; a resource diff needs two.</p>
      }

      @if (event(); as current) {
        @if (current.hasInputSnippet && current.hasOutputSnippet) {
          <h3>Input vs output snippet</h3>
          <hb-diff-view
            [left]="current.inputSnippet"
            [right]="current.outputSnippet"
            leftLabel="Input snippet"
            rightLabel="Output snippet"
          />
        } @else {
          <p class="subtle">
            This trace event does not record both input and output snippets; a snippet diff needs both.
          </p>
        }
      } @else {
        <p class="subtle">Select an event to compare its input and output snippets.</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    h2 {
      margin-bottom: var(--space-2);
    }

    .hint {
      margin: 0 0 var(--space-3);
      color: var(--text-muted);
      font-size: 12.5px;
    }

    .selects {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-2) var(--space-3);
      margin-bottom: var(--space-3);
    }

    .field {
      margin-bottom: 0;
      min-width: 0;
    }

    h3 {
      margin: var(--space-4) 0 var(--space-2);
    }

    @media (max-width: 700px) {
      .selects {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class RecordPanel {
  public readonly resources = input.required<unknown[]>();
  public readonly event = input<DebuggerEvent | null>(null);

  private readonly selectedA = signal(0);
  private readonly selectedB = signal(1);

  protected readonly aIndex = computed(() => this.clamp(this.selectedA()));
  protected readonly bIndex = computed(() => this.clamp(this.selectedB()));

  protected onAChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (Number.isInteger(value) && value >= 0) this.selectedA.set(value);
  }

  protected onBChange(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (Number.isInteger(value) && value >= 0) this.selectedB.set(value);
  }

  protected resourceLabel(resource: unknown): string {
    if (!isRecord(resource)) return "unknown resource";
    const resourceType = typeof resource["resourceType"] === "string" ? resource["resourceType"] : null;
    const id = typeof resource["id"] === "string" ? resource["id"] : null;
    if (resourceType !== null && id !== null) return `${resourceType} ${id}`;
    if (resourceType !== null) return resourceType;
    return "unknown resource";
  }

  private clamp(index: number): number {
    const length = this.resources().length;
    if (length === 0) return 0;
    return Math.min(index, length - 1);
  }
}
