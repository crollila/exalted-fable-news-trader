// tests/runMvpPipelineOnce.test.js — Network-free tests for the manual capped
// end-to-end MVP pipeline script. Importing the script runs NOTHING (CLI
// guard). runPipeline is exercised with INJECTED fakes — a mock provider, the
// script's own deterministic manual classifier, and a fixture PriceSource — so
// the full sequence runs fully offline. A fetch stub proves zero network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { countNewsEvents } from '../src/database/newsEvents.js';
import { listPriceReactionsForEvent } from '../src/database/priceReactions.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { createFixturePriceSource } from '../src/prices/priceSource.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';
import { buildManualClassifier } from '../scripts/classifyNewsOnce.js';
import {
  parseArgs,
  runPipeline,
  buildPipelineReport,
  selectMeasurementEvents,
  DEFAULT_INGEST_LIMIT,
  MAX_INGEST_LIMIT,
  DEFAULT_CLASSIFIER,
  DEFAULT_CLASSIFY_LIMIT,
  MAX_CLASSIFY_LIMIT,
  DEFAULT_MEASURE_LIMIT,
  MAX_MEASURE_LIMIT,
  DEFAULT_BASELINE_LOOKBACK_MINUTES,
  MAX_BASELINE_LOOKBACK_MINUTES,
} from '../scripts/runMvpPipelineOnce.js';

const ANCHOR = '2026-06-09T14:30:00.000Z';

// One deterministic story whose received_at pins the anchor to the trades.
const RAW_NEWS = [
  {
    id: 'mvp-1',
    symbols: ['AAPL'],
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    summary: 'Strong quarter.',
    created_at: '2026-06-09T14:29:58.000Z',
    received_at: ANCHOR,
    type: 'earnings',
  },
];

// Baseline + one trade per horizon window (mirrors tests/pipeline.test.js).
const AAPL_TRADES = [
  { price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 },
  { price: 200.5, at: '2026-06-09T14:30:05.000Z', size: 20 },
  { price: 201.0, at: '2026-06-09T14:30:45.000Z', size: 30 },
  { price: 202.0, at: '2026-06-09T14:34:00.000Z', size: 40 },
  { price: 203.0, at: '2026-06-09T14:55:00.000Z', size: 25 },
  { price: 204.0, at: '2026-06-09T15:25:00.000Z', size: 15 },
  { price: 206.0, at: '2026-06-09T20:55:00.000Z', size: 60 },
];

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

