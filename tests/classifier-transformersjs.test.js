import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import {
  createTransformersJsBackend,
  parseModelFile,
  describeQ4Coverage,
} from '../src/classifier/backends/transformersjs.js';
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

// Production manifest: q8 (int8) is THE production model path/dtype.
function manifestTransformersJs() {
  return {
    schemaVersion: 1,
    model: {
      name: 'ruri-v3-pt-30m-1char',
      runtime: 'transformers.js',
      files: { model: 'onnx/model_quantized.onnx', tokenizer: 'tokenizer.json' },
      dtype: 'q8',
      maxLength: 128,
      numLabels: 47,
    },
    labelMap: labelMapData,
  };
}

describe('createTransformersJsBackend', () => {
  it('loads via injected lib and infers logits (production q8)', async () => {
    const { lib, calls } = fakeLib();
    const backend = createTransformersJsBackend(manifestTransformersJs(), { loadLib: async () => lib });

    await backend.load(manifestTransformersJs(), { baseUrl: '/', basePath: 'models/1char/' });

    // local-only, correct model id derived from basePath
    expect(lib.env.allowRemoteModels).toBe(false);
    expect(lib.env.allowLocalModels).toBe(true);
    expect(calls.modelId).toBe('models/1char');
    // 'onnx/model_quantized.onnx' + dtype q8 -> model_file_name 'model'
    // (transformers re-appends '_quantized' -> model_quantized.onnx)
    expect(calls.modelOpts.subfolder).toBe('onnx');
    expect(calls.modelOpts.model_file_name).toBe('model');
    expect(calls.modelOpts.dtype).toBe('q8');

    const logits = await backend.infer('こんにちは');
    expect(Array.isArray(logits)).toBe(true);
    expect(logits.length).toBe(47);
    expect(logits[3]).toBe(9);
    // truncation honored maxLength from manifest
    expect(calls.tokenizer[0].opts.max_length).toBe(128);
    expect(calls.tokenizer[0].opts.truncation).toBe(true);
  });

  // Non-production alternatives (backward compat): fp32 and q4 manifests still load.
  // Production is q8 (see manifestTransformersJs); these only prove other dtypes wire through.
  it('reads dtype and model file name from non-production fp32 manifest', async () => {
    const { lib, calls } = fakeLib();
    const m = manifestTransformersJs();
    m.model.dtype = 'fp32';
    m.model.files.model = 'onnx/model.onnx';
    const backend = createTransformersJsBackend(m, { loadLib: async () => lib });
    await backend.load(m, { baseUrl: '/', basePath: 'models/1char/' });
    expect(calls.modelOpts.subfolder).toBe('onnx');
    expect(calls.modelOpts.model_file_name).toBe('model');
    expect(calls.modelOpts.dtype).toBe('fp32');
  });

  it('reads dtype and a bare model file name from a non-production q4 manifest', async () => {
    const { lib, calls } = fakeLib();
    const m = manifestTransformersJs();
    m.model.dtype = 'q4';
    m.model.files.model = 'model_q4.onnx';
    const backend = createTransformersJsBackend(m, { loadLib: async () => lib });
    await backend.load(m, { baseUrl: '/', basePath: 'models/1char/' });
    // bare name still resolves into the conventional onnx/ subfolder; the
    // '_q4' suffix is stripped because transformers re-appends it from
    // dtype q4 -> model_q4.onnx
    expect(calls.modelOpts.subfolder).toBe('onnx');
    expect(calls.modelOpts.model_file_name).toBe('model');
    expect(calls.modelOpts.dtype).toBe('q4');
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

describe('parseModelFile', () => {
  it("strips the q8 '_quantized' suffix so transformers re-appends it (production fix)", () => {
    expect(parseModelFile('onnx/model_quantized.onnx', 'q8')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });

  it('leaves fp32 base bare (no suffix)', () => {
    expect(parseModelFile('onnx/model.onnx', 'fp32')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });

  it("strips the q4 suffix (dev alternative)", () => {
    expect(parseModelFile('onnx/model_q4.onnx', 'q4')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });

  it('defaults a bare path into the onnx/ subfolder and strips the q8 suffix', () => {
    expect(parseModelFile('model_quantized.onnx', 'q8')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });

  it('backward-compat: onnx/model.onnx + q4 keeps bare model (suffix not present)', () => {
    expect(parseModelFile('onnx/model.onnx', 'q4')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });

  it('falls back to the production q8 path when file is empty', () => {
    expect(parseModelFile('', 'q8')).toEqual({
      subfolder: 'onnx',
      modelFileName: 'model',
    });
  });
});

describe('describeQ4Coverage', () => {
  it('documents the partial quantization (fp32 embeddings)', () => {
    const cov = describeQ4Coverage();
    expect(cov.partial).toBe(true);
    expect(cov.embeddingsQuantized).toBe(false);
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

  it('becomes unavailable when the backend library is missing', async () => {
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
    expect(c.reason).toMatch(/transformers/);
  });
});
