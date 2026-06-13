import { describe, it, expect } from 'vitest';
import { LABELS, LABEL_DEFS, labelIdOf, buildLabelListText } from '../scripts/lib/labels.js';
import { contentHash } from '../scripts/lib/text.js';
import {
  computeDeficits, buildSynthesisPrompt, parseSynthesisResponse,
  filterCandidates, makeSyntheticRecord,
} from '../scripts/lib/synth.js';

describe('computeDeficits', () => {
  it('missing labels count as 0 (all 46 below an empty counts map)', () => {
    const d = computeDeficits({}, { min: 5 });
    expect(d.length).toBe(46);
    for (const row of d) {
      expect(row.have).toBe(0);
      expect(row.need).toBe(5);
    }
    // 同 need は label_id 昇順。
    expect(d[0].label).toBe(LABELS[0]);
  });

  it('respects min and excludes satisfied labels in auto mode', () => {
    const counts = {};
    for (const l of LABELS) counts[l] = 50;
    counts['虜'] = 1;
    const d = computeDeficits(counts, { min: 50 });
    expect(d.length).toBe(1);
    expect(d[0]).toEqual({ label: '虜', label_id: labelIdOf('虜'), have: 1, need: 49 });
  });

  it('restricts to given labels (satisfied ones included with need 0)', () => {
    const d = computeDeficits({ '犬': 60, '猫': 2 }, { min: 50, labels: ['犬', '猫'] });
    expect(d.map((r) => r.label)).toEqual(['猫', '犬']);
    expect(d[0].need).toBe(48);
    expect(d[1].need).toBe(0);
  });

  it('throws on an invalid label', () => {
    expect(() => computeDeficits({}, { min: 50, labels: ['zzz'] })).toThrow(/無効なラベル/);
  });

  it('normalizes label chars (full-width Ｈ)', () => {
    const d = computeDeficits({ H: 3 }, { min: 50, labels: ['Ｈ'] });
    expect(d[0].label).toBe('H');
    expect(d[0].have).toBe(3);
    expect(d[0].need).toBe(47);
  });

  it('sorts by need desc', () => {
    const d = computeDeficits({ '虜': 10, '犬': 40, '猫': 0 }, { min: 50, labels: ['虜', '犬', '猫'] });
    expect(d.map((r) => r.label)).toEqual(['猫', '虜', '犬']);
    expect(d.map((r) => r.need)).toEqual([50, 40, 10]);
  });
});

describe('buildSynthesisPrompt', () => {
  it('contains label, definition, count, full label list, and JSON instruction', () => {
    const p = buildSynthesisPrompt('猫', { count: 7 });
    expect(p).toContain(`対象ラベル: 猫 = ${LABEL_DEFS['猫']}`);
    expect(p).toContain('7件');
    expect(p).toContain(buildLabelListText());
    expect(p).toContain('{"posts"');
  });

  it('includes example posts marked as style reference', () => {
    const p = buildSynthesisPrompt('猫', {
      count: 3,
      examples: ['うちの猫が膝から降りない', '猫カフェ行きたい'],
    });
    expect(p).toContain('文体の参考');
    expect(p).toContain('うちの猫が膝から降りない');
    expect(p).toContain('猫カフェ行きたい');
  });

  it('omits the style-reference block without examples', () => {
    expect(buildSynthesisPrompt('猫', { count: 3 })).not.toContain('文体の参考');
  });

  it('throws on an invalid label', () => {
    expect(() => buildSynthesisPrompt('zzz', { count: 3 })).toThrow(/無効なラベル/);
  });
});

