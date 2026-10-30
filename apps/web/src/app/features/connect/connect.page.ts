import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { ApiClient } from "../../core/api-client";
import { AuthStore } from "../../core/auth.store";
import { describeProblem } from "../../core/api-errors";
import { safeReturnUrl } from "../../core/navigation";
import type { ApiProblem } from "../../core/api-types";
import { ErrorPanel } from "../../ui/primitives";

/**
 * Connect screen.
 *
 * The key never leaves memory: no localStorage, no sessionStorage, no cookie, no URL. It is
 * verified against two real calls before the shell opens (`/healthz` proves the server is
 * reachable, `/workspaces/current` proves the key is valid), so "connected" is not a guess.
 *
 * The console authenticates a *machine*, not a person. That warning is part of the UI, not a
 * comment in a README.
 */
@Component({
  selector: "hb-connect",
  standalone: true,
  imports: [FormsModule, ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-header">
      <div>
        <h1>Connect to HealthBridge</h1>
        <p>Point the console at an API and sign in with an API key. The key is held in memory only.</p>
      </div>
    </div>

    <div class="grid cols-2">
      <section class="card" aria-labelledby="connect-heading">
        <h2 id="connect-heading">Connect with an API key</h2>
        <p class="card-sub">Same-origin by default (<code>/api/v1</code>); override only for a direct connection.</p>

        <div class="field">
          <label for="base-url">API base URL</label>
          <input id="base-url" name="baseUrl" [(ngModel)]="baseUrl" autocomplete="off" spellcheck="false" />
          <p class="help">Requests are proxied through this origin when it starts with <code>/</code>.</p>
        </div>

        <div class="field">
          <label for="api-key">API key</label>
          <input
            id="api-key"
            name="apiKey"
            type="password"
            [(ngModel)]="apiKey"
            autocomplete="off"
            spellcheck="false"
            placeholder="hb_…"
            (keydown.enter)="connect()"
          />
          <p class="help">Never written to storage, logs or the URL. Reloading the tab signs you out.</p>
        </div>

        @if (problem(); as issue) {
          <hb-error [problem]="issue" />
        }

        <div class="row" style="margin-top: 12px">
          <button class="primary" type="button" (click)="connect()" [disabled]="busy() || !apiKey.trim()">
            {{ busy() ? "Verifying…" : "Connect" }}
          </button>
          @if (busy()) {
            <span class="spinner" role="status" aria-label="Verifying"></span>
          }
        </div>

        <p class="banner" style="margin-top: 16px">
          <strong>Trusted operators only.</strong> This console is a single-operator administrative tool, not a
          multi-user authentication system. Serve it over HTTPS behind your own access control and never expose it to
          the public internet.
        </p>
      </section>

      <section class="card" aria-labelledby="bootstrap-heading">
        <h2 id="bootstrap-heading">First run? Create a workspace</h2>
        <p class="card-sub">
          Needs the server's <code>HEALTHBRIDGE_BOOTSTRAP_TOKEN</code>. The returned key is shown once — the console
          connects with it immediately and keeps it in memory.
        </p>

        <div class="field">
          <label for="bootstrap-token">Bootstrap token</label>
          <input
            id="bootstrap-token"
            name="bootstrapToken"
            type="password"
            [(ngModel)]="bootstrapToken"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="workspace-name">Workspace name</label>
          <input id="workspace-name" name="workspaceName" [(ngModel)]="workspaceName" autocomplete="off" />
        </div>
        <div class="field">
          <label for="workspace-slug">Slug</label>
          <input
            id="workspace-slug"
            name="workspaceSlug"
            [(ngModel)]="workspaceSlug"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        @if (bootstrapProblem(); as issue) {
          <hb-error [problem]="issue" />
        }

        <button type="button" (click)="bootstrap()" [disabled]="bootstrapBusy() || !bootstrapToken || !workspaceSlug">
          {{ bootstrapBusy() ? "Creating…" : "Create workspace and connect" }}
        </button>
      </section>
    </div>

    @if (previousFailure(); as failure) {
      <p class="banner" style="margin-top: 16px">{{ failure }}</p>
    }
  `,
})
export class ConnectPage {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected baseUrl = "/api/v1";
  protected apiKey = "";
  protected bootstrapToken = "";
  protected workspaceName = "Clinic";
  protected workspaceSlug = `clinic-${Math.random().toString(36).slice(2, 7)}`;

  protected readonly busy = signal(false);
  protected readonly problem = signal<ApiProblem | null>(null);
  protected readonly bootstrapBusy = signal(false);
  protected readonly bootstrapProblem = signal<ApiProblem | null>(null);

  protected readonly previousFailure = computed(() => {
    const state = this.auth.state();
    if (!state.failure) return null;
    const detail = state.failureDetail ? ` (${state.failureDetail})` : "";
    if (state.failure === "unauthorized") return `The previous session ended: the API key was rejected${detail}.`;
    if (state.failure === "forbidden") return `The previous session ended: that key is not allowed here${detail}.`;
    return `The previous session ended${detail}.`;
  });

  protected connect(): void {
    const key = this.apiKey.trim();
    if (!key) return;
    this.busy.set(true);
    this.problem.set(null);

    // healthz is public: it proves the URL before blaming the key.
    this.api.health().subscribe({
      next: () => {
        this.auth.connect(key, this.baseUrl.trim() || "/api/v1");
        this.api.currentWorkspace().subscribe({
          next: () => {
            this.busy.set(false);
            this.apiKey = "";
            void this.router.navigateByUrl(this.destination());
          },
          error: (error: unknown) => {
            this.busy.set(false);
            this.auth.disconnect();
            this.problem.set(error as ApiProblem);
          },
        });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.problem.set(error as ApiProblem);
      },
    });
  }

  protected bootstrap(): void {
    this.bootstrapBusy.set(true);
    this.bootstrapProblem.set(null);
    this.api
      .createWorkspace(
        { name: this.workspaceName.trim() || "Clinic", slug: this.workspaceSlug.trim() },
        this.bootstrapToken,
      )
      .subscribe({
        next: (created) => {
          this.bootstrapBusy.set(false);
          this.bootstrapToken = "";
          this.auth.connect(created.apiKey.key, this.baseUrl.trim() || "/api/v1");
          void this.router.navigateByUrl(this.destination());
        },
        error: (error: unknown) => {
          this.bootstrapBusy.set(false);
          this.bootstrapProblem.set(error as ApiProblem);
        },
      });
  }

  protected describe(issue: ApiProblem): string {
    return describeProblem(issue);
  }

  private destination(): string {
    return safeReturnUrl(this.route.snapshot.queryParamMap.get("returnUrl")) ?? "/dashboard";
  }
}
