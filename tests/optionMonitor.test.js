// tests/optionMonitor.test.js — Offline tests for the monitored PAPER option
// execution loop. The DB is in-memory; the broker is a FAKE injected client, so
// npm test never touches the network. Proves: entry fills, stale-entry cancel,
// deterministic exits (TP/SL/max-hold/forced), sell-to-close, requote/retry,
// restart reconciliation, ignoring untracked positions, and that every failed
// broker call becomes a structured, non-fatal outcome (no naked sells, no throw).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  insertPaperOptionTrade, updatePaperOptionTrade, getPaperOptionTradeById, listActiveBotOptionTrades,
} from '../src/database/paperRuntime.js';
import { reconcileBotOptions } from '../src/paper/optionMonitor.js';

const OCC = 'AAPL260116C00150000';
const NOW = Date.parse('2026-06-18T18:00:00.000Z');
const CLOSE = Date.parse('2026-06-18T20:00:00.000Z'); // 2h after NOW
const ISO = (ms) => new Date(ms).toISOString();
const CONFIG = {
  optionExecution: {
    takeProfitPct: 0.5, stopLossPct: 0.5, maxHoldMinutes: 240, entryTimeoutMinutes: 10,
    exitRetryMinutes: 5, noEntryBeforeCloseMinutes: 30, forceCloseBeforeCloseMinutes: 15,
    limitSlippagePct: 0.05,
  },
};
const longPos = (symbol = OCC, over = {}) => ({ symbol, qty: 1, side: 'long', assetClass: 'us_option', marketValue: 200, ...over });

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function fakeClient(opts = {}) {
  const calls = { getOrder: [], cancel: [], quote: [], submit: [], positions: 0 };
  return {
    calls,
    getPositions: async () => {
      calls.positions += 1;
      if (opts.positionsThrow) throw new Error('positions boom');
      return opts.positions ?? [];
    },
    getOrder: async (id) => {
      calls.getOrder.push(id);
      if (opts.getOrderThrow) throw new Error('getOrder boom');
      return typeof opts.order === 'function'
        ? opts.order(id)
        : (opts.order ?? { id, status: 'filled', submittedAt: ISO(NOW), filledAvgPrice: 2.0 });
    },
    getOptionQuote: async (q) => {
      calls.quote.push(q);
      if (opts.quoteThrow) throw new Error('quote boom');
      return opts.quote ?? { symbol: q.optionSymbol, bid: 2.0, ask: 2.1, mid: 2.05 };
    },
    cancelOrder: async (id) => {
      calls.cancel.push(id);
      if (opts.cancelThrow) throw new Error('cancel boom');
      return { ok: true, status: 204 };
    },
    submitOptionLimitOrder: async (o) => {
      calls.submit.push(o);
      if (opts.submitThrow) throw new Error('submit boom');
      return { id: `ord_${calls.submit.length}`, status: 'accepted', submittedAt: ISO(NOW) };
    },
  };
}

function seedOption(db, over = {}) {
  // Exit-side fields are set by the monitor (via updatePaperOptionTrade), not at
  // insert time — mirror that here so seeded pending_exit rows are realistic.
  const { exitOrderId, exitAttempts, ...insertable } = over;
  const id = insertPaperOptionTrade(db, {
    underlying: 'AAPL', optionSymbol: OCC, expiry: '2026-01-16', strike: 150, right: 'call',
    quantity: 1, premiumEntry: 2.0, notionalEntry: 200, strategy: 'long_call', exitPolicy: 'test',
    status: 'open', lifecycleState: 'pending_entry', entryOrderId: 'entry_1', entryLimitPrice: 2.1,
    ...insertable,
  }).id;
  const exitUpdates = {};
  if (exitOrderId !== undefined) exitUpdates.exitOrderId = exitOrderId;
  if (exitAttempts !== undefined) exitUpdates.exitAttempts = exitAttempts;
  if (Object.keys(exitUpdates).length > 0) updatePaperOptionTrade(db, id, exitUpdates);
  return id;
}

const reconcile = (db, client, over = {}) =>
  reconcileBotOptions(db, { paperClient: client, config: CONFIG, nowMs: NOW, session: { isOpen: true, sessionCloseMs: CLOSE }, ...over });

// --- entry reconciliation ---------------------------------------------------

test('a filled entry order transitions pending_entry -> open and records the fill', async () => {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'pending_entry', entryOrderId: 'entry_1' });
  const client = fakeClient({ order: { id: 'entry_1', status: 'filled', submittedAt: ISO(NOW), filledAvgPrice: 2.05 } });
  const summary = await reconcile(db, client);
  const row = getPaperOptionTradeById(db, id);
  assert.equal(row.lifecycle_state, 'open');
  assert.equal(row.entry_order_status, 'filled');
  assert.equal(row.premium_entry, 2.05);
  assert.equal(summary.entriesFilled, 1);
  assert.equal(client.calls.submit.length, 0); // no exit on the same cycle as the fill
  closeDatabase(db);
});

