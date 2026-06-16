// tests/smokeTradesFormat.test.js — Sanitized formatting/arg/window logic of
// the manual Alpaca Trades smoke script. Importing the script runs NOTHING
// (CLI guard); no network, no credentials required, never any live call in
// npm test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  computeWindow,
  summarizeTrades,
  buildSmokeReport,
  DEFAULT_SPAN_MINUTES,
  MAX_SPAN_MINUTES,
  DEFAULT_LAG_MINUTES,
  MIN_LAG_MINUTES,
} from '../scripts/smokeAlpacaTrades.js';

// Contract-compliant trades, ascending by `at`, with an extra non-whitelisted
// field that must NEVER reach the output.
const TRADES = [
  { at: '2026-06-10T14:30:00.123Z', price: 201.5, size: 100, secret_marker: 'MUST-NOT-PRINT' },
  { at: '2026-06-10T14:30:05.500Z', price: 202.75, size: 50, secret_marker: 'MUST-NOT-PRINT' },
  { at: '2026-06-10T14:31:00.000Z', price: 200.25, size: 25, secret_marker: 'MUST-NOT-PRINT' },
];

test('parseArgs defaults to one ticker and a tiny window', () => {
  assert.deepEqual(parseArgs([]), {
    symbol: 'AAPL',
    spanMinutes: DEFAULT_SPAN_MINUTES,
    lagMinutes: DEFAULT_LAG_MINUTES,
  });
});

test('parseArgs reads symbol/minutes/lag, uppercases, takes first of a list', () => {
  const parsed = parseArgs(['--symbol', 'msft', '--minutes', '10', '--lag', '30']);
  assert.equal(parsed.symbol, 'MSFT');
  assert.equal(parsed.spanMinutes, 10);
  assert.equal(parsed.lagMinutes, 30);
  // Comma list → first ticker only (single-ticker smoke check).
  assert.equal(parseArgs(['--symbols', 'nvda, tsla']).symbol, 'NVDA');
});

test('parseArgs caps span and floors lag to safe bounds', () => {
  assert.equal(parseArgs(['--minutes', '5000']).spanMinutes, MAX_SPAN_MINUTES);
  assert.equal(parseArgs(['--minutes', '0']).spanMinutes, DEFAULT_SPAN_MINUTES); // invalid → default
  assert.equal(parseArgs(['--minutes', 'nope']).spanMinutes, DEFAULT_SPAN_MINUTES);
  // Lag below the recent-data floor is rejected (keeps the default), so the
  // window can never creep into the too-recent zone.
  assert.equal(parseArgs(['--lag', '1']).lagMinutes, DEFAULT_LAG_MINUTES);
  assert.equal(parseArgs(['--lag', String(MIN_LAG_MINUTES)]).lagMinutes, MIN_LAG_MINUTES);
});

test('computeWindow ends lag minutes in the past and spans the requested minutes', () => {
  const now = Date.parse('2026-06-10T15:00:00.000Z');
  const { fromIso, toIso } = computeWindow(now, { spanMinutes: 5, lagMinutes: 20 });
  assert.equal(toIso, '2026-06-10T14:40:00.000Z'); // now - 20m
  assert.equal(fromIso, '2026-06-10T14:35:00.000Z'); // end - 5m
  assert.ok(fromIso < toIso);
  // The window never reaches into the present.
  assert.ok(Date.parse(toIso) < now);
});

test('summarizeTrades reduces to count, first/last, min/max from whitelisted fields', () => {
  const s = summarizeTrades(TRADES);
  assert.equal(s.count, 3);
  assert.equal(s.firstAt, '2026-06-10T14:30:00.123Z');
  assert.equal(s.lastAt, '2026-06-10T14:31:00.000Z');
  assert.equal(s.minPrice, 200.25);
  assert.equal(s.maxPrice, 202.75);
});

test('summarizeTrades handles the empty window', () => {
  assert.deepEqual(summarizeTrades([]), {
    count: 0,
    firstAt: null,
    lastAt: null,
    minPrice: null,
    maxPrice: null,
  });
});

test('buildSmokeReport renders only whitelisted summary fields', () => {
  const lines = buildSmokeReport(summarizeTrades(TRADES), {
    symbol: 'AAPL',
    source: 'alpaca_iex',
    fromIso: '2026-06-10T14:35:00.000Z',
    toIso: '2026-06-10T14:40:00.000Z',
  });
  const text = lines.join('\n');
  assert.match(text, /Alpaca Trades smoke check: AAPL via source "alpaca_iex"/);
  assert.match(text, /window:  2026-06-10T14:35:00\.000Z → 2026-06-10T14:40:00\.000Z/);
  assert.match(text, /trades:  3/);
  assert.match(text, /first:   2026-06-10T14:30:00\.123Z/);
  assert.match(text, /last:    2026-06-10T14:31:00\.000Z/);
  assert.match(text, /price:   min 200\.25  max 202\.75/);
  // No non-whitelisted trade field ever reaches the output.
  assert.ok(!text.includes('MUST-NOT-PRINT'));
  assert.ok(!JSON.stringify(text).includes('secret_marker'));
});

test('buildSmokeReport explains an empty window instead of faking trades', () => {
  const lines = buildSmokeReport(summarizeTrades([]), {
    symbol: 'AAPL',
    source: 'alpaca_iex',
    fromIso: '2026-06-10T14:35:00.000Z',
    toIso: '2026-06-10T14:40:00.000Z',
  });
  assert.match(lines.join('\n'), /trades:  0/);
  assert.match(lines.join('\n'), /zero trades in this window/);
});

test('importing the script performs no network and requires no credentials', () => {
  // The import at the top executed the module without credentials, network, or
  // side effects (CLI guard). Belt-and-braces: helpers are plain functions.
  assert.equal(typeof buildSmokeReport, 'function');
  assert.equal(typeof computeWindow, 'function');
});
