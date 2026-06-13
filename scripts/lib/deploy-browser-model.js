// Pure helpers for the browser-model deploy flow (scripts/deploy-browser-model.js).
//
// Kept free of fs/child_process so the decision logic — arg parsing, which ONNX
// artifact the manifest should point at, and which output files to verify — can
// be unit-tested in isolation. The CLI wrapper supplies the side effects.

// opset 18 keeps LayerNormalization at a version onnxruntime can ingest without a
// version-conversion pass. The older default (14) forced a downgrade that crashed
// the ModernBERT export on LayerNormalization, so q8 production export now defaults
// here.
export const DEFAULT_OPSET = 18;

// Parse argv (already sliced past `node script.js`) into a plain options object.
// Throws on unknown flags so typos fail loudly instead of being silently ignored.
//
// Production is q8-only: with no mode flag the deploy produces and serves the
// int8-quantized model (onnx/model_quantized.onnx, manifest dtype 'q8').
// --dev-fp32 and --dev-q4 are NON-PRODUCTION escape hatches for local debugging
// only; they are NOT a production fallback.
export function parseDeployArgs(argv) {
  const opts = {
    runDir: null,
    mode: 'q8', // 'q8' (production) | 'q4' (dev) | 'fp32' (dev)
    skipExport: false,
    dryRun: false,
    help: false,
    opset: DEFAULT_OPSET,
    python: null,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--q8': opts.mode = 'q8'; break; // explicit production default, for clarity
      case '--dev-q4': opts.mode = 'q4'; break; // dev only — 4-bit weight-only quant
      case '--dev-fp32': opts.mode = 'fp32'; break; // dev only — unquantized
      case '--skip-export': opts.skipExport = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '--opset': opts.opset = Number(argv[++i]); break;
      case '--python': opts.python = argv[++i]; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        positionals.push(a);
    }
  }
  opts.runDir = positionals[0] || null;
  if (opts.opset != null && !Number.isInteger(opts.opset)) {
    throw new Error('--opset must be an integer');
  }
  return opts;
}

// Decide which exported ONNX file the manifest should reference and the
// transformers.js dtype hint, given the requested mode and which files exist on
// disk. Throws (with an actionable message) when the requested artifact is absent.
//
// Production ('q8') REQUIRES onnx/model_quantized.onnx and serves it as dtype
// 'q8'. There is deliberately NO silent fall-through to fp32/q4: a missing q8
// artifact is a hard error. 'q4'/'fp32' are reachable only via the explicit dev
// flags.
export function resolveModelArtifact({ mode = 'q8', q4Exists = false, fp32Exists = false, quantizedExists = false } = {}) {
  if (mode === 'q4') {
    if (!q4Exists) {
      throw new Error(
        'dev q4 mode requested but onnx/model_q4.onnx was not produced. '
        + 'Re-run the export with --dev-q4 (q4 is a dev option, not production).',
      );
    }
    return { modelFile: 'onnx/model_q4.onnx', dtype: 'q4' };
  }
  if (mode === 'fp32') {
    if (!fp32Exists) {
      throw new Error(
        'dev fp32 mode requested but onnx/model.onnx was not found in public/models/1char/. '
        + 'Run the export first (fp32 is a dev option, not production).',
      );
    }
    return { modelFile: 'onnx/model.onnx', dtype: 'fp32' };
  }
  // Production: q8 only — no fp32/q4 fallback.
  if (!quantizedExists) {
    throw new Error(
      'production q8 model onnx/model_quantized.onnx was not found in public/models/1char/. '
      + 'Re-run the export so the int8 artifact is produced (drop --skip-export), or '
      + 'export the q8 asset there first. fp32/q4 are NOT a production fallback.',
    );
  }
  return { modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' };
}

// The browser asset set that Pages must publish for runtime inference. The
// model file is parameterized because it is q8 (production), q4, or fp32 (dev).
export function expectedAssets({ modelFile = 'onnx/model_quantized.onnx' } = {}) {
  return {
    required: [
      'manifest.json',
      'config.json',
      'label_map.json',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/config.json',
      modelFile,
    ],
    recommended: [],
  };
}

// A trained HF checkpoint dir we can export from must carry weights + a config.
// Used only for a friendly pre-flight message; export_onnx.py is the real gate.
export function looksLikeCheckpoint(fileNames = []) {
  const has = (n) => fileNames.includes(n);
  const hasWeights = has('model.safetensors') || has('pytorch_model.bin');
  return hasWeights && has('config.json');
}

// Turn a verification result (which required/recommended files are present) into
// a structured report the CLI prints and exits on.
export function summarizeVerification({ required, recommended }, exists) {
  const check = (list) => list.map((file) => ({ file, present: !!exists(file) }));
  const requiredResults = check(required);
  const recommendedResults = check(recommended);
  const missingRequired = requiredResults.filter((r) => !r.present).map((r) => r.file);
  const missingRecommended = recommendedResults.filter((r) => !r.present).map((r) => r.file);
  return {
    ok: missingRequired.length === 0,
    required: requiredResults,
    recommended: recommendedResults,
    missingRequired,
    missingRecommended,
  };
}
