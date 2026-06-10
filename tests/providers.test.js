// tests/providers.test.js — Phase 2 provider abstraction validation.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNewsEvent } from '../src/providers/normalize.js';
import { assertNormalizedNewsEvent, validateProvider } from '../src/providers/newsProvider.js';
import { createMockProvider } from '../src/providers/mockProvider.js';

const BASE_INPUT = {
  provider: 'mock',
  headline: 'Test headline',
  publishedAt: '2026-06-09T14:30:00.000Z',
};

const RAW_ITEMS = [
  {
    id: 1,
    symbols: ['aapl'],
    headline: 'Apple announces something',
    summary: 'Summary A',
    created_at: '2026-06-09T10:00:00Z',
    type: 'press_release',
  },
  {
    id: 2,
    symbols: ['msft', 'MSFT'],
    headline: 'Microsoft earnings beat',
    created_at: '2026-06-09T12:00:00Z',
    type: 'earnings',
  },
  {
    id: 3,
    symbols: ['tsla'],
    headline: 'Tesla recall news',
    created_at: '2026-06-09T14:00:00Z',
    type: 'recall',
  },
];

// --- normalizeNewsEvent -------------------------------------------------------

test('normalizeNewsEvent uppercases ticker and symbols', () => {
  const event = normalizeNewsEvent({
    ...BASE_INPUT,
    ticker: 'aapl',
    symbols: ['aapl', 'msft', 'aapl', ' tsla '],
  });
  assert.equal(event.ticker, 'AAPL');
  assert.deepEqual(event.symbols, ['AAPL', 'MSFT', 'TSLA']); // upper + deduped + trimmed
});

test('normalizeNewsEvent trims headline', () => {
  const event = normalizeNewsEvent({ ...BASE_INPUT, headline: '  Spaced out headline  ' });
  assert.equal(event.headline, 'Spaced out headline');
});

test('normalizeNewsEvent rejects missing provider', () => {
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, provider: undefined }), /provider/i);
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, provider: '  ' }), /provider/i);
});

test('normalizeNewsEvent rejects missing headline', () => {
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, headline: undefined }), /headline/i);
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, headline: '   ' }), /headline/i);
});

test('normalizeNewsEvent converts valid dates to UTC ISO strings', () => {
  // string with timezone offset
  const fromOffset = normalizeNewsEvent({ ...BASE_INPUT, publishedAt: '2026-06-09T10:00:00-04:00' });
  assert.equal(fromOffset.publishedAt, '2026-06-09T14:00:00.000Z');
  // Date object
  const fromDate = normalizeNewsEvent({ ...BASE_INPUT, publishedAt: new Date(Date.UTC(2026, 5, 9, 9, 30)) });
  assert.equal(fromDate.publishedAt, '2026-06-09T09:30:00.000Z');
  // epoch milliseconds
  const fromEpoch = normalizeNewsEvent({ ...BASE_INPUT, publishedAt: Date.UTC(2026, 5, 9, 8, 0) });
  assert.equal(fromEpoch.publishedAt, '2026-06-09T08:00:00.000Z');
  // invalid date throws
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, publishedAt: 'not-a-date' }), /invalid publishedAt/i);
  // missing publishedAt throws (database requires it)
  assert.throws(() => normalizeNewsEvent({ ...BASE_INPUT, publishedAt: undefined }), /publishedAt/i);
});

test('normalizeNewsEvent defaults newsType to other', () => {
  const event = normalizeNewsEvent({ ...BASE_INPUT, rawType: 'earnings' });
  assert.equal(event.newsType, 'other'); // classification is Phase 3, not here
  assert.equal(event.rawType, 'earnings'); // original label preserved
});

test('normalizeNewsEvent stringifies providerEventId and preserves raw', () => {
  const raw = { id: 42, extra: 'untouched' };
  const event = normalizeNewsEvent({ ...BASE_INPUT, providerEventId: 42, raw });
  assert.equal(event.providerEventId, '42');
  assert.equal(event.raw, raw);
  const noId = normalizeNewsEvent(BASE_INPUT);
  assert.equal(noId.providerEventId, null);
});

// --- mock provider ------------------------------------------------------------

test('mock provider satisfies the provider contract and returns normalized events', async () => {
  const provider = createMockProvider(RAW_ITEMS);
  validateProvider(provider);
  const events = await provider.fetchNews();
  assert.equal(events.length, 3);
  for (const event of events) assertNormalizedNewsEvent(event);
  assert.equal(events[0].provider, 'mock');
  assert.equal(events[0].ticker, 'AAPL'); // derived from symbols
  assert.equal(events[0].publishedAt, '2026-06-09T10:00:00.000Z');
});

test('mock provider filters by symbol (case-insensitive)', async () => {
  const provider = createMockProvider(RAW_ITEMS);
  const events = await provider.fetchNews({ symbols: ['msft'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].headline, 'Microsoft earnings beat');
});

test('mock provider filters by since/until', async () => {
  const provider = createMockProvider(RAW_ITEMS);
  const since = await provider.fetchNews({ since: '2026-06-09T11:00:00Z' });
  assert.deepEqual(since.map((e) => e.ticker), ['MSFT', 'TSLA']);
  const until = await provider.fetchNews({ until: '2026-06-09T11:00:00Z' });
  assert.deepEqual(until.map((e) => e.ticker), ['AAPL']);
  const window = await provider.fetchNews({ since: '2026-06-09T11:00:00Z', until: '2026-06-09T13:00:00Z' });
  assert.deepEqual(window.map((e) => e.ticker), ['MSFT']);
});

test('mock provider respects limit', async () => {
  const provider = createMockProvider(RAW_ITEMS);
  assert.equal((await provider.fetchNews({ limit: 2 })).length, 2);
  assert.equal((await provider.fetchNews({ limit: 0 })).length, 0);
});

test('no network calls are made', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network call attempted in mock provider');
  };
  try {
    const provider = createMockProvider(RAW_ITEMS);
    await provider.fetchNews({ symbols: ['AAPL'], since: 0, until: Date.now(), limit: 10 });
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
