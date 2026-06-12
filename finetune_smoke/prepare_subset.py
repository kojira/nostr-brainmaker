#!/usr/bin/env python3
"""Prepare a tiny training subset for the 1-char classifier smoke test.

Reads the labeled checkpoint (JSONL) and the label map, then writes a small,
self-contained subset file that the smoke trainer consumes. Each output record
keeps only what training needs: ``content`` (text) and ``label_id`` (int).

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
    """Yield (content, label_id) for well-formed checkpoint.jsonl rows.

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


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__)
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

    per_label_count = Counter()
    written = 0
    skipped_out_of_range = 0
    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    with open(args.out, "w", encoding="utf-8") as out:
        for content, label_id in iter_records(args.checkpoint):
            if label_id < 0 or label_id >= num_labels:
                skipped_out_of_range += 1
                continue
            if per_label_count[label_id] >= args.per_label:
                continue
            if written >= args.max_total:
                break
            text = content.strip()[: args.max_chars]
            out.write(json.dumps({"content": text, "label_id": label_id}, ensure_ascii=False) + "\n")
            per_label_count[label_id] += 1
            written += 1

    print(f"checkpoint: {args.checkpoint}")
    print(f"wrote {written} examples covering {len(per_label_count)} labels -> {args.out}")
    if skipped_out_of_range:
        print(f"  ({skipped_out_of_range} rows skipped: label_id out of range)")
    if written == 0:
        print("ERROR: no examples written; check input paths", file=sys.stderr)
        sys.exit(1)

    # Stash num_labels alongside the subset so the trainer need not re-read the map.
    meta_path = os.path.join(os.path.dirname(args.out), "subset_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"num_labels": num_labels, "count": written}, f, ensure_ascii=False, indent=2)
    print(f"wrote meta -> {meta_path}")


if __name__ == "__main__":
    main()
