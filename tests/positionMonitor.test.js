// tests/positionMonitor.test.js — Exit monitor over open PAPER positions.
// Fully offline: in-memory DB, fake paper client, injected timestamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  listOpenExitablePaperTrades,
  monitorOpenEquityPositions,
  positionPrice,
  realizedExitPnl,
} from '../src/paper/positionMonitor.js';

const NOW_MS = Date.parse('2026-06-18T15:00:00.000Z');
const PARAMS = { takeProfitPct: 0.04, stopLossPct: 0.035, maxHoldMinutes: 390 };

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedOpenTrade(db, {
  ticker = 'AAPL', side = 'buy', qty = 10, fillPrice = 100,
  entryAt = '2026-06-18T14:30:00.000Z', exitOrderId = null, exitReason = null,
} = {}) {
  const run = db.prepare(
    `INSERT INTO paper_trades
       (ticker, side, quantity, status, created_at, entry_at,
        broker_order_id, broker_filled_qty, broker_filled_avg_price,
        exit_order_id, exit_reason)
     VALUES (?, ?, ?, 'open', ?, ?, 'entry_ord', ?, ?, ?, ?)`
  ).run(ticker, side, qty, entryAt, entryAt, qty, fillPrice, exitOrderId, exitReason);
  return Number(run.lastInsertRowid);
}

function fakeClient({ positions = [], orderResult = null, getOrderResult = null } = {}) {
  const calls = { orders: [], polls: [] };
  return {
    calls,
    getPositions: async () => positions,
    submitMarketOrder: async (o) => {
      calls.orders.push(o);
      return orderResult ?? { id: 'exit_ord', status: 'filled', filledQty: o.qty, filledAvgPrice: 96, filledAt: '2026-06-18T15:00:01.000Z' };
    },
    getOrder: async (id) => { calls.polls.push(id); return getOrderResult; },
  };
}

// --- helpers ------------------------------------------------------------------

test('realizedExitPnl is signed for longs and shorts', () => {
  assert.equal(realizedExitPnl({ side: 'buy', entryPrice: 100, exitPrice: 104, quantity: 10 }), 40);
  assert.equal(realizedExitPnl({ side: 'buy', entryPrice: 100, exitPrice: 96, quantity: 10 }), -40);
  assert.equal(realizedExitPnl({ side: 'sell', entryPrice: 100, exitPrice: 96, quantity: 10 }), 40);
  assert.equal(realizedExitPnl({ side: 'sell', entryPrice: 100, exitPrice: 104, quantity: 10 }), -40);
});

test('positionPrice derives per-share price from broker snapshots (short-safe)', () => {
  assert.equal(positionPrice({ qty: 10, marketValue: 1040 }), 104);
  assert.equal(positionPrice({ qty: -10, marketValue: -960 }), 96); // short position
  assert.equal(positionPrice({ qty: 0, marketValue: 0 }), null);
  assert.equal(positionPrice(null), null);
});

test('only broker-confirmed open rows are exitable', () => {
  const db = freshDb();
  seedOpenTrade(db); // confirmed -> exitable
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, broker_order_id)
     VALUES ('MSFT', 'buy', 1, 'open', 'ord_no_fill')` // no confirmed fill
  ).run();
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status)
     VALUES ('NVDA', 'buy', 1, 'closed')`
  ).run();
  assert.equal(listOpenExitablePaperTrades(db).length, 1);
  closeDatabase(db);
});

// --- monitor passes -----------------------------------------------------------

test('stop-loss breach EXITS the position and closes the row with broker-confirmed P&L', async () => {
  const db = freshDb();
  const id = seedOpenTrade(db, { fillPrice: 100 });
  const client = fakeClient({ positions: [{ symbol: 'AAPL', qty: 10, marketValue: 960 }] }); // -4%
  const result = await monitorOpenEquityPositions(db, {
    paperClient: client, nowMs: NOW_MS, executePaper: true, exitParams: PARAMS,
  });
  assert.equal(result.exitsPlanned, 1);
  assert.equal(result.exitsSubmitted, 1);
  assert.equal(result.exitsFilled, 1);
  assert.deepEqual(client.calls.orders[0], { symbol: 'AAPL', qty: 10, side: 'sell' });
  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_reason, 'stop_loss');
  assert.equal(row.exit_price, 96);
  assert.equal(row.pnl_usd, -40);
  assert.equal(row.broker_realized_pnl_usd, -40);
  closeDatabase(db);
});

