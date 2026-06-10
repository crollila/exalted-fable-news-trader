// tests/pipeline.test.js — END-TO-END fixture-only research pipeline proof.
//
//   provider fixture → normalized event → news_events row
//     → fixture classifier → sentiment_scores row
//     → fixture PriceSource → price_reactions rows
//
// Integration test only: composes existing components, adds no product
// behavior, no CLI, no runtime pipeline. Zero provider/model/market-data
// API calls — proven by a fetch stub around the whole loop.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, countNewsEvents } from '../src/database/newsEvents.js';
import { listSentimentScoresForEvent } from '../src/database/sentimentScores.js';
import { listPriceReactionsForEvent, getPriceReaction, HORIZONS } from '../src/database/priceReactions.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import { createFixturePriceSource } from '../src/prices/priceSource.js';
import { ingestAndClassify } from '../src/ingestion/classifyNews.js';
import { measureEvent } from '../src/eventStudy/measureReactions.js';
import { VALID_RESPONSE } from './fixtures/modelResponses.js';

// One deterministic story: published 14:29:58, received (anchor) 14:30:00.
const ANCHOR = '2026-06-09T14:30:00.000Z';
const RAW_NEWS = [
  {
    id: 'pipe-1',
    symbols: ['AAPL'],
    headline: 'Apple beats earnings and raises guidance',
    summary: 'Strong quarter.',
    created_at: '2026-06-09T14:29:58.000Z',
    received_at: ANCHOR, // pins the anchor to the fixture trades below
    type: 'earnings',
  },
];

// Trades around the anchor: baseline + one trade per horizon window.
const AAPL_TRADES = [
  { price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 }, // baseline
  { price: 200.5, at: '2026-06-09T14:30:05.000Z', size: 20 }, // 10s
  { price: 201.0, at: '2026-06-09T14:30:45.000Z', size: 30 }, // 1m
  { price: 202.0, at: '2026-06-09T14:34:00.000Z', size: 40 }, // 5m
  { price: 203.0, at: '2026-06-09T14:55:00.000Z', size: 25 }, // 30m
  { price: 204.0, at: '2026-06-09T15:25:00.000Z', size: 15 }, // 1h
  { price: 206.0, at: '2026-06-09T20:55:00.000Z', size: 60 }, // eod (21:00Z target)
];

function fixtures() {
  return {
    provider: createMockProvider(RAW_NEWS),
    classifier: createFixtureClassifier({ respond: () => VALID_RESPONSE }),
    priceSource: createFixturePriceSource({ tradesByTicker: { AAPL: AAPL_TRADES } }),
  };
}

test('full local research loop: news -> event row -> score row -> reaction rows', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted in fixture pipeline');
  };
  try {
    const db = openMemoryDatabase();
    runMigrations(db);
    const { provider, classifier, priceSource } = fixtures();

    // Stage 1+2: ingest and classify.
    const { ingestion, classification } = await ingestAndClassify(db, provider, { classifier });
    assert.equal(ingestion.inserted, 1);
    assert.equal(classification.stored, 1);

    // The inserted news event can be queried.
    const eventRow = findNewsEvent(db, 'mock', 'pipe-1');
    assert.ok(eventRow, 'ingested event must be queryable');
    assert.equal(eventRow.ticker, 'AAPL');
    assert.equal(eventRow.received_at, ANCHOR);

    // Exactly one sentiment_scores row, fully parsed.
    const scores = listSentimentScoresForEvent(db, eventRow.id);
    assert.equal(scores.length, 1);
    assert.equal(scores[0].parser_status, 'parsed');
    assert.equal(scores[0].prompt_version, 'sentiment_v1');
    assert.equal(scores[0].news_type, 'earnings');

    // Stage 3: measure price reactions for every canonical horizon.
    const measurement = await measureEvent(db, eventRow, priceSource);
    assert.equal(measurement.results.length, HORIZONS.length);
    assert.ok(measurement.results.every((r) => r.status === 'measured'));
    const reactions = listPriceReactionsForEvent(db, eventRow.id);
    assert.equal(reactions.length, 6);
    assert.deepEqual(reactions.map((r) => r.horizon), ['10s', '1m', '5m', '30m', '1h', 'eod']);

    // At least one measured return_pct is exactly right: (201-200)/200.
    const r1m = getPriceReaction(db, eventRow.id, '1m');
    assert.ok(Math.abs(r1m.return_pct - 0.005) < 1e-12);
    assert.equal(r1m.anchor_at, ANCHOR);
    assert.equal(r1m.price_source, 'fixture');

    // The research join works: event × score × reaction in one query,
    // grouped by prompt_version as the analysis layer will require.
    const joined = db
      .prepare(
        `SELECT n.ticker, s.prompt_version, s.sentiment_score, p.horizon, p.return_pct
         FROM news_events n
         JOIN sentiment_scores s ON s.news_event_id = n.id
         JOIN price_reactions p ON p.news_event_id = n.id
         WHERE s.parser_status IN ('parsed','fallback_used')
           AND p.measurement_status = 'measured'
         ORDER BY p.horizon`
      )
      .all();
    assert.equal(joined.length, 6); // 1 event × 1 score × 6 horizons
    assert.ok(joined.every((row) => row.prompt_version === 'sentiment_v1'));
    assert.ok(joined.every((row) => row.sentiment_score === 0.62));

    assert.equal(networkCalls, 0); // the entire loop touched no network
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('re-running every stage is idempotent: no duplicate rows anywhere', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const { provider, classifier, priceSource } = fixtures();

  // First full pass.
  await ingestAndClassify(db, provider, { classifier });
  const eventRow = findNewsEvent(db, 'mock', 'pipe-1');
  await measureEvent(db, eventRow, priceSource);

  // Second full pass: same provider items, same classifier, same source.
  const second = await ingestAndClassify(db, provider, { classifier });
  assert.equal(second.ingestion.inserted, 0);
  assert.equal(second.ingestion.duplicates, 1); // news event deduped
  assert.equal(second.classification.requested, 0); // nothing new to classify

  // Explicit re-classification of the existing event is also skipped.
  const { classifyAndStore } = await import('../src/ingestion/classifyNews.js');
  const reclassify = await classifyAndStore(db, classifier, { eventIds: [eventRow.id] });
  assert.equal(reclassify.stored, 0);
  assert.equal(reclassify.skipped, 1); // same model + prompt_version

  // Re-measurement replaces rather than duplicates.
  const remeasure = await measureEvent(db, eventRow, priceSource);
  assert.ok(remeasure.results.every((r) => r.replaced === true));

  // Final row counts: exactly one of everything per grain.
  assert.equal(countNewsEvents(db), 1);
  assert.equal(listSentimentScoresForEvent(db, eventRow.id).length, 1);
  assert.equal(listPriceReactionsForEvent(db, eventRow.id).length, 6);
  closeDatabase(db);
});
