# finetune_smoke — A100 smoke test for the 1-char classifier

A tiny, self-contained smoke test that proves the full training loop works for
the 1-character Nostr post classifier before committing to a real run.

It trains `cl-nagoya/ruri-v3-pt-30m` (a ModernBERT encoder) with a fresh
classification head for a handful of steps on a tiny subset of the existing
labeled data. **It is not meant to produce a useful model** — only to confirm,
on the target machine, that every stage runs:

```
dataset load -> tokenize -> forward -> loss -> backward -> checkpoint save
```

Each stage prints a greppable `[SMOKE][STAGE]` line so you can verify the path
end-to-end in the logs.

## Files

- `prepare_subset.py` — builds a tiny `data/subset.jsonl` from the labeled
  dataset. Run this locally (where the data lives).
- `train_smoke.py` — the minimal trainer. Run this on the remote box.
- `requirements.txt` — pinned deps. `transformers==4.48.3` is required for
  ModernBERT (ruri-v3), and `torch` is pinned **exactly** to `2.3.1` (see below).

**What runs where:** steps 1–2 (export + subset) are local and need no ML
deps — `prepare_subset.py` is pure-stdlib Python, and `train_smoke.py --help`
also works without torch/transformers installed. Steps 3–4 (smoke train, full
train) need `requirements.txt` installed and are meant for the A100 box (or a
container with the same pins); on a torch-less local machine the most you can
verify is the subset/schema/`--help` level.

## 1. Export the full training dataset (local)

Both smoke and full production training start from the same exported input:
`data/production/training/dataset.jsonl`.

Run from the repo root:

```bash
npm run export:dataset
```

This writes the full training JSONL under `data/production/training/` and is
the default `--dataset` for both `prepare_subset.py` and
`train_production.py`.

## 2. Create the subset for the smoke run (local)

After export, build a tiny subset from that full dataset. Defaults read
`data/production/training/dataset.jsonl` and `data/production/label_map.json`,
and write `finetune_smoke/data/subset.jsonl` (+ `subset_meta.json`).

```bash
python3 finetune_smoke/prepare_subset.py
```

Selection is **deterministic and coverage-first**: every label present in the
dataset gets one example (in ascending `label_id` order) before any label gets
a second, up to `--per-label` each and `--max-total` overall. So `--max-total`
truncates duplicates, not label coverage, and re-running against the same
dataset reproduces the subset byte-for-byte. With the current production
export (47 labels) the defaults yield 64 rows covering **all 47 labels**. If
`--max-total` is too small to cover every dataset label, the script prints a
`WARNING` to stderr listing the dropped labels.

`subset_meta.json` carries the handoff/debugging context the remote box needs:
`num_labels` (read by the trainers), `count`, `labels_covered`, per-label
counts, any uncovered labels, the selection parameters, and the absolute
source dataset/label-map paths. Check `labels_covered` matches expectations
before copying anything to the A100.

Tune size if you like:

```bash
python3 finetune_smoke/prepare_subset.py --per-label 2 --max-total 64
```

Content is truncated to `--max-chars` (default 512) characters per example.

Copy the subset to the remote machine, e.g.:

```bash
scp finetune_smoke/data/subset.jsonl finetune_smoke/data/subset_meta.json \
    user@a100-host:/path/to/finetune_smoke/data/
```

(Or copy the whole `finetune_smoke/` directory and run `prepare_subset.py`
remotely if the data is also present there.)

## 3. Run the smoke train (remote Linux / A100)

```bash
cd /path/to/finetune_smoke        # or the repo root
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

python3 train_smoke.py
```

Useful flags (all optional, defaults are intentionally tiny):

```bash
python3 train_smoke.py \
  --subset data/subset.jsonl \
  --model cl-nagoya/ruri-v3-pt-30m \
  --output-dir output \
  --max-steps 10 \
  --batch-size 4 \
  --max-length 128
```

## 4. Run the full production train

Once the smoke run is validated, point the real trainer at the exported full
dataset. Run from the repo root so the default paths resolve as-is:

```bash
python3 finetune_smoke/train_production.py
```

Typical explicit invocation:

```bash
python3 finetune_smoke/train_production.py \
  --dataset data/production/training/dataset.jsonl \
  --label-map data/production/label_map.json \
  --output-dir finetune_smoke/train-output/run-$(date +%Y%m%d-%H%M%S)
```

The default output location is `finetune_smoke/train-output/run-<timestamp>`.
`finetune_smoke/.gitignore` excludes `train-output/`, `output/`, and
`data/`, so local run artifacts do not get committed.

