import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import {
  indexLabelMap,
  softmax,
  topK,
  labelForIndex,
  aggregateLabels,
} from '../src/classifier/labelMap.js';

describe('indexLabelMap', () => {
  it('indexes the real production label map', () => {
    const indexed = indexLabelMap(labelMapData);
    expect(indexed.count).toBe(46);
    expect(indexed.byId.get(0).char).toBe('愛');
    expect(indexed.byId.get(45).char).toBe('国');
    expect(indexed.qa.id).toBe(46);
  });

  it('throws on an invalid label map', () => {
    expect(() => indexLabelMap({})).toThrow();
  });
});

describe('softmax', () => {
  it('uniform inputs produce equal probabilities summing to ~1', () => {
    const p = softmax([0, 0, 0]);
    expect(p).toHaveLength(3);
    for (const v of p) expect(v).toBeCloseTo(1 / 3, 6);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('is numerically stable for large values', () => {
    const p = softmax([1000, 1001, 1002]);
    for (const v of p) expect(Number.isNaN(v)).toBe(false);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('returns [] for empty input', () => {
    expect(softmax([])).toEqual([]);
  });
});

describe('topK', () => {
  it('returns the top-k sorted by prob desc', () => {
    const result = topK([0.1, 0.7, 0.2], 2);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(1);
    expect(result[1].index).toBe(2);
  });
});

describe('aggregateLabels', () => {
  it('tallies counts and shares', () => {
    const indexed = indexLabelMap(labelMapData);
    const result = aggregateLabels(
      [{ index: 0, prob: 1 }, { index: 0, prob: 1 }, { index: 45, prob: 1 }],
      indexed,
    );
    expect(result[0].id).toBe(0);
    expect(result[0].char).toBe('愛');
    expect(result[0].count).toBe(2);
    expect(result[0].share).toBeCloseTo(0.667, 2);
    expect(result.some((l) => l.id === 45)).toBe(true);
  });

  it('returns [] for empty input', () => {
    const indexed = indexLabelMap(labelMapData);
    expect(aggregateLabels([], indexed)).toEqual([]);
  });
});

describe('labelForIndex', () => {
  it('maps the QA index and unknown index', () => {
    const indexed = indexLabelMap(labelMapData);
    expect(labelForIndex(46, indexed).char).toBe('分類不能');
    expect(labelForIndex(999, indexed).char).toBe('?');
  });
});
