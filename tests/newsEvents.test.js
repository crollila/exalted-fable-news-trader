// tests/newsEvents.test.js — Persistence + dedup for normalized news events.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  insertNewsEvent,
  findNewsEvent,
  getNewsEventById,
  listRecentNewsEvents,
  countNewsEvents,
} from '../src/database/newsEvents.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { normalizeNewsEvent } from '../src/providers/normalize.js';

const RAW_ITEMS = [
  {
    id: 'evt-100',
    symbols: ['aapl'],
    headline: 'Apple announces product',
    summary: 'Short summary',
    body: 'Full body text',
    url: 'https://example.com/apple',
    author: 'Reporter A',
    created_at: '2026-06-09T10:00:00Z',
    type: 'press_release',
  },
  {
    id: 'evt-200',
    symbols: ['msft'],
    headline: 'Microsoft earnings',
    created_at: '2026-06-09T12:00:00Z',
    type: 'earnings',
  },
];

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

async function mockEvents() {
  return createMockProvider(RAW_ITEMS).fetchNews();
}

test('a normalized mock event can be inserted', async () => {
  const db = freshDb();
  const [event] = await mockEvents();
  const result = insertNewsEvent(db, event);
  assert.equal(result.inserted, true);
  assert.ok(Number.isInteger(result.id) && result.id > 0);
  assert.equal(countNewsEvents(db), 1);
  closeDatabase(db);
});

test('inserting the same provider + provider_event_id twice does not duplicate', async () => {
  const db = freshDb();
  const [event] = await mockEvents();
  const first = insertNewsEvent(db, event);
  const second = insertNewsEvent(db, event);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id); // caller gets the existing row's id
  assert.equal(countNewsEvents(db), 1);
  closeDatabase(db);
});

test('events with null providerEventId are always inserted (no dedup key)', () => {
  const db = freshDb();
  const event = normalizeNewsEvent({
    provider: 'mock',
    headline: 'No id event',
    publishedAt: '2026-06-09T09:00:00Z',
    symbols: ['TSLA'],
  });
  assert.equal(event.providerEventId, null);
  assert.equal(insertNewsEvent(db, event).inserted, true);
  assert.equal(insertNewsEvent(db, event).inserted, true);
  assert.equal(countNewsEvents(db), 2);
  closeDatabase(db);
});

test('the existing row can be queried back by dedup key and by id', async () => {
  const db = freshDb();
  const [event] = await mockEvents();
  const { id } = insertNewsEvent(db, event);
  const byKey = findNewsEvent(db, 'mock', 'evt-100');
  assert.ok(byKey);
  assert.equal(byKey.id, id);
  const byId = getNewsEventById(db, id);
  assert.equal(byId.headline, 'Apple announces product');
  assert.equal(findNewsEvent(db, 'mock', 'no-such-id'), null);
  assert.equal(findNewsEvent(db, 'mock', null), null);
  closeDatabase(db);
});

test('required normalized fields are persisted correctly', async () => {
  const db = freshDb();
  const [event] = await mockEvents();
  const { id } = insertNewsEvent(db, event);
  const row = getNewsEventById(db, id);
  assert.equal(row.provider, 'mock');
  assert.equal(row.provider_event_id, 'evt-100');
  assert.equal(row.ticker, 'AAPL');
  assert.equal(row.headline, 'Apple announces product');
  assert.equal(row.body, 'Full body text');
  assert.equal(row.published_at, '2026-06-09T10:00:00.000Z'); // UTC ISO-8601
  assert.ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.received_at));
  assert.equal(row.news_type, 'other');
  // original provider payload preserved (url/author/symbols recoverable)
  const raw = JSON.parse(row.raw_payload);
  assert.equal(raw.url, 'https://example.com/apple');
  assert.equal(raw.author, 'Reporter A');
  assert.deepEqual(raw.symbols, ['aapl']);
  closeDatabase(db);
});

test('body falls back to summary when provider sent no body', () => {
  const db = freshDb();
  const event = normalizeNewsEvent({
    provider: 'mock',
    providerEventId: 'evt-300',
    headline: 'Summary only',
    summary: 'Just a summary',
    publishedAt: '2026-06-09T11:00:00Z',
    symbols: ['NVDA'],
  });
  const { id } = insertNewsEvent(db, event);
  assert.equal(getNewsEventById(db, id).body, 'Just a summary');
  closeDatabase(db);
});

test('insert rejects events without a ticker', () => {
  const db = freshDb();
  const event = normalizeNewsEvent({
    provider: 'mock',
    headline: 'Market-wide news, no symbols',
    publishedAt: '2026-06-09T08:00:00Z',
  });
  assert.equal(event.ticker, null);
  assert.throws(() => insertNewsEvent(db, event), /ticker/i);
  assert.equal(countNewsEvents(db), 0);
  closeDatabase(db);
});

test('listRecentNewsEvents orders newest first and respects limit/ticker filter', async () => {
  const db = freshDb();
  for (const event of await mockEvents()) insertNewsEvent(db, event);
  const all = listRecentNewsEvents(db);
  assert.deepEqual(all.map((r) => r.ticker), ['MSFT', 'AAPL']); // newest published first
  assert.equal(listRecentNewsEvents(db, { limit: 1 }).length, 1);
  const aapl = listRecentNewsEvents(db, { ticker: 'aapl' });
  assert.equal(aapl.length, 1);
  assert.equal(aapl[0].ticker, 'AAPL');
  closeDatabase(db);
});