## 5. What success looks like

The run should end with lines like:

```
[SMOKE][DATASET]  loaded N examples, num_labels=47 ...
[SMOKE][TOKENIZE] input_ids shape=(4, ...) (batch x seq_len)
[SMOKE][FORWARD]  logits shape=(4, 47) (batch x num_labels)
[SMOKE][LOSS]     step 0: loss=...
[SMOKE][BACKWARD] backward + optimizer.step ok ...
[SMOKE][SAVE]     checkpoint written to output
[SMOKE][DONE]     smoke test passed: ... all confirmed
```

and an `output/` directory containing the saved checkpoint
(`config.json`, `model.safetensors`, tokenizer files).

## 6. Deploy the trained run to the browser (ONNX export)

Once `train_production.py` has produced a real run-dir
(`finetune_smoke/train-output/run-<ts>/` with `config.json` + `model.safetensors`),
deploy it to the browser app's model directory in one command from the repo root:

```bash
# export-only extra deps (NOT in requirements.txt; install on the export box)
pip install -r requirements-export.txt        # from finetune_smoke/, or -r finetune_smoke/...

npm run model:deploy -- finetune_smoke/train-output/run-<ts>            # fp32 (default)
npm run model:deploy -- finetune_smoke/train-output/run-<ts> --quantize # int8 → manifest dtype q8
npm run model:deploy -- finetune_smoke/train-output/run-<ts> --dry-run  # print the plan only
npm run model:deploy -- finetune_smoke/train-output/run-<ts> --skip-export # rebuild manifest only
```

`model:deploy` (`scripts/deploy-browser-model.js`) drives the whole flow: it
validates the run-dir, runs `export_onnx.py`, builds `manifest.json` via
`scripts/build-model-manifest.js`, and verifies the browser asset set landed in
`public/models/1char/`.

**Blocker:** there is **no trained run-dir committed in this repo**, so this step
is gated on running step 4 first. **Nothing here is committed:** the exported
ONNX/tokenizer binaries under `public/models/1char/` are gitignored (only that
dir's `README.md` and `manifest.example.json` are tracked).

Equivalent manual steps (what `model:deploy` runs for you):

```bash
python3 export_onnx.py --run-dir train-output/run-<ts> [--quantize]   # from finetune_smoke/
node scripts/build-model-manifest.js finetune_smoke/train-output/run-<ts>
#   quantized: node scripts/build-model-manifest.js <run-dir> --dtype q8 --model-file onnx/model_quantized.onnx
```

### Known-good export environment (this Mac)

The ONNX export is confirmed working on this machine with a **dedicated Python
3.13 venv** at `finetune_smoke/.venv-export`. `model:deploy` auto-detects it:
when neither `--python` nor `$PYTHON` is given, it uses
`finetune_smoke/.venv-export/bin/python` if that path exists (else falls back to
`python3`).

**Why a dedicated venv:** the default system `python3` on this Mac is **3.9.6**,
which is too old for `onnxruntime 1.20.1` (it needs Python **>=3.10**). The
`.venv-export` (Python 3.13) is the known-good export env.

Confirmed working package set in `.venv-export`:

- torch 2.6.0
- transformers 4.48.3
- tokenizers 0.21.0
- safetensors 0.4.5
- optimum[onnxruntime] 1.24.0
- onnx 1.17.0
- onnxruntime 1.20.1
- onnxscript
- protobuf 7.x

With this env, against e.g. run-dir
`finetune_smoke/train-output/run-20260612-2318-prod`, `export_onnx.py` succeeds
and writes `public/models/1char/onnx/model.onnx` (the resulting ONNX reports
**opset 14**).

## Notes

- The classifier head is sized from `label_map.json` (46 labels + the `qa`
  "分類不能" bucket → `num_labels=47`). The trainer reads this from
  `subset_meta.json` if present, otherwise infers it from the data.
- First run downloads the model weights from the Hugging Face Hub; the box
  needs network access (or a pre-populated `HF_HOME` cache).
- Runs on CPU too (slower); it auto-selects CUDA when available.
- **Why torch is pinned exactly to `2.3.1`:** a loose constraint like
  `torch>=2.2` lets pip resolve the newest available wheel. On a recent run that
  pulled `torch 2.12.0+cu130`, whose bundled CUDA 13 runtime could not
  initialize against the host's 560.xx driver, so training silently fell back to
  CPU. The exact pin matches the remote snapshot and keeps us on a CUDA 12 wheel
  the driver supports — don't loosen it without checking the host driver.
