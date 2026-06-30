// tests/alpacaTradesPriceSource.test.js — Real Alpaca trades PriceSource.
// FAKE HTTP ONLY: every test injects a fake fetch; npm test never touches
// the network (proven below). No real keys: fake values only. No database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  createAlpacaTradesPriceSource,
  DEFAULT_FEED,
  DEFAULT_MAX_PAGES,
} from '../src/prices/alpacaTradesPriceSource.js';
import { validatePriceSource } from '../src/prices/priceSource.js';

const FAKE_KEY_ID = 'TEST-FAKE-KEY-ID-12345';
const FAKE_SECRET = 'TEST-FAKE-SECRET-67890';

function configuredConfig() {
  return loadConfig({ ALPACA_API_KEY_ID: FAKE_KEY_ID, ALPACA_API_SECRET_KEY: FAKE_SECRET });
}

function okResponse(payload) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
}

/** Fake fetch that records calls; response may be a value, fn, or queue. */
function fakeFetch(response) {
  const calls = [];
  const queue = Array.isArray(response) ? [...response] : null;
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (queue) return queue.shift();
    if (typeof response === 'function') return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}

// Raw Alpaca-shaped trade items (verified shape: t/p/s plus extras).
const RAW_TRADES = [
  { t: '2026-06-10T14:30:00.123456789Z', p: 201.5, s: 100, x: 'V', i: 1, z: 'C' },
  { t: '2026-06-10T14:30:05.5Z', p: 201.75, s: 50, x: 'V', i: 2, z: 'C' },
  { t: '2026-06-10T14:31:00Z', p: 202.0, s: 25, x: 'V', i: 3, z: 'C' },
];

const FROM = '2026-06-10T14:29:30.250Z';
const TO = '2026-06-10T14:35:00.750Z';

// --- contract & not-configured -------------------------------------------------

test('factory satisfies the PriceSource contract and names the feed', () => {
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: [] })),
  });
  validatePriceSource(source);
  assert.equal(source.name, `alpaca_${DEFAULT_FEED}`);
  const sip = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: [] })),
    feed: 'sip',
  });
  assert.equal(sip.name, 'alpaca_sip');
});

test('no credentials → throws not-configured and makes zero HTTP calls', () => {
  const http = fakeFetch(okResponse({ trades: [] }));
  assert.throws(
    () => createAlpacaTradesPriceSource(loadConfig({}), { httpFetch: http }),
    /not configured/i
  );
  assert.throws(
    () =>
      createAlpacaTradesPriceSource(loadConfig({ ALPACA_API_KEY_ID: FAKE_KEY_ID }), {
        httpFetch: http,
      }),
    /not configured/i
  );
  assert.equal(http.calls.length, 0);
});

// --- success mapping --------------------------------------------------------------

test('success maps t/p/s to at/price/size, ms-normalized, ascending', async () => {
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: [...RAW_TRADES].reverse(), next_page_token: null })),
  });
  const trades = await source.getTradesAround('AAPL', FROM, TO);
  assert.equal(trades.length, 3);
  // ns-precision input normalized to fixed-width ms ISO.
  assert.deepEqual(trades[0], { price: 201.5, at: '2026-06-10T14:30:00.123Z', size: 100 });
  assert.deepEqual(trades[1], { price: 201.75, at: '2026-06-10T14:30:05.500Z', size: 50 });
  assert.deepEqual(trades[2], { price: 202.0, at: '2026-06-10T14:31:00.000Z', size: 25 });
  // Ascending despite reversed input.
  for (let i = 1; i < trades.length; i += 1) assert.ok(trades[i - 1].at <= trades[i].at);
});

test('trades are PriceSource-compatible for the event-study engine fields', async () => {
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: RAW_TRADES })),
  });
  for (const trade of await source.getTradesAround('AAPL', FROM, TO)) {
    assert.equal(typeof trade.price, 'number');
    assert.ok(trade.price > 0);
    assert.match(trade.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});

// --- query parameters --------------------------------------------------------------

