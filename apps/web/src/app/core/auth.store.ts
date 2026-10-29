import { Injectable, computed, signal } from "@angular/core";
import { maskKey } from "./format";

/**
 * Holds the operator's API key — **in memory only**.
 *
 * Deliberately not persisted: no localStorage, no sessionStorage, no cookie, no URL. A reload
 * drops the key, which is annoying and correct for a console that has no session model of its
 * own. The store is also the seam for a future BFF: when a cookie-based session arrives, only
 * `connect()`/`disconnect()` and the interceptor change; screens keep asking `isConnected()`.
 *
 * What this cannot do is authenticate a *user*. It authenticates a *machine* with a shared
 * secret, so the console is for trusted operators on trusted networks, and it says so on the
 * connect screen.
 */

export type ConnectionFailure = "unauthorized" | "forbidden" | "network" | "invalid";

export interface ConnectionState {
  connected: boolean;
  baseUrl: string;
  keyPrefix: string | null;
  failure: ConnectionFailure | null;
  failureDetail: string | null;
}

const DEFAULT_STATE: ConnectionState = {
  connected: false,
  baseUrl: "/api/v1",
  keyPrefix: null,
  failure: null,
  failureDetail: null,
};

@Injectable({ providedIn: "root" })
export class AuthStore {
  private readonly apiKeySignal = signal<string | null>(null);
  private readonly stateSignal = signal<ConnectionState>(DEFAULT_STATE);
  private readonly inFlightSignal = signal(0);

  public readonly apiKey = this.apiKeySignal.asReadonly();
  public readonly state = this.stateSignal.asReadonly();
  public readonly isConnected = computed(() => this.stateSignal().connected);
  public readonly inFlight = computed(() => this.inFlightSignal());
  public readonly keyPrefix = computed(() => this.stateSignal().keyPrefix);
  public readonly failure = computed(() => this.stateSignal().failure);

  /** Called by the connect screen only after `GET /healthz` + `GET /workspaces/current` succeeded. */
  public connect(apiKey: string, baseUrl = DEFAULT_STATE.baseUrl): void {
    const trimmed = apiKey.trim();
    this.apiKeySignal.set(trimmed);
    this.stateSignal.set({
      connected: true,
      baseUrl,
      keyPrefix: maskKey(trimmed),
      failure: null,
      failureDetail: null,
    });
  }

  public disconnect(): void {
    this.apiKeySignal.set(null);
    this.stateSignal.set({ ...DEFAULT_STATE, failure: null, failureDetail: null });
  }

  /** Session died server-side (401/403). Keep the reason so the connect screen can explain it. */
  public invalidate(failure: ConnectionFailure, detail?: string): void {
    if (!this.stateSignal().connected) return;
    this.apiKeySignal.set(null);
    this.stateSignal.set({ ...DEFAULT_STATE, failure, failureDetail: detail ?? null });
  }

  public noteFailure(failure: ConnectionFailure, detail: string): void {
    this.stateSignal.update((state) => ({ ...state, failure, failureDetail: detail }));
  }

  public noteRequest(): void {
    this.inFlightSignal.update((count) => count + 1);
  }

  public noteResponse(): void {
    this.inFlightSignal.update((count) => Math.max(0, count - 1));
  }
}
