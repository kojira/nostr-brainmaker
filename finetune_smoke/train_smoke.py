#!/usr/bin/env python3
"""Minimal training smoke test for the 1-char Nostr post classifier.

Trains cl-nagoya/ruri-v3-pt-30m (a ModernBERT encoder) with a fresh
classification head for a handful of steps on the tiny subset produced by
prepare_subset.py. The point is NOT accuracy -- it is to prove the full loop
works on the target machine:

    dataset load -> tokenize -> forward -> loss -> backward -> checkpoint save

Each of those stages prints an explicit, greppable confirmation line so a CI or
human watching the logs can verify the smoke test actually exercised the path.
"""

import argparse
import json
import os
import sys


def log(stage, msg):
    print(f"[SMOKE][{stage}] {msg}", flush=True)


def load_subset(path):
    texts, labels = [], []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            content = rec.get("content")
            label_id = rec.get("label_id")
            if not isinstance(content, str) or label_id is None:
                continue
            texts.append(content)
            labels.append(int(label_id))
    return texts, labels


def read_num_labels(subset_path, labels):
    """Prefer the meta file written by prepare_subset.py; fall back to data."""
    meta_path = os.path.join(os.path.dirname(subset_path), "subset_meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            n = json.load(f).get("num_labels")
            if isinstance(n, int) and n > 0:
                return n
    return max(labels) + 1


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subset", default=os.path.join(here, "data", "subset.jsonl"))
    ap.add_argument("--model", default="cl-nagoya/ruri-v3-pt-30m")
    ap.add_argument("--output-dir", default=os.path.join(here, "output"))
    ap.add_argument("--max-steps", type=int, default=10)
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--max-length", type=int, default=128)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    # Imports are inside main so --help works without the heavy deps installed.
    import torch
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
    )

    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log("ENV", f"torch={torch.__version__} device={device} cuda={torch.cuda.is_available()}")
    import transformers

    log("ENV", f"transformers={transformers.__version__}")

    # 1) DATASET LOAD ---------------------------------------------------------
    if not os.path.exists(args.subset):
        log("FATAL", f"subset not found: {args.subset} (run prepare_subset.py first)")
        sys.exit(1)
    texts, labels = load_subset(args.subset)
    if not texts:
        log("FATAL", "subset is empty")
        sys.exit(1)
    num_labels = read_num_labels(args.subset, labels)
    log("DATASET", f"loaded {len(texts)} examples, num_labels={num_labels} from {args.subset}")

    # Model + tokenizer -------------------------------------------------------
    log("MODEL", f"loading tokenizer + model {args.model} (num_labels={num_labels})")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model, num_labels=num_labels
    )
    model.to(device)
    model.train()
    log("MODEL", f"loaded; param count={sum(p.numel() for p in model.parameters()):,}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    # Training loop -----------------------------------------------------------
    step = 0
    n = len(texts)
    bs = args.batch_size
    last_loss = None
    while step < args.max_steps:
        start = (step * bs) % n
        batch_texts = [texts[(start + i) % n] for i in range(bs)]
        batch_labels = [labels[(start + i) % n] for i in range(bs)]

        # 2) TOKENIZE ---------------------------------------------------------
        enc = tokenizer(
            batch_texts,
            padding=True,
            truncation=True,
            max_length=args.max_length,
            return_tensors="pt",
        ).to(device)
        label_tensor = torch.tensor(batch_labels, dtype=torch.long, device=device)
        if step == 0:
            log("TOKENIZE", f"input_ids shape={tuple(enc['input_ids'].shape)} (batch x seq_len)")

        # 3) FORWARD + 4) LOSS ------------------------------------------------
        optimizer.zero_grad()
        outputs = model(**enc, labels=label_tensor)
        loss = outputs.loss
        if step == 0:
            log("FORWARD", f"logits shape={tuple(outputs.logits.shape)} (batch x num_labels)")
        log("LOSS", f"step {step}: loss={loss.item():.4f}")

        # 5) BACKWARD ---------------------------------------------------------
        loss.backward()
        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if step == 0:
            log("BACKWARD", f"backward + optimizer.step ok (grad_norm={grad_norm:.4f})")

        last_loss = loss.item()
        step += 1

    log("TRAIN", f"completed {step} steps, final loss={last_loss:.4f}")

    # 6) CHECKPOINT SAVE ------------------------------------------------------
    os.makedirs(args.output_dir, exist_ok=True)
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    saved = sorted(os.listdir(args.output_dir))
    log("SAVE", f"checkpoint written to {args.output_dir}")
    log("SAVE", f"files: {saved}")

    log("DONE", "smoke test passed: load+tokenize+forward+loss+backward+save all confirmed")


if __name__ == "__main__":
    main()
