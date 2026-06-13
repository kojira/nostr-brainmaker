import { describe, it, expect } from 'vitest';
import { renderBrainFromPosts } from '../src/brain.js';

function createFakeCanvas() {
  const calls = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    font: '',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    bezierCurveTo() {},
    fill() {},
    stroke() {},
    fillRect() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    measureText(text) {
      return { width: text.length * 24 };
    },
    fillText(text, x, y) {
      calls.push({ text, x, y, font: this.font, fillStyle: this.fillStyle });
    },
  };
  return {
    width: 0,
    height: 0,
    getContext() {
      return ctx;
    },
    calls,
  };
}

function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

describe('renderBrainFromPosts', () => {
  it('renders one glyph per post without collapsing repeated chars', () => {
    const canvas = createFakeCanvas();
    const perPost = [
      { id: 0, char: '愛', prob: 0.9 },
      { id: 0, char: '愛', prob: 0.8 },
      { id: 1, char: '眠', prob: 0.7 },
    ];

    const random = sequenceRandom([0.05, 0.15, 0.35, 0.25, 0.65, 0.4, 0.85, 0.55]);
    const result = renderBrainFromPosts(canvas, perPost, { name: 'alice' }, { random });

    expect(result.count).toBe(3);
    expect(result.placed).toHaveLength(3);
    expect(result.placed.filter((item) => item.post.char === '愛')).toHaveLength(2);
  });

  it('shrinks all glyphs uniformly when post count is high', () => {
    const canvas = createFakeCanvas();
    const perPost = Array.from({ length: 180 }, (_, id) => ({ id: id % 46, char: '愛', prob: 0.9 }));

    const result = renderBrainFromPosts(canvas, perPost, {}, { random: Math.random });

    expect(result.fontSize).toBeLessThan(56);
    expect(new Set(result.placed.map((item) => item.fontSize))).toEqual(new Set([result.fontSize]));
  });
});
