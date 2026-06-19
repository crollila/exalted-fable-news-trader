// src/paper/marketHours.js — US regular-session detection for the paper loop.
//
// APPROXIMATION ONLY: Mon-Fri, 09:30-16:00 America/New_York (DST handled by
// Intl). It does NOT model market holidays or half-days — a full exchange
// holiday calendar is deferred. Callers must surface that limitation. Pure
// functions (no network, no DB); the clock is injectable for tests.

/** US regular session bounds in Eastern minutes-of-day: [09:30, 16:00). */
export const MARKET_OPEN_MINUTE = 9 * 60 + 30;
export const MARKET_CLOSE_MINUTE = 16 * 60;

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Decompose a Date/ms into Eastern weekday + minutes-of-day (DST-aware). */
export function easternParts(at = Date.now()) {
  const ms = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    ET_FORMAT.formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  const hour = Number.parseInt(parts.hour, 10);
  const minute = Number.parseInt(parts.minute, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { weekday: parts.weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

/** True when `at` falls within the US regular-session approximation. */
export function isMarketOpen(at = Date.now()) {
  const p = easternParts(at);
  return (
    !!p &&
    WEEKDAYS.has(p.weekday) &&
    p.minutesOfDay >= MARKET_OPEN_MINUTE &&
    p.minutesOfDay < MARKET_CLOSE_MINUTE
  );
}

/** Is `at` a weekend (Sat/Sun in Eastern time)? */
export function isWeekend(at = Date.now()) {
  const p = easternParts(at);
  return !!p && !WEEKDAYS.has(p.weekday);
}

/** Sanitized status label for heartbeats: 'open' | 'closed_weekend' | 'closed'. */
export function marketStatusLabel(at = Date.now()) {
  if (isWeekend(at)) return 'closed_weekend';
  return isMarketOpen(at) ? 'open' : 'closed';
}

/** The standing limitation message (printed once by the loop). */
export const HOLIDAY_LIMITATION_NOTE =
  'NOTE: market-hours gating is Mon-Fri 09:30-16:00 ET only; US market holidays ' +
  'and half-days are NOT modeled (no exchange calendar yet).';
