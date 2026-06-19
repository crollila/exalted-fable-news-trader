// src/eventStudy/measureReactions.js — Fixture-only measurement engine (Phase 4).
//
// Turns PriceSource trades into price_reactions rows for the canonical
// horizons. All writes go through insertPriceReaction, so re-measurement
// replaces rows (idempotent) and status/price consistency is enforced once.
//
// Definitions (docs/event-study-plan.md §4):
// - Anchor: news_events.received_at — when WE could first have acted.
// - Baseline: last trade at or before the anchor (within the lookback).
// - Reaction: last trade STRICTLY AFTER the anchor and at/before
//   anchor + horizon. The baseline trade never doubles as the reaction;
//   a window with no post-anchor trade stores 'no_reaction'.
//
// TEMPORARY FIXTURE EOD POLICY: the 'eod' target is the same UTC calendar
// day at 21:00:00.000Z (≈ 4pm US/Eastern standard close). This is a fixture
// convenience, NOT a real market-session policy — real session calendars,
// half-days, DST, and the market_closed status arrive with the real
// market-data client step. market_closed is never emitted by this engine.
//
// Fixture-only: uses the PriceSource contract; no market-data APIs.

import { validatePriceSource } from '../prices/priceSource.js';
import { HORIZONS, MEASUREMENT_STATUS, insertPriceReaction } from '../database/priceReactions.js';

const HORIZON_MS = Object.freeze({
  '10s': 10_000,
  '1m': 60_000,
  '5m': 300_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
});

/** Default how far back to look for a baseline trade. Fixture-stage choice. */
export const DEFAULT_BASELINE_LOOKBACK_MS = 15 * 60_000;

/** Temporary fixture EOD target for an anchor: same UTC day, 21:00:00.000Z. */
export function eodTargetFor(anchorIso) {
  return `${anchorIso.slice(0, 10)}T21:00:00.000Z`;
}

function targetFor(anchorIso, horizon) {
  if (horizon === 'eod') return eodTargetFor(anchorIso);
  return new Date(Date.parse(anchorIso) + HORIZON_MS[horizon]).toISOString();
}

/** Last element of trades with at <= cutoff (and optionally at > after). */
function lastTradeAtOrBefore(trades, cutoff, after = null) {
  let found = null;
  for (const trade of trades) {
    if (trade.at > cutoff) break; // trades are time-ascending per contract
    if (after !== null && trade.at <= after) continue;
    found = trade;
  }
  return found;
}

/**
 * Measure one persisted news event across the canonical horizons and store
 * the results. Never throws on missing data or source failure — those are
 * stored as status rows (failures are data).
 *
 * @param {object} db  open database handle
 * @param {object} eventRow  a news_events row (id, ticker, received_at)
 * @param {import('../prices/priceSource.js').PriceSource} priceSource
 * @param {object} [options]
 * @param {string[]} [options.horizons]  subset of canonical horizons
 * @param {number} [options.baselineLookbackMs]
 * @returns {Promise<{
 *   newsEventId: number, ticker: string, anchorAt: string, priceSource: string,
 *   window: { baselineFromIso: string, reactionToIso: string,
 *             baselineLookbackMs: number, tradeCount: number|null },
 *   results: { horizon: string, status: string, replaced: boolean }[],
 * }>}
 *
 * The returned `window` is sanitized DIAGNOSTIC data only — the exact bounds
 * fetched (baseline lookback start, final reaction-window end), the lookback
 * used, and the COUNT of trades the source returned (tradeCount stays null on
 * source_error). It never contains trade payloads, prices, or secrets, so it
 * is safe for the manual scripts to print.
 */
