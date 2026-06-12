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

## 1. Create the subset (local)

Run from the repo root. Defaults read
`data/production/labels/checkpoint.jsonl` and `data/production/label_map.json`,
and write `finetune_smoke/data/subset.jsonl` (+ `subset_meta.json`).

```bash
python3 finetune_smoke/prepare_subset.py
```

Tune size if you like:

```bash
python3 finetune_smoke/prepare_subset.py --per-label 2 --max-total 64
```

Copy the subset to the remote machine, e.g.:

```bash
scp finetune_smoke/data/subset.jsonl finetune_smoke/data/subset_meta.json \
    user@a100-host:/path/to/finetune_smoke/data/
```

(Or copy the whole `finetune_smoke/` directory and run `prepare_subset.py`
remotely if the data is also present there.)

## 2. Run the smoke train (remote Linux / A100)

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

## 3. What success looks like

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
