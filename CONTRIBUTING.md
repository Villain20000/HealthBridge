# Contributing

Thanks for helping. This project optimises for *honest, verifiable* capability.

## Ground rules

1. **Never claim a capability the code does not have.** If you add an adapter, add its manifest, tests, `docs/capability-matrix.md` row and CLI listing in the same PR.
2. **No silent data loss.** Anything skipped, rejected or unmapped must appear in issues, `dataLoss` or `rejectedRecords`.
3. **No PHI in tests, traces, fixtures or logs.** Synthetic data only.
4. **No arbitrary code evaluation** in mappings. Extend the fixed transform set instead.
5. **Tests come with the code.** A PR without tests is not mergeable for engine code.

## Setup

```bash
git clone https://github.com/Villain20000/HealthBridge.git
cd HealthBridge
npm ci
npm run build
npm test           # node:test, offline
npx tsx examples/run-sdk-example.ts
node packages/cli/dist/bin.js doctor
```

Node.js >= 22 is required. No database, Redis or Docker is needed for engine/CLI/SDK work.

## Repository conventions

- TypeScript strict mode, `NodeNext` modules, ESM-style `.js` import specifiers.
- Packages under `packages/*` must stay dependency-light; the CLI must remain offline-capable.
- Adapters live behind `MedicalFormatAdapter` (`detect`/`score`, `inspect`, `parse`, `getManifest`, optional `health`).
- Parse problems that cannot be attached to a record go through `ParseContext.onIssue`.
- Traces are emitted only through `TraceCollector.emit` — do not hand-build trace objects.

## New adapter checklist

- [ ] `score()` returns calibrated confidence; most specific adapter wins
- [ ] capabilities + `status` + `limitations` in the manifest
- [ ] golden fixtures (synthetic) under `packages/adapters/test/fixtures/`
- [ ] contract tests: detect, inspect, parse, malformed input reporting
- [ ] envelope has checksum, source location and encoding
- [ ] capability matrix row + README/roadmap update
- [ ] documented trust boundary if it executes third-party code

## Commit and PR style

Conventional commits (`fix(trace): …`, `feat(cli): …`, `docs: …`). PR description must state: what changed, what was executed (`npm test` output), and known limitations. Use `.github/pull_request_template.md`.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
