/**
 * Fixed-window rate limiter for the public bootstrap endpoint.
 *
 * `POST /api/v1/workspaces` cannot rely on `ApiKeyGuard`: the route is public, so
 * the guard returns before its token-bucket limiter runs. Every bootstrap attempt
 * therefore needs its own limit, keyed by client IP, and failed (unauthenticated)
 * attempts must cost a slot too — otherwise the bootstrap token can be guessed
 * without any constraint.
 *
 * In-process by design, like `TokenBucketRateLimiter`: with more than one API
 * replica each process gets its own window. That is acceptable for a startup-only
 * endpoint; a horizontally scaled deployment should move the counter to shared
 * storage.
 */
export interface BootstrapRateLimiterOptions {
  /** Attempts allowed per window, per key. */
  attemptsPerWindow: number;
  /** Window length in milliseconds. */
  windowMs: number;
  now?: () => number;
}

export interface BootstrapRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: string;
}

interface Window {
  count: number;
  startedAt: number;
}

/** Bound memory: entries are swept once the map grows past this size. */
const SWEEP_THRESHOLD = 1024;

export class BootstrapRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly attemptsPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: BootstrapRateLimiterOptions) {
    if (options.attemptsPerWindow <= 0) throw new Error("attemptsPerWindow must be positive");
    if (options.windowMs <= 0) throw new Error("windowMs must be positive");
    this.attemptsPerWindow = options.attemptsPerWindow;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  public consume(key: string): BootstrapRateLimitDecision {
    const now = this.now();
    if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(now);

    const current = this.windows.get(key);
    const window = current && now - current.startedAt < this.windowMs ? current : { count: 0, startedAt: now };
    this.windows.set(key, window);

    const resetAtMs = window.startedAt + this.windowMs;
    if (window.count >= this.attemptsPerWindow) {
      return {
        allowed: false,
        limit: this.attemptsPerWindow,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
        resetAt: new Date(resetAtMs).toISOString(),
      };
    }

    window.count += 1;
    return {
      allowed: true,
      limit: this.attemptsPerWindow,
      remaining: this.attemptsPerWindow - window.count,
      retryAfterSeconds: 0,
      resetAt: new Date(resetAtMs).toISOString(),
    };
  }

  /** Test/maintenance hook; not used in request handling. */
  public reset(key?: string): void {
    if (key === undefined) this.windows.clear();
    else this.windows.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
