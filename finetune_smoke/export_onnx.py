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
      onnx/model_quantized.onnx       (int8, production, only with --quantize)
      onnx/model_q4.onnx              (4-bit weight-only, dev alternative, only with --q4)

The int8 model_quantized.onnx is the production browser model: onnxruntime dynamic
int8 quantization shrinks the artifact ~4x versus fp32 (~37MB) and onnxruntime-web /
transformers.js load it directly via the `q8` dtype. The 4-bit q4 model is kept as a
non-production dev alternative.

After running this, generate the manifest the browser fetches at runtime:

    node scripts/build-model-manifest.js <run-dir> --dtype q8 --model-file onnx/model_quantized.onnx  # production
    node scripts/build-model-manifest.js <run-dir>            # fp32 (dev)
    node scripts/build-model-manifest.js <run-dir> --dtype q4 --model-file onnx/model_q4.onnx          # dev

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

    This is a non-production dev alternative (production is the int8 q8 model).
    onnxruntime ships the quantizer in two
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


def _run_main_export(run_dir: Path, onnx_dir: Path, opset: int) -> None:
    """Export the checkpoint to onnx_dir/model.onnx (+ optional model.onnx_data sidecar)
    via optimum's main_export, tolerating a known optimum cleanup bug.

    We call main_export directly (rather than the ORTModelForSequenceClassification
    .from_pretrained(export=True) + save_pretrained dance) because that wrapper exports
    into a TemporaryDirectory: when the optimum cleanup bug below fires it raises before
    from_pretrained returns and the temp dir is destroyed, leaving nothing to recover.
    main_export lets us export straight into onnx_dir, so even if the post-export cleanup
    throws, model.onnx and its sidecar are already sitting in the target dir.

    The optimum bug (optimum 1.24.0, exporters/onnx/convert.py): after consolidating
    external weights into `model.onnx_data` (underscore), the cleanup loop does an
    unconditional os.remove() on the model's *original* external-data reference, which for
    ModernBERT is named `model.onnx.data` (dot). That file no longer exists at that point,
    so os.remove raises FileNotFoundError even though model.onnx + model.onnx_data were
    written fine. We catch that specific FileNotFoundError and continue only when both
    output files are present.
    """
    from optimum.exporters.onnx import main_export

    def _do_export(with_opset: bool) -> None:
        kwargs = dict(
            model_name_or_path=str(run_dir),
            output=onnx_dir,
            task="text-classification",
            do_validation=False,
            no_post_process=True,
        )
        if with_opset:
            kwargs["opset"] = opset
        main_export(**kwargs)

    # opset defaults to 18 (see main()): ModernBERT uses LayerNormalization, which a
    # downgrade to opset 14 cannot version-convert, so the old default crashed the export.
    try:
        try:
            _do_export(with_opset=True)
            print(f"[export] using explicit opset={opset}")
        except TypeError as exc:
            if "opset" not in str(exc):
                raise
            print(
                f"[export] this optimum version does not accept an explicit opset "
                f"({exc}); falling back to export without one"
            )
            _do_export(with_opset=False)
    except FileNotFoundError as exc:
        # Tolerate the optimum external-data cleanup bug, but ONLY if it really left us a
        # usable model. The bug is about a stale `*.onnx.data` reference; require that the
        # missing file looks like that and that model.onnx (+ its real sidecar) exist.
        missing = Path(getattr(exc, "filename", "") or "")
        model_onnx = onnx_dir / "model.onnx"
        model_onnx_data = onnx_dir / "model.onnx_data"
        looks_like_cleanup_bug = ".onnx.data" in (missing.name or str(exc))
        if not (looks_like_cleanup_bug and model_onnx.exists() and model_onnx_data.exists()):
            raise
        print(
            f"[export] tolerating optimum external-data cleanup bug: it tried to remove a "
            f"stale '{missing.name or '*.onnx.data'}' that no longer exists, but model.onnx "
            f"and model.onnx_data were written correctly; continuing."
        )


def export_model(run_dir: Path, out_dir: Path, opset: int, quantize: bool, q4: bool, q4_block_size: int) -> list[str]:
    onnx_dir = out_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    print(f"[export] loading + converting checkpoint: {run_dir}")
    _run_main_export(run_dir, onnx_dir, opset)

    model_onnx = onnx_dir / "model.onnx"
    if not model_onnx.exists():
        fail(f"export did not produce {model_onnx}")
    produced = ["onnx/model.onnx"]
    print(f"[export] wrote {model_onnx}")

    if quantize:
        import tempfile

        import onnx
        from optimum.onnxruntime import ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig

        # The freshly exported model.onnx carries graph.value_info shapes that make
        # onnxruntime's quantization shape-inference fail ("Inferred shape and existing
        # shape differ in dimension 0"). Sanitize into a temp single-file ONNX with the
        # value_info cleared (and no external data) and quantize from that copy; the
        # public model.onnx is left untouched.
        print("[export] applying dynamic int8 quantization")
        qconfig = AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False)
        with tempfile.TemporaryDirectory() as tmp_dir:
            sanitized = Path(tmp_dir) / "model.onnx"
            sanitized_model = onnx.load(str(model_onnx))
            del sanitized_model.graph.value_info[:]
            onnx.save(sanitized_model, str(sanitized), save_as_external_data=False)

            quantizer = ORTQuantizer.from_pretrained(tmp_dir, file_name="model.onnx")
            # Write the quantized output straight into onnx_dir so the public artifact
            # path is unchanged. optimum names the output model_quantized.onnx by default.
            quantizer.quantize(save_dir=str(onnx_dir), quantization_config=qconfig)
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
    parser.add_argument("--opset", type=int, default=18, help="ONNX opset version (default 18; avoids the ModernBERT LayerNormalization conversion failure)")
    parser.add_argument("--quantize", action="store_true", help="also emit the production int8-quantized model (onnx/model_quantized.onnx)")
    parser.add_argument("--q4", action="store_true", help="also emit the 4-bit weight-only model (onnx/model_q4.onnx, dev alternative)")
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
    if args.quantize:
        print("  # production (int8 q8):")
        print(f"  node scripts/build-model-manifest.js {args.run_dir} --dtype q8 --model-file onnx/model_quantized.onnx")
    else:
        print("  # production needs the int8 model — re-run with --quantize, then:")
        print(f"  node scripts/build-model-manifest.js {args.run_dir} --dtype q8 --model-file onnx/model_quantized.onnx")
    print("  # or, to serve the unquantized fp32 model (dev):")
    print(f"  node scripts/build-model-manifest.js {args.run_dir}")
    if args.q4:
        print("  # or, to serve the 4-bit model (dev alternative):")
        print(f"  node scripts/build-model-manifest.js {args.run_dir} --dtype q4 --model-file onnx/model_q4.onnx")


if __name__ == "__main__":
    main()
