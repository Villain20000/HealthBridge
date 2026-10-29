import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiClient } from "../../core/api-client";
import type { ApiProblem, AuditEvent } from "../../core/api-types";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";
import { formatRelative, truncateMiddle } from "../../core/format";

/**
 * Audit log: what happened, to which object, by which key, and whether it worked.
 * Read-only by design — the API has no endpoint to edit or delete an audit event.
 */
@Component({
  selector: "hb-audit",
  standalone: true,
  imports: [EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Audit</h1>
        <p>Security-relevant events for this workspace, newest first.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
      </div>
    </div>

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && events().length === 0) {
      <hb-loading label="Loading audit events…" />
    } @else if (events().length === 0) {
      <hb-empty title="No audit events" message="Actions such as key creation, uploads and runs are recorded here." />
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
              <th>Actor</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody>
            @for (event of events(); track event.id) {
              <tr>
                <td class="subtle">{{ relative(event.createdAt) }}</td>
                <td class="mono">{{ event.action }}</td>
                <td class="mono" [title]="event.targetId">
                  {{ shorten(event.targetType) }} {{ shorten(event.targetId) }}
                </td>
                <td>
                  <span class="chip" [class]="event.outcome === 'success' ? 'ok' : 'danger'">{{ event.outcome }}</span>
                </td>
                <td class="subtle mono">{{ event.actorKeyId ?? "—" }}</td>
                <td class="subtle mono">{{ event.requestId ? shorten(event.requestId) : "—" }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button type="button" class="small" (click)="next()" [disabled]="!cursor() || loading()">Next</button>
        <span>{{ events().length }} shown{{ cursor() ? " · more available" : "" }}</span>
      </div>
    }
  `,
})
export class AuditPage {
  private readonly api = inject(ApiClient);

  protected readonly events = signal<AuditEvent[]>([]);
  protected readonly cursor = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);

  constructor() {
    this.reload();
  }

  protected reload(): void {
    this.cursor.set(undefined);
    this.fetch();
  }

  protected next(): void {
    const cursor = this.cursor();
    if (cursor) this.fetch(cursor);
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected shorten(value: string): string {
    return truncateMiddle(value, 9);
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.listAudit(50, cursor).subscribe({
      next: (page) => {
        this.events.update((current) => (cursor ? [...current, ...page.items] : page.items));
        this.cursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }
}
