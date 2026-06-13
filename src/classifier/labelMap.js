// Pure helpers for working with the 1-char classifier label map and model outputs.
// No DOM, no network — safe to unit test and reuse from Node.

export function indexLabelMap(raw) {
  if (!raw || !Array.isArray(raw.labels)) {
    throw new Error('invalid label map');
  }
  const byId = new Map();
  for (const label of raw.labels) {
    byId.set(label.id, label);
  }
  return {
    version: raw.version ?? null,
    count: raw.labels.length,
    labels: raw.labels,
    byId,
    qa: raw.qa ?? null,
  };
}

export function softmax(logits) {
  if (!logits || logits.length === 0) return [];
  let max = -Infinity;
  for (const v of logits) {
    if (v > max) max = v;
  }
  const exps = logits.map((v) => Math.exp(v - max));
  let sum = 0;
  for (const v of exps) sum += v;
  return exps.map((v) => v / sum);
}

export function topK(probs, k = 3) {
  const indexed = probs.map((prob, index) => ({ index, prob }));
  indexed.sort((a, b) => b.prob - a.prob);
  return indexed.slice(0, Math.min(k, probs.length));
}

export function labelForIndex(index, indexed) {
  if (indexed.byId.has(index)) {
    return indexed.byId.get(index);
  }
  if (indexed.qa && indexed.qa.id === index) {
    return indexed.qa;
  }
  return { id: index, char: '?', def: '' };
}

export function aggregateLabels(perPost, indexed) {
  const total = perPost.length;
  if (total === 0) return [];
  const counts = new Map();
  for (const post of perPost) {
    const labelIndex = post.id ?? post.index;
    counts.set(labelIndex, (counts.get(labelIndex) || 0) + 1);
  }
  const out = [];
  for (const [index, count] of counts) {
    const label = labelForIndex(index, indexed);
    out.push({
      id: label.id,
      char: label.char,
      def: label.def,
      count,
      share: count / total,
    });
  }
  out.sort((a, b) => (b.count - a.count) || (a.id - b.id));
  return out;
}
