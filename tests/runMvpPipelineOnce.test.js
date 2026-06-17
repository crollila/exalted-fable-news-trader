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
import { buildManualClassifier } from '../scripts/classifyNewsOnce.js';
import {
  parseArgs,
  runPipeline,
  buildPipelineReport,
  DEFAULT_INGEST_LIMIT,
  MAX_INGEST_LIMIT,
  DEFAULT_CLASSIFY_LIMIT,
  MAX_CLASSIFY_LIMIT,
  DEFAULT_MEASURE_LIMIT,
  MAX_MEASURE_LIMIT,
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
    skipIngest: false,
  });
  assert.equal(DEFAULT_INGEST_LIMIT, 5);
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

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runPipeline, 'function');
  assert.equal(typeof buildPipelineReport, 'function');
});
