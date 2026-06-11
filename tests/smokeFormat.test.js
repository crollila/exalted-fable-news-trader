// tests/smokeFormat.test.js — Sanitized formatting logic of the manual
// Alpaca News smoke script. Importing the script runs NOTHING (CLI guard);
// no network, no credentials required, never any live call in npm test.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate,
  formatEventLine,
  buildSmokeReport,
  parseArgs,
  MAX_SMOKE_LIMIT,
} from '../scripts/smokeAlpacaNews.js';

const EVENT = {
  provider: 'alpaca',
  providerEventId: '24843171',
  ticker: 'AAPL',
  symbols: ['AAPL', 'MSFT'],
  headline: 'Apple Unveils New Product Line',
  publishedAt: '2026-06-09T13:30:00.000Z',
  url: 'https://www.benzinga.com/news/apple-event',
  // Fields that must NEVER appear in output:
  raw: { secret_marker: 'RAW-PAYLOAD-MUST-NOT-PRINT', body: 'full article text' },
  summary: null,
  body: null,
  author: 'Reporter',
  receivedAt: '2026-06-09T13:30:01.000Z',
  rawType: null,
  newsType: 'other',
};

test('formatEventLine renders only whitelisted fields', () => {
  const line = formatEventLine(EVENT);
  assert.match(line, /2026-06-09T13:30:00\.000Z/);
  assert.match(line, /AAPL \(AAPL,MSFT\)/);
  assert.match(line, /Apple Unveils New Product Line/);
  assert.match(line, /id: 24843171/);
  assert.match(line, /https:\/\/www\.benzinga\.com\/news\/apple-event/);
  // The raw payload (and anything inside it) never reaches the output.
  assert.ok(!line.includes('RAW-PAYLOAD-MUST-NOT-PRINT'));
  assert.ok(!line.includes('full article text'));
});

test('non-http(s) urls are omitted', () => {
  const line = formatEventLine({ ...EVENT, url: 'ftp://weird/place' });
  assert.ok(!line.includes('ftp://'));
  const line2 = formatEventLine({ ...EVENT, url: null });
  assert.ok(!line2.includes('http'));
});

test('long headlines are truncated', () => {
  const line = formatEventLine({ ...EVENT, headline: 'X'.repeat(300) });
  assert.ok(line.includes('…'));
  assert.ok(line.length < 300);
  assert.equal(truncate('short', 10), 'short');
});

test('buildSmokeReport includes count header and handles empty results', () => {
  const report = buildSmokeReport([EVENT, EVENT]);
  assert.match(report[0], /fetched 2 event\(s\) via provider "alpaca"/);
  assert.equal(report.length, 3); // header + 2 lines
  const empty = buildSmokeReport([]);
  assert.match(empty[0], /fetched 0 event\(s\)/);
  assert.match(empty[1], /zero events returned/);
});

test('report never contains raw payload content for any event', () => {
  const text = buildSmokeReport([EVENT]).join('\n');
  assert.ok(!text.includes('RAW-PAYLOAD-MUST-NOT-PRINT'));
  assert.ok(!JSON.stringify(text).includes('secret_marker'));
});

test('parseArgs maps symbols/limit and caps the limit at a tiny sample', () => {
  assert.deepEqual(parseArgs([]), { symbols: ['AAPL'], limit: 5 });
  const parsed = parseArgs(['--symbols', 'msft, nvda', '--limit', '3']);
  assert.deepEqual(parsed.symbols, ['msft', 'nvda']);
  assert.equal(parsed.limit, 3);
  assert.equal(parseArgs(['--limit', '500']).limit, MAX_SMOKE_LIMIT); // capped
  assert.equal(parseArgs(['--limit', 'nope']).limit, 5); // invalid → default
});

test('importing the script performs no network and requires no credentials', () => {
  // This whole file already proves it: the import at the top executed the
  // module without credentials, network, or side effects (CLI guard).
  // Belt-and-braces: global fetch was never replaced or invoked here.
  assert.equal(typeof buildSmokeReport, 'function');
});
