import { describe, it, expect } from 'vitest';
import {
  startOfLocalDay,
  localDayKey,
  recentDayWindow,
  rangeLabel,
  activeDayStats,
} from '../src/daterange.js';

const DAY = 24 * 60 * 60 * 1000;

describe('startOfLocalDay', () => {
  it('zeroes the time-of-day in local time', () => {
    const d = startOfLocalDay(new Date('2026-06-12T15:34:21'));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
});

describe('recentDayWindow', () => {
  it('starts at local midnight and ends at now', () => {
    const now = new Date('2026-06-12T15:00:00');
    const w = recentDayWindow(7, now);
    expect(w.days).toBe(7);
    expect(w.start.getHours()).toBe(0);
    expect(w.end.getTime()).toBe(now.getTime());
  });

  it('spans today + previous (N-1) calendar days', () => {
    const now = new Date('2026-06-12T15:00:00');
    const w = recentDayWindow(7, now);
    // start should be 6 days before today's local midnight => 2026-06-06
    const expectedStart = startOfLocalDay(now);
    expectedStart.setDate(expectedStart.getDate() - 6);
    expect(w.start.getTime()).toBe(expectedStart.getTime());
    expect(localDayKey(w.start)).toBe('2026-6-6');
  });

  it('N=1 means just today (from local midnight)', () => {
    const now = new Date('2026-06-12T09:30:00');
    const w = recentDayWindow(1, now);
    expect(w.start.getTime()).toBe(startOfLocalDay(now).getTime());
  });

  it('sinceSec covers strictly more than (N-1)*24h and at most N*24h before now', () => {
    const now = new Date('2026-06-12T15:00:00');
    const w = recentDayWindow(7, now);
    const ageMs = now.getTime() - w.start.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(6 * DAY); // at least the previous 6 full days
    expect(ageMs).toBeLessThan(7 * DAY); // never reaches a full 7*24h
    expect(w.sinceSec).toBe(Math.floor(w.start.getTime() / 1000));
  });

  it('clamps non-positive / invalid days to 1', () => {
    const now = new Date('2026-06-12T15:00:00');
    expect(recentDayWindow(0, now).days).toBe(1);
    expect(recentDayWindow(-5, now).days).toBe(1);
    expect(recentDayWindow(undefined, now).days).toBe(1);
  });
});

describe('rangeLabel', () => {
  it('always spans the full requested window', () => {
    const now = new Date('2026-06-12T15:00:00');
    const label = rangeLabel(7, now);
    expect(label).toContain('〜');
    // both endpoints present
    expect(label.split('〜').length).toBe(2);
  });
});

describe('activeDayStats', () => {
  it('returns null when there are no events', () => {
    expect(activeDayStats([])).toBe(null);
    expect(activeDayStats(null)).toBe(null);
  });

  it('counts distinct local days and the min/max timestamps', () => {
    const base = Math.floor(new Date('2026-06-10T12:00:00').getTime() / 1000);
    const events = [
      { created_at: base },
      { created_at: base + 60 }, // same day
      { created_at: base + 2 * 24 * 60 * 60 }, // +2 days
    ];
    const stats = activeDayStats(events);
    expect(stats.activeDays).toBe(2);
    expect(stats.firstSec).toBe(base);
    expect(stats.lastSec).toBe(base + 2 * 24 * 60 * 60);
  });

  it('ignores malformed events', () => {
    const stats = activeDayStats([{ created_at: 1000 }, null, { foo: 1 }]);
    expect(stats.activeDays).toBe(1);
  });
});