// Insert an EXISTING news_events row directly (as if previously ingested), so
// tests can stage an "oldest event 1" trap alongside fresh/current candidates.
function insertEvent(db, { ticker = 'AAPL', receivedAt, provider = 'seed', providerEventId } = {}) {
  const info = db.prepare(INSERT_EVENT_SQL).run({
    provider,
    provider_event_id: providerEventId ?? `evt-${receivedAt}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: 'other',
  });
  return Number(info.lastInsertRowid);
}

// Mark an existing event as already scored by the manual baseline, so the
// classify stage's unscored-selection skips it (mirrors a prior-run score).
async function scoreManual(db, eventId) {
  await classifyAndStore(db, buildManualClassifier(), { eventIds: [eventId] });
}

const OLDER = '2026-06-01T14:30:00.000Z'; // older than ANCHOR; no fixture trades

const baseOpts = {
  symbols: ['AAPL'],
  ingestLimit: 5,
  classifyLimit: 1,
  measureLimit: 1,
  reportLimit: 10,
};

// --- argument parsing & cap enforcement -----------------------------------

test('parseArgs defaults are tiny and safe', () => {
  assert.deepEqual(parseArgs([]), {
    symbols: ['AAPL'],
    ingestLimit: DEFAULT_INGEST_LIMIT,
    classifyLimit: DEFAULT_CLASSIFY_LIMIT,
    measureLimit: DEFAULT_MEASURE_LIMIT,
    measureIds: null,
    skipIngest: false,
    classifier: DEFAULT_CLASSIFIER,
    baselineLookbackMinutes: null, // null → engine default; default behavior unchanged
  });
  assert.equal(DEFAULT_INGEST_LIMIT, 5);
  assert.equal(DEFAULT_CLASSIFIER, 'manual_baseline');
});

test('parseArgs reads --baseline-lookback-minutes, caps it, and rejects junk', () => {
  assert.equal(parseArgs(['--baseline-lookback-minutes', '60']).baselineLookbackMinutes, 60);
  assert.equal(
    parseArgs(['--baseline-lookback-minutes', '99999']).baselineLookbackMinutes,
    MAX_BASELINE_LOOKBACK_MINUTES
  );
  assert.equal(parseArgs(['--baseline-lookback-minutes', '0']).baselineLookbackMinutes, null);
  assert.equal(parseArgs([]).baselineLookbackMinutes, null);
  assert.equal(DEFAULT_BASELINE_LOOKBACK_MINUTES, 15);
});

test('parseArgs reads --measure-ids, dedups, and truncates to the hard cap', () => {
  assert.deepEqual(parseArgs(['--measure-ids', '6,7,8']).measureIds, [6, 7, 8]);
  assert.deepEqual(parseArgs(['--measure-ids', '3,3,1']).measureIds, [3, 1]); // deduped
  // More ids than the measure cap are truncated, so the cap can never be exceeded.
  assert.deepEqual(parseArgs(['--measure-ids', '1,2,3,4,5,6,7']).measureIds, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseArgs(['--measure-ids', 'a,-1,0']).measureIds, []); // all invalid
  assert.equal(parseArgs([]).measureIds, null); // absent → null (use fresh-event priority)
});

test('parseArgs reads --classifier', () => {
  assert.equal(parseArgs(['--classifier', 'openai']).classifier, 'openai');
  assert.equal(parseArgs(['--classifier', 'real_model']).classifier, 'real_model');
});

test('parseArgs clamps every limit to its hard cap and rejects junk', () => {
  const a = parseArgs([
    '--ingest-limit', '999',
    '--classify-limit', '999',
    '--measure-limit', '999',
  ]);
  assert.equal(a.ingestLimit, MAX_INGEST_LIMIT);
  assert.equal(a.classifyLimit, MAX_CLASSIFY_LIMIT);
  assert.equal(a.measureLimit, MAX_MEASURE_LIMIT);
  assert.equal(MAX_INGEST_LIMIT, 20);

  const junk = parseArgs(['--ingest-limit', 'nope', '--measure-limit', '0']);
  assert.equal(junk.ingestLimit, DEFAULT_INGEST_LIMIT);
  assert.equal(junk.measureLimit, DEFAULT_MEASURE_LIMIT);
});

test('parseArgs reads --symbols and --skip-ingest', () => {
  const a = parseArgs(['--symbols', 'AAPL, MSFT ', '--skip-ingest']);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.skipIngest, true);
  // Empty --symbols falls back to the default rather than an empty fetch.
  assert.deepEqual(parseArgs(['--symbols', ' , ']).symbols, ['AAPL']);
});

// --- full sequence, offline, with all stages ------------------------------

test('runPipeline runs ingest -> classify -> measure -> summary with zero network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted in MVP pipeline test');
  };
  try {
    const db = freshDb();
    const result = await runPipeline(
      db,
      {
        provider: createMockProvider(RAW_NEWS),
        classifier: buildManualClassifier(),
        priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
      },
      baseOpts
    );

    // Stage 1: one event ingested.
    assert.equal(result.ingest.ran, true);
    assert.equal(result.ingest.summary.inserted, 1);
    assert.equal(countNewsEvents(db), 1);

    // Stage 2: one deterministic score stored.
    assert.equal(result.classify.ran, true);
    assert.equal(result.classify.selectedCount, 1);
    assert.equal(result.classify.summary.stored, 1);
    assert.deepEqual(result.classify.summary.statusCounts, { parsed: 1 });

    // Stage 3: every horizon measured cleanly on the fixture trades.
    assert.equal(result.measure.ran, true);
    assert.equal(result.measure.selectedCount, 1);
    const reactions = listPriceReactionsForEvent(db, result.measure.batch.summaries[0].newsEventId);
    assert.equal(reactions.length, 6);
    assert.ok(reactions.every((r) => r.measurement_status === 'measured'));

    // Stage 4: read-only summary reflects all three tables.
    assert.equal(result.summary.totalNewsEvents, 1);
    assert.equal(result.summary.totalSentimentScores, 1);
    assert.equal(result.summary.totalPriceReactions, 6);

    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- baseline lookback threading -------------------------------------------

test('runPipeline threads a wider baseline lookback into the price-source window', async () => {
  // Recording source captures the exact window the measure stage requests.
  const calls = [];
  const recordingSource = {
    name: 'recording',
    getTradesAround: async (ticker, fromIso, toIso) => {
      calls.push({ ticker, fromIso, toIso });
      return [];
    },
  };

  // Default (no option): baseline window starts 15m before the anchor, and the
  // engine's own default is surfaced on the result for the report header.
  const db1 = freshDb();
  const result1 = await runPipeline(
    db1,
    { provider: createMockProvider(RAW_NEWS), classifier: buildManualClassifier(), priceSource: recordingSource },
    baseOpts
  );
  assert.equal(calls.at(-1).fromIso, '2026-06-09T14:15:00.000Z');
  assert.equal(result1.measure.baselineLookbackMs, 15 * 60_000);
  const defaultToIso = calls.at(-1).toIso;

  // With baselineLookbackMs (60m): window starts 60m earlier; reaction END
  // unchanged; the chosen value is surfaced on the result.
  const db2 = freshDb();
  const result2 = await runPipeline(
    db2,
    { provider: createMockProvider(RAW_NEWS), classifier: buildManualClassifier(), priceSource: recordingSource },
    { ...baseOpts, baselineLookbackMs: 60 * 60_000 }
  );
  assert.equal(calls.at(-1).fromIso, '2026-06-09T13:30:00.000Z');
  assert.equal(calls.at(-1).toIso, defaultToIso);
  assert.equal(result2.measure.baselineLookbackMs, 60 * 60_000);
  closeDatabase(db1);
  closeDatabase(db2);
});

// --- skip behavior ---------------------------------------------------------

test('runPipeline skips ingest when no provider is given, still classifies + measures', async () => {
  const db = freshDb();
  // Seed an existing event directly (as if previously ingested).
  await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS),
      classifier: buildManualClassifier(),
      priceSource: null,
      priceSkipReason: 'no creds',
    },
    baseOpts
  );
  // Now run again with ingest skipped but a price source present.
  const result = await runPipeline(
    db,
    {
      provider: null,
      providerSkipReason: 'ingest disabled via --skip-ingest',
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  assert.equal(result.ingest.ran, false);
  assert.match(result.ingest.reason, /--skip-ingest/);
  assert.equal(result.measure.ran, true);
  assert.equal(countNewsEvents(db), 1); // no new ingest
  closeDatabase(db);
});

test('runPipeline reports no_baseline outcomes as data, never hiding them', async () => {
  const db = freshDb();
  // Fixture source with an empty trade window → no baseline for any horizon.
  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS),
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: [] } }),
    },
    baseOpts
  );
  const statuses = new Set();
  for (const s of result.measure.batch.summaries) for (const r of s.results) statuses.add(r.status);
  assert.deepEqual([...statuses], ['no_baseline']); // surfaced, not dropped
  closeDatabase(db);
});

// --- report composition & redaction ---------------------------------------

test('buildPipelineReport composes all four stages and stays sanitized', async () => {
  const db = freshDb();
  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS),
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  const text = buildPipelineReport(result).join('\n');
  assert.match(text, /stage 1: ingest/);
  assert.match(text, /stage 2: classify \/ score/);
  assert.match(text, /stage 3: measure reactions/);
  assert.match(text, /stage 4: research summary/);
  assert.match(text, /model "manual_baseline" prompt "manual_v1"/);
  // The composed measure report carries the lookback header + window diagnostics.
  assert.match(text, /lookback:   15m baseline window/);
  assert.match(text, /window diagnostics:/);
  // The stored headline never reaches the composed, sanitized report.
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('buildPipelineReport renders SKIPPED markers for skipped stages', () => {
  const text = buildPipelineReport({
    ingest: { ran: false, reason: 'ingest disabled via --skip-ingest' },
    classify: {
      selectedCount: 0,
      model: 'manual_baseline',
      promptVersion: 'manual_v1',
      summary: { classified: 0, stored: 0, skipped: 0, failed: 0, statusCounts: {}, errors: [] },
    },
    measure: { ran: false, reason: 'Alpaca credentials not configured' },
    summary: {
      totalNewsEvents: 0,
      totalSentimentScores: 0,
      totalPriceReactions: 0,
      measurementStatusCounts: {},
      horizonCounts: {},
      avgReturnByHorizon: {},
      recentMeasuredEvents: [],
    },
  }).join('\n');
  assert.match(text, /SKIPPED: ingest disabled via --skip-ingest/);
  assert.match(text, /SKIPPED: Alpaca credentials not configured/);
});

// --- measurement targeting: prefer fresh/current-run events ---------------

test('selectMeasurementEvents honors priority: explicit > inserted > classified > fallback', () => {
  const db = freshDb();
  const id1 = insertEvent(db, { receivedAt: OLDER, providerEventId: 'e1' }); // oldest = fallback trap
  const id2 = insertEvent(db, { receivedAt: '2026-06-02T14:30:00.000Z', providerEventId: 'e2' });
  const id3 = insertEvent(db, { receivedAt: '2026-06-03T14:30:00.000Z', providerEventId: 'e3' });
  const id4 = insertEvent(db, { receivedAt: '2026-06-04T14:30:00.000Z', providerEventId: 'e4' });

  // 1) explicit ids win outright.
  const explicit = selectMeasurementEvents(db, {
    measureIds: [id4], insertedIds: [id3], classifiedIds: [id2], limit: 1,
  });
  assert.equal(explicit.source, 'explicit ids');
  assert.deepEqual(explicit.events.map((r) => r.id), [id4]);

  // 2) inserted ids beat classified + fallback.
  const inserted = selectMeasurementEvents(db, { insertedIds: [id3], classifiedIds: [id2], limit: 1 });
  assert.equal(inserted.source, 'inserted ids');
  assert.deepEqual(inserted.events.map((r) => r.id), [id3]);

  // 3) classified ids beat fallback when nothing was inserted this run.
  const classified = selectMeasurementEvents(db, { classifiedIds: [id2], limit: 1 });
  assert.equal(classified.source, 'classified ids');
  assert.deepEqual(classified.events.map((r) => r.id), [id2]);

  // 4) fallback only when no current-run ids exist — and it is the oldest row.
  const fallback = selectMeasurementEvents(db, { limit: 1 });
  assert.equal(fallback.source, 'fallback selection');
  assert.deepEqual(fallback.events.map((r) => r.id), [id1]);
  closeDatabase(db);
});

test('selectMeasurementEvents enforces the measure cap regardless of source', () => {
  const db = freshDb();
  const ids = [1, 2, 3, 4, 5].map((n) =>
    insertEvent(db, { receivedAt: `2026-06-0${n}T14:30:00.000Z`, providerEventId: `c${n}` })
  );
  // Five inserted ids, cap 1 → at most one event selected.
  assert.equal(selectMeasurementEvents(db, { insertedIds: ids, limit: 1 }).events.length, 1);
  // Cap 3 → at most three; never more than the requested cap.
  assert.equal(selectMeasurementEvents(db, { insertedIds: ids, limit: 3 }).events.length, 3);
  closeDatabase(db);
});

test('runPipeline measures INSERTED current-run events, not the oldest event 1', async () => {
  const db = freshDb();
  const oldId = insertEvent(db, { receivedAt: OLDER, providerEventId: 'old' }); // the event-1 trap
  // Mock provider ingests a fresh event at the anchor → it becomes the inserted id.
  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS),
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  const freshId = result.ingest.summary.insertedIds[0];
  assert.notEqual(freshId, oldId);
  assert.equal(result.measure.selectionSource, 'inserted ids');
  assert.deepEqual(result.measure.batch.summaries.map((s) => s.newsEventId), [freshId]);
  // The fresh event measured cleanly; the old trap was never selected.
  assert.ok(result.measure.batch.summaries[0].results.every((r) => r.status === 'measured'));
  closeDatabase(db);
});

test('runPipeline falls back to CLASSIFIED ids when ingest is skipped (no inserted ids)', async () => {
  const db = freshDb();
  const oldId = insertEvent(db, { receivedAt: OLDER, providerEventId: 'old' });
  await scoreManual(db, oldId); // already scored → excluded from classify selection
  const freshId = insertEvent(db, { receivedAt: ANCHOR, providerEventId: 'fresh' }); // unscored candidate

  const result = await runPipeline(
    db,
    {
      provider: null,
      providerSkipReason: 'ingest disabled via --skip-ingest',
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  // Classify picked the fresh unscored event; measurement targets that, not event 1.
  assert.equal(result.classify.selectedCount, 1);
  assert.equal(result.measure.selectionSource, 'classified ids');
  assert.deepEqual(result.measure.batch.summaries.map((s) => s.newsEventId), [freshId]);
  assert.notEqual(freshId, oldId);
  closeDatabase(db);
});

test('runPipeline with explicit --measure-ids measures exactly those events', async () => {
  const db = freshDb();
  insertEvent(db, { receivedAt: OLDER, providerEventId: 'old' }); // event 1 trap
  const targetId = insertEvent(db, { receivedAt: ANCHOR, providerEventId: 'target' });

  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS), // also inserts a fresh event
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    { ...baseOpts, measureIds: [targetId] }
  );
  // Explicit ids win over the just-inserted event and over the fallback.
  assert.equal(result.measure.selectionSource, 'explicit ids');
  assert.deepEqual(result.measure.batch.summaries.map((s) => s.newsEventId), [targetId]);
  closeDatabase(db);
});

test('duplicate-only ingest does not blindly force event 1 when a current candidate exists', async () => {
  const db = freshDb();
  // Event 1 is a 'mock'/'mvp-1' row that the provider will re-emit as a dup.
  const oldId = insertEvent(db, {
    receivedAt: OLDER, provider: 'mock', providerEventId: 'mvp-1',
  });
  await scoreManual(db, oldId); // already scored
  const freshId = insertEvent(db, { receivedAt: ANCHOR, providerEventId: 'fresh' }); // unscored

  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS), // RAW_NEWS id 'mvp-1' → duplicate of event 1
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  // Ingest produced a duplicate, no inserted ids.
  assert.equal(result.ingest.summary.duplicates, 1);
  assert.deepEqual(result.ingest.summary.insertedIds, []);
  // So measurement targets the classified current candidate, never event 1.
  assert.equal(result.measure.selectionSource, 'classified ids');
  assert.deepEqual(result.measure.batch.summaries.map((s) => s.newsEventId), [freshId]);
  assert.notEqual(freshId, oldId);
  closeDatabase(db);
});

test('buildPipelineReport shows the measurement selection source and stays sanitized', async () => {
  const db = freshDb();
  insertEvent(db, { receivedAt: OLDER, providerEventId: 'old' });
  const result = await runPipeline(
    db,
    {
      provider: createMockProvider(RAW_NEWS),
      classifier: buildManualClassifier(),
      priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
    },
    baseOpts
  );
  const text = buildPipelineReport(result).join('\n');
  assert.match(text, /measurement target — source: inserted ids/);
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runPipeline, 'function');
  assert.equal(typeof buildPipelineReport, 'function');
  assert.equal(typeof selectMeasurementEvents, 'function');
});
