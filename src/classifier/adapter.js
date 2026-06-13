// The integration seam between the browser app and a trained 1-char classifier.
// Always graceful: if no manifest or no backend is present, it stays 'unavailable'
// and the caller falls back to the heuristic render.

import { loadManifest, loadLabelMap } from './manifest.js';
import { indexLabelMap, softmax, aggregateLabels } from './labelMap.js';
import { normalizeForClassifier } from './normalize.js';
import { resolveBackendFactory } from './backend.js';

export function createClassifier(opts = {}) {
  const { basePath, baseUrl, fetchImpl, backendFactory, maxPosts = 200 } = opts;

  let state = 'idle'; // 'idle' | 'ready' | 'unavailable'
  let reason = null;
  let manifest = null;
  let indexed = null;
  let backend = null;

  async function init() {
    if (state !== 'idle') return state;
    try {
      const loaded = await loadManifest({ basePath, baseUrl, fetchImpl });
      if (!loaded.present) {
        state = 'unavailable';
        reason = loaded.error || 'manifest absent';
        return state;
      }
      manifest = loaded.manifest;

      const rawMap = await loadLabelMap(loaded, { fetchImpl });
      indexed = indexLabelMap(rawMap);

      const factory = backendFactory || resolveBackendFactory();
      if (!factory) {
        state = 'unavailable';
        reason = 'no inference backend registered';
        return state;
      }

      backend = factory(manifest);
      await backend.load(manifest, { baseUrl: loaded.baseUrl, basePath: loaded.basePath });
      state = 'ready';
      return state;
    } catch (err) {
      state = 'unavailable';
      reason = err.message;
      return state;
    }
  }

  async function classifyPosts(texts) {
    if (state !== 'ready') {
      throw new Error('classifier not ready: ' + reason);
    }
    const slice = (texts || []).slice(0, maxPosts);
    const perPost = [];
    for (const t of slice) {
      const norm = normalizeForClassifier(t);
      if (!norm) continue;
      const out = await backend.infer(norm);
      const probs = softmax(out);
      let bi = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[bi]) bi = i;
      }
      perPost.push({ index: bi, prob: probs[bi] });
    }
    const labels = aggregateLabels(perPost, indexed);
    return {
      mode: 'classifier',
      model: manifest?.model?.name || 'unknown',
      posts: perPost.length,
      labels,
    };
  }

  return {
    init,
    classifyPosts,
    get available() {
      return state === 'ready';
    },
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    get manifest() {
      return manifest;
    },
  };
}
