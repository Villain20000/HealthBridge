import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { jsonPath } from "../core/json";

/**
 * Bounded JSON tree for payloads and resources.
 *
 * Rows are built depth-first over the expansion state and capped by depth, array width and total
 * rows. Every row is labelled with the count of what it hides, so a cap never looks like an empty
 * branch. Paths come from `jsonPath`, which means `getByPath(value, row.path)` finds the row again.
 */

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ARRAY_ITEMS = 200;
const DEFAULT_MAX_ROWS = 5000;
const PREVIEW_LENGTH = 80;
const ROOT_EXPANDED: ReadonlySet<string> = new Set([""]);

interface TreeLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxRows: number;
}

interface TreeRow {
  path: string;
  depth: number;
  label: string;
  preview: string;
  expandable: boolean;
  expanded: boolean;
  notices: string[];
}

interface TreeView {
  rows: TreeRow[];
  truncated: boolean;
  maxRows: number;
}

interface SourceState<T> {
  source: unknown;
  value: T;
}

let nextInstanceId = 0;

function resolveLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function previewString(value: string): string {
  if (value.length <= PREVIEW_LENGTH) return JSON.stringify(value) ?? "";
  return `${JSON.stringify(value.slice(0, PREVIEW_LENGTH))}…`;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return previewString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return "[symbol]";
  if (value === null) return "null";
  const container = value as object;
  if (Array.isArray(container)) return container.length === 0 ? "[]" : `[${container.length} items]`;
  const fields = Object.keys(container).length;
  return fields === 0 ? "{}" : `{${fields} fields}`;
}

function buildTree(root: unknown, rootLabel: string, limits: TreeLimits, expandedPaths: ReadonlySet<string>): TreeView {
  const rows: TreeRow[] = [];
  let truncated = false;

  const add = (value: unknown, path: string, depth: number, label: string): void => {
    if (rows.length >= limits.maxRows) {
      truncated = true;
      return;
    }

    const container = typeof value === "object" && value !== null;
    const array = Array.isArray(value);
    const keys = container && !array ? Object.keys(value) : [];
    const items = array ? (value as unknown[]) : [];
    const totalChildren = array ? items.length : keys.length;
    const visibleChildren = array ? Math.min(items.length, limits.maxArrayItems) : keys.length;
    const depthBlocked = container && totalChildren > 0 && depth >= limits.maxDepth;
    const expandable = visibleChildren > 0 && !depthBlocked;
    const expanded = expandable && expandedPaths.has(path);

    const notices: string[] = [];
    if (depthBlocked) notices.push(`Depth limit ${limits.maxDepth} reached`);
    if (array && items.length > limits.maxArrayItems) {
      notices.push(`${items.length - limits.maxArrayItems} more items not shown (cap ${limits.maxArrayItems})`);
    }

    rows.push({ path, depth, label, preview: previewValue(value), expandable, expanded, notices });
    if (!expanded) return;

    if (array) {
      for (let index = 0; index < visibleChildren; index += 1) {
        if (rows.length >= limits.maxRows) {
          truncated = true;
          return;
        }
        add(items[index], jsonPath(path, index), depth + 1, `[${index}]`);
      }
      return;
    }

    for (const key of keys) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        return;
      }
      add((value as Record<string, unknown>)[key], jsonPath(path, key), depth + 1, key);
    }
  };

  add(root, "", 0, rootLabel);
  return { rows, truncated, maxRows: limits.maxRows };
}

