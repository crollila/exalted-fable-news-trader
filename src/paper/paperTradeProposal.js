// src/paper/paperTradeProposal.js — Conservative paper-trade proposal + minimal
// risk gate + DB writers (Phase 5, first vertical slice).
//
// SCOPE OF THIS SLICE — deliberately tiny and safe:
// - Equity LONG only. Market BUY only. Whole shares only.
// - No shorts, no options, no margin logic, no notional/buying-power sizing
//   (those are a later, separately reviewed phase).
// - assessProposal is a PURE function (no DB, no network, no clock): given an
//   event + its sentiment score, it returns an accept/reject decision with a
//   human-readable reason. The script decides whether to persist/execute.
// - The two writers persist the outcome through the EXISTING migration-001
//   tables (paper_trades on an executed order, rejected_trades on a refusal).
//   No schema/migration change.
//
// Sanitization: this module never reads or returns raw_response, raw_payload,
// headers, or keys. summarizeScore() reduces a score row to a numeric/label
// whitelist, so nothing downstream can leak model text.

/** Default order size: a single share. Conservative on purpose. */
export const DEFAULT_QTY = 1;

/** Hard quantity cap for the first slice — no uncapped trading. */
export const MAX_QTY = 100;

/** Conservative score gates. A long trade must clear ALL of these. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minConfidence: 0.6,
  minImpact: 0.5,
  minSentiment: 0.3,
});

/** Only these parser outcomes carry a usable score (others are failures-as-data). */
export const USABLE_PARSER_STATUSES = Object.freeze(['parsed', 'fallback_used']);

/** Clamp a requested quantity to [1, MAX_QTY] whole shares; junk -> default. */
export function clampQty(qty) {
  const n = Number.parseInt(qty, 10);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_QTY;
  return Math.min(n, MAX_QTY);
}

/** Coerce a value to a finite number, or null (so missing scores never pass). */
function numOrNull(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Compact number for reasons/reports; null -> "(none)". */
function fmt(n) {
  return n === null || n === undefined ? '(none)' : String(Math.round(n * 1000) / 1000);
}

/**
 * Reduce a sentiment score row (snake_case columns) OR a camelCase score object
 * to a SANITIZED whitelist for reasons/reports. Never includes raw_response,
 * detail, raw_payload, or any free text beyond the model/prompt identifiers.
 */
export function summarizeScore(score) {
  return {
    model: score?.model ?? null,
    promptVersion: score?.prompt_version ?? score?.promptVersion ?? null,
    direction: score?.direction ?? null,
    parserStatus: score?.parser_status ?? score?.parserStatus ?? null,
    newsType: score?.news_type ?? score?.newsType ?? null,
    sentiment: numOrNull(score?.sentiment_score ?? score?.sentimentScore),
    impact: numOrNull(score?.impact_score ?? score?.impactScore),
    confidence: numOrNull(score?.confidence),
  };
}

/**
 * Assess a conservative long paper-trade proposal for one scored event.
 * PURE — no DB, no network. Returns a structured decision.
 *
 * Rejection rules (in order), each producing a clear reason:
 *   1. missing ticker
 *   2. symbol not in the CLI-provided allowed list
 *   3. parser_status not usable (need parsed/fallback_used)
 *   4. direction is not 'up' (long-only slice; shorts are out of scope)
 *   5. confidence below threshold
 *   6. impact below threshold
 *   7. sentiment below threshold
 *
 * @param {object} args
 * @param {{id?: number, ticker?: string}} args.event
 * @param {object} args.score              a sentiment_scores row (or camelCase)
 * @param {number} [args.qty]              requested shares (clamped here too)
 * @param {string[]} [args.allowedSymbols] CLI allow-list (required to pass)
 * @param {object} [args.thresholds]       overrides for DEFAULT_THRESHOLDS
 * @returns {{ eventId: number|null, ticker: string, assetClass: 'equity',
 *   side: 'buy', quantity: number, thresholds: object, score: object,
 *   accepted: boolean, reason: string }}
 */
export function assessProposal({ event, score, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {} } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) };
  const ticker = String(event?.ticker ?? '').trim().toUpperCase();
  const quantity = clampQty(qty);
  const allowed = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

  const base = {
    eventId: Number.isInteger(event?.id) ? event.id : null,
    ticker,
    assetClass: 'equity',
    side: 'buy', // long-only slice: market BUY only
    quantity,
    thresholds: t,
    score: summarizeScore(score),
  };
  const reject = (reason) => ({ ...base, accepted: false, reason });

  if (!ticker) return reject('missing ticker on event');
  if (!allowed.includes(ticker)) {
    return reject(`symbol ${ticker} not in allowed list [${allowed.join(',') || 'none'}]`);
  }

  const status = base.score.parserStatus;
  if (!USABLE_PARSER_STATUSES.includes(status)) {
    return reject(`parser_status "${status ?? '(none)'}" not usable (need parsed/fallback_used)`);
  }

  const direction = base.score.direction;
  if (direction !== 'up') {
    return reject(`direction "${direction ?? '(none)'}" is not up (long-only slice; no shorts)`);
  }

  const { confidence, impact, sentiment } = base.score;
  if (confidence === null || confidence < t.minConfidence) {
    return reject(`confidence ${fmt(confidence)} below threshold ${t.minConfidence}`);
  }
  if (impact === null || impact < t.minImpact) {
    return reject(`impact ${fmt(impact)} below threshold ${t.minImpact}`);
  }
  if (sentiment === null || sentiment < t.minSentiment) {
    return reject(`sentiment ${fmt(sentiment)} below threshold ${t.minSentiment}`);
  }

  return {
    ...base,
    accepted: true,
    reason:
      `long ${ticker}: direction up, confidence ${fmt(confidence)} >= ${t.minConfidence}, ` +
      `impact ${fmt(impact)} >= ${t.minImpact}, sentiment ${fmt(sentiment)} >= ${t.minSentiment}`,
  };
}

