import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";
import type { TraceExport } from "./trace.logic";

/**
 * Export of the filtered stored trace. The payload carries server-redacted rows only; the
 * component never re-fetches or re-shapes it.
 */
@Component({
  selector: "hb-debugger-export",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="dbg-export-heading">
      <h2 id="dbg-export-heading">Export filtered trace</h2>

      <p class="subtle">
        Contains server-redacted payloads. Only the events matching the current filters are included.
      </p>

      <div class="actions">
        <button type="button" class="small" [disabled]="payload() === null" (click)="copy()">Copy JSON</button>
        <button type="button" class="small" [disabled]="payload() === null" (click)="download()">Download JSON</button>
      </div>

      <p class="summary">
        @if (payload(); as current) {
          {{ current.count }} events · run {{ current.runId }}
        } @else {
          Load a run to export its stored trace.
        }
      </p>

      <p class="status subtle" role="status" aria-live="polite">{{ status() }}</p>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    h2 {
      margin-bottom: var(--space-2);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: var(--space-3) 0 var(--space-2);
    }

    .summary {
      margin: 0 0 var(--space-1);
      font-size: 12.5px;
      color: var(--text-muted);
    }

    .status {
      margin: 0;
      min-height: 1.2em;
      font-size: 12.5px;
    }
  `,
})
export class DebuggerExport {
  public readonly payload = input.required<TraceExport | null>();

  protected readonly status = signal("");

  protected async copy(): Promise<void> {
    const payload = this.payload();
    if (payload === null) return;

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      this.status.set("Copied to clipboard.");
    } catch {
      this.status.set("Copy failed — use Download JSON instead.");
    }
  }

  protected download(): void {
    const payload = this.payload();
    if (payload === null) return;

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `healthbridge-trace-${payload.runId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
