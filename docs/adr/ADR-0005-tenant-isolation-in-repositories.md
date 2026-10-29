# ADR-0005: Tenant isolation enforced in the repository layer

- **Status:** accepted (Phase C)
- **Date:** 2026-10-29
- **Context:** The API serves multiple workspaces (tenants) from one database. A
  missing `WHERE workspace_id = ?` is the most common and most damaging bug in
  this class of system, and it is invisible in tests that use a single tenant.

## Decision

1. Every repository method takes `workspaceId` as its **first argument**. There
   is no `findById(id)` variant, so a call site cannot forget the scope.
2. A record that exists but belongs to another workspace is reported as
   `NOT_FOUND`, never `FORBIDDEN`. Cross-tenant identifiers therefore cannot be
   probed for existence.
3. The workspace id is **never** taken from the URL or the request body. It comes
   from the authenticated principal (`x-api-key` → workspace).
4. SQL statements are generated with their scope predicate inline, and
   `packages/persistence/test/sql-scoping.test.ts` asserts that every generated
   statement carries a `workspace_id` predicate and parameter.
5. Foreign keys cascade on `workspace_id` where it is safe (assets, mappings,
   runs, traces) so a workspace delete cannot leave orphaned PHI.

## Consequences

**Good**

- Forgetting the scope is a type error, not a data breach.
- The SQL-scoping test fails the build if someone adds an unscoped statement.
- Cross-tenant probing yields a boring `404`.

**Bad / accepted**

- Every query carries an extra parameter and index prefix; all indexes start with
  `workspace_id`.
- Cross-tenant admin reporting needs its own repository methods rather than a
  "global" variant of the same one. That is intentional friction.

## Verification

- `packages/persistence/test/sql-scoping.test.ts` — generated SQL is scoped.
- `packages/persistence/test/memory.test.ts` — behaviour contract shared by both
  implementations.
- `apps/api/test/api.e2e.test.ts` → *"isolates tenants"* — a second workspace
  cannot read, reference, or run against another tenant's records over HTTP.
