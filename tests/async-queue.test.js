import { describe, it, expect } from 'vitest';
import { AsyncQueue, QUEUE_DONE } from '../scripts/lib/async-queue.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('AsyncQueue', () => {
  it('preserves push/pull ordering', async () => {
    const q = new AsyncQueue();
    await q.push('a');
    await q.push('b');
    await q.push('c');
    expect(q.size).toBe(3);
    expect(await q.pull()).toBe('a');
    expect(await q.pull()).toBe('b');
    expect(await q.pull()).toBe('c');
  });

  it('pull before push waits then resolves', async () => {
    const q = new AsyncQueue();
    let resolved = false;
    const p = q.pull().then((v) => { resolved = true; return v; });
    await tick();
    expect(resolved).toBe(false);
    await q.push('x');
    expect(await p).toBe('x');
    expect(resolved).toBe(true);
  });

  it('close drains buffer then returns QUEUE_DONE', async () => {
    const q = new AsyncQueue();
    await q.push('1');
    await q.push('2');
    q.close();
    expect(q.closed).toBe(true);
    expect(await q.pull()).toBe('1');
    expect(await q.pull()).toBe('2');
    expect(await q.pull()).toBe(QUEUE_DONE);
    expect(await q.pull()).toBe(QUEUE_DONE);
  });

  it('close wakes waiting pullers with QUEUE_DONE', async () => {
    const q = new AsyncQueue();
    const p1 = q.pull();
    const p2 = q.pull();
    q.close();
    expect(await p1).toBe(QUEUE_DONE);
    expect(await p2).toBe(QUEUE_DONE);
  });

  it('applies backpressure with highWaterMark', async () => {
    const q = new AsyncQueue({ highWaterMark: 1 });
    await q.push('a'); // size 1, ok
    let pushResolved = false;
    const p = q.push('b').then(() => { pushResolved = true; }); // exceeds HWM, waits
    await tick();
    expect(pushResolved).toBe(false);
    expect(q.size).toBe(2);
    // drain via a pull
    expect(await q.pull()).toBe('a');
    await p;
    expect(pushResolved).toBe(true);
  });

  it('throws on push after close', async () => {
    const q = new AsyncQueue();
    q.close();
    expect(() => q.push('x')).toThrow();
  });

  it('routes push directly to a waiting puller', async () => {
    const q = new AsyncQueue();
    const pullP = q.pull();
    await q.push('direct');
    expect(await pullP).toBe('direct');
    expect(q.size).toBe(0);
  });
});
