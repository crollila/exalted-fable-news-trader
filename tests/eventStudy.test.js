// tests/eventStudy.test.js — Fixture-only measurement engine (Phase 4).
// PriceSource fixtures only: no market-data APIs, no network.
// Run with: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertNewsEvent, getNewsEventById } from '../src/database/newsEvents.js';
import {
  getPriceReaction,
  listPriceReactionsForEvent,
} from '../src/database/priceReactions.js';
import { createFixturePriceSource } from '../src/prices/priceSource.js';
import {
  measureEvent,
  measureEvents,
  eodTargetFor,
} from '../src/eventStudy/measureReactions.js';
import { normalizeNewsEvent } from '../src/providers/normalize.js';

const ANCHOR = '2026-06-09T14:30:00.000Z';

// Trades around the anchor: one pre-anchor baseline candidate plus one trade
// inside each successive horizon window (10s / 1m / 5m / 30m / 1h / eod).
const AAPL_TRADES = [
  { price: 199.0, at: '2026-06-09T14:20:00.000Z', size: 10 }, // early; NOT the baseline
  { price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 }, // baseline (last <= anchor)
  { price: 200.5, at: '2026-06-09T14:30:05.000Z', size: 20 }, // 10s window
  { price: 201.0, at: '2026-06-09T14:30:45.000Z', size: 30 }, // 1m window
  { price: 202.0, at: '2026-06-09T14:34:00.000Z', size: 40 }, // 5m window
  { price: 203.0, at: '2026-06-09T14:55:00.000Z', size: 25 }, // 30m window
  { price: 204.0, at: '2026-06-09T15:25:00.000Z', size: 15 }, // 1h window
  { price: 206.0, at: '2026-06-09T20:55:00.000Z', size: 60 }, // before eod target
  { price: 999.0, at: '2026-06-09T21:30:00.000Z', size: 5 },  // after eod target; ignored
];

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedEventRow(db, { ticker = 'AAPL', receivedAt = ANCHOR, id = 'es-1' } = {}) {
  const event = normalizeNewsEvent({
    provider: 'mock',
    providerEventId: id,
    headline: `Event ${id}`,
    publishedAt: '2026-06-09T14:29:58.000Z',
    receivedAt,
    symbols: [ticker],
  });
  const inserted = insertNewsEvent(db, event);
  return getNewsEventById(db, inserted.id);
}

function aaplSource(trades = AAPL_TRADES) {
  return createFixturePriceSource({ tradesByTicker: { AAPL: trades } });
}

test('baseline uses the last trade at or before received_at, not after', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  await measureEvent(db, row, aaplSource());
  const r = getPriceReaction(db, row.id, '1m');
  assert.equal(r.baseline_price, 200.0); // the 14:29:59 trade
  assert.equal(r.baseline_at, '2026-06-09T14:29:59.000Z');
  assert.notEqual(r.baseline_price, 200.5); // never a post-anchor trade
  closeDatabase(db);
});

test('each canonical horizon creates one price_reactions row with correct reactions', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  const summary = await measureEvent(db, row, aaplSource());
  assert.equal(summary.results.length, 6);
  assert.ok(summary.results.every((r) => r.status === 'measured'));

  const rows = listPriceReactionsForEvent(db, row.id);
  assert.deepEqual(rows.map((r) => r.horizon), ['10s', '1m', '5m', '30m', '1h', 'eod']);
  const reactionByHorizon = Object.fromEntries(rows.map((r) => [r.horizon, r.reaction_price]));
  assert.deepEqual(reactionByHorizon, {
    '10s': 200.5, '1m': 201.0, '5m': 202.0, '30m': 203.0, '1h': 204.0, eod: 206.0,
  });
  assert.equal(rows[0].anchor_at, ANCHOR);
  assert.equal(rows[0].price_source, 'fixture');
  closeDatabase(db);
});

