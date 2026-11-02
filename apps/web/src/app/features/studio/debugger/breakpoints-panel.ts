import { ChangeDetectionStrategy, Component, input, output, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import type { Breakpoint, BreakpointKind, ConditionOp } from "./breakpoints.logic";

@Component({
  selector: "hb-breakpoints-panel",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="dbg-bp-heading">
      <div class="header">
        <h2 id="dbg-bp-heading">Breakpoints</h2>
        <button
          type="button"
          class="small secondary"
          (click)="showAddForm.set(!showAddForm())"
        >
          {{ showAddForm() ? "Cancel" : "+ Add Breakpoint" }}
        </button>
      </div>

      @if (showAddForm()) {
        <form class="add-form" (ngSubmit)="onAddSubmit()">
          <div class="field">
            <label for="bp-kind">Type</label>
            <select id="bp-kind" [ngModel]="newKind()" (ngModelChange)="newKind.set($event)" name="kind">
              <option value="seq">Event sequence (#)</option>
              <option value="status">Status (error, warning...)</option>
              <option value="stage">Stage (mapping, validate...)</option>
              <option value="record">Record index (0, 1...)</option>
              <option value="rule">Rule ID</option>
              <option value="condition">Snippet condition</option>
            </select>
          </div>

          @if (newKind() !== "condition") {
            <div class="field">
              <label for="bp-value">Value</label>
              <input
                id="bp-value"
                type="text"
                [ngModel]="newValue()"
                (ngModelChange)="newValue.set($event)"
                name="value"
                required
                [placeholder]="placeholderForKind(newKind())"
              />
            </div>
          } @else {
            <div class="field">
              <label for="bp-target">Target</label>
              <select id="bp-target" [ngModel]="newCondTarget()" (ngModelChange)="newCondTarget.set($event)" name="target">
                <option value="input">Input snippet</option>
                <option value="output">Output snippet</option>
              </select>
            </div>

            <div class="field">
              <label for="bp-path">Field path</label>
              <input
                id="bp-path"
                type="text"
                [ngModel]="newCondPath()"
                (ngModelChange)="newCondPath.set($event)"
                name="path"
                required
                placeholder="e.g. patient.gender or code"
              />
            </div>

            <div class="field">
              <label for="bp-op">Operator</label>
              <select id="bp-op" [ngModel]="newCondOp()" (ngModelChange)="newCondOp.set($event)" name="op">
                <option value="exists">exists</option>
                <option value="not_exists">not_exists</option>
                <option value="equals">equals</option>
                <option value="not_equals">not_equals</option>
                <option value="contains">contains</option>
              </select>
            </div>

            @if (newCondOp() === "equals" || newCondOp() === "not_equals" || newCondOp() === "contains") {
              <div class="field">
                <label for="bp-expected">Expected value</label>
                <input
                  id="bp-expected"
                  type="text"
                  [ngModel]="newCondVal()"
                  (ngModelChange)="newCondVal.set($event)"
                  name="val"
                  placeholder="Expected value"
                />
              </div>
            }
          }

          <div class="form-actions">
            <button type="submit" class="small primary">Save Breakpoint</button>
          </div>
        </form>
      }

      @if (breakpoints().length === 0) {
        <p class="subtle empty-note">
          No active breakpoints. Click sequence numbers in the timeline or click "+ Add Breakpoint".
        </p>
      } @else {
        <ul class="bp-list">
          @for (bp of breakpoints(); track bp.id) {
            <li class="breakpoint-item" [class.disabled]="!bp.enabled">
              <label class="item-label">
                <input
                  type="checkbox"
                  [checked]="bp.enabled"
                  (change)="toggle.emit(bp.id)"
                  [attr.aria-label]="'Toggle breakpoint ' + labelForBreakpoint(bp)"
                />
                <span class="chip micro" [class.muted]="!bp.enabled">{{ bp.kind }}</span>
                <span class="bp-text mono">{{ labelForBreakpoint(bp) }}</span>
              </label>
              <button
                type="button"
                class="small icon-only delete-btn"
                [attr.aria-label]="'Delete breakpoint ' + labelForBreakpoint(bp)"
                (click)="remove.emit(bp.id)"
              >
                ✕
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: var(--space-3);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-2);
    }

    h2 {
      margin: 0;
      font-size: 15px;
    }

    .empty-note {
      margin: var(--space-2) 0 0;
      font-size: 13px;
    }

    .add-form {
      padding: var(--space-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-inset);
      margin-bottom: var(--space-3);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .field label {
      font-size: 12px;
      font-weight: 500;
    }

    .field input, .field select {
      font-size: 13px;
      padding: 4px 8px;
    }

    .form-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--space-1);
    }

    .bp-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .breakpoint-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      padding: 6px var(--space-2);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg-card);
    }

    .breakpoint-item.disabled {
      opacity: 0.6;
    }

    .item-label {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      cursor: pointer;
      min-width: 0;
      flex: 1;
    }

    .bp-text {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip.micro {
      font-size: 10px;
      padding: 1px 4px;
      text-transform: uppercase;
    }

    .delete-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      padding: 2px 6px;
    }

    .delete-btn:hover {
      color: var(--danger, #dc2626);
    }
  `,
})
export class BreakpointsPanel {
  public readonly breakpoints = input<Breakpoint[]>([]);
  public readonly add = output<Omit<Breakpoint, "id">>();
  public readonly remove = output<string>();
  public readonly toggle = output<string>();

  protected readonly showAddForm = signal(false);
  protected readonly newKind = signal<BreakpointKind>("seq");
  protected readonly newValue = signal("");
  protected readonly newCondTarget = signal<"input" | "output">("input");
  protected readonly newCondPath = signal("");
  protected readonly newCondOp = signal<ConditionOp>("exists");
  protected readonly newCondVal = signal("");

  protected placeholderForKind(kind: BreakpointKind): string {
    switch (kind) {
      case "seq":
        return "e.g. 42";
      case "status":
        return "e.g. error or warning";
      case "stage":
        return "e.g. mapping or validate";
      case "record":
        return "e.g. 0";
      case "rule":
        return "e.g. rule-patient-gender";
      default:
        return "";
    }
  }

  protected labelForBreakpoint(bp: Breakpoint): string {
    if (bp.kind === "seq") return `Event #${bp.value}`;
    if (bp.kind === "record") return `Record #${bp.value}`;
    if (bp.kind === "condition") {
      const op = bp.conditionOp ?? "exists";
      const val = bp.conditionValue !== undefined ? ` "${bp.conditionValue}"` : "";
      return `${bp.conditionTarget ?? "input"}.${bp.conditionPath} ${op}${val}`;
    }
    return `${bp.value}`;
  }

  protected onAddSubmit(): void {
    const kind = this.newKind();
    if (kind === "condition") {
      const path = this.newCondPath().trim();
      if (!path) return;
      this.add.emit({
        kind: "condition",
        enabled: true,
        value: "",
        conditionTarget: this.newCondTarget(),
        conditionPath: path,
        conditionOp: this.newCondOp(),
        conditionValue: this.newCondVal() || undefined,
      });
    } else {
      const rawVal = this.newValue().trim();
      if (!rawVal) return;
      const value = kind === "seq" || kind === "record" ? Number(rawVal) : rawVal;
      this.add.emit({
        kind,
        enabled: true,
        value,
      });
    }

    this.newValue.set("");
    this.newCondPath.set("");
    this.newCondVal.set("");
    this.showAddForm.set(false);
  }
}
