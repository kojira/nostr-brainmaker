import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import { createClassifier } from '../src/classifier/adapter.js';

function manifestWithInlineMap() {
  return {
    schemaVersion: 1,
    model: {
      name: 'ruri-v3-pt-30m-1char',
      runtime: 'onnx',
      files: { model: 'model.onnx', tokenizer: 'tokenizer.json' },
      maxLength: 256,
      numLabels: 47,
    },
    labelMap: labelMapData,
  };
}

function fetchReturning(manifest) {
  return async () => ({ ok: true, json: async () => manifest });
}

describe('createClassifier', () => {
  it('is unavailable when manifest fetch fails (absent)', async () => {
    const c = createClassifier({ fetchImpl: async () => ({ ok: false }) });
    await c.init();
    expect(c.available).toBe(false);
    expect(c.state).toBe('unavailable');
    expect(c.reason).toMatch(/manifest/);
  });

  it('captures an explicit reason when backend load fails', async () => {
    const c = createClassifier({
      fetchImpl: fetchReturning(manifestWithInlineMap()),
      backendFactory: () => ({
        async load() {
          throw new Error('missing model artifact');
        },
        async infer() {
          return [];
        },
        dispose() {},
      }),
    });
    await c.init();
    expect(c.available).toBe(false);
    expect(c.state).toBe('unavailable');
    expect(c.reason).toBe('missing model artifact');
  });

  it('is unavailable when no backend factory is registered', async () => {
    const c = createClassifier({ fetchImpl: fetchReturning(manifestWithInlineMap()) });
    await c.init();
    expect(c.available).toBe(false);
    expect(c.state).toBe('unavailable');
    expect(c.reason).toBe('no inference backend registered');
  });

  it('classifies posts with an injected backend', async () => {
    const backendFactory = () => ({
      async load() {},
      async infer(text) {
        const logits = new Array(47).fill(0);
        logits[text.length % 47] = 10;
        return logits;
      },
      dispose() {},
    });

    const c = createClassifier({
      fetchImpl: fetchReturning(manifestWithInlineMap()),
      backendFactory,
    });
    await c.init();
    expect(c.available).toBe(true);

    const result = await c.classifyPosts(['aaa', 'b', 'aaa']);
    expect(result.mode).toBe('classifier');
    expect(result.posts).toBe(3);
    expect(result.labels.length).toBeGreaterThan(0);
    const totalCount = result.labels.reduce((a, l) => a + l.count, 0);
    expect(totalCount).toBe(3);
  });

  it('uses the supplied app base URL for manifest and backend assets', async () => {
    const fetched = [];
    let loadCtx = null;
    const backendFactory = () => ({
      async load(_manifest, ctx) {
        loadCtx = ctx;
      },
      async infer() {
        return new Array(47).fill(0);
      },
      dispose() {},
    });

    const c = createClassifier({
      baseUrl: '/nostr-brainmaker/',
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => manifestWithInlineMap() };
      },
      backendFactory,
    });

    await c.init();

    expect(fetched).toEqual(['/nostr-brainmaker/models/1char/manifest.json']);
    expect(loadCtx).toEqual({ baseUrl: '/nostr-brainmaker/', basePath: 'models/1char/' });
  });

  it('throws on classifyPosts before init', async () => {
    const c = createClassifier({ fetchImpl: fetchReturning(manifestWithInlineMap()) });
    await expect(c.classifyPosts(['x'])).rejects.toThrow();
  });
});
