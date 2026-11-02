import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

@Component({
  selector: "hb-debugger-toolbar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar" role="toolbar" aria-label="Debugger execution controls">
      <div class="control-group">
        <button
          type="button"
          class="small primary-step"
          (click)="continue.emit()"
          [disabled]="!hasBreakpoints() || !canNext()"
          title="Continue to next breakpoint (F5)"
        >
          <span class="icon" aria-hidden="true">▶</span>
          <span>Continue</span>
          <kbd class="key-badge">F5</kbd>
        </button>

        <button
          type="button"
          class="small"
          (click)="stepBack.emit()"
          [disabled]="!canPrevious()"
          title="Step back to previous event (Shift+F10)"
        >
          <span class="icon" aria-hidden="true">◀</span>
          <span>Step Back</span>
          <kbd class="key-badge">⇧F10</kbd>
        </button>

        <button
          type="button"
          class="small"
          (click)="stepOver.emit()"
          [disabled]="!canNext()"
          title="Step over to next event (F10)"
        >
          <span>Step Over</span>
          <span class="icon" aria-hidden="true">↷</span>
          <kbd class="key-badge">F10</kbd>
        </button>
      </div>

      <div class="divider" role="separator" aria-orientation="vertical"></div>

      <div class="control-group">
        <button
          type="button"
          class="small"
          (click)="jumpPrevError.emit()"
          title="Jump to previous error or warning event"
        >
          <span>⏮ Prev Error</span>
        </button>
        <button
          type="button"
          class="small danger-btn"
          (click)="jumpNextError.emit()"
          title="Jump to next error or warning event (Alt+E)"
        >
          <span>Next Error ⏭</span>
          <kbd class="key-badge">Alt+E</kbd>
        </button>
      </div>

      <div class="divider" role="separator" aria-orientation="vertical"></div>

      <div class="control-group">
        <button
          type="button"
          class="small"
          (click)="jumpPrevRecord.emit()"
          title="Jump to first event of previous record"
        >
          <span>Prev Record</span>
        </button>
        <button
          type="button"
          class="small"
          (click)="jumpNextRecord.emit()"
          title="Jump to first event of next record"
        >
          <span>Next Record</span>
        </button>
      </div>

      <div class="status-info">
        @if (totalCount() > 0 && currentIndex() >= 0) {
          <span class="subtle mono">Event {{ currentIndex() + 1 }} of {{ totalCount() }}</span>
        } @else if (totalCount() > 0) {
          <span class="subtle mono">{{ totalCount() }} events</span>
        }
      </div>
    </div>

    @if (offFilterNotice(); as notice) {
      <div class="off-filter-alert" role="alert">
        <span class="alert-msg">{{ notice.label }}</span>
        <div class="alert-actions">
          <button type="button" class="small action-link" (click)="jumpOffFilter.emit()">
            Clear filter & jump
          </button>
          <button type="button" class="small dismiss-btn" aria-label="Dismiss notice" (click)="clearOffFilter.emit()">
            ✕
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: var(--space-3);
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-3);
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .divider {
      width: 1px;
      height: 24px;
      background: var(--border);
      margin: 0 var(--space-1);
    }

    .primary-step {
      font-weight: 600;
    }

    .danger-btn {
      color: var(--danger, #dc2626);
    }

    .key-badge {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--bg-inset, rgba(0, 0, 0, 0.05));
      border: 1px solid var(--border);
      margin-left: var(--space-1);
    }

    .status-info {
      margin-left: auto;
      font-size: 12px;
    }

    .off-filter-alert {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      margin-top: var(--space-2);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius);
      background: var(--bg-card);
      border: 1px solid var(--warning, #f59e0b);
      font-size: 13px;
    }

    .alert-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .action-link {
      font-weight: 600;
      color: var(--primary, #2563eb);
    }

    .dismiss-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
    }
  `,
})
export class DebuggerToolbar {
  public readonly canPrevious = input<boolean>(false);
  public readonly canNext = input<boolean>(false);
  public readonly hasBreakpoints = input<boolean>(false);
  public readonly currentIndex = input<number>(-1);
  public readonly totalCount = input<number>(0);
  public readonly offFilterNotice = input<{ seq: number; label: string } | null>(null);

  public readonly continue = output<void>();
  public readonly stepOver = output<void>();
  public readonly stepBack = output<void>();
  public readonly jumpNextError = output<void>();
  public readonly jumpPrevError = output<void>();
  public readonly jumpNextRecord = output<void>();
  public readonly jumpPrevRecord = output<void>();
  public readonly jumpOffFilter = output<void>();
  public readonly clearOffFilter = output<void>();
}
