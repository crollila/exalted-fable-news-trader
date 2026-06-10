// tests/classifyNews.test.js — Optional classification stage wired to
// ingestion. Fixture classifier only: no model calls, no provider APIs,
// no trading logic. Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { countNewsEvents } from '../src/database/newsEvents.js';
import {
  listSentimentScoresForEvent,
  countSentimentScoresByStatus,
} from '../src/database/sentimentScores.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';
import { classifyAndStore, ingestAndClassify } from '../src/ingestion/classifyNews.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import {
  VALID_RESPONSE,
  MALFORMED_JSON_RESPONSE,
  UNKNOWN_ENUM_RESPONSE,
} from './fixtures/modelResponses.js';

const RAW_ITEMS = [
  { id: 'c-1', symbols: ['AAPL'], headline: 'Apple item', created_at: '2026-06-09T10:00:00Z' },
  { id: 'c-2', symbols: ['MSFT'], headline: 'Microsoft item', created_at: '2026-06-09T11:00:00Z' },
  { id: 'c-3', symbols: ['TSLA'], headline: 'Tesla item', created_at: '2026-06-09T12:00:00Z' },
];

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function validClassifier() {
  return createFixtureClassifier({ respond: () => VALID_RESPONSE });
}

function scoreCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM sentiment_scores').get().n);
}

// --- ingestion unchanged without classification --------------------------------

test('normal ingestion still works without classification', async () => {
  const db = freshDb();
  const summary = await ingestNews(db, createMockProvider(RAW_ITEMS));
  assert.equal(summary.inserted, 3);
  assert.equal(scoreCount(db), 0); // no classifier → no scores
  closeDatabase(db);
});

test('ingestAndClassify without a classifier behaves exactly like ingestNews', async () => {
  const db = freshDb();
  const { ingestion, classification } = await ingestAndClassify(db, createMockProvider(RAW_ITEMS));
  assert.equal(ingestion.inserted, 3);
  assert.equal(classification, null);
  assert.equal(scoreCount(db), 0);
  closeDatabase(db);
});

// --- classify-and-store happy path ----------------------------------------------

