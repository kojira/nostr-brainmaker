import { describe, it, expect } from 'vitest';
import { validateGeminiOutput } from '../scripts/lib/schema.js';

function base(overrides = {}) {
  return {
    label: '愛',
    label_id: 0,
    confidence: 0.9,
    rationale: 'やさしい気持ちが中心。',
    is_uncertain: false,
    ...overrides,
  };
}

describe('validateGeminiOutput', () => {
  it('accepts a valid object', () => {
    const r = validateGeminiOutput(base());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a bad label', () => {
    const r = validateGeminiOutput(base({ label: 'zzz', label_id: 0 }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/label_not_allowed/);
  });

  it('rejects label_id mismatch', () => {
    const r = validateGeminiOutput(base({ label: '愛', label_id: 5 }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/label_id_mismatch/);
  });

  it('rejects confidence > 1', () => {
    const r = validateGeminiOutput(base({ confidence: 1.5 }));
    expect(r.valid).toBe(false);
  });

  it('allowQA toggles 分類不能', () => {
    const obj = base({ label: '分類不能', label_id: 46 });
    expect(validateGeminiOutput(obj, { allowQA: false }).valid).toBe(false);
    expect(validateGeminiOutput(obj, { allowQA: true }).valid).toBe(true);
  });
});
