import { describe, it, expect } from 'vitest';
import {
  LABELS, QA_LABEL, QA_LABEL_ID, ID_TO_LABEL, LABEL_TO_ID,
  normalizeLabelChar, isValidLabel, labelIdOf, buildLabelListText, buildLabelMap,
} from '../scripts/lib/labels.js';

describe('labels', () => {
  it('LABELS has 46 entries', () => {
    expect(LABELS.length).toBe(46);
  });

  it('ids 0..45 round-trip', () => {
    for (let i = 0; i < 46; i++) {
      const c = ID_TO_LABEL[i];
      expect(LABEL_TO_ID[c]).toBe(i);
      expect(labelIdOf(c)).toBe(i);
    }
  });

  it('normalizeLabelChar converts full-width Ｈ to H and trims', () => {
    expect(normalizeLabelChar('Ｈ')).toBe('H');
    expect(normalizeLabelChar('  愛 ')).toBe('愛');
  });

  it('isValidLabel handles valid/invalid and allowQA', () => {
    expect(isValidLabel('愛')).toBe(true);
    expect(isValidLabel('H')).toBe(true);
    expect(isValidLabel('Ｈ')).toBe(true);
    expect(isValidLabel('zzz')).toBe(false);
    expect(isValidLabel(QA_LABEL)).toBe(false);
    expect(isValidLabel(QA_LABEL, { allowQA: true })).toBe(true);
  });

  it('buildLabelListText contains 0:愛 and 46:分類不能', () => {
    const text = buildLabelListText();
    expect(text).toContain('- 0: 愛 = 愛情・親愛・やさしさ・会いたさ');
    expect(text).toContain(`- 46: ${QA_LABEL} =`);
    expect(text.split('\n').length).toBe(47);
  });

  it('labelIdOf(国) === 45 and QA_LABEL_ID is 46', () => {
    expect(labelIdOf('国')).toBe(45);
    expect(QA_LABEL_ID).toBe(46);
  });

  it('buildLabelMap shape', () => {
    const m = buildLabelMap();
    expect(m.count).toBe(46);
    expect(m.labels.length).toBe(46);
    expect(m.qa.id).toBe(46);
    expect(m.labels[0]).toEqual({ id: 0, char: '愛', def: '愛情・親愛・やさしさ・会いたさ' });
  });
});