export async function measureEvent(db, eventRow, priceSource, options = {}) {
  validatePriceSource(priceSource);
  if (!eventRow || !Number.isInteger(eventRow.id) || !eventRow.ticker || !eventRow.received_at) {
    throw new Error('measureEvent: eventRow must be a news_events row with id, ticker, received_at');
  }
  const horizons = options.horizons ?? HORIZONS;
  for (const h of horizons) {
    if (!HORIZONS.includes(h)) throw new Error(`measureEvent: unknown horizon "${h}"`);
  }
  const lookbackMs = options.baselineLookbackMs ?? DEFAULT_BASELINE_LOOKBACK_MS;

  const anchorAt = eventRow.received_at;
  const fromIso = new Date(Date.parse(anchorAt) - lookbackMs).toISOString();
  const maxTarget = horizons.map((h) => targetFor(anchorAt, h)).sort().at(-1);

  const base = {
    anchorAt,
    priceSource: priceSource.name,
    measuredAt: new Date().toISOString(),
  };
  const summary = {
    newsEventId: eventRow.id,
    ticker: eventRow.ticker,
    anchorAt,
    priceSource: priceSource.name,
    // Sanitized diagnostics: the exact window fetched + trade COUNT (no payloads).
    window: {
      baselineFromIso: fromIso,
      reactionToIso: maxTarget,
      baselineLookbackMs: lookbackMs,
      tradeCount: null, // set after a successful fetch; stays null on source_error
    },
    results: [],
  };

  // One fetch covers every horizon. A source failure marks ALL requested
  // horizons source_error — observable, never thrown.
  let trades;
  try {
    trades = await priceSource.getTradesAround(eventRow.ticker, fromIso, maxTarget);
  } catch {
    for (const horizon of horizons) {
      const { replaced } = insertPriceReaction(db, eventRow.id, {
        ...base, horizon, measurementStatus: MEASUREMENT_STATUS.SOURCE_ERROR,
      });
      summary.results.push({ horizon, status: MEASUREMENT_STATUS.SOURCE_ERROR, replaced });
    }
    return summary;
  }
  summary.window.tradeCount = trades.length; // count only — never the trades

  const baseline = lastTradeAtOrBefore(trades, anchorAt);

  for (const horizon of horizons) {
    let row;
    if (!baseline) {
      row = { ...base, horizon, measurementStatus: MEASUREMENT_STATUS.NO_BASELINE };
    } else {
      const target = targetFor(anchorAt, horizon);
      const reaction = lastTradeAtOrBefore(trades, target, anchorAt); // strictly after anchor
      if (!reaction) {
        row = {
          ...base, horizon,
          measurementStatus: MEASUREMENT_STATUS.NO_REACTION,
          baselineAt: baseline.at,
          baselinePrice: baseline.price,
        };
      } else {
        const window = trades.filter((t) => t.at > anchorAt && t.at <= target);
        row = {
          ...base, horizon,
          measurementStatus: MEASUREMENT_STATUS.MEASURED,
          baselineAt: baseline.at,
          baselinePrice: baseline.price,
          reactionPrice: reaction.price,
          highPrice: Math.max(...window.map((t) => t.price)),
          lowPrice: Math.min(...window.map((t) => t.price)),
          volume: window.every((t) => typeof t.size === 'number')
            ? window.reduce((sum, t) => sum + t.size, 0)
            : null,
        };
      }
    }
    const { replaced } = insertPriceReaction(db, eventRow.id, row);
    summary.results.push({ horizon, status: row.measurementStatus, replaced });
  }
  return summary;
}

/**
 * Measure several news_events rows. Per-event failures are recorded, never
 * fatal to the batch.
 * @returns {Promise<{ measuredEvents: number, failedEvents: number,
 *   summaries: object[], errors: { newsEventId: number|null, error: string }[] }>}
 */
export async function measureEvents(db, eventRows, priceSource, options = {}) {
  const out = { measuredEvents: 0, failedEvents: 0, summaries: [], errors: [] };
  for (const eventRow of eventRows) {
    try {
      out.summaries.push(await measureEvent(db, eventRow, priceSource, options));
      out.measuredEvents += 1;
    } catch (err) {
      out.failedEvents += 1;
      out.errors.push({ newsEventId: eventRow?.id ?? null, error: err.message });
    }
  }
  return out;
}
