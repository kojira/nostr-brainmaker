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
//     the adapter turns into an explicit 'unavailable' state for the UI.
//
// Asset layout served from public/models/1char/ (Vite serves it at /models/1char/):
//   config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json
//   onnx/model_quantized.onnx  (int8, production default; manifest.model.dtype === 'q8')
//   onnx/model.onnx            (optional fp32 alternative, non-production)
//   onnx/model_q4.onnx         (optional 4-bit weight-only alternative, manifest.model.dtype === 'q4')

import { registerBackendFactory } from '../backend.js';

// Default dynamic import. Kept as a thunk so tests can inject a fake library.
const defaultLoadLib = () => import('@huggingface/transformers');

// transformers.js dtype -> filename-suffix mapping. transformers.js RE-APPENDS
// this suffix to model_file_name when resolving the ONNX file (e.g. dtype 'q4'
// + model_file_name 'model' -> 'model_q4.onnx'). We must therefore hand it the
// BARE base name; see parseModelFile.
const DTYPE_SUFFIX = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
};

// Split a manifest file path like 'onnx/model_quantized.onnx' into the subfolder
// and the transformers.js model_file_name (extension-less). A bare
// 'model_quantized.onnx' is assumed to live under the conventional 'onnx/'
// subfolder. The default production path is the int8 (q8) model.
//
// transformers.js re-appends the dtype suffix (DTYPE_SUFFIX) to model_file_name
// when resolving the ONNX file, so we strip that suffix from the base here to
// avoid doubling it (e.g. 'model_quantized' + dtype 'q8' ->
// 'model_quantized_quantized.onnx', which does not exist). We return the bare
// base ('model') and let transformers.js re-append '_quantized' ->
// 'model_quantized.onnx'.
export function parseModelFile(file, dtype) {
  const raw = typeof file === 'string' && file.length ? file : 'onnx/model_quantized.onnx';
  const slash = raw.lastIndexOf('/');
  const subfolder = slash >= 0 ? raw.slice(0, slash) : 'onnx';
  const base = (slash >= 0 ? raw.slice(slash + 1) : raw).replace(/\.onnx$/i, '');
  const suffix = DTYPE_SUFFIX[dtype] || '';
  const modelFileName = suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  return { subfolder, modelFileName };
}

// Documents WHY the q4 ONNX artifact (a non-production dev alternative; production
// is the int8 q8 model) is ~107MB rather than the ~141MB you might expect from a
// "full" 4-bit quantization. The q4 build is a PARTIAL
// quantization: the major dense weights become MatMulNBits (4-bit), but the
// embedding/Gather tensors stay fp32. That fp32 embedding table is the bulk of
// the residual size. This is a checkable documentation helper only — it is not
// wired into load()/infer().
export function describeQ4Coverage() {
  const approxQ4Bytes = 107 * 1024 * 1024;
  const approxFp32Bytes = 141 * 1024 * 1024;
  return {
    partial: true,
    embeddingsQuantized: false,
    approxQ4Bytes,
    approxFp32Bytes,
    reason:
      'Partial 4-bit quantization: dense weights are MatMulNBits (4-bit), but embedding/Gather tensors remain fp32, so the artifact stays ~107MB.',
  };
}

export function createTransformersJsBackend(manifest, opts = {}) {
  const loadLib = opts.loadLib || defaultLoadLib;
  const model = manifest?.model || {};
  const maxLength = Number.isInteger(model.maxLength) && model.maxLength > 0 ? model.maxLength : 256;
  const dtype = model.dtype || 'q8';
  const { subfolder, modelFileName } = parseModelFile(model.files?.model, dtype);

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
