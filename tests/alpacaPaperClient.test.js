// tests/alpacaPaperClient.test.js — Network-free tests for the PAPER order
// client. Importing the module runs NOTHING; every HTTP call goes through an
// injected fake fetch, so npm test never touches the network and no real
// credentials are used. The load-bearing assertions: the endpoint is the
// Alpaca PAPER endpoint (never live), and keys are redacted from all errors and
// never placed in the request body.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlpacaPaperClient,
  sanitizeOrder,
  PAPER_BASE_URL,
  LIVE_BASE_URL_FORBIDDEN,
} from '../src/paper/alpacaPaperClient.js';

const KEY = 'PAPER-KEY-MUST-NOT-LEAK';
const SECRET = 'PAPER-SECRET-MUST-NOT-LEAK';

function paperConfig(extra = {}) {
  return { alpacaPaper: { keyId: KEY, secretKey: SECRET }, ...extra };
}

/** A fake fetch that records calls and returns a canned Response-like object. */
function fakeFetch(responder) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchFn, calls };
}

function okOrder(overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      id: 'ord_123',
      client_order_id: 'cli_abc',
      symbol: 'AAPL',
      qty: '1',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      status: 'accepted',
      submitted_at: '2026-06-18T14:30:00.000Z',
      filled_qty: '0',
      filled_avg_price: null,
      ...overrides,
    }),
  };
}

// --- configuration & endpoint safety --------------------------------------

test('createAlpacaPaperClient throws clearly when paper credentials are missing', () => {
  assert.throws(() => createAlpacaPaperClient({ alpacaPaper: { keyId: null, secretKey: null } }), /not configured/);
  assert.throws(() => createAlpacaPaperClient({}), /not configured/);
});

test('the client uses the Alpaca PAPER endpoint, never the live endpoint', async () => {
  assert.ok(PAPER_BASE_URL.startsWith('https://paper-api.alpaca.markets'));
  // The live host must NOT be the base URL (paper host contains "api.alpaca..."
  // as a substring, so compare on the live host PREFIX, not includes()).
  assert.ok(!PAPER_BASE_URL.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.equal(LIVE_BASE_URL_FORBIDDEN, 'https://api.alpaca.markets');

  const { fetchFn, calls } = fakeFetch(() => okOrder());
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  assert.equal(client.baseUrl, PAPER_BASE_URL);
  await client.submitMarketOrder({ symbol: 'AAPL', qty: 1, side: 'buy' });
  assert.ok(calls[0].url.startsWith('https://paper-api.alpaca.markets/v2/orders'));
  assert.ok(!calls[0].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
});

test('live trading cannot be enabled by this client even with liveTradingEnabled config', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder());
  // Even if config claims live trading is enabled, the client ignores it and
  // there is no option to point at the live endpoint.
  const client = createAlpacaPaperClient(paperConfig({ liveTradingEnabled: true }), { httpFetch: fetchFn });
  await client.submitMarketOrder({ symbol: 'AAPL', qty: 1 });
  assert.ok(calls[0].url.startsWith(PAPER_BASE_URL));
  // There is no baseUrl option: passing one must not redirect the request.
  const client2 = createAlpacaPaperClient(paperConfig(), {
    httpFetch: fetchFn,
    baseUrl: LIVE_BASE_URL_FORBIDDEN, // ignored by construction
  });
  await client2.submitMarketOrder({ symbol: 'AAPL', qty: 1 });
  assert.ok(calls[1].url.startsWith(PAPER_BASE_URL));
});

// --- request shape & secret hygiene ---------------------------------------

test('submitMarketOrder posts a market order; keys go in headers only, never the body', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder());
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await client.submitMarketOrder({ symbol: 'aapl', qty: 2, side: 'buy' });

  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    symbol: 'AAPL', // uppercased
    qty: 2,
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
  });
  // Keys are in headers...
  assert.equal(init.headers['APCA-API-KEY-ID'], KEY);
  assert.equal(init.headers['APCA-API-SECRET-KEY'], SECRET);
  // ...and NEVER in the serialized body.
  assert.ok(!init.body.includes(KEY));
  assert.ok(!init.body.includes(SECRET));
});

