# 🧠 Nostr 脳内メーカー (nostr-brainmaker)

A fully static, client-side web app that takes a **Nostr** identity
(`npub` / hex pubkey / `nprofile`), fetches that author's posts from the last
N days directly from Nostr relays in the browser, analyzes the text, and renders
a **脳内メーカー (brain-maker)** style image you can download as PNG.

No backend. No server. Everything runs in the browser and deploys to GitHub Pages.

**Live demo:** https://kojira.github.io/nostr-brainmaker/

![screenshot](docs/screenshot.png)

## Features

- Accepts **npub**, **hex pubkey**, or **nprofile** (relay hints in an nprofile are used).
- **NIP-07**: one-click "NIP-07 から取得" fetches your public key from a browser
  extension (Alby, nos2x, …) via `window.nostr.getPublicKey()` and fills the input.
- Fetches `kind:1` notes from the last 3 / 7 / 14 / 30 days via `nostr-tools` `SimplePool`.
- Heuristic tokenization (Latin words + Japanese runs & bigrams) with a stopword list and frequency analysis.
- Words placed inside a hand-drawn brain, sized by frequency and colored by category
  (愛情 / 仕事 / 欲望 / 遊び / 悩み / その他).
- Shows exactly **what was fetched and from which relays**.
- One-click **PNG export**.
- Deep links: `?npub=npub1...` auto-runs on load.

## Stack

- **Vite** (vanilla JS, no framework) — builds to a static bundle.
- **nostr-tools** — `nip19` decoding + relay querying.
- **Canvas 2D** — rendering and PNG export.
- **Vitest** — unit tests for the text-analysis helpers.

## Architecture

```
index.html          # markup + mount points
src/
  main.js           # UI wiring: input → fetch → analyze → render
  nostr.js          # resolveInput() + fetchRecentNotes() + fetchProfile()  (network)
  analyze.js        # cleanText / tokenize / countFrequencies / topTerms /
                    # categorize / buildBrainModel  (pure, fully tested)
  brain.js          # renderBrain() canvas drawing + exportCanvas()
  style.css
tests/
  analyze.test.js   # unit tests for the pure helpers
.github/workflows/
  deploy.yml        # CI: test + build + deploy to GitHub Pages
vite.config.js      # base path = /<repo>/ for Pages
```

Data flow: `resolveInput` decodes the identity → `fetchRecentNotes` queries
relays for the author's recent `kind:1` events → their `content` is concatenated
and passed to `buildBrainModel` → `renderBrain` draws the result to a canvas.

The analysis layer (`analyze.js`) is intentionally free of DOM and network code
so it can be unit-tested in Node.

## Setup

```bash
npm install
```

## Develop

```bash
npm run dev      # local dev server (http://localhost:5173)
```

## Test

```bash
npm test         # vitest run
```

## Build

```bash
npm run build    # outputs static site to ./dist
npm run preview  # preview the production build
```

For a custom base path (e.g. custom domain at root):

```bash
BASE_PATH=/ npm run build
```

## Production labeling pipeline

Offline Node scripts (separate from the browser app) to build a labeled dataset:
collect/curate Japanese `kind:1` notes from multiple relays, then label them with
the Gemini API into the 46-label "1-character" set.

```bash
npm run collect              # collect raw notes → filter/sample → data/production/approved-notes.json
npm run collect -- --dry-run # print the plan, no network

export GEMINI_API_KEY=...    # or put it in a .env file at the repo root
npm run label                # label approved notes → data/production/labels/
npm run label -- --dry-run   # validate config, no API calls
```

### Streaming pipeline (collect → filter → queue → parallel label)

The serial `collect`/`label` commands above still work. For building a *balanced*
dataset there is also a single streaming pipeline that keeps feeding notes through
a queue into parallel labeling workers **until every one of the 46 labels has at
least `--min` (default 50) labeled items**:

```bash
npm run report:labels            # per-label counts, labels still below target (no network)
npm run pipeline -- --dry-run    # plan + fresh-run counts (use --seed-existing-labels to reuse existing labels)
npm run pipeline                 # offline: replay data/production/raw/raw-notes.jsonl
npm run pipeline -- --allow-network   # also fetch fresh notes from relays when raw runs dry
```

By default each run is a **fresh** count: completion counts start at zero. It still
reads `labels/checkpoint.jsonl` (a labeling progress/resume log — **not** a model
checkpoint) and `gemini-labels.json` to dedup already-seen `event_id`s (never
relabeled) and to preserve their items in the rebuilt output, but those existing
labels do **not** seed the `--min` targets. Pass `--seed-existing-labels` to opt
into reusing them as initial counts (resume a prior run's progress). It **never
caps or discards** items once a label passes the target — downsampling is a
separate later step. The producer stops fetching once all labels reach the target;
in-flight/queued items are still labeled. Progress reporting shows raw fetched,
language-pass, queue length, per-label counts, labels below target, and labeling
success/failure. Outputs extend (not overwrite) `gemini-labels.json`,
`labeling-report.json`, and add `pipeline-report.json`. Key options:
`--min 50`, `--concurrency 5`, `--rpm 60`, `--raw <jsonl>`, `--allow-network`,
`--seed-existing-labels` (default OFF), `--resume` (default ON), `--dry-run`.

Outputs land under `data/production/` (raw notes, approved set, labels, raw
Gemini logs, reports). See [docs/production-pipeline.md](docs/production-pipeline.md)
for all options, resume/checkpointing, and the second-pass refinement, and
[docs/1char-classification-design.md](docs/1char-classification-design.md) for
the label-set design.

## Deploy (GitHub Pages)

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`):

1. Push to `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The workflow runs tests, builds with `BASE_PATH=/<repo-name>/`, and publishes `dist/`.

The published URL is `https://<user>.github.io/<repo-name>/`.

## Notes & limitations

- Japanese tokenization is heuristic (no morphological analyzer in the browser),
  so "words" are whitespace/punctuation chunks plus Japanese character runs and bigrams.
  It's tuned to be *fun and usable*, not linguistically precise.
- Relay availability varies; if no notes are found, try a different period or an
  identity with public relay activity. Default relays:
  `yabu.me`, `r.kojira.io`, `x.kojira.io`.
- All processing is local; nothing is sent to any server other than the public
  Nostr relays you query.

## License

MIT
