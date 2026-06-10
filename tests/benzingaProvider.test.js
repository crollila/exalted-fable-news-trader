// tests/benzingaProvider.test.js — Benzinga adapter skeleton (fixtures only).
// No network calls, no API keys. Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBenzingaNewsProvider } from '../src/providers/benzingaNewsProvider.js';
import { validateProvider, assertNormalizedNewsEvent } from '../src/providers/newsProvider.js';
import { BENZINGA_NEWS_FIXTURES } from './fixtures/benzingaNews.js';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, countNewsEvents } from '../src/database/newsEvents.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

/** Provider wired to static fixtures instead of a network transport. */
function fixtureProvider(items = BENZINGA_NEWS_FIXTURES) {
  return createBenzingaNewsProvider({ fetchRawNews: async () => items });
}

test('benzinga provider passes the provider contract validation', () => {
  const provider = fixtureProvider();
  validateProvider(provider);
  assert.equal(provider.name, 'benzinga'); // stable, explicit name
});

test('benzinga provider has no network capability by default', async () => {
  const provider = createBenzingaNewsProvider(); // no transport injected
  validateProvider(provider);
  await assert.rejects(() => provider.fetchNews(), /no transport configured/i);
});

test('benzinga fixture maps to canonical normalized event fields', () => {
  const event = fixtureProvider().normalizeProviderItem(BENZINGA_NEWS_FIXTURES[0]);
  assertNormalizedNewsEvent(event);
  assert.equal(event.provider, 'benzinga');
  assert.equal(event.providerEventId, '38291444'); // from fixture id, stringified
  assert.equal(event.ticker, 'AAPL'); // from stocks[0].name
  assert.deepEqual(event.symbols, ['AAPL']);
  assert.equal(event.headline, 'Apple Raises Guidance After Strong Quarter'); // from title
  assert.equal(event.summary, 'Apple lifted its full-year outlook following better-than-expected results.'); // from teaser
  assert.equal(event.body, '<p>Apple Inc. raised its guidance for the fiscal year...</p>');
  assert.equal(event.url, 'https://www.benzinga.com/news/apple-guidance');
  assert.equal(event.author, 'Benzinga Newsdesk');
  // RFC-2822 with -0400 offset converts to UTC ISO:
  assert.equal(event.publishedAt, '2026-06-09T13:30:00.000Z');
  assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // stamped now
  assert.ok(event.receivedAt >= event.publishedAt);
  assert.equal(event.rawType, 'News,Guidance'); // channel names preserved
  assert.equal(event.newsType, 'other'); // classification is Phase 3
  assert.equal(event.raw, BENZINGA_NEWS_FIXTURES[0]);
});

test('object-wrapped multi-stock list maps to symbols, ticker is first', () => {
  const event = fixtureProvider().normalizeProviderItem(BENZINGA_NEWS_FIXTURES[1]);
  assert.deepEqual(event.symbols, ['NVDA', 'AMD']);
  assert.equal(event.ticker, 'NVDA');
});

test('empty author/teaser/body/channels become null where appropriate', () => {
  const event = fixtureProvider().normalizeProviderItem(BENZINGA_NEWS_FIXTURES[2]);
  assert.equal(event.author, null);
  assert.equal(event.summary, null);
  assert.equal(event.body, null);
  assert.equal(event.rawType, null); // no channels
  assert.equal(event.headline, 'Ford Files Routine Disclosure');
  assert.equal(event.ticker, 'F');
});

test('fetchNews returns normalized events from fixtures', async () => {
  const events = await fixtureProvider().fetchNews();
  assert.equal(events.length, 3);
  for (const event of events) {
    assertNormalizedNewsEvent(event);
    assert.equal(event.provider, 'benzinga');
  }
});

test('benzinga adapter works with ingestion and dedups on repeat (no network)', async () => {
  const db = openMemoryDatabase();
  runMigrations(db);
  const provider = fixtureProvider();

  const first = await ingestNews(db, provider);
  assert.equal(first.provider, 'benzinga');
  assert.equal(first.fetched, 3);
  assert.equal(first.inserted, 3);
  assert.equal(first.failed, 0);

  // Repeated ingestion dedups by provider + provider_event_id.
  const second = await ingestNews(db, provider);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(countNewsEvents(db), 3);

  const row = findNewsEvent(db, 'benzinga', '38291444');
  assert.ok(row);
  assert.equal(row.ticker, 'AAPL');
  assert.equal(row.published_at, '2026-06-09T13:30:00.000Z');
  assert.equal(row.news_type, 'other');
  closeDatabase(db);
});

test('alpaca and benzinga events with same numeric id do not collide', async () => {
  // Dedup key is (provider, provider_event_id) — same id from different
  // providers must store as two separate events.
  const db = openMemoryDatabase();
  runMigrations(db);
  const benzinga = fixtureProvider([{ ...BENZINGA_NEWS_FIXTURES[0], id: 777 }]);
  await ingestNews(db, benzinga);
  const { createAlpacaNewsProvider } = await import('../src/providers/alpacaNewsProvider.js');
  const alpaca = createAlpacaNewsProvider({
    fetchRawNews: async () => [
      {
        id: 777,
        headline: 'Same id, different provider',
        author: 'X',
        created_at: '2026-06-09T16:00:00Z',
        summary: '',
        content: '',
        url: 'https://example.com/x',
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
