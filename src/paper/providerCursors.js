// src/paper/providerCursors.js — Pure per-provider cursor/watermark helpers.
//
// No DB, no network, no clock — deterministic and fully unit-testable. The DB
// read/write of cursors lives in src/database/paperRuntime.js; the ingestion
// orchestration lives in scripts/runPaperTradingOnce.js. This module only holds
// the pure decisions: what `since` to fetch from, and what the next watermark
// should be, given a prior cursor.
//
// Watermark model: a provider cursor is the maximum `published_at` (UTC ISO)
// among rows we have successfully persisted. Both live providers expose a
// documented published-time delta parameter (Alpaca `start`, Benzinga
// `publishedSince`), so the same watermark drives both. Dedup on
// (provider, provider_event_id) makes a small boundary re-fetch harmless.

/** Default bound on pages followed per provider per cycle. */
export const DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE = 3;
export const MAX_PROVIDER_MAX_PAGES_PER_CYCLE = 10;

/** Cursor kind persisted with every row (single strategy today). */
export const CURSOR_KIND = 'published_watermark';

function parseMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Date.parse(value);
}

/**
 * Resolve the `since` a provider should fetch from this cycle. The cursor only
 * ever NARROWS the window (never widens past the fallback lookback floor), so a
 * long outage never triggers an unbounded historical backfill, and a normal
 * cycle resumes exactly from the retained watermark.
 *
 * @param {object} args
 * @param {string|null} args.cursorValue  retained watermark (UTC ISO) or null
 * @param {string} args.fallbackSinceIso  lookback floor (now - newsLookback)
 * @param {number} args.nowMs
 * @returns {string} UTC ISO `since`
 */
export function resolveProviderSince({ cursorValue = null, fallbackSinceIso, nowMs = Date.now() } = {}) {
  const fallbackMs = parseMs(fallbackSinceIso);
  const floorMs = Number.isFinite(fallbackMs) ? fallbackMs : nowMs;
  const cursorMs = parseMs(cursorValue);
  const sinceMs = Number.isFinite(cursorMs) ? Math.max(cursorMs, floorMs) : floorMs;
  return new Date(sinceMs).toISOString();
}

/**
 * Compute the next cursor watermark. Advances only forward: a successful ingest
 * that persisted rows moves the watermark to the newest persisted published_at;
 * an empty (nothing persisted) success leaves it unchanged.
 *
 * @param {object} args
 * @param {string|null} args.priorCursor
 * @param {string|null} args.maxPublishedAt  newest published_at persisted, or null
 * @returns {string|null}
 */
export function nextCursorValue({ priorCursor = null, maxPublishedAt = null } = {}) {
  const nextMs = parseMs(maxPublishedAt);
  if (!Number.isFinite(nextMs)) return priorCursor ?? null; // nothing new persisted
  const priorMs = parseMs(priorCursor);
  if (Number.isFinite(priorMs) && priorMs >= nextMs) return priorCursor; // never go backwards
  return new Date(nextMs).toISOString();
}

/** Clamp a requested per-cycle page bound to [1, MAX]. */
export function clampMaxPages(value, fallback = DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, MAX_PROVIDER_MAX_PAGES_PER_CYCLE);
}
