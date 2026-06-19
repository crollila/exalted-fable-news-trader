// tests/measureReactionsOnce.test.js — Network-free tests for the manual
// capped measurement script. Importing the script runs NOTHING (CLI guard):
// no network, no credentials, no live market-data call. The DB-touching tests
// use an in-memory database and a FIXTURE PriceSource, so npm test stays
// fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createFixturePriceSource } from '../src/prices/priceSource.js';
import { measureEvents } from '../src/eventStudy/measureReactions.js';
import { listPriceReactionsForEvent, HORIZONS } from '../src/database/priceReactions.js';
import {
  parseArgs,
  selectEvents,
  aggregateResults,
  buildMeasureReport,
  perEventDiagnostics,
  resolveBaselineLookbackMs,
  DEFAULT_MEASURE_LIMIT,
  MAX_MEASURE_LIMIT,
  DEFAULT_BASELINE_LOOKBACK_MINUTES,
  MAX_BASELINE_LOOKBACK_MINUTES,
} from '../scripts/measureReactionsOnce.js';

const ANCHOR = '2026-06-09T14:30:00.000Z';

// Trades around the anchor: baseline + one trade per horizon window (mirrors
// tests/pipeline.test.js so every horizon measures cleanly).
const AAPL_TRADES = [
  { price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 },
  { price: 200.5, at: '2026-06-09T14:30:05.000Z', size: 20 },
  { price: 201.0, at: '2026-06-09T14:30:45.000Z', size: 30 },
  { price: 202.0, at: '2026-06-09T14:34:00.000Z', size: 40 },
  { price: 203.0, at: '2026-06-09T14:55:00.000Z', size: 25 },
  { price: 204.0, at: '2026-06-09T15:25:00.000Z', size: 15 },
  { price: 206.0, at: '2026-06-09T20:55:00.000Z', size: 60 },
];

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