test('query includes symbol path, whole-second start/end, feed, limit; no secrets in URL', async () => {
  const http = fakeFetch(okResponse({ trades: [] }));
  const source = createAlpacaTradesPriceSource(configuredConfig(), { httpFetch: http });
  await source.getTradesAround('aapl', FROM, TO);
  assert.equal(http.calls.length, 1);
  const url = new URL(http.calls[0].url);
  assert.ok(url.pathname.endsWith('/stocks/AAPL/trades'), `path was ${url.pathname}`);
  // start floored / end ceiled to whole seconds (API rejects fractions).
  assert.equal(url.searchParams.get('start'), '2026-06-10T14:29:30Z');
  assert.equal(url.searchParams.get('end'), '2026-06-10T14:35:01Z');
  assert.equal(url.searchParams.get('feed'), 'iex');
  assert.equal(url.searchParams.get('limit'), '10000');
  assert.equal(url.searchParams.get('page_token'), null); // first page
  // Secrets travel in headers only — never in the URL.
  assert.ok(!http.calls[0].url.includes(FAKE_KEY_ID));
  assert.ok(!http.calls[0].url.includes(FAKE_SECRET));
  assert.equal(http.calls[0].init.headers['APCA-API-KEY-ID'], FAKE_KEY_ID);
  assert.equal(http.calls[0].init.headers['APCA-API-SECRET-KEY'], FAKE_SECRET);
});

test('getLatestTrade uses the read-only latest trade endpoint and stays sanitized', async () => {
  const http = fakeFetch(okResponse({
    trade: { t: '2026-06-10T14:35:00.123456789Z', p: 203.5, s: 10 },
  }));
  const source = createAlpacaTradesPriceSource(configuredConfig(), { httpFetch: http });
  const trade = await source.getLatestTrade('spy');

  assert.deepEqual(trade, { price: 203.5, at: '2026-06-10T14:35:00.123Z', size: 10 });
  assert.equal(http.calls.length, 1);
  const url = new URL(http.calls[0].url);
  assert.ok(url.pathname.endsWith('/stocks/SPY/trades/latest'), `path was ${url.pathname}`);
  assert.equal(url.searchParams.get('feed'), 'iex');
  assert.ok(!http.calls[0].url.includes(FAKE_KEY_ID));
  assert.ok(!http.calls[0].url.includes(FAKE_SECRET));
});

test('getLatestTrade rejects malformed latest payloads without leaking keys', async () => {
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trade: { t: 'bad', p: 0 } })),
  });
  let caught;
  try {
    await source.getLatestTrade('SPY');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.match(caught.message, /latest trade payload/);
  assert.ok(!caught.message.includes(FAKE_KEY_ID));
  assert.ok(!caught.message.includes(FAKE_SECRET));
});

test('input validation throws before any HTTP', async () => {
  const http = fakeFetch(okResponse({ trades: [] }));
  const source = createAlpacaTradesPriceSource(configuredConfig(), { httpFetch: http });
  await assert.rejects(() => source.getTradesAround('', FROM, TO), /ticker/);
  await assert.rejects(() => source.getTradesAround('AAPL', 'not-a-date', TO), /valid ISO/);
  await assert.rejects(() => source.getTradesAround('AAPL', FROM, 'nope'), /valid ISO/);
  await assert.rejects(() => source.getTradesAround('AAPL', TO, FROM), /must not be after/);
  assert.equal(http.calls.length, 0);
});

// --- window bounding ---------------------------------------------------------------

test('returned trades are strictly window-bounded despite second-rounded request', async () => {
  // The request floors/ceils to whole seconds, so the API may return trades
  // slightly outside the exact ms window; the client must filter them out.
  const padded = [
    { t: '2026-06-10T14:29:30.100Z', p: 200.0, s: 1 }, // before fromIso (.250)
    ...RAW_TRADES,
    { t: '2026-06-10T14:35:00.900Z', p: 203.0, s: 1 }, // after toIso (.750)
  ];
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: padded })),
  });
  const trades = await source.getTradesAround('AAPL', FROM, TO);
  assert.equal(trades.length, 3);
  assert.ok(trades.every((t) => t.at >= FROM && t.at <= TO));
});

test('inclusive bounds: trades exactly at fromIso/toIso are kept', async () => {
  const edges = [
    { t: FROM, p: 1.0, s: 1 },
    { t: TO, p: 2.0, s: 1 },
  ];
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: edges })),
  });
  const trades = await source.getTradesAround('AAPL', FROM, TO);
  assert.equal(trades.length, 2);
});

// --- pagination ---------------------------------------------------------------------

test('pagination follows next_page_token, sends it back, merges ascending', async () => {
  const page1 = okResponse({ trades: [RAW_TRADES[2]], next_page_token: 'TOK-1' });
  const page2 = okResponse({ trades: [RAW_TRADES[0], RAW_TRADES[1]], next_page_token: null });
  const http = fakeFetch([page1, page2]);
  const source = createAlpacaTradesPriceSource(configuredConfig(), { httpFetch: http });
  const trades = await source.getTradesAround('AAPL', FROM, TO);
  assert.equal(http.calls.length, 2);
  assert.equal(new URL(http.calls[0].url).searchParams.get('page_token'), null);
  assert.equal(new URL(http.calls[1].url).searchParams.get('page_token'), 'TOK-1');
  assert.equal(trades.length, 3);
  for (let i = 1; i < trades.length; i += 1) assert.ok(trades[i - 1].at <= trades[i].at);
});