@Component({
  selector: "hb-json-tree",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #list class="tree" role="tree" [attr.aria-label]="label()">
      @for (row of view().rows; track $index) {
        <div
          class="row"
          role="treeitem"
          [id]="rowId($index)"
          [attr.aria-level]="row.depth + 1"
          [attr.aria-expanded]="row.expandable ? row.expanded : null"
          [attr.aria-selected]="row.path === selected()"
          [attr.tabindex]="activeIndex() === $index ? 0 : -1"
          [style.padding-left.px]="row.depth * 14 + 8"
          (click)="activate(row)"
          (keydown)="onKeydown($event, $index)"
        >
          <span class="toggle" aria-hidden="true">{{ row.expandable ? (row.expanded ? "▾" : "▸") : "" }}</span>
          <span class="label">{{ row.label }}</span>
          <span class="sep" aria-hidden="true">:</span>
          <span class="preview">{{ row.preview }}</span>
          @for (notice of row.notices; track $index) {
            <span class="notice">{{ notice }}</span>
          }
        </div>
      }
    </div>
    @if (view().truncated) {
      <p class="footer">Showing the first {{ view().maxRows }} nodes; additional data is hidden by the row cap.</p>
    }
  `,
  styles: `
    :host {
      display: block;
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .tree {
      background: var(--bg-inset);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      max-height: 480px;
      overflow: auto;
      padding: var(--space-1) 0;
    }
    .row {
      display: flex;
      align-items: baseline;
      gap: var(--space-1);
      padding-block: 2px;
      padding-right: var(--space-3);
      color: var(--text);
      cursor: pointer;
      line-height: 1.7;
      white-space: nowrap;
    }
    .row:hover {
      background: var(--bg-hover);
    }
    .row[aria-selected="true"] {
      background: var(--accent-soft);
      color: var(--text);
      font-weight: 600;
    }
    .row:focus-visible {
      outline: none;
      box-shadow: var(--focus);
      border-radius: var(--radius-sm);
    }
    .toggle {
      flex: none;
      width: 12px;
      color: var(--text-muted);
    }
    .label {
      color: var(--text);
    }
    .sep,
    .preview {
      color: var(--text-muted);
      font-weight: 400;
    }
    .preview {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .notice {
      flex: none;
      margin-left: var(--space-2);
      padding: 0 6px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      color: var(--warn);
      font-size: 11.5px;
    }
    .footer {
      margin: var(--space-2) 0 0;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class JsonTree {
  readonly value = input.required<unknown>();
  readonly label = input("JSON value");
  readonly maxDepth = input(12);
  readonly maxArrayItems = input(200);
  readonly maxRows = input(5000);
  readonly selectedPath = input<string | null>(null);
  readonly pathSelected = output<string>();

  private readonly instanceId = nextInstanceId++;
  private readonly list = viewChild<ElementRef<HTMLElement>>("list");
  private readonly expansion = signal<SourceState<ReadonlySet<string>> | null>(null);
  private readonly selection = signal<SourceState<string | null> | null>(null);
  private readonly active = signal<SourceState<string> | null>(null);

  private readonly limits = computed<TreeLimits>(() => ({
    maxDepth: resolveLimit(this.maxDepth(), DEFAULT_MAX_DEPTH),
    maxArrayItems: resolveLimit(this.maxArrayItems(), DEFAULT_MAX_ARRAY_ITEMS),
    maxRows: resolveLimit(this.maxRows(), DEFAULT_MAX_ROWS),
  }));

  private readonly expandedPaths = computed<ReadonlySet<string>>(() => {
    const current = this.expansion();
    return current !== null && current.source === this.value() ? current.value : ROOT_EXPANDED;
  });

  private readonly internalSelection = computed<string | null>(() => {
    const current = this.selection();
    return current !== null && current.source === this.value() ? current.value : null;
  });

  protected readonly selected = computed<string | null>(() => this.selectedPath() ?? this.internalSelection());

  protected readonly view = computed<TreeView>(() =>
    buildTree(this.value(), this.label(), this.limits(), this.expandedPaths()),
  );

  private readonly activePath = computed<string>(() => {
    const current = this.active();
    return current !== null && current.source === this.value() ? current.value : "";
  });

  protected readonly activeIndex = computed<number>(() => {
    const index = this.view().rows.findIndex((row) => row.path === this.activePath());
    return index === -1 ? 0 : index;
  });

  protected rowId(index: number): string {
    return `${this.instanceId}-row-${index}`;
  }

  protected activate(row: TreeRow): void {
    this.select(row);
    if (row.expandable) this.setExpanded(row.path, !row.expanded);
  }

  private select(row: TreeRow): void {
    this.setActive(row.path);
    this.selection.set({ source: this.value(), value: row.path });
    this.pathSelected.emit(row.path);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    const rows = this.view().rows;
    const row = rows[index];
    const child = rows[index + 1];
    switch (event.key) {
      case "ArrowDown":
        this.moveTo(index + 1);
        break;
      case "ArrowUp":
        this.moveTo(index - 1);
        break;
      case "Home":
        this.moveTo(0);
        break;
      case "End":
        this.moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.expandable) {
          if (row.expanded) {
            if (child !== undefined && child.depth > row.depth) this.moveTo(index + 1);
          } else {
            this.setExpanded(row.path, true);
          }
        }
        break;
      case "ArrowLeft":
        if (row.expandable && row.expanded) {
          this.setExpanded(row.path, false);
        } else {
          this.moveToParent(index);
        }
        break;
      case "Enter":
      case " ":
        this.select(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private setExpanded(path: string, expanded: boolean): void {
    const next = new Set(this.expandedPaths());
    if (expanded) next.add(path);
    else next.delete(path);
    this.expansion.set({ source: this.value(), value: next });
  }

  private setActive(path: string): void {
    this.active.set({ source: this.value(), value: path });
  }

  private moveTo(index: number): void {
    const rows = this.view().rows;
    if (index < 0 || index >= rows.length) return;
    this.setActive(rows[index].path);
    this.focusRow(index);
  }

  private moveToParent(index: number): void {
    const rows = this.view().rows;
    const depth = rows[index].depth;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (rows[candidate].depth < depth) {
        this.moveTo(candidate);
        return;
      }
    }
  }

  private focusRow(index: number): void {
    queueMicrotask(() => {
      const element = this.list()?.nativeElement.querySelectorAll<HTMLElement>("[role='treeitem']")[index];
      if (!element) return;
      element.focus();
      element.scrollIntoView({ block: "nearest" });
    });
  }
}
