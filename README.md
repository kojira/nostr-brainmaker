# 🧠 Nostr 脳内メーカー (nostr-brainmaker)

A fully static, client-side web app that takes a **Nostr** identity
(`npub` / hex pubkey / `nprofile`), fetches that author's posts from the last
N days directly from Nostr relays in the browser, classifies each post with a
trained **1-character classifier**, and renders a **1 post = 1 glyph**
brain-maker image you can download as PNG.

No backend. No server. Everything runs in the browser and deploys to GitHub Pages.

**Live demo:** https://kojira.github.io/nostr-brainmaker/

![screenshot](docs/screenshot.png)

## Features

- Accepts **npub**, **hex pubkey**, or **nprofile** (relay hints in an nprofile are used).
- **NIP-07**: one-click "NIP-07 から取得" fetches your public key from a browser
  extension (Alby, nos2x, …) via `window.nostr.getPublicKey()` and fills the input.
- Fetches `kind:1` notes from the last 3 / 7 / 14 / 30 days via `nostr-tools` `SimplePool`.
- Learned **1 post = 1 character** classification with argmax label selection.
- Repeated labels are rendered as repeated glyphs; identical characters are never collapsed into one representative glyph.
- Glyph positions are random inside the brain outline, without semantic placement.
- Glyph size is fixed by default and only shrinks uniformly when there are many posts.
- Glyph color is fixed per classifier label.
- Shows exactly **what was fetched and from which relays**.
- One-click **PNG export**.
- Deep links: `?npub=npub1...` auto-runs on load.

## Stack

- **Vite** (vanilla JS, no framework) — builds to a static bundle.
- **nostr-tools** — `nip19` decoding + relay querying.
- **Canvas 2D** — rendering and PNG export.
- **Vitest** — unit tests for classifier and rendering helpers.

## Architecture

```
index.html          # markup + mount points
src/
  main.js           # UI wiring: input → fetch → classify → render
  nostr.js          # resolveInput() + fetchRecentNotes() + fetchProfile()  (network)
  brain.js          # renderBrainFromPosts() canvas drawing + exportCanvas()
  classifier/       # model manifest / label map / normalization / inference adapter
  style.css
tests/
  classifier-adapter.test.js
  brain.test.js
.github/workflows/
  deploy.yml        # CI: test + build + deploy to GitHub Pages
vite.config.js      # base path = /<repo>/ for Pages
```

Data flow: `resolveInput` decodes the identity → `fetchRecentNotes` queries
relays for the author's recent `kind:1` events → `classifier.classifyPosts()`
returns `perPost` predictions → `renderBrainFromPosts()` draws one glyph per
classified post to a canvas.

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
npm run export:dataset           # merge real + synthetic into data/production/training/dataset.jsonl
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

### Synthetic backfill (逆生成)

When some labels stay underrepresented no matter how long the pipeline runs
(e.g. 虜/犬/猫 with only a handful of real posts), you can reverse-generate
Japanese Nostr-style posts with Gemini for just the deficit labels instead of
waiting for more collection:

```bash
npm run synthesize -- --dry-run                 # show per-label deficits + plan, no API calls
GEMINI_API_KEY=... npm run synthesize -- --min 50
GEMINI_API_KEY=... npm run synthesize -- --labels 虜,犬,猫,抱,泣,妬,仏,癒,嘘,羨 --min 50
```

Each generated post is round-trip **verified** by default: it is re-labeled with
the production labeling prompt and kept only if the model returns the target
label (disable with `--no-verify`). Output is kept strictly separate from real
Nostr data under `data/production/labels/` — `synthetic-labels.json`,
`synthetic-checkpoint.jsonl` (crash-safe resume log), and
`synthesis-report.json` — all gitignored. Synthetic records are always
distinguishable (`synthetic: true`, `syn-` event_id prefix, `pubkey:
"synthetic"`, `source: "synthetic:<model>"`). `npm run report:labels` shows a
separate `synth` column plus a combined total per label once synthetic data
exists. Treat synthetic data as a last-resort backfill and keep it flagged in
training.

### Training dataset export

`npm run export:dataset` builds the JSONL that training consumes by merging the
real labeling artifacts (`gemini-labels.json` + `checkpoint.jsonl`) and the
synthetic backfill artifacts (`synthetic-labels.json` +
`synthetic-checkpoint.jsonl`) into gitignored files under
`data/production/training/`:

- `dataset.jsonl` — one record per training example with `content`, `label`,
  `label_id`, `source_type`, `event_id`, `source_model`, `source`, and the
  carry-through metadata needed to audit provenance.
