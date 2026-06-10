// src/prices/priceSource.js — PriceSource contract + fixture source (Phase 4).
//
// Mirrors the provider/classifier injection pattern: the contract is JSDoc
// typedefs plus runtime validation, and the fixture source is backed by
// injected trade data with a throwing default — structurally incapable of
// calling a market-data API or needing keys. Real Alpaca/Polygon price
// clients are a later, separately reviewed step behind this same interface.

/**
 * @typedef {object} Trade
 * @property {number} price   trade price (> 0)
 * @property {string} at      UTC ISO-8601 timestamp
 * @property {number} [size]  trade size, if known
 */

/**
 * @typedef {object} PriceSource
 * @property {string} name  stable identifier stored in price_reactions.price_source
 * @property {(ticker: string, fromIso: string, toIso: string) => Promise<Trade[]>} getTradesAround
 *   Trades for ticker with `at` in [fromIso, toIso], ascending by time.
 *   Resolves to [] when the source has no data for the window.
 */

/** Throw if an object does not satisfy the PriceSource contract shape. */
export function validatePriceSource(source) {
  if (!source || typeof source !== 'object') {
    throw new Error('PriceSource must be an object');
  }
  if (typeof source.name !== 'string' || source.name.trim() === '') {
    throw new Error('PriceSource.name must be a non-empty string');
  }
  if (typeof source.getTradesAround !== 'function') {
    throw new Error('PriceSource.getTradesAround must be a function');
  }
  return source;
}

function noTradesConfigured() {
  throw new Error(
    'fixturePriceSource: no trades configured. Inject tradesByTicker ' +
      '(e.g. canned trades in tests). Real market-data clients are a later phase.'
  );
}

/**
 * Create a fixture-backed PriceSource.
 * @param {object} [options]
 * @param {Record<string, Trade[]>} [options.tradesByTicker]
 *   canned trades per uppercase ticker. Omitting it yields a source whose
 *   getTradesAround rejects — the skeleton has no data and no network.
 * @returns {PriceSource}
 */
export function createFixturePriceSource({ tradesByTicker } = {}) {
  async function getTradesAround(ticker, fromIso, toIso) {
    if (tradesByTicker === undefined) noTradesConfigured();
    const trades = tradesByTicker[String(ticker).toUpperCase()] ?? [];
    return trades
      .filter((t) => t.at >= fromIso && t.at <= toIso)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  return { name: 'fixture', getTradesAround };
}
