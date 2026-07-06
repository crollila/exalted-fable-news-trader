// tests/providerCursors.test.js — Pure per-provider cursor helpers + bounded
// transport pagination. FAKE HTTP ONLY: every transport test injects a fake
// fetch; npm test never touches the network. No real keys.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  resolveProviderSince,
  nextCursorValue,
  clampMaxPages,
  DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE,
  MAX_PROVIDER_MAX_PAGES_PER_CYCLE,
} from '../src/paper/providerCursors.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createBenzingaNewsHttpTransport } from '../src/providers/benzingaNewsHttpTransport.js';

const FAKE_ALPACA = { ALPACA_API_KEY_ID: 'TEST-KEY', ALPACA_API_SECRET_KEY: 'TEST-SECRET' };
const FAKE_BENZINGA = { BENZINGA_API_KEY: 'TEST-BZ-KEY' };

// --- pure helpers -----------------------------------------------------------

test('resolveProviderSince narrows to the cursor but never past the lookback floor', () => {
  const nowMs = Date.parse('2026-06-18T15:00:00.000Z');
  const floor = '2026-06-18T14:00:00.000Z';
  // No cursor => the lookback floor.
  assert.equal(resolveProviderSince({ cursorValue: null, fallbackSinceIso: floor, nowMs }), floor);
  // Cursor newer than the floor => resume from the cursor.
  assert.equal(
    resolveProviderSince({ cursorValue: '2026-06-18T14:30:00.000Z', fallbackSinceIso: floor, nowMs }),
    '2026-06-18T14:30:00.000Z'
  );
  // Cursor OLDER than the floor => clamp to the floor (never widen the window).
  assert.equal(
    resolveProviderSince({ cursorValue: '2026-06-18T10:00:00.000Z', fallbackSinceIso: floor, nowMs }),
    floor
  );
});

test('nextCursorValue advances forward only and holds on an empty ingest', () => {
  assert.equal(nextCursorValue({ priorCursor: null, maxPublishedAt: '2026-06-18T14:05:00.000Z' }), '2026-06-18T14:05:00.000Z');
  // Newer watermark advances.
  assert.equal(
    nextCursorValue({ priorCursor: '2026-06-18T14:00:00.000Z', maxPublishedAt: '2026-06-18T14:05:00.000Z' }),
    '2026-06-18T14:05:00.000Z'
  );
  // Older/equal watermark never moves the cursor backwards.
  assert.equal(
    nextCursorValue({ priorCursor: '2026-06-18T14:05:00.000Z', maxPublishedAt: '2026-06-18T14:00:00.000Z' }),
    '2026-06-18T14:05:00.000Z'
  );
  // Empty ingest (nothing persisted) leaves the cursor unchanged.
  assert.equal(nextCursorValue({ priorCursor: '2026-06-18T14:05:00.000Z', maxPublishedAt: null }), '2026-06-18T14:05:00.000Z');
  assert.equal(nextCursorValue({ priorCursor: null, maxPublishedAt: null }), null);
});

test('clampMaxPages bounds the per-cycle page count', () => {
  assert.equal(clampMaxPages('3'), 3);
  assert.equal(clampMaxPages('999'), MAX_PROVIDER_MAX_PAGES_PER_CYCLE);
  assert.equal(clampMaxPages('0'), DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE);
  assert.equal(clampMaxPages('nope'), DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE);
});

// --- bounded pagination: Alpaca (page_token) --------------------------------

function alpacaItem(id) {
  return { id, headline: `Item ${id}`, created_at: '2026-06-18T14:00:00.000Z', symbols: ['AAPL'], summary: '', content: '', url: `u/${id}`, author: 'a' };
}

/** Fake fetch that serves Alpaca pages keyed by the page_token query param. */
function pagedAlpacaFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const token = new URL(url).searchParams.get('page_token');
    const idx = token ? Number(token) : 0;
    const page = pages[idx];
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ news: page.items, next_page_token: page.next }) };
  };
  fn.calls = calls;
  return fn;
}

