// tests/alphaVantageProvider.test.js — Alpha Vantage adapter skeleton
// (fixtures only). No network calls, no API keys, no sentiment engine.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlphaVantageNewsProvider,
  compactTimestampToIso,
} from '../src/providers/alphaVantageNewsProvider.js';
import { validateProvider, assertNormalizedNewsEvent } from '../src/providers/newsProvider.js';
import { ALPHA_VANTAGE_NEWS_FIXTURES } from './fixtures/alphaVantageNews.js';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, countNewsEvents } from '../src/database/newsEvents.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

/** Provider wired to static fixtures instead of a network transport. */
function fixtureProvider(items = ALPHA_VANTAGE_NEWS_FIXTURES) {
  return createAlphaVantageNewsProvider({ fetchRawNews: async () => items });
}

test('alpha vantage provider passes the provider contract validation', () => {
  const provider = fixtureProvider();
  validateProvider(provider);
  assert.equal(provider.name, 'alpha_vantage'); // stable, explicit name
});

test('alpha vantage provider has no network capability by default', async () => {
  const provider = createAlphaVantageNewsProvider(); // no transport injected
  validateProvider(provider);
  await assert.rejects(() => provider.fetchNews(), /no transport configured/i);
});

test('compact time_published parses to UTC ISO; bad input throws', () => {
  assert.equal(compactTimestampToIso('20260609T133000'), '2026-06-09T13:30:00Z');
  assert.throws(() => compactTimestampToIso('2026-06-09'), /unparseable/i);
  assert.throws(() => compactTimestampToIso(null), /unparseable/i);
});

test('alpha vantage fixture maps to canonical normalized event fields', () => {
  const event = fixtureProvider().normalizeProviderItem(ALPHA_VANTAGE_NEWS_FIXTURES[0]);
  assertNormalizedNewsEvent(event);
  assert.equal(event.provider, 'alpha_vantage');
  // No dedicated id in the feed → deterministic derived id from the URL:
  assert.equal(event.providerEventId, 'https://www.example-news.com/apple-supplier-ramp');
  assert.equal(event.ticker, 'AAPL'); // from ticker_sentiment[0].ticker
  assert.deepEqual(event.symbols, ['AAPL']);
  assert.equal(event.headline, 'Apple Supplier Ramps Production Ahead Of Launch'); // from title
  assert.equal(event.summary, 'Suppliers are increasing output ahead of the fall launch.');
  assert.equal(event.body, null); // the feed carries no article body
  assert.equal(event.url, 'https://www.example-news.com/apple-supplier-ramp');
  assert.equal(event.author, 'Jane Reporter, Co Author'); // authors[] joined
  assert.equal(event.publishedAt, '2026-06-09T13:30:00.000Z'); // compact → UTC ISO
  assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // stamped now
  assert.ok(event.receivedAt >= event.publishedAt);
  assert.equal(event.rawType, 'Technology'); // category_within_source
  assert.equal(event.newsType, 'other'); // OUR classification is Phase 3
  assert.equal(event.raw, ALPHA_VANTAGE_NEWS_FIXTURES[0]);
});

test('derived id is deterministic (same item → same id)', () => {
  const provider = fixtureProvider();
  const a = provider.normalizeProviderItem(ALPHA_VANTAGE_NEWS_FIXTURES[0]);
  const b = provider.normalizeProviderItem(ALPHA_VANTAGE_NEWS_FIXTURES[0]);
  assert.equal(a.providerEventId, b.providerEventId);
});

test('multi-ticker sentiment maps to symbols, ticker is first', () => {
  const event = fixtureProvider().normalizeProviderItem(ALPHA_VANTAGE_NEWS_FIXTURES[1]);
  assert.deepEqual(event.symbols, ['XOM', 'CVX']);
  assert.equal(event.ticker, 'XOM');
});

test('empty authors/summary/category become null where appropriate', () => {
  const event = fixtureProvider().normalizeProviderItem(ALPHA_VANTAGE_NEWS_FIXTURES[2]);
  assert.equal(event.author, null);
  assert.equal(event.summary, null);
  assert.equal(event.rawType, null);
  assert.equal(event.ticker, 'BA');
});

test('provider sentiment fields stay in raw payload; sentiment_scores stays empty', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  await ingestNews(db, fixtureProvider());

  // Raw provider sentiment is preserved for later research...
  const row = findNewsEvent(db, 'alpha_vantage', 'https://www.example-news.com/apple-supplier-ramp');
  const raw = JSON.parse(row.raw_payload);
  assert.equal(raw.overall_sentiment_score, 0.31);
  assert.equal(raw.overall_sentiment_label, 'Somewhat-Bullish');
  assert.equal(raw.ticker_sentiment[0].ticker_sentiment_score, '0.42');

  // ...but OUR sentiment engine has not run: sentiment_scores is untouched.
  const count = db.prepare('SELECT COUNT(*) AS n FROM sentiment_scores').get().n;
  assert.equal(Number(count), 0);
  closeDatabase(db);
});

test('ingestion works and repeated runs dedup by provider + provider_event_id', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const provider = fixtureProvider();

  const first = await ingestNews(db, provider);
  assert.equal(first.provider, 'alpha_vantage');
  assert.equal(first.fetched, 3);
  assert.equal(first.inserted, 3);
  assert.equal(first.failed, 0);

  const second = await ingestNews(db, provider);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(countNewsEvents(db), 3);
  closeDatabase(db);
});

test('cross-provider dedup stays scoped by provider name on id collision', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const collidingId = 'https://www.example-news.com/apple-supplier-ramp';

  await ingestNews(db, fixtureProvider([ALPHA_VANTAGE_NEWS_FIXTURES[0]]));

  // A Benzinga event whose id equals the Alpha Vantage derived id must still insert.
  const { createBenzingaNewsProvider } = await import('../src/providers/benzingaNewsProvider.js');
  const benzinga = createBenzingaNewsProvider({
    fetchRawNews: async () => [
      {
        id: collidingId,
        author: 'X',
        created: 'Tue, 09 Jun 2026 12:00:00 -0400',
        updated: 'Tue, 09 Jun 2026 12:00:00 -0400',
        title: 'Colliding id, different provider',
        teaser: '',
        body: '',
        url: 'https://www.benzinga.com/news/collide',
        channels: [],
        stocks: [{ name: 'AAPL' }],
        tags: [],
      },
    ],
  });
  const summary = await ingestNews(db, benzinga);
  assert.equal(summary.inserted, 1); // no false dedup across providers
  assert.equal(countNewsEvents(db), 2);
  closeDatabase(db);
});
