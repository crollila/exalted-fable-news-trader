// tests/ingestion.test.js — Mock provider → normalization → persistence.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { findNewsEvent, listRecentNewsEvents, countNewsEvents } from '../src/database/newsEvents.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';

const RAW_ITEMS = [
  { id: 'a-1', symbols: ['aapl'], headline: 'Apple item', created_at: '2026-06-09T10:00:00Z' },
  { id: 'm-1', symbols: ['msft'], headline: 'Microsoft item', created_at: '2026-06-09T11:00:00Z' },
  { id: 't-1', symbols: ['tsla'], headline: 'Tesla item', created_at: '2026-06-09T12:00:00Z' },
];

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('mock events are ingested and persisted with an accurate summary', async () => {
  const db = freshDb();
  const summary = await ingestNews(db, createMockProvider(RAW_ITEMS));
  assert.equal(summary.provider, 'mock');
  assert.equal(summary.fetched, 3);
  assert.equal(summary.inserted, 3);
  assert.equal(summary.duplicates, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.insertedIds.length, 3);
  assert.deepEqual(summary.errors, []);
  assert.equal(countNewsEvents(db), 3);
  closeDatabase(db);
});

test('duplicates are counted, not inserted twice', async () => {
  const db = freshDb();
  // Provider list contains the same event twice plus one new one.
  const provider = createMockProvider([RAW_ITEMS[0], RAW_ITEMS[0], RAW_ITEMS[1]]);
  const summary = await ingestNews(db, provider);
  assert.equal(summary.fetched, 3);
  assert.equal(summary.inserted, 2);
  assert.equal(summary.duplicates, 1);
  assert.equal(countNewsEvents(db), 2);
  closeDatabase(db);
});

test('repeated ingestion is idempotent for dedupable events', async () => {
  const db = freshDb();
  const provider = createMockProvider(RAW_ITEMS);
  const first = await ingestNews(db, provider);
  const second = await ingestNews(db, provider);
  assert.equal(first.inserted, 3);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  assert.equal(second.insertedIds.length, 0);
  assert.equal(countNewsEvents(db), 3); // unchanged after second run
  closeDatabase(db);
});

test('fetch options pass through to the provider (symbol filter)', async () => {
  const db = freshDb();
  const summary = await ingestNews(db, createMockProvider(RAW_ITEMS), { symbols: ['AAPL'] });
  assert.equal(summary.fetched, 1);
  assert.equal(summary.inserted, 1);
  assert.equal(countNewsEvents(db), 1);
  closeDatabase(db);
});

test('a bad event is recorded as failed without aborting the batch', async () => {
  const db = freshDb();
  // Second item has no symbols → normalized ticker is null → insert rejects it.
  const provider = createMockProvider([
    RAW_ITEMS[0],
    { id: 'bad-1', symbols: [], headline: 'Market-wide, no ticker', created_at: '2026-06-09T13:00:00Z' },
    RAW_ITEMS[2],
  ]);
  const summary = await ingestNews(db, provider);
  assert.equal(summary.fetched, 3);
  assert.equal(summary.inserted, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].error, /ticker/i);
  assert.equal(summary.errors[0].providerEventId, 'bad-1');
  assert.equal(countNewsEvents(db), 2);
  closeDatabase(db);
});

test('persisted rows can be queried back with existing helpers', async () => {
  const db = freshDb();
  const summary = await ingestNews(db, createMockProvider(RAW_ITEMS));
  const row = findNewsEvent(db, 'mock', 'm-1');
  assert.ok(row);
  assert.equal(row.headline, 'Microsoft item');
  assert.ok(summary.insertedIds.includes(row.id));
  const recent = listRecentNewsEvents(db);
  assert.deepEqual(recent.map((r) => r.ticker), ['TSLA', 'MSFT', 'AAPL']); // newest first
  closeDatabase(db);
});

test('ingestNews rejects objects that do not satisfy the provider contract', async () => {
  const db = freshDb();
  await assert.rejects(() => ingestNews(db, { name: 'broken' }), /fetchNews/i);
  closeDatabase(db);
});