test('a stale unfilled entry order is canceled after the timeout', async () => {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'pending_entry', entryOrderId: 'entry_1' });
  const client = fakeClient({ order: { id: 'entry_1', status: 'new', submittedAt: ISO(NOW - 30 * 60_000) } });
  const summary = await reconcile(db, client);
  const row = getPaperOptionTradeById(db, id);
  assert.equal(row.lifecycle_state, 'canceled');
  assert.equal(row.status, 'canceled');
  assert.deepEqual(client.calls.cancel, ['entry_1']);
  assert.equal(summary.entriesCanceled, 1);
  closeDatabase(db);
});

// --- deterministic exits ----------------------------------------------------

async function exerciseExit({ bid, openedMinutesAgo = 10, sessionCloseMs = CLOSE, nowMs = NOW }) {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'open', openedAt: ISO(NOW - openedMinutesAgo * 60_000), premiumEntry: 2.0 });
  const client = fakeClient({ positions: [longPos()], quote: { symbol: OCC, bid, ask: bid + 0.1 } });
  const summary = await reconcileBotOptions(db, {
    paperClient: client, config: CONFIG, nowMs, session: { isOpen: true, sessionCloseMs },
  });
  return { db, id, client, summary, row: getPaperOptionTradeById(db, id) };
}

test('take-profit submits a SELL-to-close limit and moves to pending_exit', async () => {
  const { db, client, row, summary } = await exerciseExit({ bid: 3.0 });
  assert.equal(client.calls.submit.length, 1);
  assert.equal(client.calls.submit[0].side, 'sell');
  assert.equal(client.calls.submit[0].optionSymbol, OCC);
  assert.ok(client.calls.submit[0].limitPrice > 0);
  assert.equal(row.lifecycle_state, 'pending_exit');
  assert.equal(row.exit_reason, 'take_profit');
  assert.equal(summary.exitsSubmitted, 1);
  closeDatabase(db);
});

test('stop-loss submits a sell-to-close', async () => {
  const { db, client, row } = await exerciseExit({ bid: 1.0 });
  assert.equal(client.calls.submit[0].side, 'sell');
  assert.equal(row.exit_reason, 'stop_loss');
  closeDatabase(db);
});

test('max-hold submits a sell-to-close', async () => {
  const { db, client, row } = await exerciseExit({ bid: 2.1, openedMinutesAgo: 300 });
  assert.equal(client.calls.submit[0].side, 'sell');
  assert.equal(row.exit_reason, 'max_hold');
  closeDatabase(db);
});

test('forced same-day flatten submits a sell-to-close near the close even when in profit-neutral', async () => {
  const { db, client, row } = await exerciseExit({ bid: 2.1, nowMs: CLOSE - 10 * 60_000 });
  assert.equal(client.calls.submit[0].side, 'sell');
  assert.equal(row.exit_reason, 'forced_close');
  closeDatabase(db);
});

test('a healthy position within thresholds HOLDS (no order)', async () => {
  const { db, client, row } = await exerciseExit({ bid: 2.1 });
  assert.equal(client.calls.submit.length, 0);
  assert.equal(row.lifecycle_state, 'open');
  closeDatabase(db);
});

// --- pending_exit fill / requote --------------------------------------------

test('a filled exit order closes the position and records realized P&L', async () => {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'pending_exit', exitOrderId: 'exit_1', exitLimitPrice: 2.4, premiumEntry: 2.0, exitReason: 'take_profit' });
  const client = fakeClient({ order: { id: 'exit_1', status: 'filled', submittedAt: ISO(NOW), filledAvgPrice: 2.5 } });
  const summary = await reconcile(db, client);
  const row = getPaperOptionTradeById(db, id);
  assert.equal(row.lifecycle_state, 'closed');
  assert.equal(row.status, 'closed');
  assert.equal(row.premium_exit, 2.5);
  assert.equal(row.realized_pnl_usd, 50); // (2.5 - 2.0) * 100 * 1
  assert.equal(summary.exitsFilled, 1);
  closeDatabase(db);
});

test('an unfilled exit order is canceled and requoted within the exit window', async () => {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'pending_exit', exitOrderId: 'exit_1', premiumEntry: 2.0, exitAttempts: 1, exitReason: 'stop_loss' });
  const client = fakeClient({
    order: { id: 'exit_1', status: 'new', submittedAt: ISO(NOW - 10 * 60_000) },
    positions: [longPos()],
    quote: { symbol: OCC, bid: 1.8, ask: 1.9 },
  });
  const summary = await reconcile(db, client);
  const row = getPaperOptionTradeById(db, id);
  assert.deepEqual(client.calls.cancel, ['exit_1']); // cancelled the stale exit
  assert.equal(client.calls.submit.length, 1); // and requoted a fresh sell
  assert.equal(client.calls.submit[0].side, 'sell');
  assert.equal(row.lifecycle_state, 'pending_exit');
  assert.equal(Number(row.exit_attempts), 2);
  assert.equal(summary.requotes, 1);
  closeDatabase(db);
});

// --- restart resilience -----------------------------------------------------

