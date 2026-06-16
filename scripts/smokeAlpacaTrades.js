// scripts/smokeAlpacaTrades.js — MANUAL live smoke check for the Alpaca
// Trades PriceSource (src/prices/alpacaTradesPriceSource.js). Diagnostic
// tool only; mirrors scripts/smokeAlpacaNews.js.
//
//   Run:  node --env-file=.env scripts/smokeAlpacaTrades.js [--symbol AAPL] [--minutes 5] [--lag 20]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked fetch of one tiny recent window, then exit. No polling,
//   no scheduling, no background jobs.
// - Reads credentials ONLY via loadConfig() (src/config.js); this file never
//   touches process.env for secrets. Use --env-file=.env (built into Node)
//   to load your local .env — no dotenv dependency, no .env parsing here.
// - Explicit construction of createAlpacaTradesPriceSource(config) — the only
//   place a real market-data path is enabled. Disabled-by-default otherwise.
// - SANITIZED OUTPUT ONLY: symbol, requested window, source name, trade
//   count, first/last trade timestamps, and min/max price. Trade prices and
//   timestamps are PUBLIC market data. Never prints keys, auth headers,
//   request URLs, or raw payloads/objects.
// - Window discipline: the window ENDS ~lag minutes in the past (default 20,
//   min 16) so it stays outside Alpaca's too-recent-data restriction
//   (~15 minutes on the free/IEX feed), and spans a few minutes (default 5).
// - Zero trades is still a PASS: outside market hours or on the thin IEX
//   feed an empty window is expected — the check proves reachability and
//   payload normalization, not feed completeness.
// - NO database writes, NO trading, NO paper orders, NO model calls.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';

/** Window span is a tiny diagnostic sample; never a backfill. */
export const DEFAULT_SPAN_MINUTES = 5;
export const MAX_SPAN_MINUTES = 60;

/** End the window in the past to dodge the free-feed recent-data limit. */
export const DEFAULT_LAG_MINUTES = 20;
export const MIN_LAG_MINUTES = 16; // just outside the ~15-min restriction
export const MAX_LAG_MINUTES = 10_080; // one week back, generous upper bound

/**
 * Parse minimal CLI args: --symbol AAPL --minutes N --lag N. Exported for
 * tests. One ticker only (the first token if a comma list is passed).
 */
export function parseArgs(argv) {
  const args = { symbol: 'AAPL', spanMinutes: DEFAULT_SPAN_MINUTES, lagMinutes: DEFAULT_LAG_MINUTES };
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--symbol' || argv[i] === '--symbols') && argv[i + 1]) {
      const first = argv[i + 1].split(',')[0].trim().toUpperCase();
      if (first) args.symbol = first;
      i += 1;
    } else if (argv[i] === '--minutes' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.spanMinutes = Math.min(n, MAX_SPAN_MINUTES);
      i += 1;
    } else if (argv[i] === '--lag' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n >= MIN_LAG_MINUTES) {
        args.lagMinutes = Math.min(n, MAX_LAG_MINUTES);
      }
      i += 1;
    }
  }
  return args;
}

/**
 * Compute the requested [fromIso, toIso] UTC window from a reference time.
 * Pure (takes nowMs) so tests are deterministic. The window ends `lagMinutes`
 * before now and spans `spanMinutes`. Returns fixed-width ms UTC ISO strings.
 */
export function computeWindow(nowMs, { spanMinutes, lagMinutes }) {
  const endMs = nowMs - lagMinutes * 60_000;
  const startMs = endMs - spanMinutes * 60_000;
  return { fromIso: new Date(startMs).toISOString(), toIso: new Date(endMs).toISOString() };
}

/**
 * Reduce a (contract-compliant, ascending) Trade[] to sanitized summary
 * metadata: count, first/last timestamps, min/max price. Reads ONLY the
 * whitelisted price/at fields — anything else on a trade is ignored.
 */
export function summarizeTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { count: 0, firstAt: null, lastAt: null, minPrice: null, maxPrice: null };
  }
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const t of trades) {
    if (t.price < minPrice) minPrice = t.price;
    if (t.price > maxPrice) maxPrice = t.price;
  }
  return {
    count: trades.length,
    firstAt: trades[0].at,
    lastAt: trades[trades.length - 1].at,
    minPrice,
    maxPrice,
  };
}

/** Build the full sanitized report as an array of printable lines. */
export function buildSmokeReport(summary, { symbol, source, fromIso, toIso } = {}) {
  const lines = [
    `Alpaca Trades smoke check: ${symbol ?? '?'} via source "${source ?? '?'}"`,
    `  window:  ${fromIso} → ${toIso}`,
    `  trades:  ${summary.count}`,
  ];
  if (summary.count > 0) {
    lines.push(
      `  first:   ${summary.firstAt}`,
      `  last:    ${summary.lastAt}`,
      `  price:   min ${summary.minPrice}  max ${summary.maxPrice}`
    );
  } else {
    lines.push(
      '  (zero trades in this window — expected outside market hours or on the thin IEX feed)'
    );
  }
  return lines;
}

async function main() {
  const { symbol, spanMinutes, lagMinutes } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Same key pair as the news transport (account-level; read via config only).
  if (!config.alpacaNews.keyId || !config.alpacaNews.secretKey) {
    console.error(
      'Smoke check NOT RUN: Alpaca market-data credentials are not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env\n' +
        '(see .env.example) and run with:  node --env-file=.env scripts/smokeAlpacaTrades.js'
    );
    process.exit(1);
  }

  try {
    // Explicit construction — the only place a real market-data path is enabled.
    const source = createAlpacaTradesPriceSource(config);
    const { fromIso, toIso } = computeWindow(Date.now(), { spanMinutes, lagMinutes });
    const trades = await source.getTradesAround(symbol, fromIso, toIso);
    const summary = summarizeTrades(trades);
    for (const line of buildSmokeReport(summary, { symbol, source: source.name, fromIso, toIso })) {
      console.log(line);
    }
    console.log('Smoke check PASSED (source reachable, trades normalized).');
  } catch (err) {
    // Source errors are already sanitized/redacted at the client.
    console.error(`Smoke check FAILED: ${err.message}`);
    process.exit(1);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
