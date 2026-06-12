# Production labeling pipeline — operator guide

A two-stage, reusable pipeline that (1) collects and curates Japanese Nostr
`kind:1` notes from multiple relays, and (2) labels them with the Gemini API
into the 46-label "1-character" set. See
[1char-classification-design.md](./1char-classification-design.md) for the label
design rationale.

Both scripts are plain Node ESM and require **no `ws` package** (Node 22 has a
global `WebSocket`). Run from the repo root.

## Environment setup

The labeler needs a Gemini API key, read from `GEMINI_API_KEY` (override with
`--api-key-env`). Either export it:

```sh
export GEMINI_API_KEY=...
```

…or put it in a `.env` file at the repo root (a minimal `KEY=VALUE` loader is
built in — **no dotenv dependency**). `.env` is gitignored.

```
GEMINI_API_KEY=your-key-here
```

## Stage 1 — collect

```sh
npm run collect            # full run
npm run collect -- --dry-run   # print the plan (relays, slices, targets), no network
```

What it does:

1. Splits the last `--window-days` into `--slice-days` chunks (newest first) and
   queries each relay **independently** with `{kinds:[1], since, until, limit}`,
   paging backwards by `until`. A slow/failing relay is logged and skipped — it
   never aborts the run.
2. Dedups raw notes by `event.id`, aggregating the relays each was seen on. Skips
   empty / mention-only notes and enforces `--raw-per-author-cap` during raw
   collection. Stops at `--raw-target`.
3. **Preserves every raw note** to `data/production/raw/raw-notes.jsonl`.
4. Filters + samples to the approved set:
   - near-duplicate removal by normalized-content hash (oldest kept as representative),
   - language detection (`franc` + kana/CJK ratios) — non-Japanese excluded,
   - spam/low-quality heuristics (too many URLs/hashtags, promo boilerplate,
     high-frequency boilerplate across authors),
   - diversity sampling to `--target` with per-author cap `--per-author-cap` via
     round-robin across authors (newest-first within author).

Key options (defaults): `--raw-target 7000`, `--target 2000`,
`--per-author-cap 10`, `--raw-per-author-cap 25`, `--window-days 45`,
`--slice-days 3`, `--query-limit 500`, `--relays <comma list>`,
`--out-dir data/production`, `--timeout-ms 8000`, `--max-pages 8`,
`--resume`, `--dry-run`.

Outputs (under `--out-dir`):

- `raw/raw-notes.jsonl` — preserved raw notes.
- `approved-notes.json` — `{pilot_name, source_relays, selection_policy, samples[]}`;
  `samples[]` contains approved + review items with a `review_status` field.
  The labeler consumes `review_status === 'approved'`.
- `collection-report.json` — counts, per-author stats, language breakdown, slices.
- `label_map.json` — the 46-label map (discoverable copy).

**Resume:** `--resume` loads the existing `raw-notes.jsonl` and skips re-fetching
ids already present (still merges relay observations).

## Stage 2 — label

```sh
npm run label                  # full run (refinement second pass ON)
npm run label -- --dry-run     # validate config + count todo, no API calls
npm run label -- --no-refine   # disable the second pass
```

What it does:

1. Loads `--input` (default `data/production/approved-notes.json`), selects
   `review_status === 'approved'`, applies `--limit`.
2. Builds the exact pilot prompt (`buildLabelingPrompt`) and calls Gemini with a
   `RateLimiter({rpm})` and bounded `--concurrency`. Transport errors (429/5xx/
   network) retry with exponential backoff + full jitter (honoring `Retry-After`).
   On HTTP success the output is schema- and label-validated; an invalid response
   triggers a fresh request up to `--max-retries`. Still-invalid → recorded as a
   failure (no label assigned).
3. **Second pass (refinement):** items with `confidence < --min-confidence` or
   `is_uncertain === true` are re-examined with `buildRefinementPrompt`, which
   tells the model its first guess and asks it to compare the 2-3 most plausible
   candidates before committing. Successful pass-2 results overwrite the item
   (`pass: 2`). Items still below threshold are counted as `needs_human_review`.

Key options (defaults): `--input data/production/approved-notes.json`,
`--out-dir data/production/labels`, `--model gemini-3.1-flash-lite`,
`--concurrency 5`, `--rpm 60`, `--limit 0`, `--min-confidence 0.6`,
`--refine` (default ON; disable with `--no-refine`), `--max-retries 5`,
`--api-key-env GEMINI_API_KEY`, `--resume` (default ON), `--dry-run`.

Outputs (under `--out-dir`):

