import { describe, it, expect } from 'vitest';
import { cleanText, contentHash, charRatios, normalizeContent } from '../scripts/lib/text.js';

describe('text helpers', () => {
  it('contentHash is stable and ignores URLs (different URL, same text)', () => {
    const a = 'おなかすいた https://example.com/x';
    const b = 'おなかすいた https://example.com/different-url';
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('contentHash ignores case and collapses runs of whitespace', () => {
    const c = 'Hello World';
    const d = 'hello   world';
    expect(contentHash(c)).toBe(contentHash(d));
  });

  it('cleanText strips URLs, nostr: and npub mentions', () => {
    const t = 'やあ https://example.com nostr:note1abc npub1qqqqqqqq テキスト';
    const cleaned = cleanText(t);
    expect(cleaned).not.toMatch(/https?:\/\//);
    expect(cleaned).not.toMatch(/nostr:/);
    expect(cleaned).not.toMatch(/npub1/);
    expect(cleaned).toContain('やあ');
    expect(cleaned).toContain('テキスト');
  });

  it('charRatios is sane on a known mixed string', () => {
    const r = charRatios('あいうカキ漢字abc');
    expect(r.length).toBe(10);
    expect(r.kanaRatio).toBeCloseTo(5 / 10, 5); // あいうカキ
    expect(r.cjkRatio).toBeCloseTo(7 / 10, 5); // + 漢字
    expect(r.latinRatio).toBeCloseTo(3 / 10, 5); // abc
  });

  it('normalizeContent collapses whitespace and lowercases', () => {
    expect(normalizeContent('  Foo   BAR  ')).toBe('foo bar');
  });
});
