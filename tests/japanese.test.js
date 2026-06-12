import { describe, it, expect } from 'vitest';
import { detectJapanese } from '../scripts/lib/japanese.js';

describe('detectJapanese', () => {
  it('accepts ordinary Japanese text', () => {
    const r = detectJapanese('おなかすいた、ごはん食べたい');
    expect(r.isJapanese).toBe(true);
    expect(r.excludeReason).toBe(null);
  });

  it('rejects English-only text', () => {
    const r = detectJapanese('hello world this is plain english text');
    expect(r.isJapanese).toBe(false);
    expect(r.excludeReason).toBe('not_japanese');
  });

  it('rejects too-short text', () => {
    const r = detectJapanese('あ');
    expect(r.isJapanese).toBe(false);
    expect(r.excludeReason).toBe('too_short');
  });

  it('rejects Chinese-only (kana ratio 0) via franc_non_jp', () => {
    const r = detectJapanese('我们今天去公园散步看风景非常开心');
    expect(r.kanaRatio).toBe(0);
    expect(r.francLang).toBe('cmn');
    expect(r.isJapanese).toBe(false);
    expect(r.excludeReason).toBe('franc_non_jp');
  });

  it('does not exclude on franc und (short kana text passes heuristic)', () => {
    // かな比率が高く長さも足りる短文。franc は 'und' を返しうるが除外しない。
    const r = detectJapanese('ねむいなあ');
    expect(r.isJapanese).toBe(true);
    expect(r.excludeReason).toBe(null);
  });
});
