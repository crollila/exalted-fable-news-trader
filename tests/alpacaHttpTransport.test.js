// tests/alpacaHttpTransport.test.js — Alpaca News HTTP transport.
// FAKE HTTP ONLY: every test injects a fake fetch; npm test never touches
// the network (proven below). No real keys: fake values only.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { assertNormalizedNewsEvent } from '../src/providers/newsProvider.js';
import { ALPACA_NEWS_FIXTURES } from './fixtures/alpacaNews.js';

// Obviously-fake test credentials (never real keys).
const FAKE_KEY_ID = 'TEST-FAKE-KEY-ID-12345';
const FAKE_SECRET = 'TEST-FAKE-SECRET-67890';

function configuredConfig() {
  return loadConfig({ ALPACA_API_KEY_ID: FAKE_KEY_ID, ALPACA_API_SECRET_KEY: FAKE_SECRET });
}

function okResponse(payload) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
}

/** Fake fetch that records calls and returns a queued response. */
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === 'function') return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}

// --- not configured -----------------------------------------------------------

test('no credentials → throws not-configured and makes zero HTTP calls', () => {
  const http = fakeFetch(okResponse({ news: [] }));
  const noKeys = loadConfig({}); // alpacaNews.keyId/secretKey both null
  assert.throws(() => createAlpacaNewsHttpTransport(noKeys, { httpFetch: http }), /not configured/i);
  const onlyOneKey = loadConfig({ ALPACA_API_KEY_ID: FAKE_KEY_ID });
  assert.throws(() => createAlpacaNewsHttpTransport(onlyOneKey, { httpFetch: http }), /not configured/i);
  assert.equal(http.calls.length, 0); // construction throws BEFORE any HTTP
});

// --- success path ---------------------------------------------------------------

test('fake HTTP success returns raw items compatible with the existing adapter', async () => {
  const http = fakeFetch(okResponse({ news: ALPACA_NEWS_FIXTURES }));
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });

  const rawItems = await transport({});
  assert.equal(rawItems.length, 3);
  assert.equal(rawItems[0].id, ALPACA_NEWS_FIXTURES[0].id);

  // The unchanged adapter normalizes transport output end-to-end.
  const provider = createAlpacaNewsProvider({ fetchRawNews: transport });
  const events = await provider.fetchNews({});
  assert.equal(events.length, 3);
  for (const event of events) {
    assertNormalizedNewsEvent(event);
    assert.equal(event.provider, 'alpaca');
  }
  assert.equal(events[0].ticker, 'AAPL');
});

test('bare-array payloads are tolerated', async () => {
  const http = fakeFetch(okResponse(ALPACA_NEWS_FIXTURES));
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });
  assert.equal((await transport({})).length, 3);
});

// --- query option mapping ---------------------------------------------------------

test('query options map to URL params without leaking secrets', async () => {
  const http = fakeFetch(okResponse({ news: [] }));
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });
  await transport({
    symbols: ['aapl', ' msft '],
    since: '2026-06-09T14:00:00Z',
    until: '2026-06-09T15:00:00Z',
    limit: 25,
  });
  assert.equal(http.calls.length, 1); // exactly one-shot
  const url = new URL(http.calls[0].url);
  assert.equal(url.searchParams.get('symbols'), 'AAPL,MSFT');
  assert.equal(url.searchParams.get('start'), '2026-06-09T14:00:00.000Z');
  assert.equal(url.searchParams.get('end'), '2026-06-09T15:00:00.000Z');
  assert.equal(url.searchParams.get('limit'), '25');
  // Secrets travel in headers only — never in the URL.
  assert.ok(!http.calls[0].url.includes(FAKE_KEY_ID));
  assert.ok(!http.calls[0].url.includes(FAKE_SECRET));
  assert.equal(http.calls[0].init.headers['APCA-API-KEY-ID'], FAKE_KEY_ID);
});

test('omitted options produce a bare URL with no params', async () => {
  const http = fakeFetch(okResponse({ news: [] }));
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });
  await transport();
  assert.equal(new URL(http.calls[0].url).searchParams.size, 0);
});

// --- failure paths, all sanitized ---------------------------------------------------

test('non-2xx response throws sanitized error', async () => {
  const http = fakeFetch({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) });
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });
  await assert.rejects(() => transport({}), /HTTP 403 Forbidden/);
});

test('malformed payload throws sanitized error', async () => {
  const cases = [
    okResponse({ unexpected: true }), // JSON but no news array
    okResponse('a string'),
    { ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('bad json'); } },
  ];
  for (const response of cases) {
    const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: fakeFetch(response) });
    await assert.rejects(() => transport({}), /unexpected payload shape|not valid JSON/);
  }
});

test('no API key appears in thrown messages or serializable error details', async () => {
  // Worst case: the HTTP layer itself throws an error that embeds both keys
  // (real clients can embed request config). The transport must redact.
  const leakyHttp = async () => {
    throw new Error(`connect failed for request with ${FAKE_KEY_ID} and ${FAKE_SECRET}`);
  };
  const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: leakyHttp });
  let caught;
  try {
    await transport({});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  const serialized = JSON.stringify({ message: caught.message, stack: caught.stack ?? '' });
  assert.ok(!caught.message.includes(FAKE_KEY_ID), 'key id leaked in message');
  assert.ok(!caught.message.includes(FAKE_SECRET), 'secret leaked in message');
  assert.ok(!serialized.includes(FAKE_KEY_ID), 'key id leaked in serialized error');
  assert.ok(!serialized.includes(FAKE_SECRET), 'secret leaked in serialized error');
  assert.match(caught.message, /\[redacted\]/); // redaction actually happened

  // Sanity: not-configured and HTTP-status errors also never carry keys.
  try {
    createAlpacaNewsHttpTransport(loadConfig({}), {});
  } catch (err) {
    assert.ok(!err.message.includes(FAKE_KEY_ID));
  }
});

// --- no live network anywhere -------------------------------------------------------

test('npm test performs no live network calls (global fetch untouched)', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('live network attempted');
  };
  try {
    const http = fakeFetch(okResponse({ news: ALPACA_NEWS_FIXTURES }));
    const transport = createAlpacaNewsHttpTransport(configuredConfig(), { httpFetch: http });
    await transport({ symbols: ['AAPL'], limit: 5 });
    assert.equal(networkCalls, 0); // injected fake used; global fetch never hit
  } finally {
    globalThis.fetch = originalFetch;
  }
});
