// Live relay integration test — hits the real DEFAULT_RELAYS (no mocks).
// Excluded from `npm test` (which only matches *.test.js); run explicitly with
// `npm run test:live`.
//
// Goal: confirm the 7-day and 30-day retrieval windows do NOT collapse to the
// same fixed slice against live data (the bug fixed by paging via `until`).
import { describe, it, expect } from 'vitest';
import { fetchRecentNotes, resolveInput, DEFAULT_RELAYS } from '../src/nostr.js';
import { recentDayWindow } from '../src/daterange.js';

const NPUB = 'npub1k0jrarx8um0lyw3nmysn50539ky4k8p7gfgzgrsvn8d7lccx3d0s38dczd';

describe('live relay fetch (real DEFAULT_RELAYS)', () => {
  it('7-day and 30-day windows do not collapse to the same result/window', async () => {
    const { pubkey } = resolveInput(NPUB);

    const opts = { relays: DEFAULT_RELAYS, timeoutMs: 10000 };
    const week = await fetchRecentNotes(pubkey, { days: 7, ...opts });
    const month = await fetchRecentNotes(pubkey, { days: 30, ...opts });

    const w7 = recentDayWindow(7);
    const w30 = recentDayWindow(30);

    // The two requested windows are genuinely different time ranges.
    expect(w30.sinceSec).toBeLessThan(w7.sinceSec);

    // Live connectivity sanity: this is an active author, so the relays must
    // return at least some notes. Zero here means a relay/network problem.
    expect(week.events.length + month.events.length).toBeGreaterThan(0);

    // The 30-day window is a superset of the 7-day window and therefore can
    // never contain fewer notes.
    expect(month.events.length).toBeGreaterThanOrEqual(week.events.length);

    // Every returned note actually falls inside its requested window.
    for (const e of week.events) expect(e.created_at).toBeGreaterThanOrEqual(w7.sinceSec);
    for (const e of month.events) expect(e.created_at).toBeGreaterThanOrEqual(w30.sinceSec);

    // Anti-collapse (the core check): the 30-day result must not be an identical
    // fixed slice of the 7-day one. For an active author it either returns
    // strictly more notes, or surfaces at least one note older than 7 days.
    const hasOlderThanWeek = month.events.some((e) => e.created_at < w7.sinceSec);
    expect(month.events.length > week.events.length || hasOlderThanWeek).toBe(true);

    // eslint-disable-next-line no-console
    console.log(`[live] week=${week.events.length} month=${month.events.length} olderThanWeek=${hasOlderThanWeek}`);
  });
});
