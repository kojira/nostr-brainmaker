import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import { createTransformersJsBackend } from '../src/classifier/backends/transformersjs.js';
import { createClassifier } from '../src/classifier/adapter.js';

// A fake @huggingface/transformers that records how it was configured and returns
// deterministic logits, so we can prove the wiring without the real (heavy) lib.
function fakeLib() {
  const env = {};
  const calls = { tokenizer: [], modelOpts: null, modelId: null };
  const lib = {
    env,
    async AutoTokenizer_from_pretrained() {},
    AutoTokenizer: {
      async from_pretrained(modelId) {
        calls.modelId = modelId;
        // tokenizer is a callable returning fake encodings
        const tok = async (text, opts) => {
          calls.tokenizer.push({ text, opts });
          return { input_ids: [[1, 2, 3]], attention_mask: [[1, 1, 1]] };
        };
        return tok;
      },
    },
    AutoModelForSequenceClassification: {
      async from_pretrained(modelId, opts) {
        calls.modelOpts = opts;
        return async (_inputs) => {
          // pick a label deterministically — 47-wide logits, peak at id 3
          const data = new Float32Array(47);
          data[3] = 9;
          return { logits: { data } };
        };
      },
    },
  };
  return { lib, env, calls };
}

function manifestTransformersJs() {
  return {
    schemaVersion: 1,
    model: {
      name: 'ruri-v3-pt-30m-1char',
      runtime: 'transformers.js',
      files: { model: 'onnx/model.onnx', tokenizer: 'tokenizer.json' },
      maxLength: 128,
      numLabels: 47,
    },
    labelMap: labelMapData,
  };
}

describe('createTransformersJsBackend', () => {
  it('loads via injected lib and infers logits', async () => {
    const { lib, calls } = fakeLib();
    const backend = createTransformersJsBackend(manifestTransformersJs(), { loadLib: async () => lib });

    await backend.load(manifestTransformersJs(), { baseUrl: '/', basePath: 'models/1char/' });

    // local-only, correct model id derived from basePath
    expect(lib.env.allowRemoteModels).toBe(false);
    expect(lib.env.allowLocalModels).toBe(true);
    expect(calls.modelId).toBe('models/1char');
    // 'onnx/model.onnx' -> subfolder 'onnx', model_file_name 'model'
    expect(calls.modelOpts.subfolder).toBe('onnx');
    expect(calls.modelOpts.model_file_name).toBe('model');
    expect(calls.modelOpts.dtype).toBe('fp32');

    const logits = await backend.infer('こんにちは');
    expect(Array.isArray(logits)).toBe(true);
    expect(logits.length).toBe(47);
    expect(logits[3]).toBe(9);
    // truncation honored maxLength from manifest
    expect(calls.tokenizer[0].opts.max_length).toBe(128);
    expect(calls.tokenizer[0].opts.truncation).toBe(true);
  });

  it('reads dtype and a bare model file name from the manifest', async () => {
    const { lib, calls } = fakeLib();
    const m = manifestTransformersJs();
    m.model.dtype = 'q8';
    m.model.files.model = 'model_quantized.onnx';
    const backend = createTransformersJsBackend(m, { loadLib: async () => lib });
    await backend.load(m, { baseUrl: '/', basePath: 'models/1char/' });
    // bare name still resolves into the conventional onnx/ subfolder
    expect(calls.modelOpts.subfolder).toBe('onnx');
    expect(calls.modelOpts.model_file_name).toBe('model_quantized');
    expect(calls.modelOpts.dtype).toBe('q8');
  });

  it('throws on infer before load (adapter -> unavailable)', async () => {
    const backend = createTransformersJsBackend(manifestTransformersJs(), { loadLib: async () => fakeLib().lib });
    await expect(backend.infer('x')).rejects.toThrow();
  });

  it('surfaces a missing library as a load failure', async () => {
    const backend = createTransformersJsBackend(manifestTransformersJs(), {
      loadLib: async () => {
        throw new Error('Cannot find package @huggingface/transformers');
      },
    });
    await expect(backend.load(manifestTransformersJs(), {})).rejects.toThrow(/transformers/);
  });
});

describe('createClassifier with transformers.js backend', () => {
  it('reaches ready and classifies posts end-to-end', async () => {
    const { lib } = fakeLib();
    const c = createClassifier({
      fetchImpl: async () => ({ ok: true, json: async () => manifestTransformersJs() }),
      backendFactory: (manifest) => createTransformersJsBackend(manifest, { loadLib: async () => lib }),
    });
    await c.init();
    expect(c.available).toBe(true);

    const result = await c.classifyPosts(['ねこが好き', 'いぬも好き']);
    expect(result.mode).toBe('classifier');
    expect(result.posts).toBe(2);
    // both posts land on label id 3
    expect(result.labels[0].id).toBe(3);
    expect(result.labels[0].count).toBe(2);
  });

  it('falls back to unavailable when the backend library is missing', async () => {
    const c = createClassifier({
      fetchImpl: async () => ({ ok: true, json: async () => manifestTransformersJs() }),
      backendFactory: (manifest) =>
        createTransformersJsBackend(manifest, {
          loadLib: async () => {
            throw new Error('Cannot find package @huggingface/transformers');
          },
        }),
    });
    await c.init();
    expect(c.available).toBe(false);
    expect(c.state).toBe('unavailable');
  });
});