test('a short is covered with a BUY order when it hits take-profit', async () => {
  const db = freshDb();
  seedOpenTrade(db, { side: 'sell', fillPrice: 100 });
  const client = fakeClient({
    positions: [{ symbol: 'AAPL', qty: -10, marketValue: -950 }], // price 95 -> +5% for the short
    orderResult: { id: 'exit_ord', status: 'filled', filledQty: 10, filledAvgPrice: 95, filledAt: '2026-06-18T15:00:01.000Z' },
  });
  const result = await monitorOpenEquityPositions(db, {
    paperClient: client, nowMs: NOW_MS, executePaper: true, exitParams: PARAMS,
  });
  assert.equal(result.exitsFilled, 1);
  assert.equal(client.calls.orders[0].side, 'buy'); // buy-to-cover
  const row = db.prepare('SELECT * FROM paper_trades').get();
  assert.equal(row.exit_reason, 'take_profit');
  assert.equal(row.pnl_usd, 50);
  closeDatabase(db);
});

test('dry run PLANS exits but never submits orders or mutates rows', async () => {
  const db = freshDb();
  const id = seedOpenTrade(db, { fillPrice: 100 });
  const client = fakeClient({ positions: [{ symbol: 'AAPL', qty: 10, marketValue: 900 }] }); // -10%
  const result = await monitorOpenEquityPositions(db, {
    paperClient: client, nowMs: NOW_MS, executePaper: false, exitParams: PARAMS,
  });
  assert.equal(result.exitsPlanned, 1);
  assert.equal(result.exitsSubmitted, 0);
  assert.equal(client.calls.orders.length, 0);
  assert.equal(db.prepare('SELECT status FROM paper_trades WHERE id = ?').get(id).status, 'open');
  assert.ok(result.lines.some((l) => l.includes('WOULD EXIT')));
  closeDatabase(db);
});

test('an unfilled exit order is recorded, then confirmed by a later poll', async () => {
  const db = freshDb();
  const id = seedOpenTrade(db, { fillPrice: 100 });
  // Pass 1: submit returns accepted with no fill yet.
  const client1 = fakeClient({
    positions: [{ symbol: 'AAPL', qty: 10, marketValue: 950 }],
    orderResult: { id: 'exit_pending', status: 'accepted', filledQty: null, filledAvgPrice: null },
  });
  await monitorOpenEquityPositions(db, { paperClient: client1, nowMs: NOW_MS, executePaper: true, exitParams: PARAMS });
  let row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.status, 'open');
  assert.equal(row.exit_order_id, 'exit_pending');
  assert.equal(row.exit_reason, 'stop_loss');

  // Pass 2: the poll finds the fill and closes the row (no duplicate order).
  const client2 = fakeClient({
    positions: [{ symbol: 'AAPL', qty: 10, marketValue: 950 }],
    getOrderResult: { id: 'exit_pending', status: 'filled', filledQty: 10, filledAvgPrice: 95.5, filledAt: '2026-06-18T15:05:00.000Z' },
  });
  const second = await monitorOpenEquityPositions(db, { paperClient: client2, nowMs: NOW_MS + 300_000, executePaper: true, exitParams: PARAMS });
  assert.equal(second.pendingPolled, 1);
  assert.equal(second.exitsFilled, 1);
  assert.equal(client2.calls.orders.length, 0);
  row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_price, 95.5);
  assert.equal(row.pnl_usd, -45);
  closeDatabase(db);
});

test('a canceled exit order is cleared so the next pass can retry', async () => {
  const db = freshDb();
  const id = seedOpenTrade(db, { fillPrice: 100, exitOrderId: 'exit_dead', exitReason: 'stop_loss' });
  const client = fakeClient({
    positions: [{ symbol: 'AAPL', qty: 10, marketValue: 950 }],
    getOrderResult: { id: 'exit_dead', status: 'canceled', filledQty: null, filledAvgPrice: null },
  });
  const result = await monitorOpenEquityPositions(db, { paperClient: client, nowMs: NOW_MS, executePaper: true, exitParams: PARAMS });
  assert.equal(result.pendingPolled, 1);
  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.status, 'open');
  assert.equal(row.exit_order_id, null); // retry next pass
  closeDatabase(db);
});

test('healthy positions are left alone', async () => {
  const db = freshDb();
  seedOpenTrade(db, { fillPrice: 100 });
  const client = fakeClient({ positions: [{ symbol: 'AAPL', qty: 10, marketValue: 1010 }] }); // +1%
  const result = await monitorOpenEquityPositions(db, {
    paperClient: client, nowMs: NOW_MS, executePaper: true, exitParams: PARAMS,
  });
  assert.equal(result.checked, 1);
  assert.equal(result.exitsPlanned, 0);
  assert.equal(client.calls.orders.length, 0);
  closeDatabase(db);
});
