#!/usr/bin/env python3
"""Export a trained 1-char classifier checkpoint to browser-consumable ONNX.

This produces the transformers.js asset layout under public/models/1char/:

    public/models/1char/
      config.json
      tokenizer.json
      tokenizer_config.json
      special_tokens_map.json
      label_map.json
      onnx/model.onnx                 (fp32, always)
      onnx/model_quantized.onnx       (int8, only with --quantize)
      onnx/model_q4.onnx              (4-bit weight-only, only with --q4)

The q4 artifact is the production browser model: onnxruntime weight-only 4-bit
quantization (MatMulNBits) shrinks the MatMul weights ~4x versus fp32 with a much
smaller accuracy hit than int8 dynamic quantization, and onnxruntime-web /
transformers.js load it directly via the `q4` dtype.

After running this, generate the manifest the browser fetches at runtime:

    node scripts/build-model-manifest.js <run-dir>            # fp32
    node scripts/build-model-manifest.js <run-dir> --dtype q8 --model-file onnx/model_quantized.onnx
    node scripts/build-model-manifest.js <run-dir> --dtype q4 --model-file onnx/model_q4.onnx

The model/tokenizer binaries are gitignored and never committed; only the manifest
schema example and READMEs are tracked.

OPTIONAL DEPENDENCIES
---------------------
ONNX export needs extras that are NOT in finetune_smoke/requirements.txt (they are
only required on the export box, not for training):

    pip install -r finetune_smoke/requirements-export.txt

If they are missing this script exits with code 2 and prints the install command,
so CI/training environments without the extras fail loudly rather than silently.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "public" / "models" / "1char"

# Tokenizer / config files copied verbatim from the HF checkpoint into the
# transformers.js asset directory. Missing optional ones are skipped silently.
TOKENIZER_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "spm.model",
    "sentencepiece.bpe.model",
]


def fail(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def require_export_deps():
    """Import optimum lazily and give an actionable error if absent."""
    try:
        from optimum.onnxruntime import ORTModelForSequenceClassification  # noqa: F401
    except Exception as exc:  # ImportError or transitive failure
        fail(
            "ONNX export dependencies are not installed.\n"
            "  Install them with:\n"
            "    pip install -r finetune_smoke/requirements-export.txt\n"
            f"  (underlying import error: {exc})",
            code=2,
        )


def copy_tokenizer(run_dir: Path, out_dir: Path) -> list[str]:
    copied = []
    for name in TOKENIZER_FILES:
        src = run_dir / name
        if src.exists():
            shutil.copy2(src, out_dir / name)
            copied.append(name)
    return copied


def copy_label_map(run_dir: Path, out_dir: Path) -> bool:
    for candidate in (run_dir / "label_map.json", REPO_ROOT / "data" / "production" / "label_map.json"):
        if candidate.exists():
            shutil.copy2(candidate, out_dir / "label_map.json")
            return True
    return False


def quantize_q4(onnx_dir: Path, block_size: int) -> str | None:
    """Produce onnx/model_q4.onnx from model.onnx via onnxruntime 4-bit weight-only
    quantization (MatMulNBits).

    This is the production browser artifact. onnxruntime ships the quantizer in two
    spellings depending on version: the newer onnxruntime>=1.21 exposes
    MatMulNBitsQuantizer in onnxruntime.quantization.matmul_nbits_quantizer, while the
    pinned onnxruntime==1.20.1 in requirements-export.txt exposes MatMul4BitsQuantizer
    in onnxruntime.quantization.matmul_4bits_quantizer. We try both so the script works
    in either export venv.
    """
    import onnx

    QuantizerCls = None
    try:
        from onnxruntime.quantization.matmul_nbits_quantizer import (
            MatMulNBitsQuantizer as QuantizerCls,
        )
    except Exception:
        try:
            from onnxruntime.quantization.matmul_4bits_quantizer import (
                MatMul4BitsQuantizer as QuantizerCls,
            )
        except Exception as exc:
            fail(
                "onnxruntime 4-bit weight-only quantizer is not available.\n"
                "  It ships with onnxruntime (see finetune_smoke/requirements-export.txt).\n"
                f"  (underlying import error: {exc})",
                code=2,
            )

    src_path = onnx_dir / "model.onnx"
    q4_path = onnx_dir / "model_q4.onnx"

    print(f"[export] applying 4-bit weight-only quantization (block_size={block_size})")
    model = onnx.load(str(src_path))
    quantizer = QuantizerCls(model, block_size=block_size, is_symmetric=True)
    quantizer.process()
    # quantizer.model is an ONNXModel wrapper exposing save_model_to_file.
    quantizer.model.save_model_to_file(str(q4_path), use_external_data_format=False)

    if q4_path.exists():
        print(f"[export] wrote {q4_path}")
        return "onnx/model_q4.onnx"
    print("[export] warning: expected model_q4.onnx not found", file=sys.stderr)
    return None


def export_model(run_dir: Path, out_dir: Path, opset: int, quantize: bool, q4: bool, q4_block_size: int) -> list[str]:
    from optimum.onnxruntime import ORTModelForSequenceClassification

    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    print(f"[export] loading + converting checkpoint: {run_dir}")
    # Some optimum versions (e.g. 1.24.0) no longer accept `opset` via
    # from_pretrained(export=True); it gets forwarded to an internal export path
    # (ORTModel._from_transformers) that rejects it with a TypeError. Try with an
    # explicit opset first, then fall back cleanly to exporting without it.
    try:
        ort_model = ORTModelForSequenceClassification.from_pretrained(
            str(run_dir), export=True, opset=opset
        )
        print(f"[export] using explicit opset={opset}")
    except TypeError as exc:
        if "opset" not in str(exc):
            raise
        print(
            f"[export] this optimum version does not accept opset via from_pretrained "
            f"({exc}); falling back to export without an explicit opset"
        )
        ort_model = ORTModelForSequenceClassification.from_pretrained(
            str(run_dir), export=True
        )
    # save_pretrained writes model.onnx (+ config.json) into onnx_dir.
    ort_model.save_pretrained(str(onnx_dir))
    produced = ["onnx/model.onnx"]
    print(f"[export] wrote {onnx_dir / 'model.onnx'}")

    if quantize:
        from optimum.onnxruntime import ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig

        print("[export] applying dynamic int8 quantization")
        quantizer = ORTQuantizer.from_pretrained(str(onnx_dir), file_name="model.onnx")
        qconfig = AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False)
        quantizer.quantize(save_dir=str(onnx_dir), quantization_config=qconfig)
        # optimum names the output model_quantized.onnx by default.
        quant_path = onnx_dir / "model_quantized.onnx"
        if quant_path.exists():
            produced.append("onnx/model_quantized.onnx")
            print(f"[export] wrote {quant_path}")
        else:
            print("[export] warning: expected model_quantized.onnx not found", file=sys.stderr)

    if q4:
        q4_produced = quantize_q4(onnx_dir, q4_block_size)
        if q4_produced:
            produced.append(q4_produced)

    return produced


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-dir", required=True, help="trained checkpoint dir (e.g. finetune_smoke/train-output/run-...)")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT), help=f"output dir (default {DEFAULT_OUT})")
    parser.add_argument("--opset", type=int, default=14, help="ONNX opset version (default 14)")
    parser.add_argument("--quantize", action="store_true", help="also emit an int8-quantized model (onnx/model_quantized.onnx)")
    parser.add_argument("--q4", action="store_true", help="also emit the production 4-bit weight-only model (onnx/model_q4.onnx)")
    parser.add_argument("--q4-block-size", type=int, default=32, help="block size for 4-bit weight-only quantization (default 32)")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    if not run_dir.is_dir():
        fail(f"run dir not found: {run_dir}")

    require_export_deps()
    out_dir.mkdir(parents=True, exist_ok=True)

    produced = export_model(run_dir, out_dir, args.opset, args.quantize, args.q4, args.q4_block_size)
    tok = copy_tokenizer(run_dir, out_dir)
    has_label_map = copy_label_map(run_dir, out_dir)

    print()
    print(f"[done] assets in {out_dir}")
    print(f"  onnx models:  {', '.join(produced)}")
    print(f"  tokenizer:    {', '.join(tok) if tok else '(none copied — check run dir)'}")
    print(f"  label_map:    {'label_map.json' if has_label_map else 'MISSING — copy data/production/label_map.json manually'}")
    print()
    print("next: write the manifest the browser fetches at runtime:")
    print(f"  node scripts/build-model-manifest.js {args.run_dir}")
    if args.quantize:
        print("  # or, to serve the int8 quantized model:")
        print(f"  node scripts/build-model-manifest.js {args.run_dir} --dtype q8 --model-file onnx/model_quantized.onnx")
    if args.q4:
        print("  # or, to serve the production 4-bit model:")
        print(f"  node scripts/build-model-manifest.js {args.run_dir} --dtype q4 --model-file onnx/model_q4.onnx")


if __name__ == "__main__":
    main()
