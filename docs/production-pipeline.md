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
If `labels/synthetic-labels.json` exists (see Stage 4 below, override with
`--synthetic-json`), the table gains `real` / `synth` / `total` columns and the
`need` status is computed against the combined total; both real-only and
real+synthetic below-target lists are printed. Without the synthetic file the
output is unchanged. `--json` / `--out <path>` emit the machine-readable
`pipeline-report.json` shape (real data only). No network or API calls.

## Training dataset export (`npm run export:dataset`)

`scripts/export-dataset.js` materializes the merged JSONL that downstream
training should consume. It reads:

- real: `data/production/labels/checkpoint.jsonl` + `gemini-labels.json`
- synthetic: `data/production/labels/synthetic-checkpoint.jsonl` +
  `synthetic-labels.json`
- label map: `data/production/label_map.json`

and writes gitignored outputs under `data/production/training/`:

- `dataset.jsonl` — one JSON object per training row with at least `content`,
  `label`, `label_id`, `source_type`, `event_id`, `source_model`, and `source`.
- `summary.json` — total rows, `real` / `synthetic` breakdown, per-label counts,
  duplicate-overwrite count, and missing-`event_id` assignments.
- `manifest.json` — exact input/output paths and export metadata.

Merge semantics:

1. `*.json` snapshots are loaded first, then `*.jsonl` checkpoint rows. Later
   records overwrite earlier ones for the same `event_id`, so the crash-safe
   append log remains the source of truth for the final row.
2. Missing or blank `event_id`s are replaced with deterministic fallback ids
   derived from `label + content`, so malformed upstream rows do not break the
   export.
3. Rows missing `content` or carrying an unknown label are skipped and counted in
   `summary.json`.

Usage:

```sh
npm run export:dataset
node scripts/export-dataset.js --data-dir data/production --out-dir data/production/training
```

The `finetune_smoke/` helpers default to
`data/production/training/dataset.jsonl`, so the training flow is:

```sh
npm run export:dataset                    # full production dataset JSONL
python3 finetune_smoke/prepare_subset.py # optional smoke subset (deterministic, covers every label)
python3 finetune_smoke/train_smoke.py    # optional smoke verification on the subset
python3 finetune_smoke/train_production.py
```

For the real run, the default input is already the exported full dataset, so an
explicit command looks like:

```sh
python3 finetune_smoke/train_production.py \
  --dataset data/production/training/dataset.jsonl \
  --label-map data/production/label_map.json \
  --output-dir finetune_smoke/train-output/run-$(date +%Y%m%d-%H%M%S)
```

`finetune_smoke/train-output/` is intentionally gitignored.

## Stage 4 — Synthetic backfill (`npm run synthesize`)

`scripts/synthesize.js` reverse-generates (逆生成) Japanese Nostr-style posts
with Gemini for labels that stay below the `--min` target, so the training set
can be balanced without waiting for more Nostr collection. **Use it as a
backfill of last resort**: synthetic text is model-written, not observed
behavior, and should stay clearly flagged (or be downweighted/excluded) in
training.

```sh
npm run synthesize -- --dry-run                   # deficits + plan, no API key needed
GEMINI_API_KEY=... npm run synthesize -- --min 50 # backfill every label below 50
GEMINI_API_KEY=... npm run synthesize -- --labels 虜,犬,猫 --min 50
```

What it does, per deficit label:

1. Counts existing data: real items (`gemini-labels.json` + `checkpoint.jsonl`
   ok-records, deduped by `event_id`) **plus** already-generated synthetic items
   (`synthetic-labels.json` + `synthetic-checkpoint.jsonl`). Effective
   `have = real + synthetic`, so re-running resumes instead of regenerating.
2. Builds a Japanese generation prompt asking for `--batch` short, diverse,
   casual SNS-style posts (1〜120字, no hashtag spam / usernames / URLs) whose
   dominant mental state is the target label. The prompt embeds the label's
   definition, the **full 46-label list** (the post must not read more naturally
   as any other label), and up to 3 real posts of that label as 文体の参考
   (style reference only — copying is forbidden).
3. Filters candidates: length bounds, `detectJapanese` (the repo's real
   `franc` + kana/CJK policy), and dedup by normalized-content hash against the
   batch, all real labeled items, and all prior synthetic items.
4. **Verification round-trip (default ON):** each surviving candidate is sent
   through the shared `labelOne` with the unmodified production labeling prompt.
   It is kept **only if the returned label equals the target label**; the
   verifier's `confidence`/`rationale` are stored and the record gets
   `verified: true`. With `--no-verify`, filtered candidates are kept directly
   (`verified: false`, confidence 0.9).
