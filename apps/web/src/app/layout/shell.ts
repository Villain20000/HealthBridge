import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { filter } from "rxjs/operators";
import { AuthStore } from "../core/auth.store";
import { ApiClient } from "../core/api-client";
import type { Health } from "../core/api-types";

/**
 * Application shell: navigation, connection state, and the two facts that must never be
 * hidden — the server's `mode` (demo = volatile memory) and `queue.mode` (process = work dies
 * with the process). A console that silently runs on volatile storage is a trap.
 */
@Component({
  selector: "hb-shell",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">H</span>
          <span>HealthBridge</span>
          <span class="chip plain muted" aria-label="Application version">Operator Console</span>
        </div>

        @if (auth.isConnected()) {
          <nav class="nav" aria-label="Primary">
            <a routerLink="/dashboard" routerLinkActive="active">Dashboard</a>
            <a routerLink="/studio" routerLinkActive="active">Studio</a>
            <a routerLink="/runs" routerLinkActive="active">Runs</a>
            <a routerLink="/assets" routerLinkActive="active">Assets</a>
            <a routerLink="/mappings" routerLinkActive="active">Mappings</a>
            <a routerLink="/pipelines" routerLinkActive="active">Pipelines</a>
            <a routerLink="/keys" routerLinkActive="active">API keys</a>
            <a routerLink="/audit" routerLinkActive="active">Audit</a>
          </nav>
        }

        <div class="topbar-right">
          @if (health(); as h) {
            <span class="chip plain" [class]="h.mode === 'database' ? 'ok' : 'warn'" [title]="modeHint(h)">
              mode: {{ h.mode }}
            </span>
            <span class="chip plain" [class]="h.queue.mode === 'durable' ? 'ok' : 'warn'" [title]="queueHint(h)">
              queue: {{ h.queue.mode }}
            </span>
          }
          @if (auth.inFlight() > 0) {
            <span class="spinner" role="status" aria-label="Request in flight"></span>
          }
          @if (auth.isConnected()) {
            <button type="button" class="small ghost" (click)="openFormats()" aria-haspopup="dialog">Formats</button>
            <span class="chip plain muted" [title]="'API key ' + auth.keyPrefix()">{{ auth.keyPrefix() }}</span>
            <button type="button" class="small ghost" (click)="disconnect()">Disconnect</button>
          }
          <button type="button" class="small ghost" (click)="toggleTheme()" [attr.aria-label]="themeLabel()">
            {{ themeLabel() }}
          </button>
        </div>
      </header>

      <main id="main" class="page" tabindex="-1">
        <router-outlet />
      </main>

      @if (formatsOpen()) {
        <div class="modal-backdrop" (click)="formatsOpen.set(false)" (keydown.escape)="formatsOpen.set(false)">
          <div
            class="modal-card card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="formats-title"
            (click)="$event.stopPropagation()"
            style="max-width: 820px; width: 92vw; max-height: 85vh; overflow-y: auto"
          >
            <div class="row" style="justify-content: space-between; align-items: center">
              <h2 id="formats-title">Supported Adapters & Formats</h2>
              <button type="button" class="small ghost" (click)="formatsOpen.set(false)" aria-label="Close dialog">
                ✕
              </button>
            </div>
            <p class="card-sub">
              Live format adapters reported by <code>GET /api/v1/formats</code>.
            </p>

            @if (formatsLoading()) {
              <p class="subtle" style="margin-top: 16px">Loading format adapters…</p>
            } @else if (formatsList().length === 0) {
              <p class="subtle" style="margin-top: 16px">No format adapters available.</p>
            } @else {
              <div class="table-wrap" style="margin-top: 16px">
                <table>
                  <thead>
                    <tr>
                      <th>Format</th>
                      <th>Version</th>
                      <th>Status</th>
                      <th>Extensions</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (fmt of formatsList(); track fmt.format) {
                      <tr>
                        <td class="mono"><strong>{{ fmt.format }}</strong></td>
                        <td class="mono subtle">{{ fmt.version }}</td>
                        <td>
                          <span class="chip" [class.ok]="fmt.status === 'supported'" [class.warn]="fmt.status !== 'supported'">
                            {{ fmt.status }}
                          </span>
                        </td>
                        <td class="mono subtle">{{ fmt.extensions?.join(', ') }}</td>
                        <td>{{ fmt.description }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            <div class="row" style="justify-content: flex-end; margin-top: 16px">
              <button type="button" class="small" (click)="formatsOpen.set(false)">Close</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class ShellLayout {
  protected readonly auth = inject(AuthStore);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private lastPath: string | null = null;

  protected readonly health = signal<Health | null>(null);
  protected readonly dark = signal(document.documentElement.dataset["theme"] !== "light");
  protected readonly formatsOpen = signal(false);
  protected readonly formatsLoading = signal(false);
  protected readonly formatsList = signal<any[]>([]);

  protected openFormats(): void {
    this.formatsOpen.set(true);
    if (this.formatsList().length === 0) {
      this.formatsLoading.set(true);
      this.api.formats().subscribe({
        next: (res: any) => {
          this.formatsList.set(res?.formats ?? []);
          this.formatsLoading.set(false);
        },
        error: () => {
          this.formatsLoading.set(false);
        },
      });
    }
  }

  constructor() {
    this.applyTheme();
    if (this.auth.isConnected()) this.refreshHealth();

    // Focus follows a real page change, never a query or fragment update: a filter or tab
    // change must not steal focus from the control the operator just used. The first observed
    // navigation is the one that created this shell, so it is ignored.
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        const path = event.urlAfterRedirects.split(/[?#]/)[0];
        const previous = this.lastPath;
        this.lastPath = path;
        if (previous === null || previous === path) return;
        queueMicrotask(() => document.getElementById("main")?.focus());
      });

    // A 401 clears the key; without this the operator would sit on a shell whose navigation
    // has disappeared. Redirect once, and only when a session was just lost.
    effect(() => {
      const connected = this.auth.isConnected();
      const reason = this.auth.state().failure;
      if (!connected && reason && !this.router.url.startsWith("/connect")) {
        void this.router.navigate(["/connect"], {
          queryParams: { returnUrl: this.router.url },
        });
      }
    });
  }

  protected modeHint(health: Health): string {
    return health.mode === "database"
      ? "MySQL persistence: data survives a restart."
      : "Demo mode: everything is in memory and is lost when the process stops.";
  }

  protected queueHint(health: Health): string {
    return health.queue.mode === "durable"
      ? "Jobs live in the database and survive a restart."
      : "Jobs live in this process only; a restart drops queued work.";
  }

  protected refreshHealth(): void {
    this.api.health().subscribe({
      next: (health) => this.health.set(health),
      error: () => this.health.set(null),
    });
  }

  protected disconnect(): void {
    this.auth.disconnect();
    void this.router.navigate(["/connect"]);
  }

  protected themeLabel(): string {
    return this.dark() ? "Light theme" : "Dark theme";
  }

  protected toggleTheme(): void {
    this.dark.update((value) => !value);
    document.documentElement.dataset["theme"] = this.dark() ? "dark" : "light";
    try {
      localStorage.setItem("hb.theme", this.dark() ? "dark" : "light");
    } catch {
      // A theme preference is not worth failing over.
    }
  }

  private applyTheme(): void {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("hb.theme");
    } catch {
      // Storage may be unavailable; fall back to the OS preference.
    }
    if (stored === "light" || stored === "dark") {
      document.documentElement.dataset["theme"] = stored;
      this.dark.set(stored === "dark");
    }
  }
}
