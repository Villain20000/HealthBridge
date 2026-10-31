# Multi-workspace sessions — planned

**Status:** ⬜ not implemented · **Phase:** D4 · **UI today:** one workspace per session; switching
workspaces means switching API keys.

## Why it matters

Consultants and platform teams operate several tenants. Re-authenticating per tenant is workable
for one operator and painful for a team.

## What exists today (verified)

- A key is bound to exactly one workspace; `/workspaces/current` returns it (`docs/api.md`).
- Repositories take `workspaceId` from the principal, never from the URL (ADR-0005).
- The console displays the workspace slug and the key prefix; there is no switcher.

## What is missing

- `GET /workspaces` for a principal that holds membership in several workspaces.
- Membership model (user ↔ workspace ↔ role) — today identity is a key, not a user.
- A session representation that can target a workspace without a new credential.

## Proposed design

Depends on `auth-bff-oidc.md`: a session carries a user; membership rows grant roles per
workspace; the active workspace is a session attribute switched by `POST /session/workspace`
(server-side, audited). API keys remain single-workspace for machines. The console gains a
workspace picker in the shell and re-fetches on switch; no route structure changes.

## Acceptance criteria

- Switching workspace cannot change scopes beyond the user's membership.
- Every switch is audited with actor, from-workspace and to-workspace.
- A request with a workspace the user no longer belongs to returns `403`, not an empty list.
- No client-side filtering of records from other workspaces (the API never returns them).

## Risks / non-goals

- This is an identity feature, not a UI dropdown; shipping the picker before membership exists
  would be fake.
- No cross-workspace search or aggregate dashboards.
