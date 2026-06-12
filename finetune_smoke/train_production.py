#!/usr/bin/env python3
"""Production training for the 1-char Nostr post classifier.

Trains a single-label text classifier on top of cl-nagoya/ruri-v3-pt-30m (a
ModernBERT encoder) using the full labeled checkpoint. Unlike train_smoke.py --
which runs a handful of hand-rolled steps purely to prove the loop works -- this
script uses the Hugging Face ``Trainer`` for a real run: proper train/val split,
periodic evaluation, checkpointing, and a reproducible record of how it was
launched.

Pipeline:

    load checkpoint.jsonl + label_map.json
        -> drop malformed rows
        -> deterministic train/val split (seed) keeping rare labels in train
        -> tokenize
        -> Trainer.train() with periodic eval + checkpoint save
        -> copy label_map.json + write train_command.sh + run_metadata.json

Every stage prints a greppable ``[TRAIN][STAGE]`` line so a human or CI watching
the logs can follow the run end-to-end.
"""

import argparse
import json
import os
import shutil
import sys
import time
from collections import Counter


def log(stage, msg):
    print(f"[TRAIN][{stage}] {msg}", flush=True)


def load_label_map(path):
    """Return (num_labels, id_to_char) from label_map.json.

    num_labels is derived as max label id + 1, including the optional ``qa``
    bucket, so the classification head is always wide enough for any label_id
    found in the data.
    """
    with open(path, "r", encoding="utf-8") as f:
        lm = json.load(f)

    ids = []
    id_to_char = {}
    for entry in lm.get("labels", []):
        if "id" in entry:
            ids.append(int(entry["id"]))
            id_to_char[int(entry["id"])] = entry.get("char", "")
    qa = lm.get("qa")
    if isinstance(qa, dict) and "id" in qa:
        ids.append(int(qa["id"]))
        id_to_char[int(qa["id"])] = qa.get("char", "")

    if not ids:
        raise ValueError(f"no label ids found in {path}")
    return max(ids) + 1, id_to_char


def load_records(path, num_labels):
    """Load (texts, labels) from checkpoint.jsonl, skipping malformed rows.

    A row is kept only if it has non-empty string ``content`` and an integer
    ``label_id`` within [0, num_labels). Everything else (blank lines, bad JSON,
    missing/out-of-range fields) is counted and skipped, never fatal.
    """
    texts, labels = [], []
    stats = Counter()
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                stats["blank"] += 1
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["bad_json"] += 1
                continue
            content = rec.get("content")
            label_id = rec.get("label_id")
            if not isinstance(content, str) or not content.strip():
                stats["no_content"] += 1
                continue
            if label_id is None:
                stats["no_label"] += 1
                continue
            try:
                label_id = int(label_id)
            except (TypeError, ValueError):
                stats["bad_label"] += 1
                continue
            if label_id < 0 or label_id >= num_labels:
                stats["out_of_range"] += 1
                continue
            texts.append(content.strip())
            labels.append(label_id)
            stats["kept"] += 1
    return texts, labels, stats


