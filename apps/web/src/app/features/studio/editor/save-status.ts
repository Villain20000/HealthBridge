import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import type { ApiProblem } from "../../../core/api-types";
import { ErrorPanel } from "../../../ui/primitives";
import type { DraftConflict, SaveState } from "./editor.store";

/**
 * Autosave state for the draft. A 409 conflict is never retried silently, so this panel offers the
 * two explicit choices: reload the server draft (drops local edits) or overwrite it (keeps them).
 */
@Component({
  selector: "hb-save-status",
  standalone: true,
  imports: [ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="save-status" role="status" aria-live="polite" [attr.data-state]="state()">{{ label() }}</p>
    @if (state() === "conflict") {
      <div class="error-panel" role="alert">
        <strong>This draft was changed somewhere else.</strong>
        <div class="meta">
          @if (conflict(); as info) {
            @if (info.currentRevision !== null) {
              <span>Server revision {{ info.currentRevision }}. </span>
            }
          }
          <span>Reload the server draft to drop your edits, or overwrite it with yours.</span>
        </div>
        <div class="actions" style="margin-top: 10px">
          <button class="small" type="button" (click)="reload.emit()">Reload server draft</button>
          <button class="small" type="button" (click)="overwrite.emit()">Overwrite server draft</button>
        </div>
      </div>
    }
    @if (state() === "error") {
      <hb-error [problem]="problem()" [showRetry]="true" (retry)="retry.emit()"></hb-error>
    }
  `,
})
export class SaveStatus {
  public readonly state = input.required<SaveState>();
  public readonly revision = input(0);
  public readonly problem = input<ApiProblem | null>(null);
  public readonly conflict = input<DraftConflict | null>(null);

  public readonly retry = output<void>();
  public readonly reload = output<void>();
  public readonly overwrite = output<void>();

  protected readonly label = computed(() => {
    switch (this.state()) {
      case "idle":
        return "No unsaved changes";
      case "dirty":
        return "Unsaved changes";
      case "saving":
        return "Saving…";
      case "saved":
        return `Saved · revision ${this.revision()}`;
      case "conflict":
        return "Not saved: draft conflict";
      case "error":
        return "Not saved: save failed";
    }
  });
}