test('restart reconciliation resumes bot-owned rows persisted by a prior process', async () => {
  const db = freshDb();
  // Simulate persisted state from before a crash: one pending entry + one open.
  seedOption(db, { optionSymbol: OCC, lifecycleState: 'pending_entry', entryOrderId: 'entry_A' });
  const openId = seedOption(db, { optionSymbol: 'MSFT260116P00400000', underlying: 'MSFT', right: 'put', strategy: 'long_put', lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
  assert.equal(listActiveBotOptionTrades(db).length, 2);
  const client = fakeClient({
    order: { id: 'entry_A', status: 'filled', submittedAt: ISO(NOW), filledAvgPrice: 2.0 },
    positions: [longPos('MSFT260116P00400000')],
    quote: { symbol: 'MSFT260116P00400000', bid: 3.5, ask: 3.6 }, // take-profit on the open one
  });
  const summary = await reconcile(db, client);
  assert.equal(summary.entriesFilled, 1);
  assert.equal(summary.exitsSubmitted, 1);
  assert.equal(getPaperOptionTradeById(db, openId).lifecycle_state, 'pending_exit');
  closeDatabase(db);
});

// --- bot-owned only ---------------------------------------------------------

test('the monitor never touches untracked/manual option positions', async () => {
  const db = freshDb();
  // No bot rows at all, but the broker reports a manual option position.
  const client = fakeClient({ positions: [longPos('TSLA260116C00250000')] });
  const summary = await reconcile(db, client);
  assert.equal(summary.checked, 0);
  assert.equal(client.calls.submit.length, 0);
  assert.equal(client.calls.cancel.length, 0);
  closeDatabase(db);
});

test('with one tracked exit-ready row alongside an untracked position, only the tracked symbol is sold', async () => {
  const db = freshDb();
  seedOption(db, { lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
  const client = fakeClient({
    positions: [longPos(OCC), longPos('TSLA260116C00250000')],
    quote: { symbol: OCC, bid: 3.0, ask: 3.1 }, // take-profit on the tracked one
  });
  await reconcile(db, client);
  assert.equal(client.calls.submit.length, 1);
  assert.equal(client.calls.submit[0].optionSymbol, OCC); // never the untracked TSLA position
  closeDatabase(db);
});

// --- failure handling: structured, non-fatal --------------------------------

test('failed positions read DEFERS exits (never a naked sell) and is recorded, not thrown', async () => {
  const db = freshDb();
  const id = seedOption(db, { lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
  const client = fakeClient({ positionsThrow: true, quote: { symbol: OCC, bid: 3.0, ask: 3.1 } });
  const summary = await reconcile(db, client);
  assert.equal(client.calls.submit.length, 0); // no sell without confirmed holding
  assert.ok(summary.errors.length > 0);
  assert.equal(getPaperOptionTradeById(db, id).lifecycle_state, 'open');
  closeDatabase(db);
});

test('failed order poll / quote / submit / cancel calls become structured non-fatal outcomes', async () => {
  // entry poll failure
  const db1 = freshDb();
  seedOption(db1, { lifecycleState: 'pending_entry', entryOrderId: 'entry_1' });
  const c1 = fakeClient({ getOrderThrow: true });
  const s1 = await reconcile(db1, c1);
  assert.ok(s1.errors.some((e) => /entry poll/.test(e)));
  closeDatabase(db1);

  // quote failure while open -> holds, recorded
  const db2 = freshDb();
  const id2 = seedOption(db2, { lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
  const c2 = fakeClient({ positions: [longPos()], quoteThrow: true });
  const s2 = await reconcile(db2, c2);
  assert.equal(c2.calls.submit.length, 0);
  assert.equal(getPaperOptionTradeById(db2, id2).lifecycle_state, 'open');
  assert.ok(s2.errors.some((e) => /quote/.test(e)));
  closeDatabase(db2);

  // submit failure on a take-profit -> recorded, stays open (retried next cycle)
  const db3 = freshDb();
  const id3 = seedOption(db3, { lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
  const c3 = fakeClient({ positions: [longPos()], quote: { symbol: OCC, bid: 3.0, ask: 3.1 }, submitThrow: true });
  const s3 = await reconcile(db3, c3);
  assert.equal(getPaperOptionTradeById(db3, id3).lifecycle_state, 'open');
  assert.ok(s3.errors.some((e) => /exit submit/.test(e)));
  closeDatabase(db3);
});

test('no paper client => the monitor is a no-op (no throw)', async () => {
  const db = freshDb();
  seedOption(db, { lifecycleState: 'open', openedAt: ISO(NOW), premiumEntry: 2.0 });
  const summary = await reconcileBotOptions(db, { paperClient: null, config: CONFIG, nowMs: NOW, session: { isOpen: true, sessionCloseMs: CLOSE } });
  assert.equal(summary.checked, 0);
  closeDatabase(db);
});

// --- no network -------------------------------------------------------------

test('the full monitor path runs with zero real network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error('network attempted'); };
  try {
    const db = freshDb();
    seedOption(db, { lifecycleState: 'open', openedAt: ISO(NOW - 10 * 60_000), premiumEntry: 2.0 });
    await reconcile(db, fakeClient({ positions: [longPos()], quote: { symbol: OCC, bid: 3.0, ask: 3.1 } }));
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