test('submitMarketOrder returns a sanitized order (no raw payload leakage)', async () => {
  const { fetchFn } = fakeFetch(() =>
    okOrder({ status: 'filled', filled_avg_price: '201.5', filled_qty: '1', secret_field: 'RAW-MUST-NOT-APPEAR' })
  );
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const order = await client.submitMarketOrder({ symbol: 'AAPL', qty: 1 });
  assert.deepEqual(order, {
    id: 'ord_123',
    clientOrderId: 'cli_abc',
    symbol: 'AAPL',
    side: 'buy',
    qty: 1,
    type: 'market',
    status: 'filled',
    submittedAt: '2026-06-18T14:30:00.000Z',
    filledQty: 1,
    filledAvgPrice: 201.5,
  });
  // The extra raw field is not carried through.
  assert.ok(!Object.prototype.hasOwnProperty.call(order, 'secret_field'));
});

// --- error sanitization ----------------------------------------------------

test('an HTTP error is redacted and reports status only', async () => {
  const { fetchFn } = fakeFetch(() => ({
    ok: false,
    status: 403,
    statusText: `forbidden for key ${KEY}`, // pretend the key leaked into statusText
    json: async () => ({}),
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await assert.rejects(
    () => client.submitMarketOrder({ symbol: 'AAPL', qty: 1 }),
    (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.ok(!err.message.includes(KEY));
      assert.ok(!err.message.includes(SECRET));
      assert.match(err.message, /\[redacted\]/);
      return true;
    }
  );
});

test('a network failure is sanitized and never rethrows the raw error', async () => {
  const { fetchFn } = fakeFetch(() => {
    throw new Error(`socket blew up while using ${SECRET}`);
  });
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await assert.rejects(
    () => client.submitMarketOrder({ symbol: 'AAPL', qty: 1 }),
    (err) => {
      assert.match(err.message, /request failed/);
      assert.ok(!err.message.includes(SECRET));
      return true;
    }
  );
});

test('malformed JSON / non-object payloads are reported safely', async () => {
  const bad = fakeFetch(() => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('nope'); } }));
  const client1 = createAlpacaPaperClient(paperConfig(), { httpFetch: bad.fetchFn });
  await assert.rejects(() => client1.submitMarketOrder({ symbol: 'AAPL', qty: 1 }), /not valid JSON/);

  const arr = fakeFetch(() => ({ ok: true, status: 200, statusText: 'OK', json: async () => [1, 2] }));
  const client2 = createAlpacaPaperClient(paperConfig(), { httpFetch: arr.fetchFn });
  await assert.rejects(() => client2.submitMarketOrder({ symbol: 'AAPL', qty: 1 }), /unexpected order payload/);
});

// --- input validation ------------------------------------------------------

test('submitMarketOrder validates symbol, qty, and side', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder());
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await assert.rejects(() => client.submitMarketOrder({ symbol: '', qty: 1 }), /non-empty string/);
  await assert.rejects(() => client.submitMarketOrder({ symbol: 'AAPL', qty: 0 }), /positive number/);
  await assert.rejects(() => client.submitMarketOrder({ symbol: 'AAPL', qty: -3 }), /positive number/);
  await assert.rejects(() => client.submitMarketOrder({ symbol: 'AAPL', qty: 1, side: 'short' }), /buy\/sell/);
  assert.equal(calls.length, 0); // nothing was sent for invalid input
});

test('sanitizeOrder tolerates missing fields and never throws', () => {
  assert.deepEqual(sanitizeOrder({}), {
    id: null, clientOrderId: null, symbol: null, side: null, qty: null,
    type: null, status: null, submittedAt: null, filledQty: null, filledAvgPrice: null,
  });
});

test('importing the client module performs no network and requires no credentials', () => {
  assert.equal(typeof createAlpacaPaperClient, 'function');
  assert.equal(typeof PAPER_BASE_URL, 'string');
});
