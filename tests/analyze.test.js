import { describe, it, expect } from 'vitest';
import {
  cleanText,
  tokenize,
  isStopword,
  countFrequencies,
  topTerms,
  categorize,
  buildBrainModel,
} from '../src/analyze.js';

describe('cleanText', () => {
  it('strips urls, nostr: links and npub mentions', () => {
    const out = cleanText('hello https://example.com/x nostr:npub1abc npub1def world');
    expect(out).not.toMatch(/https?:/);
    expect(out).not.toMatch(/nostr:/);
    expect(out).not.toMatch(/npub1/);
    expect(out).toContain('hello');
    expect(out).toContain('world');
  });
});

describe('tokenize', () => {
  it('lowercases latin words and drops 1-char latin', () => {
    const t = tokenize('Hello World a I');
    expect(t).toContain('hello');
    expect(t).toContain('world');
    expect(t).not.toContain('a');
  });

  it('extracts japanese runs and bigrams', () => {
    const t = tokenize('開発が楽しい');
    expect(t).toContain('開発'); // run
    // bigrams from longer runs are present
    expect(t.some((x) => x.length === 2)).toBe(true);
  });

  it('ignores pure punctuation/whitespace', () => {
    expect(tokenize('  ... !!!  ')).toEqual([]);
  });
});

describe('isStopword', () => {
  it('flags english and japanese function words', () => {
    expect(isStopword('the')).toBe(true);
    expect(isStopword('の')).toBe(true);
    expect(isStopword('nostr')).toBe(false);
  });
});

describe('countFrequencies', () => {
  it('counts and removes stopwords', () => {
    const counts = countFrequencies(['code', 'code', 'the', 'bug']);
    expect(counts.get('code')).toBe(2);
    expect(counts.get('bug')).toBe(1);
    expect(counts.has('the')).toBe(false);
  });
});

describe('topTerms', () => {
  it('returns most frequent terms sorted desc', () => {
    const text = 'bitcoin bitcoin bitcoin nostr nostr relay';
    const top = topTerms(text, 5);
    expect(top[0].term).toBe('bitcoin');
    expect(top[0].count).toBe(3);
    expect(top.map((t) => t.term)).toContain('nostr');
  });

  it('respects the n limit', () => {
    const text = 'aa bb cc dd ee ff gg hh'.replace(/\w+/g, (w) => `${w} ${w}`);
    expect(topTerms(text, 3).length).toBeLessThanOrEqual(3);
  });
});

describe('categorize', () => {
  it('maps known keywords to categories', () => {
    expect(categorize('好き')).toBe('愛情');
    expect(categorize('開発')).toBe('仕事');
    expect(categorize('疲れた')).toBe('悩み');
    expect(categorize('ゲーム')).toBe('遊び');
    expect(categorize('bitcoin')).toBe('欲望');
  });
  it('falls back to その他', () => {
    expect(categorize('xyzzy')).toBe('その他');
  });
});

describe('buildBrainModel', () => {
  it('builds terms, categories and total', () => {
    const text = 'code code code 好き 好き ゲーム bitcoin bitcoin';
    const model = buildBrainModel(text, 10);
    expect(model.terms.length).toBeGreaterThan(0);
    expect(model.total).toBeGreaterThan(0);
    expect(Object.keys(model.categories).length).toBeGreaterThan(0);
    // weights normalized to [0,1], top term weight === 1
    expect(model.terms[0].weight).toBeCloseTo(1, 5);
    for (const t of model.terms) {
      expect(t.weight).toBeGreaterThan(0);
      expect(t.weight).toBeLessThanOrEqual(1);
      expect(t.category).toBeTruthy();
    }
  });

  it('handles empty input gracefully', () => {
    const model = buildBrainModel('', 10);
    expect(model.terms).toEqual([]);
    expect(model.total).toBe(0);
  });
});
