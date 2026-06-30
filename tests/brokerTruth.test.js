// tests/brokerTruth.test.js - Offline tests for PAPER broker reconciliation
// and aligned SPY benchmark performance snapshots.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  calculateBotStrategyExposure,
  classifyBrokerOrderState,
  fetchAlignedBenchmarkPrice,
  formatBrokerTruthLines,
  reconcileBrokerTruth,
  recordPerformanceSnapshot,
} from '../src/paper/brokerTruth.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function insertEquityTrade(db, overrides = {}) {
  const row = {
    ticker: 'AAPL',
    side: 'buy',
    quantity: 1,
    tradeReason: null,
    status: 'open',
    brokerOrderId: null,
    ...overrides,
  };
  return db
    .prepare(
      `INSERT INTO paper_trades
         (ticker, side, quantity, trade_reason, status, broker_order_id)
       VALUES
         (@ticker, @side, @quantity, @tradeReason, @status, @brokerOrderId)`
    )
    .run(row).lastInsertRowid;
}

function fakePaperClient({ orders = {}, positions = [], account = null, positionsError = null, accountError = null } = {}) {
  const calls = { getOrder: [], getPositions: 0, getAccount: 0 };
  return {
    calls,
    getPositions: async () => {
      calls.getPositions += 1;
      if (positionsError) throw new Error(positionsError);
      return positions;
    },
    getOrder: async (id) => {
      calls.getOrder.push(id);
      if (!orders[id]) throw new Error(`missing order ${id}`);
      return { id, ...orders[id] };
    },
    getAccount: async () => {
      calls.getAccount += 1;
      if (accountError) throw new Error(accountError);
      return account ?? { status: 'ACTIVE', equity: 10000, portfolioValue: 10000, cash: 5000, buyingPower: 20000 };
    },
  };
}

function fakePriceSource(tradesByTicker = {}, { latestByTicker = null, name = 'fixture' } = {}) {
  const source = {
    name,
    getTradesAround: async (ticker, fromIso, toIso) =>
      (tradesByTicker[String(ticker).toUpperCase()] ?? [])
        .filter((t) => t.at >= fromIso && t.at <= toIso)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  };
  if (latestByTicker) {
    source.getLatestTrade = async (ticker) => {
      const trade = latestByTicker[String(ticker).toUpperCase()];
      if (!trade) throw new Error(`latest missing ${ticker}`);
      return trade;
    };
  }
  return source;
}

test('classifyBrokerOrderState recognizes paper order transitions', () => {
  assert.equal(classifyBrokerOrderState({ status: 'accepted' }), 'pending');
  assert.equal(classifyBrokerOrderState({ status: 'partially_filled', filledQty: 0.5 }), 'partially_filled');
  assert.equal(classifyBrokerOrderState({ status: 'filled' }), 'filled');
  assert.equal(classifyBrokerOrderState({ status: 'canceled' }), 'canceled');
  assert.equal(classifyBrokerOrderState({ status: 'rejected' }), 'rejected');
  assert.equal(classifyBrokerOrderState({ status: 'expired' }), 'expired');
  assert.equal(classifyBrokerOrderState({ status: 'replaced' }), 'replaced');
});

