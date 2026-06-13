// Backend contract + injectable registry. A real runtime (onnxruntime-web /
// transformers.js) can be plugged in later WITHOUT bundling it now.
//
// A backend instance contract:
//   async load(manifest, ctx)            — load model/tokenizer; ctx has { baseUrl, basePath }
//   async infer(normalizedText) -> number[]  — returns logits or probs (length === numLabels)
//   dispose()                            — free resources

export function createUnavailableBackend(reason) {
  const msg = reason || 'classifier runtime not bundled';
  return {
    id: 'unavailable',
    async load() {
      throw new Error(msg);
    },
    async infer() {
      throw new Error(msg);
    },
    dispose() {},
  };
}

let _factory = null;

export function registerBackendFactory(fn) {
  _factory = fn;
}

export function resolveBackendFactory() {
  return _factory;
}