test('classify-and-store works for fixture classifier parsed output', async () => {
  const db = freshDb();
  const { ingestion, classification } = await ingestAndClassify(db, createMockProvider(RAW_ITEMS), {
    classifier: validClassifier(),
  });
  assert.equal(ingestion.inserted, 3);
  assert.equal(classification.requested, 3);
  assert.equal(classification.classified, 3);
  assert.equal(classification.stored, 3);
  assert.equal(classification.failed, 0);
  assert.equal(classification.skipped, 0);
  assert.deepEqual(classification.statusCounts, { parsed: 3 });
  assert.deepEqual(classification.errors, []);

  const rows = listSentimentScoresForEvent(db, ingestion.insertedIds[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parser_status, 'parsed');
  assert.equal(rows[0].news_type, 'earnings');
  closeDatabase(db);
});

// --- failure outcomes stored as data ---------------------------------------------

test('malformed/fallback/model_error outcomes are stored as sentiment_scores rows', async () => {
  const db = freshDb();
  const { insertedIds } = await ingestNews(db, createMockProvider(RAW_ITEMS));
  // One classifier per outcome, distinct model names so idempotency does not skip.
  const cases = [
    [MALFORMED_JSON_RESPONSE, 'malformed_json', 'm-malformed'],
    [UNKNOWN_ENUM_RESPONSE, 'fallback_used', 'm-fallback'],
  ];
  for (const [raw, expectedStatus, modelName] of cases) {
    const classifier = createFixtureClassifier({ modelName, respond: () => raw });
    const summary = await classifyAndStore(db, classifier, { eventIds: insertedIds });
    assert.equal(summary.stored, 3);
    assert.equal(summary.statusCounts[expectedStatus], 3);
  }
  const errClassifier = createFixtureClassifier({
    modelName: 'm-error',
    respond: () => {
      throw new Error('simulated outage');
    },
  });
  const errSummary = await classifyAndStore(db, errClassifier, { eventIds: insertedIds });
  assert.equal(errSummary.stored, 3);
  assert.equal(errSummary.statusCounts.model_error, 3);

  const counts = countSentimentScoresByStatus(db);
  assert.equal(counts.malformed_json, 3);
  assert.equal(counts.fallback_used, 3);
  assert.equal(counts.model_error, 3);
  closeDatabase(db);
});

test('classification failure does not delete or block news_events', async () => {
  const db = freshDb();
  const { insertedIds } = await ingestNews(db, createMockProvider(RAW_ITEMS));
  const classifier = createFixtureClassifier({ respond: () => MALFORMED_JSON_RESPONSE });
  const summary = await classifyAndStore(db, classifier, { eventIds: insertedIds });
  assert.equal(summary.classified, 3); // all failures, all stored as data
  assert.equal(countNewsEvents(db), 3); // news rows fully intact
  closeDatabase(db);
});

// --- idempotency / dedup interaction ---------------------------------------------

test('rerunning classification on the same events creates no duplicate rows', async () => {
  const db = freshDb();
  const { insertedIds } = await ingestNews(db, createMockProvider(RAW_ITEMS));
  const classifier = validClassifier();

  const first = await classifyAndStore(db, classifier, { eventIds: insertedIds });
  assert.equal(first.stored, 3);

  const second = await classifyAndStore(db, classifier, { eventIds: insertedIds });
  assert.equal(second.stored, 0);
  assert.equal(second.skipped, 3); // same model + prompt_version → skip
  assert.equal(scoreCount(db), 3); // unchanged

  // A different prompt version is a different experiment → stores new rows.
  const v2 = createFixtureClassifier({ promptVersion: 'sentiment_v2', respond: () => VALID_RESPONSE });
  const third = await classifyAndStore(db, v2, { eventIds: insertedIds });
  assert.equal(third.stored, 3);
  assert.equal(scoreCount(db), 6);
  closeDatabase(db);
});

test('duplicate news events skipped by ingestion dedup are not re-classified', async () => {
  const db = freshDb();
  const provider = createMockProvider(RAW_ITEMS);
  const classifier = validClassifier();

  const first = await ingestAndClassify(db, provider, { classifier });
  assert.equal(first.classification.stored, 3);

  // Re-ingest the same items: all duplicates, zero new ids → zero classification.
  const second = await ingestAndClassify(db, provider, { classifier });
  assert.equal(second.ingestion.inserted, 0);
  assert.equal(second.ingestion.duplicates, 3);
  assert.equal(second.classification.requested, 0);
  assert.equal(second.classification.stored, 0);
  assert.equal(scoreCount(db), 3); // no extra rows from the rerun
  closeDatabase(db);
});

// --- error observability and input validation -------------------------------------

test('unknown event ids are skipped and observable in the summary', async () => {
  const db = freshDb();
  const { insertedIds } = await ingestNews(db, createMockProvider([RAW_ITEMS[0]]));
  const summary = await classifyAndStore(db, validClassifier(), {
    eventIds: [...insertedIds, 99999],
  });
  assert.equal(summary.stored, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].newsEventId, 99999);
  assert.match(summary.errors[0].error, /not found/);
  closeDatabase(db);
});

test('classifyAndStore validates its inputs', async () => {
  const db = freshDb();
  await assert.rejects(() => classifyAndStore(db, { name: 'bad' }, { eventIds: [] }), /classifyEvent|promptVersion/);
  await assert.rejects(() => classifyAndStore(db, validClassifier(), {}), /eventIds/);
  closeDatabase(db);
});

test('no network is touched anywhere in the pipeline', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted');
  };
  try {
    const db = freshDb();
    await ingestAndClassify(db, createMockProvider(RAW_ITEMS), { classifier: validClassifier() });
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
