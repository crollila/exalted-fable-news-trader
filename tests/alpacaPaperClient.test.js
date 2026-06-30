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
  DATA_BASE_URL,
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
    assetClass: null,
    status: 'filled',
    submittedAt: '2026-06-18T14:30:00.000Z',
    filledQty: 1,
    filledAvgPrice: 201.5,
    filledAt: null,
    canceledAt: null,
    expiredAt: null,
    updatedAt: null,
    replacedAt: null,
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
    type: null, assetClass: null, status: null, submittedAt: null, filledQty: null, filledAvgPrice: null,
    filledAt: null, canceledAt: null, expiredAt: null, updatedAt: null, replacedAt: null,
  });
});

// --- account / positions snapshots -----------------------------------------

test('getAccount parses a sanitized snapshot and uses the paper endpoint', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({
      id: 'acct_1', status: 'ACTIVE', equity: '30000', cash: '10000', buying_power: '60000',
      multiplier: '2', portfolio_value: '30000', pattern_day_trader: false,
      trading_blocked: false, account_blocked: false, options_trading_level: 2,
      secret: 'RAW-MUST-NOT-APPEAR',
    }),
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const acct = await client.getAccount();
  assert.ok(calls[0].url.startsWith('https://paper-api.alpaca.markets/v2/account'));
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(acct.equity, 30000);
  assert.equal(acct.buyingPower, 60000);
  assert.equal(acct.multiplier, 2);
  assert.equal(acct.optionsTradingLevel, 2);
  assert.equal(acct.tradingBlocked, false);
  assert.ok(!Object.prototype.hasOwnProperty.call(acct, 'secret'));
});