test('page cap throws a sanitized error rather than silently truncating', async () => {
  // Every page claims another page exists.
  const http = fakeFetch(() => okResponse({ trades: [RAW_TRADES[0]], next_page_token: 'MORE' }));
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: http,
    maxPages: 3,
  });
  await assert.rejects(
    () => source.getTradesAround('AAPL', FROM, TO),
    /window too large.*truncated/s
  );
  assert.equal(http.calls.length, 3); // stopped at the cap
  // Default cap is the documented constant.
  assert.equal(DEFAULT_MAX_PAGES, 10);
});

// --- empty & failure paths, all sanitized -------------------------------------------

test('no trades returns [] (null, missing, or empty trades field)', async () => {
  for (const payload of [{ trades: [] }, { trades: null }, { symbol: 'AAPL' }]) {
    const source = createAlpacaTradesPriceSource(configuredConfig(), {
      httpFetch: fakeFetch(okResponse(payload)),
    });
    assert.deepEqual(await source.getTradesAround('AAPL', FROM, TO), []);
  }
});

test('HTTP 401/403/429/5xx produce sanitized errors without keys', async () => {
  for (const [status, statusText] of [
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
  ]) {
    const source = createAlpacaTradesPriceSource(configuredConfig(), {
      httpFetch: fakeFetch({ ok: false, status, statusText, json: async () => ({}) }),
    });
    let caught;
    try {
      await source.getTradesAround('AAPL', FROM, TO);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `expected throw for HTTP ${status}`);
    assert.match(caught.message, new RegExp(`HTTP ${status}`));
    assert.ok(!caught.message.includes(FAKE_KEY_ID));
    assert.ok(!caught.message.includes(FAKE_SECRET));
  }
});

test('malformed responses produce sanitized errors', async () => {
  const cases = [
    okResponse('a string'),
    okResponse([1, 2, 3]),
    okResponse({ trades: 'not-an-array' }),
    { ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('bad json'); } },
  ];
  for (const response of cases) {
    const source = createAlpacaTradesPriceSource(configuredConfig(), {
      httpFetch: fakeFetch(response),
    });
    await assert.rejects(
      () => source.getTradesAround('AAPL', FROM, TO),
      /unexpected payload shape|not valid JSON/
    );
  }
});

test('malformed trade items are dropped; all-malformed throws', async () => {
  const mixed = [{ t: 'garbage', p: 1 }, { t: RAW_TRADES[0].t, p: -5 }, RAW_TRADES[1]];
  const source = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: mixed })),
  });
  const trades = await source.getTradesAround('AAPL', FROM, TO);
  assert.equal(trades.length, 1); // only the valid item survives

  const allBad = createAlpacaTradesPriceSource(configuredConfig(), {
    httpFetch: fakeFetch(okResponse({ trades: [{ t: 'garbage', p: 0 }, { p: 1 }] })),
  });
  await assert.rejects(() => allBad.getTradesAround('AAPL', FROM, TO), /all trade items.*malformed/);
});

test('auth headers are sent but never leak into thrown messages', async () => {
  // Worst case: the HTTP layer throws an error embedding both keys.
  const leakyHttp = async () => {
    throw new Error(`connect failed with ${FAKE_KEY_ID} / ${FAKE_SECRET}`);
  };
  const source = createAlpacaTradesPriceSource(configuredConfig(), { httpFetch: leakyHttp });
  let caught;
  try {
    await source.getTradesAround('AAPL', FROM, TO);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  const serialized = JSON.stringify({ message: caught.message, stack: caught.stack ?? '' });
  assert.ok(!caught.message.includes(FAKE_KEY_ID));
  assert.ok(!caught.message.includes(FAKE_SECRET));
  assert.ok(!serialized.includes(FAKE_KEY_ID));
  assert.ok(!serialized.includes(FAKE_SECRET));
  assert.match(caught.message, /\[redacted\]/);
});

// --- no live network anywhere ---------------------------------------------------------

test('npm test performs no live network calls (global fetch untouched)', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('live network attempted');
  };
  try {
    const source = createAlpacaTradesPriceSource(configuredConfig(), {
      httpFetch: fakeFetch(okResponse({ trades: RAW_TRADES })),
    });
    await source.getTradesAround('AAPL', FROM, TO);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
