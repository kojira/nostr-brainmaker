// Pure helpers for the browser-model deploy flow (scripts/deploy-browser-model.js).
//
// Kept free of fs/child_process so the decision logic — arg parsing, which ONNX
// artifact the manifest should point at, and which output files to verify — can
// be unit-tested in isolation. The CLI wrapper supplies the side effects.

export const DEFAULT_OPSET = 14;

// Parse argv (already sliced past `node script.js`) into a plain options object.
// Throws on unknown flags so typos fail loudly instead of being silently ignored.
export function parseDeployArgs(argv) {
  const opts = {
    runDir: null,
    quantize: false,
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
      case '--quantize': opts.quantize = true; break;
      case '--fp32': opts.quantize = false; break; // explicit default, for clarity
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

// Decide which exported ONNX file the manifest should reference and the optional
// transformers.js dtype hint, given the requested mode and which files exist on
// disk. Throws (with an actionable message) when the requested artifact is absent.
export function resolveModelArtifact({ quantize = false, fp32Exists = false, quantizedExists = false } = {}) {
  if (quantize) {
    if (!quantizedExists) {
      throw new Error(
        'quantized mode requested but onnx/model_quantized.onnx was not produced. '
        + 'Re-run the export with --quantize (the fp32 model alone is not enough).',
      );
    }
    return { modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' };
  }
  if (!fp32Exists) {
    throw new Error(
      'onnx/model.onnx was not found in public/models/1char/. Run the export first '
      + '(drop --skip-export), or export the assets there before using --skip-export.',
    );
  }
  return { modelFile: 'onnx/model.onnx', dtype: null };
}

// The browser asset set, split into hard requirements (deploy fails without them)
// and recommended extras (transformers.js still works without, but warn). The
// model file is parameterized because it is fp32 or quantized depending on mode.
export function expectedAssets({ modelFile = 'onnx/model.onnx' } = {}) {
  return {
    required: ['manifest.json', modelFile, 'tokenizer.json', 'config.json'],
    recommended: ['tokenizer_config.json', 'special_tokens_map.json', 'label_map.json'],
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
