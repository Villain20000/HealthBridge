# Cookie-based BFF / OIDC authentication — planned

**Status:** ⬜ not implemented · **Phase:** D4 · **UI today:** in-memory API key, documented as a
single-operator administrative tool.

## Why it matters

A bearer key in browser memory is not XSS-proof and cannot be revoked per session. A BFF with a
`HttpOnly` cookie removes the credential from JavaScript entirely and enables SSO.

## What exists today (verified)

- `AuthStore` holds the key in a signal, never in storage; interceptors add `x-api-key`.
- 401 clears the session and returns to `/connect` with the problem code and request id.
- `docs/console.md` §2 defines the seam: `isConnected()`, `key()`, `invalidate(reason)`.
- API keys are HMAC-hashed server-side with scopes and per-key rate limits.

## What is missing

- Session endpoints: `POST /session` (exchange OIDC code), `GET /session`, `DELETE /session`.
- A server-side session store (encrypted cookie or server session id) and CSRF protection.
- Principal mapping from OIDC claims to workspace + scopes; logout/back-channel logout.
- `AuthStore` implementation that never sees a credential.

## Proposed design

Strangler: add `SessionAuthStore` with the same public surface, switch the interceptor to it,
delete the connect form. The console server (`server.mjs`) becomes the BFF: it holds the token,
adds `Authorization`, and proxies `/api` with `SameSite=Lax` cookies plus a double-submit CSRF
token for mutations. SSE keeps working because the cookie travels on the fetch.

## Acceptance criteria

- No credential is readable from JavaScript (`window`, storage, URL, DevTools network payloads).
- CSRF: a cross-site POST without the token is rejected; GET/HEAD are unaffected.
- Session expiry mid-stream closes the SSE connection and routes to sign-in with a reason.
- Revoking a user's session invalidates it server-side within one request.
- The API key path keeps working for CLI/SDK clients (unchanged `x-api-key`).

## Risks / non-goals

- Cookies introduce CSRF; do not ship this without the double-submit token and `SameSite`.
- Multi-tenant user membership is a separate design (see multi-workspace.md).
- No social login, no self-service signup, no password storage.
