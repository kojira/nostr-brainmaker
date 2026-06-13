// transformers.js inference backend for the 1-char classifier.
//
// Why transformers.js: the ruri-v3 tokenizer is a HuggingFace fast tokenizer
// (tokenizer.json). transformers.js loads it natively and runs the ONNX model
// under the hood (onnxruntime-web, WASM/WebGPU), so we get tokenization +
// inference without re-implementing SentencePiece in JS.
//
// The heavy library is imported lazily inside load() via a dynamic import, so:
//   - it never inflates the bundle until a model is actually present, and
//   - a missing/failed dependency just makes the backend throw on load(), which
//     the adapter turns into 'unavailable' → heuristic fallback (non-breaking).
//
// Asset layout served from public/models/1char/ (Vite serves it at /models/1char/):
//   config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json
//   onnx/model.onnx        (fp32, default)
//   onnx/model_quantized.onnx  (optional int8, used when manifest.model.dtype === 'q8')

import { registerBackendFactory } from '../backend.js';

// Default dynamic import. Kept as a thunk so tests can inject a fake library.
const defaultLoadLib = () => import('@huggingface/transformers');

// Split a manifest file path like 'onnx/model.onnx' into the subfolder and the
// transformers.js model_file_name (extension-less). A bare 'model.onnx' is
// assumed to live under the conventional 'onnx/' subfolder.
function parseModelFile(file) {
  const raw = typeof file === 'string' && file.length ? file : 'onnx/model.onnx';
  const slash = raw.lastIndexOf('/');
  const subfolder = slash >= 0 ? raw.slice(0, slash) : 'onnx';
  const base = slash >= 0 ? raw.slice(slash + 1) : raw;
  const modelFileName = base.replace(/\.onnx$/i, '');
  return { subfolder, modelFileName };
}

export function createTransformersJsBackend(manifest, opts = {}) {
  const loadLib = opts.loadLib || defaultLoadLib;
  const model = manifest?.model || {};
  const maxLength = Number.isInteger(model.maxLength) && model.maxLength > 0 ? model.maxLength : 256;
  const dtype = model.dtype || 'fp32';
  const { subfolder, modelFileName } = parseModelFile(model.files?.model);

  let tokenizer = null;
  let runner = null;

  return {
    id: 'transformers.js',

    async load(_manifest, ctx = {}) {
      const lib = await loadLib();
      const { env, AutoTokenizer, AutoModelForSequenceClassification } = lib;

      // Serve assets only from our origin; never reach out to the HF hub.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      // transformers.js fetches from `${localModelPath}/${modelId}/...`.
      env.localModelPath = ctx.baseUrl || '/';

      // basePath is like 'models/1char/'; the model id is that path, slash-trimmed.
      const modelId = String(ctx.basePath || 'models/1char/').replace(/\/+$/, '');

      tokenizer = await AutoTokenizer.from_pretrained(modelId);
      runner = await AutoModelForSequenceClassification.from_pretrained(modelId, {
        subfolder,
        model_file_name: modelFileName,
        dtype,
        ...(opts.device ? { device: opts.device } : {}),
      });
    },

    async infer(normalizedText) {
      if (!tokenizer || !runner) {
        throw new Error('transformers.js backend not loaded');
      }
      const inputs = await tokenizer(normalizedText, { truncation: true, max_length: maxLength });
      const output = await runner(inputs);
      const logits = output?.logits;
      if (!logits || !logits.data) {
        throw new Error('transformers.js backend produced no logits');
      }
      // Single input → batch of 1; data length === numLabels.
      return Array.from(logits.data);
    },

    dispose() {
      try {
        runner?.dispose?.();
      } catch {
        // best-effort cleanup
      }
      tokenizer = null;
      runner = null;
    },
  };
}

// Register transformers.js as the default inference backend. The factory only
// runs createTransformersJsBackend(); the library import is deferred to load(),
// so calling this has no cost and no side effects until a model is present.
export function registerDefaultBackends(opts = {}) {
  registerBackendFactory((manifest) => createTransformersJsBackend(manifest, opts));
}
