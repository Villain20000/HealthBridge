---
name: Bug report
about: Report a defect with a synthetic reproduction
labels: [bug]
---

## What happened

<!-- What you expected vs. what occurred. -->

## Reproduction

Include the exact command(s). Use **synthetic** data only — never paste real patient data.

```bash
node packages/cli/dist/bin.js ...
```

Minimal input (synthetic):

```csv
...
```

## Environment

Output of `node packages/cli/dist/bin.js doctor --json`:

```json
{ ... }
```

## Impact

- [ ] Wrong output written (data corruption)
- [ ] Data silently dropped
- [ ] PHI visible where it should be redacted
- [ ] Crash / error
- [ ] UX / documentation

## Anything else

<!-- Trace excerpt (already redacted), screenshots, related issues. -->
