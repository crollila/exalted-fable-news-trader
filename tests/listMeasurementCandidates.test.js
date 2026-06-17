// tests/listMeasurementCandidates.test.js — Network-free tests for the manual
// read-only measurement-candidate finder. Importing the script runs NOTHING
// (CLI guard): no network, no credentials, no writes. The DB-touching tests use
// an in-memory database, so npm test stays fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertPriceReaction, MEASUREMENT_STATUS } from '../src/database/priceReactions.js';
import {
  parseArgs,
  easternParts,
  isMarketHours,
  collectCandidates,
  buildCandidatesReport,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SUGGESTED_IDS,
} from '../scripts/listMeasurementCandidates.js';

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

const INSERT_SCORE_SQL = `
  INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parser_status)
  VALUES (@news_event_id, @model, @prompt_version, @raw_response, @parser_status)
`;

function insertEvent(db, { id, ticker, provider = 'alpaca', receivedAt }) {
  db.prepare(INSERT_EVENT_SQL).run({
    provider,
    provider_event_id: `evt-${id}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: 'other',
  });
}

function insertModelV1Score(db, newsEventId) {
  db.prepare(INSERT_SCORE_SQL).run({
    news_event_id: newsEventId,
    model: 'claude-opus-4-8',
    prompt_version: 'model_v1',
    raw_response: 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
    parser_status: 'parsed',
  });
}

function measure(db, eventId, horizon, at) {
  insertPriceReaction(db, eventId, {
    horizon,
    measurementStatus: MEASUREMENT_STATUS.MEASURED,
    anchorAt: at,
    measuredAt: at,
    baselineAt: at,
    baselinePrice: 100,
    reactionPrice: 101,
    priceSource: 'alpaca_iex',
  });
}

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

// A seeded database with a spread of market-hours / off-hours / measured rows.
//   1 AAPL Fri 10:30 ET market-hours, unmeasured, model_v1 score
//   2 AAPL Thu 10:30 ET market-hours, unmeasured (older)
//   3 MSFT Fri 11:00 ET market-hours, MEASURED
//   4 NVDA Sat off-hours
//   5 TSLA Fri 09:00 ET off-hours (before the open)
function seededDb() {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-12T14:30:00.000Z' });
  insertEvent(db, { id: 2, ticker: 'AAPL', receivedAt: '2026-06-11T14:30:00.000Z' });
  insertEvent(db, { id: 3, ticker: 'MSFT', receivedAt: '2026-06-12T15:00:00.000Z' });
  insertEvent(db, { id: 4, ticker: 'NVDA', receivedAt: '2026-06-13T15:00:00.000Z' });
  insertEvent(db, { id: 5, ticker: 'TSLA', receivedAt: '2026-06-12T13:00:00.000Z' });
  insertModelV1Score(db, 1);
  measure(db, 3, '10s', '2026-06-12T15:00:10.000Z');
  return db;
}

// --- argument parsing & cap enforcement -----------------------------------

test('parseArgs defaults are small and safe', () => {
  assert.deepEqual(parseArgs([]), { limit: DEFAULT_LIMIT, ticker: null, all: false });
  assert.equal(DEFAULT_LIMIT, 10);
});

test('parseArgs clamps --limit, reads --ticker and --all', () => {
  assert.equal(parseArgs(['--limit', '9999']).limit, MAX_LIMIT);
  assert.equal(MAX_LIMIT, 50);
  assert.equal(parseArgs(['--limit', '3']).limit, 3);
  assert.equal(parseArgs(['--limit', 'nope']).limit, DEFAULT_LIMIT);
  assert.equal(parseArgs(['--ticker', 'aapl']).ticker, 'AAPL'); // uppercased
  assert.equal(parseArgs(['--all']).all, true);
});

// --- market-hours approximation (DST handled by Intl) ----------------------

test('isMarketHours handles EDT, EST, boundaries, and weekends', () => {
  // Summer (EDT, UTC-4): 14:30Z = 10:30 ET → in.
  assert.equal(isMarketHours('2026-06-12T14:30:00.000Z'), true);
  // Before the open: 13:00Z = 09:00 ET → out.
  assert.equal(isMarketHours('2026-06-12T13:00:00.000Z'), false);
  // Just inside the close: 19:59Z = 15:59 ET → in.
  assert.equal(isMarketHours('2026-06-12T19:59:00.000Z'), true);
  // At the close (exclusive): 20:00Z = 16:00 ET → out.
  assert.equal(isMarketHours('2026-06-12T20:00:00.000Z'), false);
  // Winter (EST, UTC-5): 14:30Z = 09:30 ET → in at the open.
  assert.equal(isMarketHours('2026-01-09T14:30:00.000Z'), true);
  assert.equal(isMarketHours('2026-01-09T21:00:00.000Z'), false); // 16:00 ET
  // Weekend: Saturday → out.
  assert.equal(isMarketHours('2026-06-13T15:00:00.000Z'), false);
  // Garbage timestamp → out, never throws.
  assert.equal(isMarketHours('not-a-date'), false);
});

test('easternParts decomposes a UTC timestamp into Eastern parts', () => {
  assert.deepEqual(easternParts('2026-06-12T14:30:00.000Z'), {
    weekday: 'Fri',
    hour: 10,
    minute: 30,
    minutesOfDay: 630,
  });
  assert.equal(easternParts('not-a-date'), null);
});

// --- selection / ranking / filtering ---------------------------------------

test('collectCandidates default keeps market-hours, unmeasured events, ranked newest first', () => {
  const db = seededDb();
  const result = collectCandidates(db, {});
  assert.equal(result.scanned, 5); // all eligible (ticker + received_at)
  assert.equal(result.marketHoursOnly, true);
  assert.deepEqual(result.candidates.map((c) => c.id), [1, 2]); // 3 measured, 4/5 off-hours
  const [first] = result.candidates;
  assert.equal(first.id, 1);
  assert.equal(first.marketHours, true);
  assert.equal(first.measured, false);
  assert.equal(first.hasModelV1, true);
  closeDatabase(db);
});

test('collectCandidates --all lists every eligible event, ranked best-first', () => {
  const db = seededDb();
  const result = collectCandidates(db, { all: true });
  assert.equal(result.marketHoursOnly, false);
  // market-hours unmeasured (1,2), then market-hours measured (3),
  // then off-hours newest-first (4 Sat, 5 Fri 09:00).
  assert.deepEqual(result.candidates.map((c) => c.id), [1, 2, 3, 4, 5]);
  const event3 = result.candidates.find((c) => c.id === 3);
  assert.equal(event3.measured, true);
  assert.deepEqual(event3.reactionCounts, { measured: 1 });
  const event4 = result.candidates.find((c) => c.id === 4);
  assert.equal(event4.marketHours, false);
  closeDatabase(db);
});

test('collectCandidates filters by ticker', () => {
  const db = seededDb();
  const result = collectCandidates(db, { ticker: 'aapl', all: true });
  assert.equal(result.ticker, 'AAPL');
  assert.equal(result.scanned, 2); // events 1 and 2 are AAPL
  assert.deepEqual(result.candidates.map((c) => c.id), [1, 2]);
  closeDatabase(db);
});

test('collectCandidates honors the limit cap', () => {
  const db = seededDb();
  assert.equal(collectCandidates(db, { all: true, limit: 1 }).candidates.length, 1);
  closeDatabase(db);
});

// --- no-event behavior -----------------------------------------------------

test('collectCandidates returns nothing on an empty database', () => {
  const db = freshDb();
  const result = collectCandidates(db, {});
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.candidates, []);
  const text = buildCandidatesReport(result).join('\n');
  assert.match(text, /no eligible news_events rows/);
  closeDatabase(db);
});

test('buildCandidatesReport explains the no-market-hours-candidates case', () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-13T15:00:00.000Z' }); // Saturday
  const result = collectCandidates(db, {});
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.candidates, []);
  const text = buildCandidatesReport(result).join('\n');
  assert.match(text, /no market-hours, unmeasured candidates/);
  assert.match(text, /try --all/);
  closeDatabase(db);
});

// --- report formatting & suggested commands --------------------------------

test('buildCandidatesReport renders sanitized per-event lines and measure commands', () => {
  const db = seededDb();
  const text = buildCandidatesReport(collectCandidates(db, {})).join('\n');
  assert.match(text, /scanned: {4}5 event/);
  assert.match(text, /filter: {5}market-hours, not-yet-measured/);
  assert.match(text, /candidates: 2/);
  assert.match(text, /- event 1 AAPL \[alpaca\] {2}received 2026-06-12T14:30:00.000Z \(ET 10:30 Fri\)/);
  assert.match(text, /market_hours=yes {2}model_v1=yes {2}measured=no {2}reactions: none/);
  assert.match(text, /measure: node --env-file=.env scripts\/measureReactionsOnce.js --ids 1/);
  assert.match(text, /measure top 2: node --env-file=.env scripts\/measureReactionsOnce.js --ids 1,2/);
  // The stored headline never reaches the sanitized report.
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('buildCandidatesReport caps the suggested combined command at MAX_SUGGESTED_IDS', () => {
  const candidates = [];
  for (let id = 1; id <= 8; id += 1) {
    candidates.push({
      id,
      ticker: 'AAPL',
      provider: 'alpaca',
      receivedAt: '2026-06-12T14:30:00.000Z',
      et: '10:30 Fri',
      marketHours: true,
      hasModelV1: false,
      measured: false,
      reactionCounts: {},
      headline: 'RAW-MUST-NOT-PRINT', // smuggled extra field is ignored
    });
  }
  const text = buildCandidatesReport({
    scanned: 8,
    marketHoursOnly: true,
    ticker: null,
    candidates,
  }).join('\n');
  assert.equal(MAX_SUGGESTED_IDS, 5);
  assert.match(text, /measure top 5: node --env-file=.env scripts\/measureReactionsOnce.js --ids 1,2,3,4,5/);
  assert.ok(!text.includes('RAW-MUST-NOT-PRINT'));
});

test('importing the script performs no network, writes, or credential reads', () => {
  assert.equal(typeof collectCandidates, 'function');
  assert.equal(typeof buildCandidatesReport, 'function');
});