test('reconcileBrokerTruth updates only ExaltedFable-owned equity rows and ignores manual positions', async () => {
  const db = freshDb();
  const id = insertEquityTrade(db, {
    quantity: 2,
    tradeReason: 'long AAPL; paper order ord_a status accepted',
  });
  const client = fakePaperClient({
    orders: {
      ord_a: {
        symbol: 'AAPL',
        status: 'filled',
        type: 'market',
        submittedAt: '2026-06-18T14:00:00.000Z',
        filledQty: 2,
        filledAvgPrice: 100,
        filledAt: '2026-06-18T14:00:02.000Z',
      },
    },
    positions: [
      { symbol: 'AAPL', qty: 2, marketValue: 210, unrealizedPl: 10, assetClass: 'us_equity' },
      { symbol: 'MSFT', qty: 99, marketValue: 9900, unrealizedPl: 1, assetClass: 'us_equity' },
    ],
  });

  const summary = await reconcileBrokerTruth(db, { paperClient: client, nowMs: Date.parse('2026-06-18T14:01:00.000Z') });
  assert.equal(summary.orders.submitted, 1);
  assert.equal(summary.orders.filled, 1);
  assert.deepEqual(client.calls.getOrder, ['ord_a']);

  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.broker_order_id, 'ord_a');
  assert.equal(row.broker_order_status, 'filled');
  assert.equal(row.broker_truth_state, 'filled');
  assert.equal(row.fill_price, 100);
  assert.equal(row.entry_at, '2026-06-18T14:00:02.000Z');
  assert.equal(row.broker_position_market_value, 210);

  const exposure = calculateBotStrategyExposure(db);
  assert.equal(exposure.grossExposure, 200);
  assert.equal(exposure.openPositionCount, 1);
  closeDatabase(db);
});

