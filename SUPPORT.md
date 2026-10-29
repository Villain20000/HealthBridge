# Support

## Read first

- `README.md` — what actually works in this release
- `ROADMAP.md` — what is planned, and what is deliberately unsupported
- `docs/capability-matrix.md` — per-format status
- `docs/cli.md` — command and exit-code reference
- `docs/troubleshooting.md` — common failures

## Getting help

- **Questions and adapter requests** — open a [GitHub discussion](https://github.com/Villain20000/HealthBridge/discussions) or an [issue](https://github.com/Villain20000/HealthBridge/issues) using the feature template.
- **Bug reports** — use the bug template. Include `node packages/cli/dist/bin.js doctor --json` output and the smallest synthetic input that reproduces the problem.
- **Security issues** — report privately through the GitHub security advisory flow described in [SECURITY.md](SECURITY.md). Never post real patient data, credentials or production traces publicly.

## What maintainers will not do

- Debug issues that involve real patient data pasted into an issue. Reproduce with synthetic data and redact.
- Guarantee clinical correctness of a mapping, unit conversion or code translation. Validate against your own terminology and clinical governance.
- Provide regulatory or compliance sign-off.

## Before you file a bug

```bash
npm ci && npm run build && npm test
node packages/cli/dist/bin.js doctor
```

If `doctor` reports `degraded`, the cause is usually an unsupported Node.js version (doctor names the minimum) or a broken install.

## Maintainers

There is no separately maintained contact list yet, and this file does not name individual
maintainers. Maintainer contacts and the contributor list will be published together with
the public repository; until then, use the repository's issue tracker and discussions, and
see [CONTRIBUTING.md](CONTRIBUTING.md) for how to take part. Security reports must follow
[SECURITY.md](SECURITY.md), not a personal contact.