- `summary.json` — total count, real/synthetic breakdown, and per-label counts.
- `manifest.json` — exact input/output paths plus export stats.

Duplicate `event_id`s are overwritten by the later source in the merge order
(`*.json` first, `*.jsonl` checkpoint second), and missing `event_id`s receive a
deterministic fallback id so the export stays usable. The `finetune_smoke`
helpers default to this exported dataset path.

End-to-end training flow from this export:

```bash
npm run export:dataset                           # full input for every training step
python3 finetune_smoke/prepare_subset.py        # optional: build tiny smoke subset
python3 finetune_smoke/train_smoke.py           # optional: prove the loop on the subset
python3 finetune_smoke/train_production.py      # full training on data/production/training/dataset.jsonl
```

`train_production.py` writes checkpoints and metadata under
`finetune_smoke/train-output/` by default. That directory is gitignored.

Outputs land under `data/production/` (raw notes, approved set, labels, raw
Gemini logs, reports). See [docs/production-pipeline.md](docs/production-pipeline.md)
for all options, resume/checkpointing, and the second-pass refinement, and
[docs/1char-classification-design.md](docs/1char-classification-design.md) for
the label-set design.

## 学習済み分類器の統合（ブラウザ）

ブラウザアプリの主経路は **学習済み 1文字分類器必須** です。`src/classifier/` の初期化に失敗した場合、アプリは旧ヒューリスティック経路へ fallback せず、明示エラーで停止します。

- **主返り値は `perPost`**: `classifier.classifyPosts()` は 1投稿ごとの `{ id, char, prob }` を返し、主描画はその配列をそのまま使用します。
- **argmax のみ**: 閾値は使いません。各投稿は argmax で 1 文字に決定されます。
- **成果物の置き場所**: エクスポートしたモデル一式は `public/models/1char/`（Vite が `/models/1char/` で配信）に置きます。アプリは実行時にここの `manifest.json` を fetch します。transformers.js 規約に従い、モデルは `onnx/model.onnx`、tokenizer 設定は直下に置きます。
- **エクスポート＆デプロイ（ワンコマンド・ハンドオフ）**: 学習 run からブラウザ成果物とマニフェストを一括生成・検証します。

  > **ブロッカー**: 学習済み run-dir（HF チェックポイント: `config.json` + `model.safetensors`）が必須です。リポジトリにはコミットされていないため、まず `finetune_smoke/train_production.py` で生成してください。生成される ONNX / tokenizer バイナリは gitignore 対象で、**コミットしません**（追跡されるのは `public/models/1char/README.md` と `manifest.example.json` のみ）。

  ```bash
  # 追加依存（export 専用）を入れてから、検証 → export → manifest → ファイル検証を1コマンドで
  pip install -r finetune_smoke/requirements-export.txt
  npm run model:deploy -- <train-output-run-dir>            # fp32（既定）
  npm run model:deploy -- <train-output-run-dir> --quantize # int8（manifest dtype q8）
  npm run model:deploy -- <train-output-run-dir> --dry-run  # 実行せず手順だけ表示
  npm run model:deploy -- <train-output-run-dir> --skip-export # 既存 export の manifest 再生成のみ
  ```

  `model:deploy` は内部で `finetune_smoke/export_onnx.py` と `scripts/build-model-manifest.js` を呼び、最後に必須ファイル（`manifest.json` / `onnx/model*.onnx` / `tokenizer.json` / `config.json`）が `public/models/1char/` に揃ったかを検証します。個別に実行したい場合:

  ```bash
  python3 finetune_smoke/export_onnx.py --run-dir <train-output-run-dir> [--quantize]
  npm run model:manifest <train-output-run-dir>
  #   量子化版を使う場合: npm run model:manifest <run-dir> -- --dtype q8 --model-file onnx/model_quantized.onnx
  ```

詳細は [docs/1char-classification-design.md](docs/1char-classification-design.md) の §9「ブラウザ推論デプロイ計画」を参照してください。

## Deploy (GitHub Pages)

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`):

1. Push to `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The workflow runs tests, builds with `BASE_PATH=/<repo-name>/`, verifies the required model artifacts under `dist/models/1char/`, and publishes `dist/`.

The published URL is `https://<user>.github.io/<repo-name>/`.

## Notes & limitations

- The browser app no longer has a heuristic word-analysis path. If model
  artifacts are missing or broken, rendering stops with an explicit error.
- Relay availability varies; if no notes are found, try a different period or an
  identity with public relay activity. Default relays:
  `yabu.me`, `r.kojira.io`, `x.kojira.io`.
- All processing is local; nothing is sent to any server other than the public
  Nostr relays you query.

## License

MIT