test('reconcileBrokerTruth counts canceled/rejected/expired/replaced broker states without claiming fills', async () => {
  const db = freshDb();
  insertEquityTrade(db, { ticker: 'AAPL', brokerOrderId: 'ord_pending' });
  insertEquityTrade(db, { ticker: 'MSFT', brokerOrderId: 'ord_cancel' });
  insertEquityTrade(db, { ticker: 'NVDA', brokerOrderId: 'ord_reject' });
  insertEquityTrade(db, { ticker: 'TSLA', brokerOrderId: 'ord_expire' });
  insertEquityTrade(db, { ticker: 'GOOG', brokerOrderId: 'ord_replace' });
  const client = fakePaperClient({
    orders: {
      ord_pending: { symbol: 'AAPL', status: 'accepted', filledQty: 0, filledAvgPrice: null },
      ord_cancel: { symbol: 'MSFT', status: 'canceled', filledQty: 0, filledAvgPrice: null },
      ord_reject: { symbol: 'NVDA', status: 'rejected', filledQty: 0, filledAvgPrice: null },
      ord_expire: { symbol: 'TSLA', status: 'expired', filledQty: 0, filledAvgPrice: null },
      ord_replace: { symbol: 'GOOG', status: 'replaced', filledQty: 0, filledAvgPrice: null },
    },
    positions: [],
  });

  const summary = await reconcileBrokerTruth(db, { paperClient: client });
  assert.equal(summary.orders.submitted, 5);
  assert.equal(summary.orders.filled, 0);
  assert.equal(summary.orders.open, 1);
  assert.equal(summary.orders.canceled, 1);
  assert.equal(summary.orders.rejected, 1);
  assert.equal(summary.orders.expired, 1);
  assert.equal(summary.orders.replaced, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE fill_price IS NOT NULL").get().n, 0);
  closeDatabase(db);
});

test('recordPerformanceSnapshot aligns broker account return and SPY return on snapshot timestamps', async () => {
  const db = freshDb();
  insertEquityTrade(db, { quantity: 1, brokerOrderId: 'ord_a' });
  let equity = 10000;
  const client = fakePaperClient({
    orders: {
      ord_a: {
        symbol: 'AAPL',
        status: 'filled',
        submittedAt: '2026-06-18T13:59:00.000Z',
        filledQty: 1,
        filledAvgPrice: 100,
        filledAt: '2026-06-18T13:59:02.000Z',
      },
    },
    positions: [{ symbol: 'AAPL', qty: 1, marketValue: 101, unrealizedPl: 1 }],
    get account() {
      return { status: 'ACTIVE', equity, portfolioValue: equity, cash: 5000, buyingPower: 20000 };
    },
  });
  client.getAccount = async () => {
    client.calls.getAccount += 1;
    return { status: 'ACTIVE', equity, portfolioValue: equity, cash: 5000, buyingPower: 20000 };
  };
  const priceSource = fakePriceSource({
    SPY: [
      { price: 500, at: '2026-06-18T14:00:00.000Z' },
      { price: 505, at: '2026-06-18T15:00:00.000Z' },
    ],
  });

  const first = await recordPerformanceSnapshot(db, {
    paperClient: client,
    priceSource,
    runtimeSessionId: null,
    nowMs: Date.parse('2026-06-18T14:00:00.000Z'),
    snapshotKind: 'loop',
  });
  assert.equal(first.brokerAccountReturn, 0);
  assert.equal(first.botReturn, null);
  equity = 10100;
  const second = await recordPerformanceSnapshot(db, {
    paperClient: client,
    priceSource,
    runtimeSessionId: null,
    nowMs: Date.parse('2026-06-18T15:00:00.000Z'),
    snapshotKind: 'loop',
  });

  assert.equal(second.baseline.snapshot_at, '2026-06-18T14:00:00.000Z');
  assert.equal(second.brokerAccountReturn, 0.01);
  assert.equal(second.botReturn, null);
  assert.equal(second.spyReturn, 0.01);
  assert.equal(second.brokerAccountExcessReturn, 0);
  assert.equal(second.spyBaseline.source, 'fixture.historical_trades');
  assert.equal(second.spyCurrent.alignmentStatus, 'exact_target');
  assert.equal(second.exposure.grossExposure, 100);
  const latest = db.prepare('SELECT * FROM paper_strategy_performance_snapshots ORDER BY id DESC LIMIT 1').get();
  assert.equal(latest.broker_account_return_pct, 0.01);
  assert.equal(latest.spy_return_pct, 0.01);
  assert.equal(latest.spy_current_source, 'fixture.historical_trades');
  assert.equal(latest.spy_current_alignment_status, 'exact_target');
  closeDatabase(db);
});

test('recordPerformanceSnapshot reports benchmark unavailable and does not invent excess return', async () => {
  const db = freshDb();
  const client = fakePaperClient({ positions: [], account: { status: 'ACTIVE', equity: 10000, portfolioValue: 10000 } });
  const result = await recordPerformanceSnapshot(db, {
    paperClient: client,
    priceSource: fakePriceSource({ SPY: [] }),
    nowMs: Date.parse('2026-06-18T14:00:00.000Z'),
  });

  assert.equal(result.spyReturn, null);
  assert.equal(result.brokerAccountExcessReturn, null);
  assert.equal(result.dataQuality, 'limited');
  assert.ok(result.warnings.some((w) => w.includes('SPY benchmark unavailable')));
  const row = db.prepare('SELECT * FROM paper_strategy_performance_snapshots ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.spy_return_pct, null);
  assert.equal(row.broker_account_excess_return_pct, null);
  closeDatabase(db);
});

test('legacy equity order markers reconcile filled, open short, and unavailable broker truth safely', async () => {
  const db = freshDb();
  const filledLong = insertEquityTrade(db, {
    ticker: 'AAPL',
    side: 'buy',
    quantity: 2,
    tradeReason: 'legacy long; paper order ord_long status accepted',
  });
  const openShort = insertEquityTrade(db, {
    ticker: 'MSFT',
    side: 'sell',
    quantity: 3,
    tradeReason: 'legacy short; paper order ord_short status accepted',
  });
  const missing = insertEquityTrade(db, {
    ticker: 'NVDA',
    side: 'buy',
    quantity: 1,
    tradeReason: 'legacy missing; paper order ord_missing status accepted',
  });
  const client = fakePaperClient({
    orders: {
      ord_long: {
        symbol: 'AAPL',
        status: 'filled',
        submittedAt: '2026-06-18T14:00:00.000Z',
        filledQty: 2,
        filledAvgPrice: 100,
        filledAt: '2026-06-18T14:00:02.000Z',
      },
      ord_short: {
        symbol: 'MSFT',
        status: 'filled',
        submittedAt: '2026-06-18T14:01:00.000Z',
        filledQty: 3,
        filledAvgPrice: 50,
        filledAt: '2026-06-18T14:01:02.000Z',
      },
    },
    positions: [
      { symbol: 'AAPL', qty: 2, marketValue: 205, unrealizedPl: 5, assetClass: 'us_equity' },
      { symbol: 'MSFT', qty: -3, side: 'short', marketValue: -147, unrealizedPl: 3, assetClass: 'us_equity' },
    ],
  });

  const summary = await reconcileBrokerTruth(db, {
    paperClient: client,
    nowMs: Date.parse('2026-06-18T14:05:00.000Z'),
  });

  assert.equal(summary.orders.submitted, 3);
  assert.equal(summary.orders.filled, 2);
  assert.equal(summary.orders.errors, 1);
  assert.ok(summary.warnings.some((w) => w.includes('ord_missing unavailable')));

  const filledLongRow = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(filledLong);
  assert.equal(filledLongRow.broker_order_id, 'ord_long');
  assert.equal(filledLongRow.broker_truth_state, 'filled');
  assert.equal(filledLongRow.broker_filled_qty, 2);
  assert.equal(filledLongRow.fill_price, 100);

  const openShortRow = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(openShort);
  assert.equal(openShortRow.broker_order_id, 'ord_short');
  assert.equal(openShortRow.broker_truth_state, 'filled');
  assert.equal(openShortRow.status, 'open');
  assert.equal(openShortRow.broker_position_qty, -3);

  const missingRow = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(missing);
  assert.equal(missingRow.broker_order_id, 'ord_missing');
  assert.equal(missingRow.broker_order_status, null);
  assert.equal(missingRow.broker_truth_state, null);
  assert.equal(missingRow.fill_price, null);
  assert.equal(missingRow.pnl_usd, null);

  const exposure = calculateBotStrategyExposure(db);
  assert.equal(exposure.grossExposure, 350);
  assert.equal(exposure.openPositionCount, 2);
  closeDatabase(db);
});

test('positions unavailable leaves current exposure unavailable instead of stale/filled-based', async () => {
  const db = freshDb();
  insertEquityTrade(db, { quantity: 1, brokerOrderId: 'ord_a' });
  const client = fakePaperClient({
    orders: {
      ord_a: { symbol: 'AAPL', status: 'filled', filledQty: 1, filledAvgPrice: 100, filledAt: '2026-06-18T14:00:01.000Z' },
    },
    positionsError: 'positions offline',
    account: { status: 'ACTIVE', equity: 10000, portfolioValue: 10000 },
  });

  const result = await recordPerformanceSnapshot(db, {
    paperClient: client,
    priceSource: fakePriceSource({
      SPY: [{ price: 500, at: '2026-06-18T14:00:00.000Z' }],
    }),
    nowMs: Date.parse('2026-06-18T14:00:00.000Z'),
  });

  assert.equal(result.exposure.grossExposure, null);
  assert.equal(result.exposure.openPositionCount, 0);
  assert.ok(result.warnings.some((w) => w.includes('positions unavailable')));
  const row = db.prepare('SELECT bot_gross_exposure FROM paper_strategy_performance_snapshots ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.bot_gross_exposure, null);
  closeDatabase(db);
});

test('fetchAlignedBenchmarkPrice uses the latest trade at or before the target timestamp', async () => {
  const source = fakePriceSource({
    SPY: [
      { price: 499, at: '2026-06-18T13:59:59.000Z' },
      { price: 500, at: '2026-06-18T14:00:00.000Z' },
      { price: 501, at: '2026-06-18T14:00:01.000Z' },
    ],
  });
  const price = await fetchAlignedBenchmarkPrice(source, {
    ticker: 'SPY',
    targetAt: '2026-06-18T14:00:00.000Z',
  });
  assert.equal(price.available, true);
  assert.equal(price.price, 500);
  assert.equal(price.at, '2026-06-18T14:00:00.000Z');
  assert.equal(price.source, 'fixture.historical_trades');
  assert.equal(price.alignmentStatus, 'exact_target');
});

test('fetchAlignedBenchmarkPrice falls back to read-only latest trade when historical window is unavailable', async () => {
  const source = {
    name: 'alpaca_iex',
    getTradesAround: async () => {
      throw new Error('HTTP 403 too recent');
    },
    getLatestTrade: async () => ({ price: 505, at: '2026-06-18T14:59:58.000Z' }),
  };
  const price = await fetchAlignedBenchmarkPrice(source, {
    ticker: 'SPY',
    targetAt: '2026-06-18T15:00:00.000Z',
  });

  assert.equal(price.available, true);
  assert.equal(price.price, 505);
  assert.equal(price.source, 'alpaca_iex.latest_trade');
  assert.equal(price.alignmentStatus, 'latest_at_or_before_target');
  assert.equal(price.targetAt, '2026-06-18T15:00:00.000Z');
});

test('fetchAlignedBenchmarkPrice refuses latest trades after the aligned target timestamp', async () => {
  const source = fakePriceSource({ SPY: [] }, {
    latestByTicker: {
      SPY: { price: 506, at: '2026-06-18T15:00:01.000Z' },
    },
    name: 'alpaca_iex',
  });
  const price = await fetchAlignedBenchmarkPrice(source, {
    ticker: 'SPY',
    targetAt: '2026-06-18T15:00:00.000Z',
  });

  assert.equal(price.available, false);
  assert.equal(price.price, null);
  assert.equal(price.alignmentStatus, 'unavailable');
  assert.match(price.unavailableReason, /after target timestamp/);
});

test('fetchAlignedBenchmarkPrice rejects stale latest fallback outside the documented lookback window', async () => {
  const source = {
    name: 'alpaca_iex',
    getTradesAround: async () => {
      throw new Error('HTTP 403 too recent');
    },
    getLatestTrade: async () => ({ price: 499, at: '2026-06-18T13:59:59.000Z' }),
  };
  const price = await fetchAlignedBenchmarkPrice(source, {
    ticker: 'SPY',
    targetAt: '2026-06-18T15:00:00.000Z',
  });

  assert.equal(price.available, false);
  assert.equal(price.price, null);
  assert.equal(price.requestedFrom, '2026-06-18T14:00:00.000Z');
  assert.equal(price.requestedTo, '2026-06-18T15:00:00.000Z');
  assert.equal(price.source, 'alpaca_iex.latest_trade');
  assert.match(price.unavailableReason, /stale before aligned lookback window/);
});

test('fetchAlignedBenchmarkPrice returns unavailable when no historical or latest benchmark trade exists', async () => {
  const price = await fetchAlignedBenchmarkPrice(fakePriceSource({ SPY: [] }), {
    ticker: 'SPY',
    targetAt: '2026-06-18T15:00:00.000Z',
  });

  assert.equal(price.available, false);
  assert.equal(price.price, null);
  assert.equal(price.at, null);
  assert.equal(price.source, 'fixture');
  assert.equal(price.alignmentStatus, 'unavailable');
  assert.match(price.unavailableReason, /unavailable in aligned historical window/);
});

test('formatBrokerTruthLines prints benchmark unavailable reason explicitly', () => {
  const lines = formatBrokerTruthLines({
    broker: { orders: { submitted: 0, filled: 0, open: 0, canceled: 0, rejected: 0, expired: 0, replaced: 0 } },
    exposure: { grossExposure: 0, openPositionCount: 0, realizedPnlUsd: null },
    brokerAccountReturn: 0,
    spyReturn: null,
    brokerAccountExcessReturn: null,
    spyBaseline: {
      targetAt: '2026-06-18T14:00:00.000Z',
      at: null,
      source: 'alpaca_iex.latest_trade',
      alignmentStatus: 'unavailable',
    },
    spyCurrent: {
      targetAt: '2026-06-18T15:00:00.000Z',
      at: null,
      source: 'alpaca_iex.latest_trade',
      alignmentStatus: 'unavailable',
    },
    spyUnavailableReason: 'SPY benchmark latest trade is stale before aligned lookback window',
    botReturnUnavailableReason: 'unavailable',
    dataQuality: 'limited',
    warnings: [],
  });

  const text = lines.join('\n');
  assert.match(text, /benchmark:\s+baseline: target=2026-06-18T14:00:00\.000Z priceAt=unavailable/);
  assert.match(text, /benchmark unavailable: SPY benchmark latest trade is stale before aligned lookback window/);
});
