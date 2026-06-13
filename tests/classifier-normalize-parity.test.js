import { describe, it, expect } from 'vitest';
import fixtures from './fixtures/normalization-parity.json';
import { normalizeForClassifier } from '../src/classifier/normalize.js';

// The same fixtures are checked from Python via `python3 finetune_smoke/normalize.py --check`.
// Both sides must agree so browser inference sees the text distribution training produced.
describe('normalizeForClassifier parity fixtures', () => {
  for (const { input, expected } of fixtures.cases) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeForClassifier(input)).toBe(expected);
    });
  }
});