test('Alpaca bounded pagination captures every page up to the limit and reports no truncation', async () => {
  const pages = [
    { items: [alpacaItem('1'), alpacaItem('2')], next: '1' },
    { items: [alpacaItem('3'), alpacaItem('4')], next: '2' },
    { items: [alpacaItem('5')], next: null },
  ];
  const http = pagedAlpacaFetch(pages);
  const transport = createAlpacaNewsHttpTransport(loadConfig(FAKE_ALPACA), { httpFetch: http });
  const res = await transport({ symbols: ['AAPL'], maxPages: 5 });
  assert.equal(res.items.length, 5);
  assert.equal(res.pages, 3);
  assert.equal(res.truncated, false);
  assert.equal(http.calls.length, 3);
  assert.equal(new URL(http.calls[0].url).searchParams.get('sort'), 'asc'); // ascending for safe resume
});

test('Alpaca pagination stops at the page bound and flags truncation when pages remain', async () => {
  const pages = [
    { items: [alpacaItem('1'), alpacaItem('2')], next: '1' },
    { items: [alpacaItem('3'), alpacaItem('4')], next: '2' },
    { items: [alpacaItem('5')], next: null },
  ];
  const http = pagedAlpacaFetch(pages);
  const transport = createAlpacaNewsHttpTransport(loadConfig(FAKE_ALPACA), { httpFetch: http });
  const res = await transport({ symbols: ['AAPL'], maxPages: 2 });
  assert.equal(res.items.length, 4);
  assert.equal(res.pages, 2);
  assert.equal(res.truncated, true);
  assert.equal(http.calls.length, 2);
});

// --- bounded pagination: Benzinga (page/pageSize) ---------------------------

function bzItem(id) {
  return { id, title: `Item ${id}`, created: 'Thu, 18 Jun 2026 10:00:00 -0400', stocks: [{ name: 'AAPL' }], teaser: '', body: '', url: `u/${id}`, author: 'a', channels: [{ name: 'News' }] };
}

/** Fake fetch that serves Benzinga pages keyed by the page query param. */
function pagedBenzingaFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const p = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, statusText: 'OK', json: async () => pages[p] };
  };
  fn.calls = calls;
  return fn;
}

test('Benzinga bounded pagination captures full pages until a short page, no truncation', async () => {
  const pages = [[bzItem('1'), bzItem('2')], [bzItem('3'), bzItem('4')], [bzItem('5')]];
  const http = pagedBenzingaFetch(pages);
  const transport = createBenzingaNewsHttpTransport(loadConfig(FAKE_BENZINGA), { httpFetch: http });
  const res = await transport({ symbols: ['AAPL'], limit: 2, maxPages: 5 });
  assert.equal(res.items.length, 5);
  assert.equal(res.pages, 3);
  assert.equal(res.truncated, false);
  assert.equal(new URL(http.calls[0].url).searchParams.get('sort'), 'created:asc');
});

test('Benzinga pagination flags truncation at the page bound when a full page remains', async () => {
  const pages = [[bzItem('1'), bzItem('2')], [bzItem('3'), bzItem('4')], [bzItem('5')]];
  const http = pagedBenzingaFetch(pages);
  const transport = createBenzingaNewsHttpTransport(loadConfig(FAKE_BENZINGA), { httpFetch: http });
  const res = await transport({ symbols: ['AAPL'], limit: 2, maxPages: 2 });
  assert.equal(res.items.length, 4);
  assert.equal(res.pages, 2);
  assert.equal(res.truncated, true);
  assert.equal(http.calls.length, 2);
});

test('a failed page mid-pagination surfaces a sanitized error and never leaks the key', async () => {
  const http = async () => ({ ok: false, status: 429, statusText: `Too Many ${FAKE_BENZINGA.BENZINGA_API_KEY}`, json: async () => ({}) });
  const transport = createBenzingaNewsHttpTransport(loadConfig(FAKE_BENZINGA), { httpFetch: http });
  await assert.rejects(
    () => transport({ symbols: ['AAPL'], limit: 2, maxPages: 3 }),
    (err) => err.status === 429 && !err.message.includes(FAKE_BENZINGA.BENZINGA_API_KEY)
  );
});