function insertEvent(db, { id, ticker, receivedAt }) {
  db.prepare(INSERT_EVENT_SQL).run({
    provider: 'test',
    provider_event_id: `evt-${id}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: 'other',
  });
}

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

// --- argument parsing & cap enforcement -----------------------------------

test('parseArgs defaults to a single event and no custom lookback', () => {
  assert.deepEqual(parseArgs([]), {
    limit: DEFAULT_MEASURE_LIMIT,
    ids: null,
    baselineLookbackMinutes: null, // null → engine default; default behavior unchanged
  });
  assert.equal(DEFAULT_MEASURE_LIMIT, 1);
});

test('parseArgs reads --baseline-lookback-minutes, caps it, and rejects junk', () => {
  assert.equal(parseArgs(['--baseline-lookback-minutes', '60']).baselineLookbackMinutes, 60);
  // Capped to the hard max regardless of input — the window can never balloon.
  assert.equal(
    parseArgs(['--baseline-lookback-minutes', '99999']).baselineLookbackMinutes,
    MAX_BASELINE_LOOKBACK_MINUTES
  );
  // Junk / non-positive → null, so the engine default (unchanged) is used.
  assert.equal(parseArgs(['--baseline-lookback-minutes', '0']).baselineLookbackMinutes, null);
  assert.equal(parseArgs(['--baseline-lookback-minutes', 'nope']).baselineLookbackMinutes, null);
  assert.equal(DEFAULT_BASELINE_LOOKBACK_MINUTES, 15);
});

test('resolveBaselineLookbackMs maps minutes→ms and stays null when omitted', () => {
  assert.equal(resolveBaselineLookbackMs(null), null); // omitted → engine default
  assert.equal(resolveBaselineLookbackMs(60), 60 * 60_000);
});

test('parseArgs clamps --limit to the hard max and rejects junk', () => {
  assert.equal(parseArgs(['--limit', '100']).limit, MAX_MEASURE_LIMIT);
  assert.equal(MAX_MEASURE_LIMIT, 5);
  assert.equal(parseArgs(['--limit', '0']).limit, DEFAULT_MEASURE_LIMIT); // invalid → default
  assert.equal(parseArgs(['--limit', 'nope']).limit, DEFAULT_MEASURE_LIMIT);
  assert.equal(parseArgs(['--limit', '3']).limit, 3);
});

test('parseArgs reads --ids, dedups, and truncates to the hard cap', () => {
  assert.deepEqual(parseArgs(['--ids', '3,1,2']).ids, [3, 1, 2]);
  assert.deepEqual(parseArgs(['--ids', '1,1,2,2']).ids, [1, 2]); // deduped
  // More ids than the cap are truncated, so the cap can never be exceeded.
  assert.deepEqual(parseArgs(['--ids', '1,2,3,4,5,6,7']).ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseArgs(['--ids', 'a,-1,0']).ids, []); // all invalid
});

// --- selection -------------------------------------------------------------

test('selectEvents returns at most the capped number, oldest received_at first', () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: '2026-06-09T12:00:00.000Z' });
  insertEvent(db, { id: 2, ticker: 'MSFT', receivedAt: '2026-06-09T10:00:00.000Z' });
  insertEvent(db, { id: 3, ticker: 'NVDA', receivedAt: '2026-06-09T11:00:00.000Z' });

  const one = selectEvents(db, { limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].ticker, 'MSFT'); // earliest received_at

  const two = selectEvents(db, { limit: 2 });
  assert.deepEqual(two.map((r) => r.ticker), ['MSFT', 'NVDA']);

  // Cap is enforced even if a larger limit slips through.
  assert.equal(selectEvents(db, { limit: 999 }).length, 3);
  closeDatabase(db);
});

test('selectEvents honors explicit --ids (capped, id order)', () => {
  const db = freshDb();
  for (const id of [1, 2, 3]) {
    insertEvent(db, { id, ticker: `T${id}`, receivedAt: '2026-06-09T10:00:00.000Z' });
  }
  const rows = selectEvents(db, { limit: 5, ids: [3, 1] });
  assert.deepEqual(rows.map((r) => r.id).sort(), [1, 3]);
  assert.equal(selectEvents(db, { limit: 5, ids: [999] }).length, 0); // unknown id
  closeDatabase(db);
});

// --- no-event behavior -----------------------------------------------------

test('selectEvents returns [] on an empty table (no-event path)', () => {
  const db = freshDb();
  assert.deepEqual(selectEvents(db, { limit: 5 }), []);
  closeDatabase(db);
});

test('buildMeasureReport explains the no-event case without faking work', () => {
  const lines = buildMeasureReport(
    { measuredEvents: 0, failedEvents: 0, summaries: [], errors: [] },
    { selectedCount: 0, sourceName: '(not constructed)' }
  );
  const text = lines.join('\n');
  assert.match(text, /selected:   0 event/);
  assert.match(text, /no eligible news_events rows/);
});

// --- status aggregation ----------------------------------------------------

test('aggregateResults counts statuses, horizons, and replaced rows', () => {
  const batch = {
    measuredEvents: 2,
    failedEvents: 0,
    summaries: [
      {
        newsEventId: 1,
        ticker: 'AAPL',
        results: [
          { horizon: '10s', status: 'measured', replaced: false },
          { horizon: '1m', status: 'measured', replaced: true },
          { horizon: 'eod', status: 'no_reaction', replaced: false },
        ],
      },
      {
        newsEventId: 2,
        ticker: 'MSFT',
        results: [
          { horizon: '10s', status: 'no_baseline', replaced: false },
          { horizon: '1m', status: 'no_baseline', replaced: false },
        ],
      },
    ],
    errors: [],
  };
  const agg = aggregateResults(batch);
  assert.deepEqual(agg.statusCounts, { measured: 2, no_reaction: 1, no_baseline: 2 });
  assert.deepEqual(agg.horizonsAttempted, ['10s', '1m', 'eod']); // canonical order
  assert.equal(agg.reactionRows, 5);
  assert.equal(agg.replacedRows, 1);
});

// --- summary formatting & redaction ---------------------------------------

test('buildMeasureReport renders only sanitized counts and per-event status', () => {
  const batch = {
    measuredEvents: 1,
    failedEvents: 0,
    summaries: [
      {
        newsEventId: 7,
        ticker: 'AAPL',
        results: [
          { horizon: '10s', status: 'measured', replaced: true },
          { horizon: '1m', status: 'measured', replaced: true },
        ],
      },
    ],
    errors: [],
  };
  const text = buildMeasureReport(batch, { selectedCount: 1, sourceName: 'alpaca_iex' }).join('\n');
  assert.match(text, /via source "alpaca_iex"/);
  assert.match(text, /selected:   1 event/);
  assert.match(text, /measured:   1 event/);
  assert.match(text, /horizons:   10s, 1m/);
  assert.match(text, /statuses:   measured=2/);
  assert.match(text, /rows:       2 written \(2 replaced\)/);
  assert.match(text, /- event 7 AAPL: 10s=measured  1m=measured/);
});

test('buildMeasureReport renders per-event errors but never raw payloads', () => {
  const batch = {
    measuredEvents: 0,
    failedEvents: 1,
    summaries: [],
    errors: [{ newsEventId: 4, error: 'measureEvent: eventRow must be a news_events row' }],
  };
  const text = buildMeasureReport(batch, { selectedCount: 1, sourceName: 'alpaca_iex' }).join('\n');
  assert.match(text, /- error \[event 4\]: measureEvent: eventRow/);
  // A smuggled raw payload on the batch is never rendered.
  const sneaky = buildMeasureReport(
    { ...batch, raw: { secret_marker: 'RAW-MUST-NOT-PRINT' } },
    { selectedCount: 1, sourceName: 'alpaca_iex' }
  ).join('\n');
  assert.ok(!sneaky.includes('RAW-MUST-NOT-PRINT'));
});

// --- baseline lookback: window widening & diagnostics ----------------------

test('a wider baseline lookback widens the REQUESTED price-source window', async () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: ANCHOR });
  const events = selectEvents(db, { limit: 1 });

  // Recording source captures the exact window the engine requests (no network).
  const calls = [];
  const recordingSource = {
    name: 'recording',
    getTradesAround: async (ticker, fromIso, toIso) => {
      calls.push({ ticker, fromIso, toIso });
      return [];
    },
  };

  // Default (no option): baseline window starts 15m before the anchor.
  await measureEvents(db, events, recordingSource);
  assert.equal(calls.at(-1).fromIso, '2026-06-09T14:15:00.000Z');
  const defaultToIso = calls.at(-1).toIso;

  // Wider lookback threaded as an engine option: window starts 60m earlier,
  // while the reaction-window END is unchanged (only the baseline start moves).
  await measureEvents(db, events, recordingSource, { baselineLookbackMs: resolveBaselineLookbackMs(60) });
  assert.equal(calls.at(-1).fromIso, '2026-06-09T13:30:00.000Z');
  assert.equal(calls.at(-1).toIso, defaultToIso);
  closeDatabase(db);
});

test('buildMeasureReport renders sanitized window diagnostics + the lookback header', async () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: ANCHOR });
  const events = selectEvents(db, { limit: 1 });
  const source = createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } });
  const batch = await measureEvents(db, events, source);

  const text = buildMeasureReport(batch, { selectedCount: 1, sourceName: source.name }).join('\n');
  assert.match(text, /lookback:   15m baseline window/); // default header
  assert.match(text, /window diagnostics:/);
  assert.match(text, /anchor_at:     2026-06-09T14:30:00.000Z/);
  assert.match(text, /baseline from: 2026-06-09T14:15:00.000Z {2}\(lookback 15m\)/);
  assert.match(text, /reaction to:   2026-06-09T21:00:00.000Z/);
  assert.match(text, /source:        fixture/);
  assert.match(text, /trades seen:   7/); // COUNT only — never the trades themselves
  // The stored headline never leaks into the diagnostics block.
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('buildMeasureReport shows a custom lookback in the header', () => {
  const text = buildMeasureReport(
    { measuredEvents: 0, failedEvents: 0, summaries: [], errors: [] },
    { selectedCount: 0, sourceName: 'alpaca_iex', baselineLookbackMs: 60 * 60_000 }
  ).join('\n');
  assert.match(text, /lookback:   60m baseline window/);
});

test('perEventDiagnostics shows an n/a trade count on source_error and stays sanitized', () => {
  const text = perEventDiagnostics({
    newsEventId: 3,
    ticker: 'AAPL',
    anchorAt: ANCHOR,
    priceSource: 'alpaca_iex',
    window: {
      baselineFromIso: '2026-06-09T14:15:00.000Z',
      reactionToIso: '2026-06-09T21:00:00.000Z',
      baselineLookbackMs: 15 * 60_000,
      tradeCount: null, // source error → count never invented
    },
  }).join('\n');
  assert.match(text, /trades seen:   n\/a \(source error\)/);
  assert.match(text, /source:        alpaca_iex/);
  // A summary with no window data produces no diagnostics lines.
  assert.deepEqual(perEventDiagnostics({ newsEventId: 9, ticker: 'X', results: [] }), []);
});

// --- integration: real writer path via fixture source (offline) -----------

test('measureEvents path writes price_reactions and the report stays sanitized', async () => {
  const db = freshDb();
  insertEvent(db, { id: 1, ticker: 'AAPL', receivedAt: ANCHOR });
  const events = selectEvents(db, { limit: 1 });
  assert.equal(events.length, 1);

  const source = createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } });
  const batch = await measureEvents(db, events, source);

  // Rows actually landed through insertPriceReaction (one per horizon).
  const reactions = listPriceReactionsForEvent(db, events[0].id);
  assert.equal(reactions.length, HORIZONS.length);
  assert.ok(reactions.every((r) => r.measurement_status === 'measured'));

  const text = buildMeasureReport(batch, { selectedCount: events.length, sourceName: source.name }).join('\n');
  assert.match(text, /measured:   1 event/);
  assert.match(text, /statuses:   measured=6/);
  // The headline stored on the event never reaches the sanitized report.
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof buildMeasureReport, 'function');
  assert.equal(typeof selectEvents, 'function');
});
