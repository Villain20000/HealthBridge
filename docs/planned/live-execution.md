# Streaming and live execution — planned

**Status:** ⬜ not implemented · **Phase:** C/F/G · **UI today:** the debugger is explicitly
"stored traces, not live execution"; uploads and pipelines buffer.

## Why it matters

Hospital exports are large. Buffering a 2 GB CSV, or being unable to pause a run halfway, are
operational blockers rather than nice-to-haves.

## What exists today (verified)

- Uploads are streamed through the console proxy, but the API reads the body into memory before
  storage (`express.raw` with `maxUploadBytes`).
- CSV parsing accumulates the canonical envelope; results and traces are bounded by
  `maxStoredResultBytes` / `maxTracesPerRun`.
- Runs are queued (durable `run_jobs`) and cancellable, including across replicas (ADR-0004).
- Live *progress* is real (SSE); live *inspection* is not — traces are read after the fact.

## What is missing

- Streaming upload to storage (hash while writing, reject on limit without buffering).
- Streaming CSV/NDJSON parse with a bounded record buffer.
- Checkpoint/resume semantics for a run, and a pause that is not a cancel.
- A "live" mode in the debugger, which requires the above plus a streaming trace feed.

## Proposed design

1. `POST /assets` accepts a stream; the adapter hashes (`sha256`) and writes to a temp key, then
   moves it into content-addressed storage. Response unchanged: `{asset}` with checksum.
2. Adapters gain an optional `parseStream(asyncIterable)`; the run service consumes records in
   windows and flushes results/traces incrementally.
3. Pause = stop after the current window, persisting `cursor` in the run row; resume reads it.
4. Only then may the UI label anything "live". Until then the wording stays "stored traces".

## Acceptance criteria

- Memory stays flat while uploading and transforming a file much larger than the container limit.
- A cancelled run releases its storage temp file and its queue lease.
- Pause/resume produces byte-identical output to an uninterrupted run (reproducibility test).
- Any screen marked "live" has a test proving events arrive while the run is still running.

## Risks / non-goals

- Streaming changes error semantics: a malformed tail is discovered after side effects exist.
  The run must fail loudly with the byte offset.
- Pausable execution is Phase G; streaming is Phase C/F. Do not conflate them.
- No distributed checkpointing across replicas in v1 of this design.