test('getPositions parses a sanitized array', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({
    ok: true, status: 200,
    json: async () => [
      { symbol: 'AAPL', qty: '10', side: 'long', market_value: '2000', cost_basis: '1900', unrealized_pl: '100', unrealized_plpc: '0.05', asset_class: 'us_equity' },
    ],
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const pos = await client.getPositions();
  assert.ok(calls[0].url.startsWith('https://paper-api.alpaca.markets/v2/positions'));
  assert.equal(pos.length, 1);
  assert.equal(pos[0].symbol, 'AAPL');
  assert.equal(pos[0].marketValue, 2000);
  assert.equal(pos[0].unrealizedPl, 100);
});

test('getClock and getCalendar use the paper endpoint and sanitize market-session data', async () => {
  const { fetchFn, calls } = fakeFetch((url) => {
    if (url.includes('/v2/clock')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          timestamp: '2026-06-18T14:00:00.000Z',
          is_open: true,
          next_open: '2026-06-19T13:30:00.000Z',
          next_close: '2026-06-18T20:00:00.000Z',
          raw_secret: 'RAW-MUST-NOT-APPEAR',
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ([{ date: '2026-06-18', open: '09:30', close: '16:00', extra: 'hidden' }]),
    };
  });
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const clock = await client.getClock();
  const calendar = await client.getCalendar({ start: '2026-06-18', end: '2026-06-18' });
  assert.ok(calls[0].url.startsWith(`${PAPER_BASE_URL}/v2/clock`));
  assert.ok(calls[1].url.startsWith(`${PAPER_BASE_URL}/v2/calendar`));
  assert.ok(!calls[0].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.equal(clock.isOpen, true);
  assert.equal(clock.nextClose, '2026-06-18T20:00:00.000Z');
  assert.ok(!Object.prototype.hasOwnProperty.call(clock, 'raw_secret'));
  assert.deepEqual(calendar[0], {
    date: '2026-06-18',
    open: '09:30',
    close: '16:00',
    sessionOpen: null,
    sessionClose: null,
  });
});

test('getAsset exposes tradability and shortability without raw payload leakage', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({
      id: 'asset-1', symbol: 'aapl', name: 'Apple Inc.', class: 'us_equity',
      exchange: 'NASDAQ', status: 'active', tradable: true, marginable: true,
      shortable: true, easy_to_borrow: true, fractionable: true, raw: 'hide',
    }),
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const asset = await client.getAsset('aapl');
  assert.ok(calls[0].url.startsWith(`${PAPER_BASE_URL}/v2/assets/AAPL`));
  assert.equal(asset.symbol, 'AAPL');
  assert.equal(asset.tradable, true);
  assert.equal(asset.shortable, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(asset, 'raw'));
});

test('getOptionContracts discovers sanitized tradable contracts from the paper endpoint', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({
      option_contracts: [
        {
          id: 'c1', symbol: 'AAPL260116C00150000', underlying_symbol: 'AAPL',
          status: 'active', tradable: true, expiration_date: '2026-01-16',
          strike_price: '150', type: 'call', style: 'american',
          open_interest: '1234', secret: 'RAW-MUST-NOT-APPEAR',
        },
      ],
      next_page_token: 'NEXT',
    }),
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const result = await client.getOptionContracts({
    underlyingSymbols: ['aapl'],
    expirationDateGte: '2026-01-01',
    expirationDateLte: '2026-02-01',
    type: 'call',
    limit: 50,
  });
  assert.ok(calls[0].url.startsWith(`${PAPER_BASE_URL}/v2/options/contracts`));
  assert.ok(!calls[0].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.match(decodeURIComponent(calls[0].url), /underlying_symbols=AAPL/);
  assert.equal(result.nextPageToken, 'NEXT');
  assert.deepEqual(result.contracts[0], {
    id: 'c1',
    symbol: 'AAPL260116C00150000',
    underlyingSymbol: 'AAPL',
    status: 'active',
    tradable: true,
    expirationDate: '2026-01-16',
    strikePrice: 150,
    type: 'call',
    style: 'american',
    openInterest: 1234,
    closePrice: null,
  });
});

test('getOptionQuote uses the read-only data endpoint and sanitizes bid/ask/mid', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({
    ok: true, status: 200,
    json: async () => ({
      snapshots: {
        AAPL260116C00150000: {
          latestQuote: { bp: 2.4, ap: 2.6, t: '2026-06-18T14:00:01.000Z', raw: 'hide' },
        },
      },
    }),
  }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const quote = await client.getOptionQuote({
    underlyingSymbol: 'aapl',
    optionSymbol: 'AAPL260116C00150000',
  });
  assert.ok(calls[0].url.startsWith(`${DATA_BASE_URL}/v1beta1/options/snapshots/AAPL`));
  assert.ok(!calls[0].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.deepEqual(quote, {
    symbol: 'AAPL260116C00150000',
    bid: 2.4,
    ask: 2.6,
    mid: 2.5,
    updatedAt: '2026-06-18T14:00:01.000Z',
  });
});

// --- equity short + option orders ------------------------------------------

test('submitMarketOrder sends a short (sell) equity order', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder({ side: 'sell' }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await client.submitMarketOrder({ symbol: 'AAPL', qty: 2, side: 'sell' });
  assert.equal(JSON.parse(calls[0].init.body).side, 'sell');
  assert.ok(calls[0].url.startsWith(PAPER_BASE_URL));
});

test('submitOptionLimitOrder sends a bounded BUY limit/day option order on the paper endpoint', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder({ symbol: 'AAPL260116C00150000', asset_class: 'us_option', type: 'limit' }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const order = await client.submitOptionLimitOrder({ optionSymbol: 'AAPL260116C00150000', qty: 1, side: 'buy', limitPrice: 2.21 });
  assert.ok(calls[0].url.startsWith(`${PAPER_BASE_URL}/v2/orders`));
  assert.ok(!calls[0].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    symbol: 'AAPL260116C00150000', qty: 1, side: 'buy', type: 'limit', time_in_force: 'day', limit_price: 2.21,
  });
  assert.equal(order.id, 'ord_123');
});

test('submitOptionLimitOrder supports sell-to-close and refuses bad OCC/qty/side/limit (never a market order)', async () => {
  const { fetchFn, calls } = fakeFetch(() => okOrder({ side: 'sell', type: 'limit' }));
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  await client.submitOptionLimitOrder({ optionSymbol: 'AAPL260116C00150000', qty: 2, side: 'sell', limitPrice: 1.85 });
  assert.equal(JSON.parse(calls[0].init.body).side, 'sell');
  await assert.rejects(() => client.submitOptionLimitOrder({ optionSymbol: 'NOTANOCC', qty: 1, limitPrice: 1 }), /OCC option symbol/);
  await assert.rejects(() => client.submitOptionLimitOrder({ optionSymbol: 'AAPL260116C00150000', qty: 0, limitPrice: 1 }), /positive integer/);
  await assert.rejects(() => client.submitOptionLimitOrder({ optionSymbol: 'AAPL260116C00150000', qty: 1, side: 'short', limitPrice: 1 }), /buy\/sell/);
  await assert.rejects(() => client.submitOptionLimitOrder({ optionSymbol: 'AAPL260116C00150000', qty: 1, side: 'buy', limitPrice: 0 }), /positive number/);
  assert.equal(calls.length, 1); // only the valid sell-to-close was sent
});

test('getOrder polls (GET) and cancelOrder deletes (DELETE, 204 no-body) on the paper endpoint', async () => {
  const { fetchFn, calls } = fakeFetch((url, init) => {
    if (init.method === 'DELETE') {
      return { ok: true, status: 204, statusText: 'No Content', json: async () => { throw new Error('no body'); } };
    }
    return okOrder({ status: 'filled', filled_avg_price: '2.05' });
  });
  const client = createAlpacaPaperClient(paperConfig(), { httpFetch: fetchFn });
  const order = await client.getOrder('ord_123');
  assert.ok(calls[0].url.startsWith(`${PAPER_BASE_URL}/v2/orders/ord_123`));
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(order.status, 'filled');
  assert.equal(order.filledAvgPrice, 2.05);
  const res = await client.cancelOrder('ord_123');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.ok(calls[1].url.startsWith(`${PAPER_BASE_URL}/v2/orders/ord_123`));
  assert.ok(!calls[1].url.startsWith(LIVE_BASE_URL_FORBIDDEN));
  assert.deepEqual(res, { ok: true, status: 204 });
});

test('importing the client module performs no network and requires no credentials', () => {
  assert.equal(typeof createAlpacaPaperClient, 'function');
  assert.equal(typeof PAPER_BASE_URL, 'string');
});