describe('parseSynthesisResponse', () => {
  it('accepts {posts:[...]} of strings', () => {
    const r = parseSynthesisResponse({ posts: ['ねむい', '猫かわいい'] });
    expect(r.ok).toBe(true);
    expect(r.posts).toEqual(['ねむい', '猫かわいい']);
  });

  it('trims entries and drops empty/non-string ones', () => {
    const r = parseSynthesisResponse({ posts: ['  ねむい  ', '', '   ', 42, null] });
    expect(r.ok).toBe(true);
    expect(r.posts).toEqual(['ねむい']);
  });

  it('rejects non-array / garbage input', () => {
    expect(parseSynthesisResponse(null).ok).toBe(false);
    expect(parseSynthesisResponse({}).ok).toBe(false);
    expect(parseSynthesisResponse({ posts: 'ねむい' }).ok).toBe(false);
    expect(parseSynthesisResponse('garbage').ok).toBe(false);
    expect(parseSynthesisResponse({ posts: [] }).ok).toBe(false);
    expect(parseSynthesisResponse({ posts: ['', '  '] }).ok).toBe(false);
  });
});

describe('filterCandidates', () => {
  const jp1 = '今日はねむすぎて何もできない';
  const jp2 = '猫がかわいくてたまらん';

  it('dedups within a batch', () => {
    const { accepted, rejected } = filterCandidates([jp1, jp1], { seenHashes: new Set() });
    expect(accepted).toEqual([jp1]);
    expect(rejected).toEqual([{ content: jp1, reason: 'duplicate' }]);
  });

  it('dedups against seenHashes (normalized content hash)', () => {
    const seen = new Set([contentHash(jp1)]);
    const { accepted, rejected } = filterCandidates([jp1, jp2], { seenHashes: seen });
    expect(accepted).toEqual([jp2]);
    expect(rejected[0].reason).toBe('duplicate');
  });

  it('enforces length bounds', () => {
    const { accepted, rejected } = filterCandidates(['短い', 'あ'.repeat(201)], { seenHashes: new Set() });
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['too_short', 'too_long']);
  });

  it('rejects non-Japanese content', () => {
    const { accepted, rejected } = filterCandidates(
      ['this is an english only post'],
      { seenHashes: new Set() },
    );
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe('not_japanese');
  });

  it('accepts distinct valid Japanese posts', () => {
    const { accepted, rejected } = filterCandidates([jp1, jp2], { seenHashes: new Set() });
    expect(accepted).toEqual([jp1, jp2]);
    expect(rejected).toEqual([]);
  });
});

describe('makeSyntheticRecord', () => {
  const content = '猫が膝の上で寝てて動けない';

  it('builds a labeled-record-shaped object with synthetic markers', () => {
    const r = makeSyntheticRecord(content, '猫', {
      model: 'gemini-3.1-flash-lite',
      verified: true,
      confidence: 0.85,
      rationale: '猫への関心が中心。',
      createdAt: 1750000000,
    });
    expect(r.event_id).toBe(`syn-${contentHash(content)}`);
    expect(r.pubkey).toBe('synthetic');
    expect(r.created_at).toBe(1750000000);
    expect(r.content).toBe(content);
    expect(r.label).toBe('猫');
    expect(r.label_id).toBe(labelIdOf('猫'));
    expect(r.confidence).toBe(0.85);
    expect(r.rationale).toBe('猫への関心が中心。');
    expect(r.is_uncertain).toBe(false);
    expect(r.pass).toBe(1);
    expect(r.source).toBe('synthetic:gemini-3.1-flash-lite');
    expect(r.synthetic).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('defaults confidence to 0.9 and rationale to 逆生成（synthetic）', () => {
    const r = makeSyntheticRecord(content, '猫', { model: 'm', verified: false, createdAt: 1 });
    expect(r.confidence).toBe(0.9);
    expect(r.rationale).toBe('逆生成（synthetic）');
    expect(r.verified).toBe(false);
  });

  it('event_id is deterministic from content', () => {
    const a = makeSyntheticRecord(content, '猫', { model: 'm', verified: false, createdAt: 1 });
    const b = makeSyntheticRecord(content, '猫', { model: 'm', verified: false, createdAt: 2 });
    expect(a.event_id).toBe(b.event_id);
  });
});
