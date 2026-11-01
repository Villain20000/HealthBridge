# Hardening, benchmarks and release automation — shipped

**Status:** ✅ landed (security suite, benchmarks, docs site, release automation) · **Phase:** F · **UI today:** none (no screen); this is
engineering work behind the API.

## Why it matters

Healthcare data brings hostile inputs (XXE, zip bombs, adversarial CSVs) and strict operational
expectations. "It works on the demo dataset" is not a security posture.

## What exists today (verified)

- Structural validators, upload/body/trace/stored-result limits, per-key rate limiting.
- Tenant isolation tests, audit trail, durable queue with lease recovery.
- Blocking production dependency audit (`npm run audit:prod`) on every CI run and before release packing. Any high/critical advisory fails unless it matches a dated exception in `scripts/audit-prod.mjs` (today: Angular 19, expires 2027-01-31). `--strict` ignores exceptions so the gate itself can be verified; the CI check **Production dependency audit** must be required in branch protection.
- No dedicated security suite, benchmarks or docs site is wired as a CI gate yet.

## What is missing

- Adversarial input suite per adapter: XXE, zip bombs, deeply nested JSON, huge cells, encodings.
- Benchmark harness with committed baselines (records/second, memory ceiling) and a regression gate.
- A docs site (the Markdown is good; there is no published site) and release automation
  (versioning, changelog enforcement, signed artifacts, container scanning).

## Proposed design

1. `packages/testkit` fixtures for hostile inputs; each adapter suite consumes them.
2. `scripts/bench.mjs` producing JSON; CI compares against `benchmarks/baseline.json` with a
   tolerance and fails on regression beyond it.
3. Static docs build (the existing Markdown) published from `main`, with link checking in CI.
4. Release workflow: tagged version, changelog gate, image build + SBOM + vulnerability scan.

## Acceptance criteria

- Hostile fixtures fail closed with a coded error and no partial object left behind.
- Benchmarks run on a fixed dataset size and are comparable run to run.
- Documentation links are checked; a broken link fails CI.
- A release cannot be cut without a changelog entry and a passing image scan.

## Risks / non-goals

- Benchmarks on shared CI runners are noisy; gate on relative change with generous tolerance.
- No penetration test is claimed by this work; external review remains separate.
