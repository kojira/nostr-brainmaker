#!/usr/bin/env python3
"""Input normalization for the trained 1-char classifier (Python side).

This is the *exact* mirror of src/classifier/normalize.js. Training (train_production.py)
and browser inference (normalize.js) MUST apply identical preprocessing, otherwise the
model sees one text distribution at train time and a different one at inference — the
"preprocessing parity" requirement in docs/1char-classification-design.md §8/§9.

Canonical fixtures live in tests/fixtures/normalization-parity.json and are checked from
both languages:
  - JS:     tests/classifier-normalize-parity.test.js
  - Python: python3 finetune_smoke/normalize.py --check

Run --check after editing either normalizer to prove the two still agree.
"""

from __future__ import annotations

import re

# Mirror of normalize.js. Keep the patterns byte-for-byte equivalent.
_URL_RE = re.compile(r"https?://\S+")
_NOSTR_RE = re.compile(r"\bnostr:\S+", re.IGNORECASE)
_MENTION_RE = re.compile(r"\bnpub1[a-z0-9]+", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def normalize_for_classifier(text) -> str:
    s = "" if text is None else str(text)
    s = _URL_RE.sub(" ", s)
    s = _NOSTR_RE.sub(" ", s)
    s = _MENTION_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s)
    return s.strip()


def _check(fixtures_path: str) -> int:
    import json
    from pathlib import Path

    data = json.loads(Path(fixtures_path).read_text(encoding="utf-8"))
    failures = []
    for case in data["cases"]:
        got = normalize_for_classifier(case["input"])
        if got != case["expected"]:
            failures.append((case["input"], case["expected"], got))
    if failures:
        print(f"PARITY FAIL: {len(failures)} mismatch(es)")
        for inp, exp, got in failures:
            print(f"  input={inp!r}\n    expected={exp!r}\n    got     ={got!r}")
        return 1
    print(f"PARITY OK: {len(data['cases'])} cases match normalize.js")
    return 0


if __name__ == "__main__":
    import argparse
    from pathlib import Path

    default_fixtures = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "normalization-parity.json"
    parser = argparse.ArgumentParser(description="normalize text or verify JS/Python parity")
    parser.add_argument("--check", nargs="?", const=str(default_fixtures), metavar="FIXTURES",
                        help="verify against the parity fixtures (default: tests/fixtures/normalization-parity.json)")
    parser.add_argument("text", nargs="?", help="text to normalize and print")
    args = parser.parse_args()

    if args.check:
        raise SystemExit(_check(args.check))
    if args.text is not None:
        print(normalize_for_classifier(args.text))
    else:
        parser.print_help()
