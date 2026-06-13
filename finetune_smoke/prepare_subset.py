#!/usr/bin/env python3
"""Prepare a tiny training subset for the 1-char classifier smoke test.

Reads the exported training dataset (JSONL) and the label map, then writes a
small, self-contained subset file that the smoke trainer consumes. Each output
record keeps only what training needs: ``content`` (text) and ``label_id`` (int).

Selection is deterministic and coverage-first: every label present in the
dataset gets one example (labels in ascending label_id order) before any label
gets a second, so ``--max-total`` truncates duplicates, not label coverage.
Re-running against the same dataset always produces the same subset.

This step is meant to run locally (where the data lives) and produce a file
small enough to copy to a remote A100 box for the actual smoke train.
"""

import argparse
import json
import os
import sys
from collections import Counter


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


def iter_records(path):
    """Yield (content, label_id) for well-formed training dataset JSONL rows.

    Robust to blank lines and rows missing the fields we care about.
    """
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                print(f"  skip line {line_no}: bad JSON", file=sys.stderr)
                continue
            content = rec.get("content")
            label_id = rec.get("label_id")
            if not isinstance(content, str) or not content.strip():
                continue
            if label_id is None:
                continue
            try:
                label_id = int(label_id)
            except (TypeError, ValueError):
                continue
            yield content, label_id


def select_subset(records, num_labels, per_label, max_total):
    """Pick subset rows deterministically, maximizing label coverage.

    Pass 1 buffers, per label, the first ``per_label`` in-range candidates in
    file order. Pass 2 emits them breadth-first: rank 0 of every label (in
    ascending label_id order), then rank 1, and so on, stopping at
    ``max_total``. With ``max_total >= number of labels in the dataset`` this
    guarantees at least one example per label.

    Returns (selected, seen_labels, skipped_out_of_range) where ``selected``
    is a list of (content, label_id) and ``seen_labels`` is every in-range
    label observed in the dataset (even if not selected).
    """
    candidates = {}
    seen_labels = set()
    skipped_out_of_range = 0
    for content, label_id in records:
        if label_id < 0 or label_id >= num_labels:
            skipped_out_of_range += 1
            continue
        seen_labels.add(label_id)
        bucket = candidates.setdefault(label_id, [])
        if len(bucket) < per_label:
            bucket.append(content)

    selected = []
    ordered_labels = sorted(candidates)
    for rank in range(per_label):
        if len(selected) >= max_total:
            break
        for label_id in ordered_labels:
            if len(selected) >= max_total:
                break
            bucket = candidates[label_id]
            if rank < len(bucket):
                selected.append((bucket[rank], label_id))
    return selected, seen_labels, skipped_out_of_range


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dataset",
        "--checkpoint",
        dest="dataset",
        default=os.path.join(repo, "data", "production", "training", "dataset.jsonl"),
        help="path to exported training dataset JSONL",
    )
    ap.add_argument(
        "--label-map",
        default=os.path.join(repo, "data", "production", "label_map.json"),
        help="path to label_map.json",
    )
    ap.add_argument(
        "--out",
        default=os.path.join(here, "data", "subset.jsonl"),
        help="output subset JSONL path",
    )
    ap.add_argument(
        "--per-label",
        type=int,
        default=2,
        help="max examples to keep per label (keeps the subset tiny)",
    )
    ap.add_argument(
        "--max-total",
        type=int,
        default=64,
        help="hard cap on total examples written",
    )
    ap.add_argument(
        "--max-chars",
        type=int,
        default=512,
        help="truncate content to this many characters in the subset",
    )
    args = ap.parse_args()

    num_labels, _ = load_label_map(args.label_map)
    print(f"label map: {args.label_map}")
    print(f"  num_labels = {num_labels}")

    selected, seen_labels, skipped_out_of_range = select_subset(
        iter_records(args.dataset), num_labels, args.per_label, args.max_total
    )

    per_label_count = Counter()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as out:
        for content, label_id in selected:
            text = content.strip()[: args.max_chars]
            out.write(json.dumps({"content": text, "label_id": label_id}, ensure_ascii=False) + "\n")
            per_label_count[label_id] += 1
    written = len(selected)

    print(f"dataset: {args.dataset}")
    print(f"wrote {written} examples covering {len(per_label_count)} labels -> {args.out}")
    if skipped_out_of_range:
        print(f"  ({skipped_out_of_range} rows skipped: label_id out of range)")
    uncovered = sorted(seen_labels - set(per_label_count))
    if uncovered:
        print(
            f"WARNING: {len(uncovered)} dataset labels not in subset (raise --max-total"
            f" to >= {len(seen_labels)} to cover all): {uncovered}",
            file=sys.stderr,
        )
    if written == 0:
        print("ERROR: no examples written; check input paths", file=sys.stderr)
        sys.exit(1)

    # Stash num_labels alongside the subset so the trainer need not re-read the
    # map, plus selection details for handoff/debugging on the remote box.
    meta_path = os.path.join(os.path.dirname(args.out), "subset_meta.json")
    meta = {
        "num_labels": num_labels,
        "count": written,
        "labels_covered": len(per_label_count),
        "labels_in_dataset": len(seen_labels),
        "labels_in_dataset_not_in_subset": uncovered,
        "label_counts": {str(k): v for k, v in sorted(per_label_count.items())},
        "selection": {
            "strategy": "coverage-first, deterministic (one per label by ascending label_id, then fill per-label quota)",
            "per_label": args.per_label,
            "max_total": args.max_total,
            "max_chars": args.max_chars,
        },
        "dataset": os.path.abspath(args.dataset),
        "label_map": os.path.abspath(args.label_map),
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"wrote meta -> {meta_path}")


if __name__ == "__main__":
    main()
