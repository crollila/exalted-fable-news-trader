// src/database/priceReactions.js — Writer/reader for price_reactions.
//
// One row per (news_event_id, horizon); re-measurement REPLACES the existing
// row via the UNIQUE constraint (docs/event-study-plan.md §4: every window
// is reconstructible and re-measurable). Fixture-only inputs today: nothing
// here calls a market-data API.
//
// Failures are data: non-'measured' rows carry NULL prices/returns with
// their measurement_status, so missing-data bias stays visible.

export const HORIZONS = Object.freeze(['10s', '1m', '5m', '30m', '1h', 'eod']);

export const MEASUREMENT_STATUS = Object.freeze({
  MEASURED: 'measured',
  NO_BASELINE: 'no_baseline',
  NO_REACTION: 'no_reaction',
  MARKET_CLOSED: 'market_closed',
  SOURCE_ERROR: 'source_error',
});

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const UPSERT_SQL = `
  INSERT INTO price_reactions
    (news_event_id, horizon, measurement_status, anchor_at, baseline_at,
     baseline_price, reaction_price, return_pct, high_price, low_price,
     volume, price_source, measured_at)
  VALUES
    (@news_event_id, @horizon, @measurement_status, @anchor_at, @baseline_at,
     @baseline_price, @reaction_price, @return_pct, @high_price, @low_price,
     @volume, @price_source, @measured_at)
  ON CONFLICT (news_event_id, horizon) DO UPDATE SET
    measurement_status = excluded.measurement_status,
    anchor_at          = excluded.anchor_at,
    baseline_at        = excluded.baseline_at,
    baseline_price     = excluded.baseline_price,
    reaction_price     = excluded.reaction_price,
    return_pct         = excluded.return_pct,
    high_price         = excluded.high_price,
    low_price          = excluded.low_price,
    volume             = excluded.volume,
    price_source       = excluded.price_source,
    measured_at        = excluded.measured_at
`;

/**
 * Insert or replace one price reaction measurement.
 *
 * @param {object} db  open database handle (from src/database/db.js)
 * @param {number} newsEventId  existing news_events.id (FK enforced)
 * @param {object} reaction
 * @param {string} reaction.horizon            one of HORIZONS
 * @param {string} reaction.measurementStatus  one of MEASUREMENT_STATUS values
 * @param {string} reaction.anchorAt           UTC ISO (= event received_at)
 * @param {string} reaction.measuredAt         UTC ISO
 * @param {string} [reaction.baselineAt]
 * @param {number} [reaction.baselinePrice]
 * @param {number} [reaction.reactionPrice]
 * @param {number} [reaction.returnPct]   computed from prices when omitted
 * @param {number} [reaction.highPrice]
 * @param {number} [reaction.lowPrice]
 * @param {number} [reaction.volume]
 * @param {string} [reaction.priceSource]  e.g. 'fixture'
 * @returns {{ id: number, replaced: boolean }}
 *   replaced=true when an existing (event, horizon) row was overwritten.
 * @throws on invalid caller input. 'measured' requires both prices;
 *   non-'measured' statuses must not carry a reaction price/return.
 */
export function insertPriceReaction(db, newsEventId, reaction) {
  if (!Number.isInteger(newsEventId) || newsEventId <= 0) {
    throw new Error(`insertPriceReaction: newsEventId must be a positive integer, got ${newsEventId}`);
  }
  if (!reaction || typeof reaction !== 'object') {
    throw new Error('insertPriceReaction: reaction must be an object');
  }
  const { horizon, measurementStatus, anchorAt, measuredAt } = reaction;
  if (!HORIZONS.includes(horizon)) {
    throw new Error(`insertPriceReaction: invalid horizon "${horizon}" (expected ${HORIZONS.join('/')})`);
  }
  if (!Object.values(MEASUREMENT_STATUS).includes(measurementStatus)) {
    throw new Error(`insertPriceReaction: invalid measurementStatus "${measurementStatus}"`);
  }
  if (!ISO_UTC_RE.test(anchorAt ?? '')) {
    throw new Error('insertPriceReaction: anchorAt must be UTC ISO-8601');
  }
  if (!ISO_UTC_RE.test(measuredAt ?? '')) {
    throw new Error('insertPriceReaction: measuredAt must be UTC ISO-8601');
  }

  const measured = measurementStatus === MEASUREMENT_STATUS.MEASURED;
  const baselinePrice = reaction.baselinePrice ?? null;
  const reactionPrice = reaction.reactionPrice ?? null;
  if (measured && (baselinePrice === null || reactionPrice === null)) {
    throw new Error("insertPriceReaction: status 'measured' requires baselinePrice and reactionPrice");
  }
  if (!measured && reactionPrice !== null) {
    throw new Error(
      `insertPriceReaction: status '${measurementStatus}' must not carry a reactionPrice`
    );
  }

  let returnPct = reaction.returnPct ?? null;
  if (measured && returnPct === null) {
    returnPct = (reactionPrice - baselinePrice) / baselinePrice;
  }

  const existing = getPriceReaction(db, newsEventId, horizon);
  db.prepare(UPSERT_SQL).run({
    news_event_id: newsEventId,
    horizon,
    measurement_status: measurementStatus,
    anchor_at: anchorAt,
    baseline_at: reaction.baselineAt ?? null,
    baseline_price: baselinePrice,
    reaction_price: reactionPrice,
    return_pct: measured ? returnPct : null,
    high_price: reaction.highPrice ?? null,
    low_price: reaction.lowPrice ?? null,
    volume: reaction.volume ?? null,
    price_source: reaction.priceSource ?? null,
    measured_at: measuredAt,
  });
  const row = getPriceReaction(db, newsEventId, horizon);
  return { id: row.id, replaced: existing !== null };
}

/** Get one reaction row by (event, horizon). Null if absent. */
export function getPriceReaction(db, newsEventId, horizon) {
  return (
    db
      .prepare('SELECT * FROM price_reactions WHERE news_event_id = ? AND horizon = ?')
      .get(newsEventId, horizon) ?? null
  );
}

/** List all reaction rows for an event, in canonical horizon order. */
export function listPriceReactionsForEvent(db, newsEventId) {
  const rows = db
    .prepare('SELECT * FROM price_reactions WHERE news_event_id = ?')
    .all(newsEventId);
  return rows.sort((a, b) => HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon));
}

/** Count rows by measurement_status (diagnostics/research helper). */
export function countPriceReactionsByStatus(db) {
  const rows = db
    .prepare('SELECT measurement_status, COUNT(*) AS n FROM price_reactions GROUP BY measurement_status')
    .all();
  return Object.fromEntries(rows.map((r) => [r.measurement_status, Number(r.n)]));
}
