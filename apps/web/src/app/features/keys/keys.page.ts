import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ApiClient } from "../../core/api-client";
import { AuthStore } from "../../core/auth.store";
import type { ApiKeyRecord, ApiProblem } from "../../core/api-types";
import { EmptyState, ErrorPanel, LoadingState } from "../../ui/primitives";
import { formatDateTime, formatRelative } from "../../core/format";

/** The shell shows a masked prefix; this rebuilds the same shape for comparison. */
function maskKeyForCompare(prefix: string): string {
  return `${prefix.slice(0, 6)}…`;
}

/**
 * API key administration.
 *
 * A newly created or rotated secret is shown exactly once, in memory, with a copy button. It is
 * never stored, and refreshing the page loses it — the same rule as the console's own key.
 */
@Component({
  selector: "hb-keys",
  standalone: true,
  imports: [FormsModule, EmptyState, ErrorPanel, LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>API keys</h1>
        <p>Machine credentials for this workspace. A secret is shown once, at creation.</p>
      </div>
      <div class="actions">
        <button type="button" class="small" (click)="reload()" [disabled]="loading()">Refresh</button>
        <button type="button" class="small primary" (click)="createOpen.set(!createOpen())">
          {{ createOpen() ? "Close" : "New key" }}
        </button>
      </div>
    </div>

    @if (revealed(); as secret) {
      <section class="card" style="margin-bottom: 16px" role="status">
        <h2>Copy this secret now</h2>
        <p class="card-sub">It will not be shown again. It is held in this page's memory only.</p>
        <div class="row">
          <code style="word-break: break-all">{{ secret }}</code>
          <button type="button" class="small" (click)="copy(secret)">{{ copied() ? "Copied" : "Copy" }}</button>
          <button type="button" class="small ghost" (click)="revealed.set(null)">Dismiss</button>
        </div>
      </section>
    }

    @if (createOpen()) {
      <section class="card" style="margin-bottom: 16px" aria-labelledby="create-key-heading">
        <h2 id="create-key-heading">Create a key</h2>
        <div class="grid cols-3">
          <div class="field">
            <label for="key-name">Name</label>
            <input id="key-name" [(ngModel)]="keyName" placeholder="ci-runner" autocomplete="off" />
          </div>
          <div class="field">
            <label for="key-role">Role</label>
            <select id="key-role" [(ngModel)]="keyRole">
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
              <option value="service">service</option>
              <option value="owner">owner</option>
            </select>
          </div>
          <div class="field">
            <label for="key-ttl">TTL in days (optional)</label>
            <input id="key-ttl" type="number" min="1" [(ngModel)]="keyTtl" />
          </div>
        </div>

        @if (createProblem(); as issue) {
          <hb-error [problem]="issue" />
        }

        <button type="button" class="primary" (click)="create()" [disabled]="creating() || !keyName">
          {{ creating() ? "Creating…" : "Create key" }}
        </button>
      </section>
    }

    @if (problem(); as issue) {
      <hb-error [problem]="issue" [showRetry]="true" (retry)="reload()" />
      <div style="height: 16px"></div>
    }

    @if (loading() && keys().length === 0) {
      <hb-loading label="Loading keys…" />
    } @else if (keys().length === 0) {
      <hb-empty title="No API keys" message="Create a key to call the API from a script or another service." />
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Role</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (key of keys(); track key.id) {
              <tr>
                <td>{{ key.name }}</td>
                <td class="mono">{{ key.prefix }}…</td>
                <td>
                  <span class="chip plain muted">{{ key.role }}</span>
                </td>
                <td class="subtle">{{ relative(key.createdAt) }}</td>
                <td class="subtle">{{ key.lastUsedAt ? relative(key.lastUsedAt) : "never" }}</td>
                <td class="subtle">{{ key.expiresAt ? stamp(key.expiresAt) : "—" }}</td>
                <td class="right">
                  <button type="button" class="small" (click)="rotate(key)" [disabled]="acting()">Rotate</button>
                  <button type="button" class="small danger" (click)="revoke(key)" [disabled]="acting()">Revoke</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    <p class="faint" style="margin-top: 16px">
      Revoking the key this console is using signs it out immediately: the next request returns 401.
    </p>
  `,
})
export class KeysPage {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthStore);

  protected readonly keys = signal<ApiKeyRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createProblem = signal<ApiProblem | null>(null);
  protected readonly revealed = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly acting = signal(false);

  protected keyName = "";
  protected keyRole = "editor";
  protected keyTtl: number | null = null;

  constructor() {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.problem.set(null);
    this.api.listKeys().subscribe({
      next: (response) => {
        this.keys.set(response.keys);
        this.loading.set(false);
      },
      error: (error: ApiProblem) => {
        this.problem.set(error);
        this.loading.set(false);
      },
    });
  }

  protected create(): void {
    this.creating.set(true);
    this.createProblem.set(null);
    this.copied.set(false);
    this.api
      .createKey({
        name: this.keyName.trim(),
        role: this.keyRole,
        ...(this.keyTtl && this.keyTtl > 0 ? { ttlDays: Number(this.keyTtl) } : {}),
      })
      .subscribe({
        next: (created) => {
          this.creating.set(false);
          this.createOpen.set(false);
          this.keyName = "";
          this.revealed.set(created.key);
          this.reload();
        },
        error: (error: ApiProblem) => {
          this.creating.set(false);
          this.createProblem.set(error);
        },
      });
  }

  protected rotate(key: ApiKeyRecord): void {
    this.acting.set(true);
    this.copied.set(false);
    this.api.rotateKey(key.id).subscribe({
      next: (created) => {
        this.acting.set(false);
        this.revealed.set(created.key);
        this.reload();
        if (this.auth.keyPrefix() === maskKeyForCompare(key.prefix)) {
          // Rotating the console's own key invalidates the session on the next call.
          this.auth.invalidate("unauthorized", "this console's key was rotated");
        }
      },
      error: (error: ApiProblem) => {
        this.acting.set(false);
        this.problem.set(error);
      },
    });
  }

  protected revoke(key: ApiKeyRecord): void {
    if (!confirm(`Revoke "${key.name}"? Clients using it stop working immediately.`)) return;
    this.acting.set(true);
    this.api.revokeKey(key.id).subscribe({
      next: () => {
        this.acting.set(false);
        this.reload();
      },
      error: (error: ApiProblem) => {
        this.acting.set(false);
        this.problem.set(error);
      },
    });
  }

  protected copy(secret: string): void {
    void navigator.clipboard?.writeText(secret).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  protected relative(iso: string): string {
    return formatRelative(iso);
  }

  protected stamp(iso: string): string {
    return formatDateTime(iso);
  }
}