5. Appends each accepted record to `labels/synthetic-checkpoint.jsonl`
   immediately (crash-safe; an interrupted run resumes from those counts), then
   loops generation rounds until the label reaches the target or `--max-rounds`
   is hit (a warning logs how many items are still missing — nothing is silently
   capped).

### Flags

| flag | default | meaning |
| --- | --- | --- |
| `--labels 虜,犬,猫` | (auto) | restrict to these labels; default = every label below `--min` |
| `--min 50` | `50` | target per label (real + synthetic) |
| `--batch 10` | `10` | posts requested per generation call |
| `--model` | `gemini-3.1-flash-lite` | Gemini model for generation **and** verification |
| `--rpm 60` | `60` | shared sliding-window rate limit across generation + verification calls |
| `--max-rounds 8` | `8` | per label: max generation rounds before giving up |
| `--no-verify` | verify ON | skip the labeling round-trip; keep filtered candidates as `verified: false` |
| `--dry-run` | off | print per-label deficits + planned rounds, no API calls (works without a key) |
| `--data-dir` | `data/production` | base dir; outputs go under `<data-dir>/labels/` |
| `--api-key-env` | `GEMINI_API_KEY` | env var (or `.env` key) holding the API key |

### Outputs (all gitignored, under `<data-dir>/labels/`)

- `synthetic-checkpoint.jsonl` — append-only resume log, one `{ok:true, ...record}`
  per accepted item, flushed immediately.
- `synthetic-labels.json` — `{generated_at, model, min, count, items[]}` with
  **all** synthetic records (previous runs included), rebuilt atomically.
- `synthesis-report.json` — `{generated_at, model, params, per_label:[{label,
  have_before, generated, verified_rejected, filter_rejected, have_after}],
  totals}`.

### How synthetic data stays separate from Nostr data

Synthetic records never touch `gemini-labels.json` / `checkpoint.jsonl`. They
live in their own files and are individually marked: `event_id` has a `syn-`
prefix (deterministic `contentHash` of the text), `pubkey` is `synthetic`,
`source` is `synthetic:<model>`, and they carry `synthetic: true` plus
`verified: true|false`. The schema is otherwise identical to real labeled
records, so downstream tooling can opt in by exporting a merged training JSONL
with `npm run export:dataset` — and can always filter synthetic data back out
via `source_type === "synthetic"` when needed.

## Stage 5 — Browser model deploy (`npm run model:deploy`)

After training produces a run-dir, this is the realistic operator path to put a
working classifier in front of the browser app. `scripts/deploy-browser-model.js`
drives the **whole** export→deploy flow as one command and verifies the result:

1. **validate** the run-dir — must be a real HF checkpoint (`config.json` +
   `model.safetensors` / `pytorch_model.bin`),
2. **export** ONNX + tokenizer + label_map into `public/models/1char/` via
   `finetune_smoke/export_onnx.py` (skippable with `--skip-export`),
3. **build** `public/models/1char/manifest.json` via
   `scripts/build-model-manifest.js`,
4. **verify** the browser asset set actually landed (required:
   `manifest.json`, `onnx/model*.onnx`, `tokenizer.json`, `config.json`;
   recommended: `tokenizer_config.json`, `special_tokens_map.json`,
   `label_map.json`).

```sh
# export-only extra deps (NOT in finetune_smoke/requirements.txt)
pip install -r finetune_smoke/requirements-export.txt

npm run model:deploy -- <train-output-run-dir>            # fp32 (default)
npm run model:deploy -- <train-output-run-dir> --quantize # int8 model, manifest dtype q8
npm run model:deploy -- <train-output-run-dir> --dry-run  # print the plan, touch nothing
npm run model:deploy -- <train-output-run-dir> --skip-export # rebuild manifest + verify only
```

Flags: `--quantize` (deploy `onnx/model_quantized.onnx` with `dtype q8`), `--fp32`
(explicit default), `--skip-export`, `--opset <n>` (default 14), `--python <bin>`
(default `$PYTHON` or `python3`), `--dry-run`.

**Blocker — a trained run-dir must exist.** There is **no run-dir committed in
this repo**, so actual ONNX generation is gated on first running
`finetune_smoke/train_production.py` (see "Training dataset export" above). Until
then `model:deploy` stops at step 1 with an actionable error, and the browser app
surfaces the classifier as unavailable (`classifier.available === false`).

**Runtime artifacts are committed for Pages.** The ONNX/tokenizer/manifest files
written under `public/models/1char/` are part of the deployed site; `.onnx`
binaries are tracked through Git LFS and the remaining runtime files are tracked
normally. This script updates local artifacts; commit them when you refresh the
deployed model.

The pure decision logic (arg parsing, fp32-vs-q8 artifact selection, the
verify file list) lives in `scripts/lib/deploy-browser-model.js` and is covered
by `tests/deploy-browser-model.test.js`.
