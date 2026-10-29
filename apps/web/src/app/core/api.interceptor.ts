import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpInterceptorFn, HttpRequest } from "@angular/common/http";
import { inject } from "@angular/core";
import { Observable, catchError, finalize, throwError } from "rxjs";
import { AuthStore } from "./auth.store";

/**
 * One place where a request becomes an authenticated, traceable API call.
 *
 * - Adds `x-api-key` from the in-memory store (never from storage, never from a URL).
 * - Adds `x-request-id` so a failure can be correlated with the server log.
 * - Adds `Idempotency-Key` for mutating calls that the API documents as idempotent, unless
 *   the caller supplied one (the console reuses the key when a user retries a submit).
 * - Drops the session on a 401 so a revoked key cannot leave the UI showing a stale
 *   "signed in" state. A 403 is surfaced instead: the key is valid, the action is not allowed.
 */

const IDEMPOTENT_POSTS = [/\/api\/v1\/runs$/, /\/api\/v1\/assets$/, /\/api\/v1\/mappings$/, /\/api\/v1\/pipelines$/];

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const apiInterceptor: HttpInterceptorFn = (
  request: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const auth = inject(AuthStore);
  const key = auth.apiKey();

  let headers = request.headers.set("x-request-id", newRequestId());
  if (key) headers = headers.set("x-api-key", key);

  const isIdempotentPost = request.method === "POST" && IDEMPOTENT_POSTS.some((pattern) => pattern.test(request.url));
  if (isIdempotentPost && !headers.has("idempotency-key")) {
    headers = headers.set("idempotency-key", newRequestId());
  }

  auth.noteRequest();

  return next(request.clone({ headers })).pipe(
    catchError((error: unknown) => {
      // 401 means the key is gone (revoked/expired) — drop the session. 403 means "valid key,
      // insufficient scope": the operator stays signed in and sees the error on the page.
      if (error instanceof HttpErrorResponse && error.status === 401) {
        auth.invalidate("unauthorized");
      }
      return throwError(() => error);
    }),
    finalize(() => auth.noteResponse()),
  );
};
