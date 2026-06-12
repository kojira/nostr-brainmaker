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
- `checkpoint.jsonl` — resume state, flushed after every item.
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
