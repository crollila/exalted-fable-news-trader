// tests/polygonProvider.test.js — Polygon/Massive adapter skeleton
// (fixtures only). No network calls, no API keys, no sentiment engine.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolygonNewsProvider } from '../src/providers/polygonNewsProvider.js';
import { validateProvider, assertNormalizedNewsEvent } from '../src/providers/newsProvider.js';
import { POLYGON_NEWS_FIXTURES } from './fixtures/polygonNews.js';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, countNewsEvents } from '../src/database/newsEvents.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

const FIXTURE_ID_0 = '8ec638777ca03b553ae516761c2a22ba2fdd2f37befae3ab6fdab74e9e5193eb';

/** Provider wired to static fixtures instead of a network transport. */
function fixtureProvider(items = POLYGON_NEWS_FIXTURES) {
  return createPolygonNewsProvider({ fetchRawNews: async () => items });
}

test('polygon provider passes the provider contract validation', () => {
  const provider = fixtureProvider();
  validateProvider(provider);
  assert.equal(provider.name, 'polygon'); // stable, explicit name
});

test('polygon provider has no network capability by default', async () => {
  const provider = createPolygonNewsProvider(); // no transport injected
  validateProvider(provider);
  await assert.rejects(() => provider.fetchNews(), /no transport configured/i);
});

test('polygon fixture maps to canonical normalized event fields', () => {
  const event = fixtureProvider().normalizeProviderItem(POLYGON_NEWS_FIXTURES[0]);
  assertNormalizedNewsEvent(event);
  assert.equal(event.provider, 'polygon');
  assert.equal(event.providerEventId, FIXTURE_ID_0); // from dedicated string id
  assert.equal(event.ticker, 'AAPL'); // from tickers[0]
  assert.deepEqual(event.symbols, ['AAPL']);
  assert.equal(event.headline, 'Apple Expands Services Revenue With New Bundle'); // from title
  assert.equal(event.summary, 'Apple introduced a new services bundle aimed at families.'); // from description
  assert.equal(event.body, null); // the feed carries no article body
  assert.equal(event.url, 'https://www.example-wire.com/apple-services-bundle'); // from article_url
  assert.equal(event.author, 'Jane Reporter');
  assert.equal(event.publishedAt, '2026-06-09T13:30:00.000Z'); // from published_utc
  assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // stamped now
  assert.ok(event.receivedAt >= event.publishedAt);
  assert.equal(event.rawType, 'services,subscription'); // keywords preserved
  assert.equal(event.newsType, 'other'); // OUR classification is Phase 3
  assert.equal(event.raw, POLYGON_NEWS_FIXTURES[0]); // publisher + insights preserved
});

test('multi-ticker list maps to symbols, ticker is first', () => {
  const event = fixtureProvider().normalizeProviderItem(POLYGON_NEWS_FIXTURES[1]);
  assert.deepEqual(event.symbols, ['JPM', 'BAC']);
  assert.equal(event.ticker, 'JPM');
});

test('empty author/description/keywords become null where appropriate', () => {
  const event = fixtureProvider().normalizeProviderItem(POLYGON_NEWS_FIXTURES[2]);
  assert.equal(event.author, null);
  assert.equal(event.summary, null);
  assert.equal(event.rawType, null);
  assert.equal(event.ticker, 'DAL');
});

test('fetchNews returns normalized events from fixtures', async () => {
  const events = await fixtureProvider().fetchNews();
  assert.equal(events.length, 3);
  for (const event of events) {
    assertNormalizedNewsEvent(event);
    assert.equal(event.provider, 'polygon');
  }
});

test('polygon insights sentiment stays in raw payload; sentiment_scores stays empty', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  await ingestNews(db, fixtureProvider());

  const row = findNewsEvent(db, 'polygon', FIXTURE_ID_0);
  const raw = JSON.parse(row.raw_payload);
  assert.equal(raw.insights[0].sentiment, 'positive'); // preserved for research
  assert.equal(raw.publisher.name, 'Example Wire');

  const count = db.prepare('SELECT COUNT(*) AS n FROM sentiment_scores').get().n;
  assert.equal(Number(count), 0); // our engine has not run
  closeDatabase(db);
});

test('ingestion works and repeated runs dedup by provider + provider_event_id', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const provider = fixtureProvider();

  const first = await ingestNews(db, provider);
  assert.equal(first.provider, 'polygon');
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

  await ingestNews(db, fixtureProvider([POLYGON_NEWS_FIXTURES[0]]));

  // An Alpaca event whose id equals the Polygon hash id must still insert.
  const { createAlpacaNewsProvider } = await import('../src/providers/alpacaNewsProvider.js');
  const alpaca = createAlpacaNewsProvider({
    fetchRawNews: async () => [
      {
        id: FIXTURE_ID_0, // colliding id, different provider
        headline: 'Colliding id, different provider',
        author: 'X',
        created_at: '2026-06-09T16:00:00Z',
        summary: '',
        content: '',
        url: 'https://example.com/collide',
        symbols: ['AAPL'],
        source: 'benzinga',
      },
    ],
  });
  const summary = await ingestNews(db, alpaca);
  assert.equal(summary.inserted, 1); // no false dedup across providers
  assert.equal(countNewsEvents(db), 2);
  closeDatabase(db);
});
