// Calendar-day date-range helpers. No DOM / network here so they are easy to test.
//
// Definition of "直近N日間" used throughout the app:
//   today + the previous (N-1) days, in the user's *local* timezone.
// i.e. the window starts at local midnight N-1 days ago and ends "now".
// This avoids the rolling now-minus-N*24h behavior that can hide today's
// early posts or surface posts from N days + a few hours ago.

/** Local midnight (00:00:00.000) of the given date. */
export function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Stable per-local-day key, e.g. "2026-6-12". */
export function localDayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Compute the "直近N日間" window in local time.
 * Returns { days, start, end, sinceSec, untilSec } where start is local
 * midnight (N-1) days before `now`, and end is `now` (inclusive upper bound).
 */
export function recentDayWindow(days, now = new Date()) {
  const n = Math.max(1, Math.floor(Number(days) || 1));
  const end = new Date(now);
  const start = startOfLocalDay(now);
  start.setDate(start.getDate() - (n - 1));
  return {
    days: n,
    start,
    end,
    sinceSec: Math.floor(start.getTime() / 1000),
    untilSec: Math.floor(end.getTime() / 1000),
  };
}

/** Localized date string for display (delegates to toLocaleDateString). */
export function formatDate(date) {
  return new Date(date).toLocaleDateString();
}

/**
 * Human-facing label for the *requested* window, e.g. "2026/6/6 〜 2026/6/12".
 * Always spans the full N days regardless of whether posts exist on each day.
 */
export function rangeLabel(days, now = new Date()) {
  const w = recentDayWindow(days, now);
  return `${formatDate(w.start)} 〜 ${formatDate(w.end)}`;
}

/**
 * Stats about the days that actually had posts, for an optional secondary
 * display so users can see the active span without being misled into thinking
 * it is the whole requested window.
 * `events` items need a numeric `created_at` (unix seconds).
 * Returns null when there are no events.
 */
export function activeDayStats(events) {
  const dayKeys = new Set();
  let firstSec = Infinity;
  let lastSec = -Infinity;
  for (const e of events || []) {
    if (!e || typeof e.created_at !== 'number') continue;
    firstSec = Math.min(firstSec, e.created_at);
    lastSec = Math.max(lastSec, e.created_at);
    dayKeys.add(localDayKey(e.created_at * 1000));
  }
  if (!dayKeys.size) return null;
  return { activeDays: dayKeys.size, firstSec, lastSec };
}
