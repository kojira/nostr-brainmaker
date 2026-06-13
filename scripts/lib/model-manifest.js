// Pure Node module bridging a training run to a browser manifest.
// The returned object is meant to be written to public/models/1char/manifest.json
// next to the exported ONNX model + tokenizer files.

function pickMetrics(runMetadata) {
  const src = runMetadata.results || runMetadata.metrics || {};
  const macroF1 = src.macroF1 ?? src.macro_f1 ?? null;
  const accuracy = src.accuracy ?? src.eval_accuracy ?? null;
  return { macroF1, accuracy };
}

export function buildBrowserManifest({
  runMetadata = {},
  labelMap = null,
  files = {},
  runtime = 'transformers.js',
  maxLength = 256,
  dtype = null,
  createdAt = null,
} = {}) {
  const name = runMetadata.model || runMetadata.base_model || 'unknown';

  const modelFiles = {
    // Production browser model is the int8-quantized artifact.
    model: files.model || 'onnx/model_quantized.onnx',
    tokenizer: files.tokenizer || 'tokenizer.json',
    ...files,
  };

  const numLabels = labelMap && Array.isArray(labelMap.labels)
    ? labelMap.labels.length + (labelMap.qa ? 1 : 0)
    : (runMetadata.num_labels || 47);

  const model = {
    name,
    runtime,
    files: modelFiles,
    maxLength,
    numLabels,
  };
  // dtype is the hint for the transformers.js backend. Production manifests set
  // 'q8' to load the int8 onnx/model_quantized.onnx; 'q4' loads the 4-bit
  // weight-only onnx/model_q4.onnx (dev alternative). Omitted → backend defaults
  // to its own production default (q8).
  if (dtype) {
    model.dtype = dtype;
  }

  const manifest = {
    schemaVersion: 1,
    model,
    metrics: pickMetrics(runMetadata),
    createdAt: createdAt || runMetadata.finished_at || runMetadata.created_at || null,
  };

  if (labelMap) {
    manifest.labelMap = labelMap;
  } else {
    manifest.labelMapPath = 'label_map.json';
  }

  return manifest;
}
