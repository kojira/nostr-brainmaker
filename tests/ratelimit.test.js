import { describe, it, expect } from 'vitest';
import { RateLimiter, runPool } from '../scripts/lib/ratelimit.js';

describe('runPool', () => {
  it('preserves order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runPool(items, async (x) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return x * 10;
    }, { concurrency: 3 });
    expect(results.map((r) => r.value)).toEqual([10, 20, 30, 40, 50]);
  });

  it('bounds concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    }, { concurrency: 4 });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('captures a thrown worker error instead of rejecting', async () => {
    const results = await runPool([1, 2, 3], async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    }, { concurrency: 2 });
    expect(results[0]).toMatchObject({ ok: true, value: 1 });
    expect(results[1].ok).toBe(false);
    expect(results[1].error.message).toBe('boom');
    expect(results[2]).toMatchObject({ ok: true, value: 3 });
  });
});

describe('RateLimiter', () => {
  it('allows N requests within the window without long waits', async () => {
    const rl = new RateLimiter({ rpm: 5, windowMs: 1000 });
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await rl.acquire();
    }
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('throttles the (N+1)th request until the window slides', async () => {
    const rl = new RateLimiter({ rpm: 2, windowMs: 80 });
    const start = Date.now();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire(); // must wait for the window to slide
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });
});
