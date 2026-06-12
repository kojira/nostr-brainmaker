import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recentDayWindow } from '../src/daterange.js';

// Mock the relay pool with a single in-memory "relay" whose dataset lives on
// globalThis.__DATASET__. querySync honours since/until/limit just like a real
// relay (newest-first, capped at `limit`), so paging behaviour is observable.
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    querySync(_relays, filter) {
      const all = globalThis.__DATASET__ || [];
      const matched = all
        .filter((e) => e.created_at >= filter.since && e.created_at <= filter.until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit);
      return Promise.resolve(matched);
    }
    close() {}
  },
}));

const { fetchRecentNotes } = await import('../src/nostr.js');

const FAST = { limit: 500, timeoutMs: 50 };

/** Build `n` notes evenly spread across the given recent-day window. */
function notesInWindow(days, n) {
  const w = recentDayWindow(days);
  const span = w.untilSec - w.sinceSec;
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    created_at: w.untilSec - Math.floor((span * i) / n) - 1, // strictly inside window
    content: `note ${i}`,
  }));
}

beforeEach(() => {
  globalThis.__DATASET__ = [];
});

describe('fetchRecentNotes paging', () => {
  it('collects more than one page of notes (not capped at limit)', async () => {
    globalThis.__DATASET__ = notesInWindow(7, 1200);
    const { events } = await fetchRecentNotes('pub', { days: 7, ...FAST });
    expect(events.length).toBe(1200);
    // Sorted newest-first and all unique.
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(1200);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].created_at).toBeGreaterThanOrEqual(events[i].created_at);
    }
  });

  it('7-day and 30-day windows differ when older notes exist', async () => {
    // Notes spread across the full 30-day window; only ~1/4 fall in the last 7d.
    globalThis.__DATASET__ = notesInWindow(30, 2000);
    const week = await fetchRecentNotes('pub', { days: 7, ...FAST });
    const month = await fetchRecentNotes('pub', { days: 30, ...FAST });
    expect(month.events.length).toBeGreaterThan(week.events.length);
    expect(month.events.length).toBe(2000);
    // Every 7-day note must be within the 7-day window.
    const weekSince = recentDayWindow(7).sinceSec;
    for (const e of week.events) expect(e.created_at).toBeGreaterThanOrEqual(weekSince);
  });

  it('dedupes notes returned more than once', async () => {
    const base = notesInWindow(7, 10);
    globalThis.__DATASET__ = [...base, ...base.map((e) => ({ ...e }))]; // duplicate ids
    const { events } = await fetchRecentNotes('pub', { days: 7, ...FAST });
    expect(events.length).toBe(10);
  });

  it('respects maxPages so a dense window cannot loop unbounded', async () => {
    // Far more notes than maxPages * limit can cover; the loop must stop early.
    globalThis.__DATASET__ = notesInWindow(7, 5000);
    const { events } = await fetchRecentNotes('pub', { days: 7, limit: 100, timeoutMs: 50, maxPages: 3 });
    // 3 pages * 100 = at most 300 collected, proving the loop is bounded.
    expect(events.length).toBeLessThanOrEqual(300);
    expect(events.length).toBeGreaterThan(100);
  });
});
