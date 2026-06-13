// Pure helpers for the browser-model deploy flow (scripts/deploy-browser-model.js).
//
// Kept free of fs/child_process so the decision logic — arg parsing, which ONNX
// artifact the manifest should point at, and which output files to verify — can
// be unit-tested in isolation. The CLI wrapper supplies the side effects.

export const DEFAULT_OPSET = 14;

// Parse argv (already sliced past `node script.js`) into a plain options object.
// Throws on unknown flags so typos fail loudly instead of being silently ignored.
//
// Production is q4-only: with no mode flag the deploy produces and serves the
// 4-bit weight-only model (onnx/model_q4.onnx, manifest dtype 'q4'). --dev-fp32
// and --dev-q8 are NON-PRODUCTION escape hatches for local debugging only; they
// are NOT a production fallback.
export function parseDeployArgs(argv) {
  const opts = {
    runDir: null,
    mode: 'q4', // 'q4' (production) | 'q8' (dev) | 'fp32' (dev)
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
      case '--q4': opts.mode = 'q4'; break; // explicit production default, for clarity
      case '--dev-q8': opts.mode = 'q8'; break; // dev only — int8 dynamic quant
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
// Production ('q4') REQUIRES onnx/model_q4.onnx and serves it as dtype 'q4'.
// There is deliberately NO silent fall-through to fp32/q8: a missing q4 artifact
// is a hard error. 'q8'/'fp32' are reachable only via the explicit dev flags.
export function resolveModelArtifact({ mode = 'q4', q4Exists = false, fp32Exists = false, quantizedExists = false } = {}) {
  if (mode === 'q8') {
    if (!quantizedExists) {
      throw new Error(
        'dev q8 mode requested but onnx/model_quantized.onnx was not produced. '
        + 'Re-run the export with --dev-q8 (q8 is a dev option, not production).',
      );
    }
    return { modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' };
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
  // Production: q4 only — no fp32/q8 fallback.
  if (!q4Exists) {
    throw new Error(
      'production q4 model onnx/model_q4.onnx was not found in public/models/1char/. '
      + 'Re-run the export so the 4-bit artifact is produced (drop --skip-export), or '
      + 'export the q4 asset there first. fp32/q8 are NOT a production fallback.',
    );
  }
  return { modelFile: 'onnx/model_q4.onnx', dtype: 'q4' };
}

// The browser asset set that Pages must publish for runtime inference. The
// model file is parameterized because it is q4 (production), q8, or fp32 (dev).
export function expectedAssets({ modelFile = 'onnx/model_q4.onnx' } = {}) {
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