test('return_pct is computed correctly through insertPriceReaction', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  await measureEvent(db, row, aaplSource());
  const r1m = getPriceReaction(db, row.id, '1m');
  assert.ok(Math.abs(r1m.return_pct - (201.0 - 200.0) / 200.0) < 1e-12);
  const r10s = getPriceReaction(db, row.id, '10s');
  assert.ok(Math.abs(r10s.return_pct - 0.0025) < 1e-12); // (200.5-200)/200
  closeDatabase(db);
});

test('no_baseline row is stored when no baseline trade exists', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  // Only post-anchor trades: nothing at/before the anchor.
  const source = aaplSource(AAPL_TRADES.filter((t) => t.at > ANCHOR));
  const summary = await measureEvent(db, row, source);
  assert.ok(summary.results.every((r) => r.status === 'no_baseline'));
  const r = getPriceReaction(db, row.id, '5m');
  assert.equal(r.measurement_status, 'no_baseline');
  assert.equal(r.baseline_price, null);
  assert.equal(r.reaction_price, null);
  assert.equal(r.return_pct, null);
  closeDatabase(db);
});

test('no_reaction row is stored when baseline exists but horizon trade is missing', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  // Baseline only — zero post-anchor trades anywhere.
  const source = aaplSource([{ price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 }]);
  const summary = await measureEvent(db, row, source);
  assert.ok(summary.results.every((r) => r.status === 'no_reaction'));
  const r = getPriceReaction(db, row.id, '1m');
  assert.equal(r.measurement_status, 'no_reaction');
  assert.equal(r.baseline_price, 200.0); // the baseline it DID find is kept
  assert.equal(r.reaction_price, null);
  assert.equal(r.return_pct, null);
  closeDatabase(db);
});

test('source_error rows are stored when the PriceSource throws', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  const broken = {
    name: 'fixture',
    getTradesAround: async () => {
      throw new Error('simulated source outage');
    },
  };
  const summary = await measureEvent(db, row, broken);
  assert.equal(summary.results.length, 6);
  assert.ok(summary.results.every((r) => r.status === 'source_error'));
  assert.equal(getPriceReaction(db, row.id, 'eod').measurement_status, 'source_error');
  closeDatabase(db);
});

test('eod uses the documented temporary fixture EOD target (21:00 UTC same day)', async () => {
  assert.equal(eodTargetFor(ANCHOR), '2026-06-09T21:00:00.000Z');
  const db = freshDb();
  const row = seedEventRow(db);
  await measureEvent(db, row, aaplSource());
  const eod = getPriceReaction(db, row.id, 'eod');
  assert.equal(eod.reaction_price, 206.0); // 20:55 trade, NOT the 21:30 one
  closeDatabase(db);
});

test('re-running measurement replaces rows instead of duplicating', async () => {
  const db = freshDb();
  const row = seedEventRow(db);
  const first = await measureEvent(db, row, aaplSource());
  assert.ok(first.results.every((r) => r.replaced === false));

  // Re-measure with revised data: the 1m trade is corrected.
  const revised = AAPL_TRADES.map((t) =>
    t.at === '2026-06-09T14:30:45.000Z' ? { ...t, price: 201.5 } : t
  );
  const second = await measureEvent(db, row, aaplSource(revised));
  assert.ok(second.results.every((r) => r.replaced === true));

  const rows = listPriceReactionsForEvent(db, row.id);
  assert.equal(rows.length, 6); // still exactly one row per horizon
  assert.equal(getPriceReaction(db, row.id, '1m').reaction_price, 201.5);
  closeDatabase(db);
});

test('measureEvents handles batches; bad rows are recorded, not fatal', async () => {
  const db = freshDb();
  const a = seedEventRow(db, { id: 'es-a' });
  const b = seedEventRow(db, { id: 'es-b' });
  const result = await measureEvents(db, [a, b, { id: 'nope' }], aaplSource());
  assert.equal(result.measuredEvents, 2);
  assert.equal(result.failedEvents, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(listPriceReactionsForEvent(db, a.id).length, 6);
  assert.equal(listPriceReactionsForEvent(db, b.id).length, 6);
  closeDatabase(db);
});

test('no network is touched anywhere in measurement', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted');
  };
  try {
    const db = freshDb();
    const row = seedEventRow(db);
    await measureEvent(db, row, aaplSource());
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
