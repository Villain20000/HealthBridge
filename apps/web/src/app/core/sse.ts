/**
 * Server-sent events over `fetch` + `ReadableStream`.
 *
 * `EventSource` cannot send `x-api-key`, so the browser's built-in client cannot be used at
 * all. This module is the replacement: it parses the wire format incrementally, survives
 * chunks that split an event in half, ignores comment/heartbeat lines, and reports a
 * reconnectable failure instead of throwing into the void.
 *
 * The parser is pure so it can be tested without a browser (see apps/web/test/sse.test.ts).
 */

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Incremental parser: feed it text chunks, get complete frames back.
 *
 * SSE frames are separated by a blank line and may use CRLF, LF or CR line endings; a chunk
 * boundary can fall anywhere, including between the CR and LF of one line.
 */
export class SseParser {
  private buffer = "";

  public push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // Normalise CRLF/CR to LF only inside the complete portion we are about to consume.
    let separator = this.nextSeparator();
    while (separator) {
      const raw = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator.length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      separator = this.nextSeparator();
    }
    return frames;
  }

  /** Leftover text that never formed a complete frame — useful for debugging, not for UI. */
  public get pending(): string {
    return this.buffer;
  }

  private nextSeparator(): { index: number; length: number } | undefined {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    const cr = this.buffer.indexOf("\r\r");
    const candidates: Array<{ index: number; length: number }> = [];
    if (lf >= 0) candidates.push({ index: lf, length: 2 });
    if (crlf >= 0) candidates.push({ index: crlf, length: 4 });
    if (cr >= 0) candidates.push({ index: cr, length: 2 });
    if (candidates.length === 0) return undefined;
    return candidates.sort((a, b) => a.index - b.index)[0];
  }
}

export function parseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split(/\r\n|\r|\n/);
  const dataLines: string[] = [];
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  let hasField = false;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue; // blank or heartbeat comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    switch (field) {
      case "event":
        event = value || "message";
        hasField = true;
        break;
      case "data":
        dataLines.push(value);
        hasField = true;
        break;
      case "id":
        id = value;
        hasField = true;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) retry = parsed;
        hasField = true;
        break;
      }
      default:
        break;
    }
  }

  if (!hasField) return undefined;
  return { event, data: dataLines.join("\n"), id, retry };
}

export type SseConnectionState = "connecting" | "open" | "reconnecting" | "closed" | "unauthorized";

export interface SseOptions {
  url: string;
  apiKey: string;
  headers?: Record<string, string>;
  onFrame: (frame: SseFrame) => void;
  onState: (state: SseConnectionState, detail?: string) => void;
  /** Backoff between reconnects; grows up to the cap. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
}

export interface SseHandle {
  close: () => void;
}

/**
 * Opens a stream and keeps it open. Reconnects with backoff (the last `id` is sent as
 * `Last-Event-ID`), never notifies twice for the same frame, and treats 401/403 as terminal —
 * retrying a rejected key forever is how a console fills a log with noise.
 */
export function openSse(options: SseOptions): SseHandle {
  const controller = new AbortController();
  let closed = false;
  let lastEventId: string | undefined;
  let lastFrameId: string | undefined;
  let attempt = 0;
  let retry = options.retryDelayMs ?? 500;
  const maxRetry = options.maxRetryDelayMs ?? 5_000;

  const abort = () => {
    closed = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const run = async (): Promise<void> => {
    while (!closed) {
      options.onState(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const response = await fetch(options.url, {
          headers: {
            accept: "text/event-stream",
            "cache-control": "no-cache",
            "x-api-key": options.apiKey,
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
            ...(options.headers ?? {}),
          },
          signal: controller.signal,
          cache: "no-store",
        });

        if (response.status === 401 || response.status === 403) {
          options.onState("unauthorized", `HTTP ${response.status}`);
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`stream failed with HTTP ${response.status}`);
        }

        attempt = 0;
        retry = options.retryDelayMs ?? 500;
        options.onState("open");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            if (frame.id) {
              // A reconnect can replay the last event; the operator must not see it twice.
              if (frame.id === lastFrameId) continue;
              lastFrameId = frame.id;
              lastEventId = frame.id;
            }
            if (frame.retry) retry = frame.retry;
            options.onFrame(frame);
          }
        }
      } catch (error) {
        if (closed) return;
        options.onState("reconnecting", (error as Error)?.message ?? "stream error");
      }

      if (closed) return;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retry * attempt, maxRetry)));
    }
  };

  void run();
  return { close: abort };
}
