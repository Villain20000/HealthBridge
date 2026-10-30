import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { diffJson, type JsonChange, type JsonChangeKind } from "../core/json";

/**
 * Accessible structural diff for resource or input/output comparisons.
 *
 * The change label is always spelled out ("Added", "Removed", "Changed"); the chip tone only
 * reinforces it. Values are bounded previews, and a value JSON cannot represent is named as such
 * instead of breaking the table.
 */

const PREVIEW_LENGTH = 160;

const CHANGE_LABELS: Record<JsonChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

const CHANGE_TONES: Record<JsonChangeKind, "ok" | "danger" | "warn"> = {
  added: "ok",
  removed: "danger",
  changed: "warn",
};

interface DiffRow {
  path: string;
  label: string;
  tone: "ok" | "danger" | "warn";
  left: string | null;
  right: string | null;
}

function previewValue(value: unknown): string {
  let text: string;
  try {
    text = serialisePreview(value);
  } catch {
    return "[unserialisable]";
  }
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

function serialisePreview(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return "[symbol]";
  if (typeof value === "bigint") throw new TypeError("Cannot serialise BigInt");

  // JSON.stringify gives up on cycles and BigInt; both become "[unserialisable]" for the caller.
  const ancestors: object[] = [];
  const encoded = JSON.stringify(value, function (this: unknown, _key: string, current: unknown): unknown {
    if (typeof current === "bigint") throw new TypeError("Cannot serialise BigInt");
    if (typeof current === "object" && current !== null) {
      const parent = ancestors.indexOf(this as object);
      if (parent === -1) ancestors.length = 0;
      else ancestors.length = parent + 1;
      if (ancestors.includes(current)) throw new TypeError("Cannot serialise circular structure");
      ancestors.push(current);
    }
    return current;
  });
  return encoded === undefined ? "undefined" : encoded;
}

function toRow(change: JsonChange): DiffRow {
  return {
    path: change.path,
    label: CHANGE_LABELS[change.kind],
    tone: CHANGE_TONES[change.kind],
    left: "left" in change ? previewValue(change.left) : null,
    right: "right" in change ? previewValue(change.right) : null,
  };
}

@Component({
  selector: "hb-diff-view",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view().rows.length === 0) {
      @if (!view().truncated) {
        <p class="empty">No differences.</p>
      }
    } @else {
      <div class="table-wrap">
        <table>
          <caption class="sr-only">
            {{
              caption()
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Change</th>
              <th scope="col">{{ leftLabel() }}</th>
              <th scope="col">{{ rightLabel() }}</th>
            </tr>
          </thead>
          <tbody>
            @for (row of view().rows; track $index) {
              <tr>
                <td class="mono path">{{ row.path === "" ? "(root)" : row.path }}</td>
                <td>
                  <span class="chip" [class]="row.tone">{{ row.label }}</span>
                </td>
                @if (row.left !== null) {
                  <td class="mono value">{{ row.left }}</td>
                } @else {
                  <td class="value"></td>
                }
                @if (row.right !== null) {
                  <td class="mono value">{{ row.right }}</td>
                } @else {
                  <td class="value"></td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    <p class="summary">{{ unchangedText() }}</p>
    @if (view().truncated) {
      <p class="notice">
        Showing the first {{ view().rows.length }} changes; additional differences are hidden by the change cap.
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .table-wrap {
      margin: 0;
    }

    .path {
      white-space: nowrap;
    }

    .value {
      max-width: 340px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .summary {
      margin: var(--space-2) 0 0;
      color: var(--text-muted);
      font-size: 12.5px;
    }

    .notice {
      margin: var(--space-2) 0 0;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--warn);
      border-radius: var(--radius-sm);
      background: var(--warn-soft);
      color: var(--text);
      font-size: 12.5px;
    }

    .empty {
      margin: 0;
    }
  `,
})
export class DiffView {
  readonly left = input.required<unknown>();
  readonly right = input.required<unknown>();
  readonly leftLabel = input("Left");
  readonly rightLabel = input("Right");
  readonly maxChanges = input(500);

  protected readonly view = computed(() => {
    const result = diffJson(this.left(), this.right(), { maxChanges: this.maxChanges() });
    return {
      rows: result.changes.map(toRow),
      truncated: result.truncated,
      unchanged: result.unchanged,
    };
  });

  protected readonly caption = computed(() => {
    const count = this.view().rows.length;
    return `${this.leftLabel()} → ${this.rightLabel()}: ${count} ${count === 1 ? "difference" : "differences"}`;
  });

  protected readonly unchangedText = computed(() => {
    const count = this.view().unchanged;
    return `${count} ${count === 1 ? "path" : "paths"} unchanged.`;
  });
}
