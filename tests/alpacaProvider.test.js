// tests/alpacaProvider.test.js — Alpaca News adapter skeleton (fixtures only).
// No network calls, no API keys. Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { validateProvider, assertNormalizedNewsEvent } from '../src/providers/newsProvider.js';
import { ALPACA_NEWS_FIXTURES } from './fixtures/alpacaNews.js';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, countNewsEvents } from '../src/database/newsEvents.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

/** Provider wired to static fixtures instead of a network transport. */
function fixtureProvider(items = ALPACA_NEWS_FIXTURES) {
  return createAlpacaNewsProvider({ fetchRawNews: async () => items });
}

test('alpaca provider passes the provider contract validation', () => {
  const provider = fixtureProvider();
  validateProvider(provider);
  assert.equal(provider.name, 'alpaca'); // stable, explicit name
});

test('alpaca provider has no network capability by default', async () => {
  const provider = createAlpacaNewsProvider(); // no transport injected
  validateProvider(provider); // shape is still valid
  await assert.rejects(() => provider.fetchNews(), /no transport configured/i);
});

test('alpaca fixture maps to canonical normalized event fields', () => {
  const provider = fixtureProvider();
  const event = provider.normalizeProviderItem(ALPACA_NEWS_FIXTURES[0]);
  assertNormalizedNewsEvent(event);
  assert.equal(event.provider, 'alpaca');
  assert.equal(event.providerEventId, '24843171'); // populated from fixture id, stringified
  assert.equal(event.ticker, 'AAPL'); // from symbols
  assert.deepEqual(event.symbols, ['AAPL']);
  assert.equal(event.headline, 'Apple Unveils New Product Line at March Event');
  assert.equal(event.summary, 'Apple announced several new products at its spring event.');
  assert.equal(event.body, '<p>Apple announced several new products today, including...</p>');
  assert.equal(event.url, 'https://www.benzinga.com/news/apple-march-event');
  assert.equal(event.author, 'Jane Reporter');
  assert.equal(event.publishedAt, '2026-06-09T13:30:00.000Z'); // UTC ISO from created_at
  assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // stamped now
  assert.ok(event.receivedAt >= event.publishedAt);
  assert.equal(event.newsType, 'other'); // classification is Phase 3
  assert.equal(event.raw, ALPACA_NEWS_FIXTURES[0]); // original payload preserved
});

test('multi-symbol fixture keeps all symbols, ticker is first', () => {
  const event = fixtureProvider().normalizeProviderItem(ALPACA_NEWS_FIXTURES[1]);
  assert.deepEqual(event.symbols, ['MSFT', 'NVDA']);
  assert.equal(event.ticker, 'MSFT');
});

test('empty author/summary/content become null, not empty strings', () => {
  const event = fixtureProvider().normalizeProviderItem(ALPACA_NEWS_FIXTURES[2]);
  assert.equal(event.author, null);
  assert.equal(event.summary, null);
  assert.equal(event.body, null);
  assert.equal(event.headline, 'Tesla Schedules Annual Shareholder Meeting');
});

test('fetchNews returns normalized events from fixtures', async () => {
  const events = await fixtureProvider().fetchNews();
  assert.equal(events.length, 3);
  for (const event of events) {
    assertNormalizedNewsEvent(event);
    assert.equal(event.provider, 'alpaca');
  }
});

test('alpaca adapter works with the existing ingestion flow (no network)', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const provider = fixtureProvider();

  const first = await ingestNews(db, provider);
  assert.equal(first.provider, 'alpaca');
  assert.equal(first.fetched, 3);
  assert.equal(first.inserted, 3);
  assert.equal(first.failed, 0);

  // Idempotent: same fixtures dedup on provider + provider_event_id.
  const second = await ingestNews(db, provider);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(countNewsEvents(db), 3);

  const row = findNewsEvent(db, 'alpaca', '24843171');
  assert.ok(row);
  assert.equal(row.ticker, 'AAPL');
  assert.equal(row.published_at, '2026-06-09T13:30:00.000Z');
  assert.equal(JSON.parse(row.raw_payload).source, 'benzinga');
  closeDatabase(db);
});