def split_train_val(labels, val_ratio, seed):
    """Deterministically split indices into (train_idx, val_idx).

    Stratified per label so val mirrors the label distribution. Labels with
    fewer than 2 examples cannot be split without starving either side, so they
    are kept entirely in train (val never sees an unseen-at-train label, and we
    never train on a label with zero examples). The split depends only on
    ``seed``, so re-running with the same seed reproduces it exactly.
    """
    import random

    by_label = {}
    for idx, lab in enumerate(labels):
        by_label.setdefault(lab, []).append(idx)

    rng = random.Random(seed)
    train_idx, val_idx = [], []
    rare_labels = []
    for lab in sorted(by_label):
        idxs = by_label[lab][:]
        if len(idxs) < 2:
            # Too few to split -- keep in train only.
            train_idx.extend(idxs)
            rare_labels.append(lab)
            continue
        rng.shuffle(idxs)
        # At least 1 to val, but always leave at least 1 in train.
        n_val = max(1, int(round(len(idxs) * val_ratio)))
        n_val = min(n_val, len(idxs) - 1)
        val_idx.extend(idxs[:n_val])
        train_idx.extend(idxs[n_val:])

    train_idx.sort()
    val_idx.sort()
    return train_idx, val_idx, rare_labels


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)

    default_ts = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    default_out = os.path.join(here, "train-output", f"run-{default_ts}")

    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--checkpoint",
        default=os.path.join(repo, "data", "production", "labels", "checkpoint.jsonl"),
        help="path to labeled checkpoint.jsonl",
    )
    ap.add_argument(
        "--label-map",
        default=os.path.join(repo, "data", "production", "label_map.json"),
        help="path to label_map.json",
    )
    ap.add_argument(
        "--output-dir",
        default=default_out,
        help="output dir for checkpoints + metadata (default: train-output/run-<timestamp>)",
    )
    ap.add_argument("--model", default="cl-nagoya/ruri-v3-pt-30m")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--train-batch-size", type=int, default=16)
    ap.add_argument("--eval-batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-length", type=int, default=256)
    ap.add_argument("--val-ratio", type=float, default=0.1,
                    help="fraction of each label's examples held out for validation")
    ap.add_argument("--save-steps", type=int, default=200)
    ap.add_argument("--eval-steps", type=int, default=200)
    ap.add_argument("--logging-steps", type=int, default=50)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="path to a checkpoint dir to resume training from "
             "(default: None = start fresh). Use the SAME --output-dir as the "
             "original run so Trainer state and checkpoints stay together.",
    )
    args = ap.parse_args()

    # Imports are inside main so --help works without the heavy deps installed.
    import numpy as np
    import torch
    from torch.utils.data import Dataset
    import transformers
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        Trainer,
        TrainingArguments,
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log("ENV", f"torch={torch.__version__} transformers={transformers.__version__}")
    log("ENV", f"device={device} cuda_available={torch.cuda.is_available()}")
    if device == "cuda":
        log("ENV", f"gpu={torch.cuda.get_device_name(0)}")

    # 1) LABEL MAP ------------------------------------------------------------
    if not os.path.exists(args.label_map):
        log("FATAL", f"label_map not found: {args.label_map}")
        sys.exit(1)
    num_labels, id_to_char = load_label_map(args.label_map)
    log("LABELS", f"num_labels={num_labels} from {args.label_map}")

    # 2) DATASET LOAD ---------------------------------------------------------
    if not os.path.exists(args.checkpoint):
        log("FATAL", f"checkpoint not found: {args.checkpoint}")
        sys.exit(1)
    texts, labels, stats = load_records(args.checkpoint, num_labels)
    log("DATASET", f"kept {stats['kept']} examples from {args.checkpoint}")
    skipped = {k: v for k, v in stats.items() if k != "kept"}
    if skipped:
        log("DATASET", f"skipped malformed/invalid rows: {dict(sorted(skipped.items()))}")
    if not texts:
        log("FATAL", "no usable examples after filtering")
        sys.exit(1)

    # 3) SPLIT ----------------------------------------------------------------
    train_idx, val_idx, rare_labels = split_train_val(labels, args.val_ratio, args.seed)
    log("SPLIT", f"train={len(train_idx)} val={len(val_idx)} (seed={args.seed}, val_ratio={args.val_ratio})")
    if rare_labels:
        rare_desc = ", ".join(f"{lab}:{id_to_char.get(lab, '?')}" for lab in rare_labels)
        log("SPLIT", f"{len(rare_labels)} label(s) with <2 examples kept in train only: {rare_desc}")
    if not val_idx:
        log("SPLIT", "WARNING: validation set is empty; periodic evaluation disabled")

    # 4) MODEL + TOKENIZER ----------------------------------------------------
    log("MODEL", f"loading tokenizer + model {args.model} (num_labels={num_labels})")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    # Force the eager attention path and float32. ModernBERT's flash/SDPA kernels
    # have produced NaN logits on some torch/transformers combos; eager + fp32 is
    # the conservative, numerically-safe choice (see train_smoke.py / README).
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=num_labels,
        attn_implementation="eager",
        torch_dtype=torch.float32,
    )
    log("MODEL", f"loaded; param count={sum(p.numel() for p in model.parameters()):,}")

    # 5) TOKENIZE -------------------------------------------------------------
    class TextClsDataset(Dataset):
        def __init__(self, idxs):
            self.idxs = idxs

        def __len__(self):
            return len(self.idxs)

        def __getitem__(self, i):
            j = self.idxs[i]
            enc = tokenizer(
                texts[j],
                padding=False,
                truncation=True,
                max_length=args.max_length,
            )
            enc["labels"] = labels[j]
            return enc

    train_ds = TextClsDataset(train_idx)
    val_ds = TextClsDataset(val_idx) if val_idx else None
    log("TOKENIZE", f"datasets built (max_length={args.max_length}); dynamic padding via collator")

    from transformers import DataCollatorWithPadding
    collator = DataCollatorWithPadding(tokenizer=tokenizer)

    def compute_metrics(eval_pred):
        logits, gold = eval_pred
        preds = np.argmax(logits, axis=-1)
        acc = float((preds == gold).mean())
        return {"accuracy": acc}

    # 6) TRAINER --------------------------------------------------------------
    os.makedirs(args.output_dir, exist_ok=True)
    do_eval = val_ds is not None
    targs = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.train_batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        learning_rate=args.lr,
        eval_strategy="steps" if do_eval else "no",
        eval_steps=args.eval_steps if do_eval else None,
        save_strategy="steps",
        save_steps=args.save_steps,
        logging_steps=args.logging_steps,
        seed=args.seed,
        # fp32 throughout for numerical safety with ModernBERT eager attention.
        fp16=False,
        bf16=False,
        report_to=[],
        dataloader_num_workers=2,
    )
    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=collator,
        compute_metrics=compute_metrics if do_eval else None,
    )

    log("TRAIN", f"starting: epochs={args.epochs} train_bs={args.train_batch_size} "
                 f"eval_bs={args.eval_batch_size} lr={args.lr}")
    if args.resume_from_checkpoint:
        if not os.path.exists(args.resume_from_checkpoint):
            log("FATAL", f"resume checkpoint not found: {args.resume_from_checkpoint}")
            sys.exit(1)
        log("TRAIN", f"resuming from checkpoint: {args.resume_from_checkpoint}")
        train_result = trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)
    else:
        log("TRAIN", "starting fresh (no --resume-from-checkpoint)")
        train_result = trainer.train()
    log("TRAIN", f"completed; train_loss={train_result.training_loss:.4f} "
                 f"steps={train_result.global_step}")

    final_metrics = {}
    if do_eval:
        final_metrics = trainer.evaluate()
        log("EVAL", f"final: {json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in final_metrics.items()}, ensure_ascii=False)}")

    # 7) SAVE FINAL MODEL -----------------------------------------------------
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    log("SAVE", f"final model + tokenizer written to {args.output_dir}")

    # 8) COPY LABEL MAP -------------------------------------------------------
    label_map_dst = os.path.join(args.output_dir, "label_map.json")
    shutil.copyfile(args.label_map, label_map_dst)
    log("SAVE", f"copied label_map.json -> {label_map_dst}")

    # 9) TRAIN COMMAND + METADATA --------------------------------------------
    cmd = "python3 " + " ".join(_shell_quote(a) for a in sys.argv)
    cmd_path = os.path.join(args.output_dir, "train_command.sh")
    with open(cmd_path, "w", encoding="utf-8") as f:
        f.write("#!/usr/bin/env bash\n")
        f.write("# Command used to launch this training run.\n")
        f.write(f"# cwd: {os.getcwd()}\n")
        f.write(cmd + "\n")
    os.chmod(cmd_path, 0o755)
    log("SAVE", f"wrote {cmd_path}")

    metadata = {
        "model": args.model,
        "num_labels": num_labels,
        "device": device,
        "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        "resumed": bool(args.resume_from_checkpoint),
        "resume_from_checkpoint": (
            os.path.abspath(args.resume_from_checkpoint)
            if args.resume_from_checkpoint
            else None
        ),
        "args": vars(args),
        "data": {
            "checkpoint": os.path.abspath(args.checkpoint),
            "label_map": os.path.abspath(args.label_map),
            "kept": stats["kept"],
            "skipped": skipped,
            "train_size": len(train_idx),
            "val_size": len(val_idx),
            "rare_labels_train_only": rare_labels,
        },
        "results": {
            "train_loss": train_result.training_loss,
            "global_step": train_result.global_step,
            "final_eval": final_metrics,
        },
        "versions": {
            "torch": torch.__version__,
            "transformers": transformers.__version__,
        },
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
    }
    meta_path = os.path.join(args.output_dir, "run_metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    log("SAVE", f"wrote {meta_path}")

    log("DONE", f"training complete -> {args.output_dir}")


def _shell_quote(s):
    """Minimal shell quoting for reconstructing the launch command."""
    if s and all(c.isalnum() or c in "-_./=:" for c in s):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    main()