/**
 * Persist a refused trade. reason is mandatory (the schema enforces a non-empty
 * reason — a rejection without a reason is a logging bug).
 * @returns {{ id: number }}
 */
export function insertRejectedTrade(
  db,
  { newsEventId = null, ticker, side = null, quantity = null, reason } = {}
) {
  if (!ticker || String(ticker).trim() === '') {
    throw new Error('insertRejectedTrade: ticker is required');
  }
  if (!reason || String(reason).trim() === '') {
    throw new Error('insertRejectedTrade: reason is required (rejection must say why)');
  }
  const run = db
    .prepare(
      `INSERT INTO rejected_trades (news_event_id, ticker, side, quantity, reason)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(newsEventId, ticker, side, quantity, String(reason));
  return { id: Number(run.lastInsertRowid) };
}

/**
 * Persist an executed PAPER trade. side must be buy/sell and quantity > 0
 * (mirrors the migration-001 CHECK constraints). status defaults to 'open'.
 * @returns {{ id: number }}
 */
export function insertPaperTrade(
  db,
  {
    newsEventId = null,
    ticker,
    side,
    quantity,
    theoreticalEntryPrice = null,
    fillPrice = null,
    entryAt = null,
    tradeReason = null,
    status = 'open',
  } = {}
) {
  if (!ticker || String(ticker).trim() === '') {
    throw new Error('insertPaperTrade: ticker is required');
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`insertPaperTrade: side must be buy/sell, got "${side}"`);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('insertPaperTrade: quantity must be > 0');
  }
  const run = db
    .prepare(
      `INSERT INTO paper_trades
         (news_event_id, ticker, side, quantity, theoretical_entry_price,
          fill_price, entry_at, trade_reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newsEventId,
      ticker,
      side,
      qty,
      theoreticalEntryPrice,
      fillPrice,
      entryAt,
      tradeReason,
      status
    );
  return { id: Number(run.lastInsertRowid) };
}