- `gemini-labels.json` — `{model, label_set_version, count, failures, items[]}`.
- `gemini-labeling-log.jsonl` — **raw prompts + raw Gemini responses**, appended
  (preserved); pass-2 lines carry `"pass":2`.
- `gemini-labeling-failures.json` — `{count, items:[{event_id, reason, attempts}]}`.
- `checkpoint.jsonl` — labeling progress / resume log (a JSONL append of per-item
  labeling outcomes, **not** a model checkpoint), flushed after every item.
- `labeling-report.json` — label counts, confidence stats/buckets, uncertain
  count, pass-2 count, needs-human-review count.

**Resume / crash-safety:** the checkpoint is appended after each item. Re-running
with `--resume` (default) skips already-labeled `event_id`s. Raw inputs
(`raw/raw-notes.jsonl`) and raw Gemini logs (`gemini-labeling-log.jsonl`) are
always preserved, never overwritten.

## Rate-limit notes

`--rpm` caps requests over a sliding 60-second window across all concurrent
workers; `--concurrency` bounds simultaneous in-flight requests. Keep
`concurrency <= rpm`. The Gemini client also self-throttles on 429 via backoff
and `Retry-After`, so transient quota hits recover automatically.

## Stage 3 — Streaming balanced pipeline (`npm run pipeline`)

`scripts/pipeline.js` reframes collect+label as a single **producer → language
filter → bounded queue → parallel labeling workers** flow whose goal is coverage:
keep going **until all 46 labels have ≥ `--min` (default 50) labeled items**. The
older `collect`/`label` commands are unchanged; this is an additive command.

Design (reusable modules under `scripts/lib/`):

- `pipeline-state.js` — `PipelineState`: per-label counts, `seen` set (event_id),
  `recordLabeled` (handles relabel decrement), `labelsBelow(min)`, `isComplete(min)`.
  `PipelineState.fromCheckpoint(records, { countExisting })` reads existing
  `labels/checkpoint.jsonl` (a labeling progress/resume log, **not** a model
  checkpoint; last `ok:true` per `event_id` wins) and marks every attempted id
  `seen` so it is never relabeled. By default (`countExisting:false`) those
  existing records are preserved for output and dedup only and do **not** seed
  completion counts; with `--seed-existing-labels` they count toward the targets.
  The QA label `分類不能` is tracked
  separately and never gates completion.
- `async-queue.js` — `AsyncQueue` with backpressure (`highWaterMark`) and a
  `QUEUE_DONE` sentinel; multi-consumer safe.
- `raw-source.js` — `rawFileSource(path)` async-iterates the existing
  `raw/raw-notes.jsonl`; `relaySource(cfg)` streams fresh `kind:1` notes from
  relays (only with `--allow-network`); `concatSources(...)` chains them.
- `pipeline.js` (`runPipeline`) — the orchestrator. One producer pulls from the
  source, applies `detectJapanese` (the repo's real `franc`-based policy), drops
  non-Japanese and already-`seen` ids, and pushes survivors onto the queue;
  `--concurrency` workers pull and label via the shared `labelOne`
  (`scripts/lib/labeler.js`, extracted from `label.js`) with a `RateLimiter`.
  Workers label **every** item they dequeue (no capping/discarding); only the
  producer stops early once `isComplete(min)`.
- `pipeline-report.js` — `buildPipelineReport` / `renderProgress` for the
  reporting outputs.

Fresh run by default: completion counts start at **zero** every run. Existing
`checkpoint.jsonl` (a labeling progress/resume log — not a model checkpoint) and
`gemini-labels.json` are still read so their `event_id`s are marked `seen` (never
relabeled) and their items are preserved in the rebuilt output — but they do
**not** count toward the `--min` targets. Pass `--seed-existing-labels` to opt into
the old behavior where existing labels seed the completion counts (resume a prior
run's progress). Each labeled item is appended to `checkpoint.jsonl` and
`gemini-labeling-log.jsonl` as it completes; existing artifacts are never deleted.
After the run, `gemini-labels.json`, `labeling-report.json`, and the new
`pipeline-report.json` are rebuilt from the **full** (preserved existing + new)
state.

Progress/reporting surfaces: raw fetched, language-pass / language-excluded,
queue length, per-label counts, labels still below target, and labeling
success/failure counts.

### Count / report command (`npm run report:labels`)

`scripts/report-labels.js` reads `labels/checkpoint.jsonl` (and merges
`gemini-labels.json` if present) and prints a per-label table with `OK`/`need N`
status, the list of labels below target, the `分類不能` count, and totals.
`--json` / `--out <path>` emit the machine-readable `pipeline-report.json` shape.
No network or API calls.
