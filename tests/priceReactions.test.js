// tests/priceReactions.test.js — Phase 4 storage foundation: migration 003,
// PriceSource contract + fixture source, insertPriceReaction writer.
// Fixture-only: no market-data APIs, no network. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertNewsEvent } from '../src/database/newsEvents.js';
import {
  HORIZONS,
  MEASUREMENT_STATUS,
  insertPriceReaction,
  getPriceReaction,
  listPriceReactionsForEvent,
  countPriceReactionsByStatus,
} from '../src/database/priceReactions.js';
import { validatePriceSource, createFixturePriceSource } from '../src/prices/priceSource.js';
import { normalizeNewsEvent } from '../src/providers/normalize.js';

const ANCHOR = '2026-06-09T14:30:00.000Z';
const MEASURED_AT = '2026-06-09T15:35:00.000Z';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedEvent(db) {
  const event = normalizeNewsEvent({
    provider: 'mock',
    providerEventId: 'pr-1',
    headline: 'Seed event',
    publishedAt: '2026-06-09T14:29:58Z',
    receivedAt: ANCHOR,
    symbols: ['AAPL'],
  });
  return insertNewsEvent(db, event).id;
}

function measuredReaction(overrides = {}) {
  return {
    horizon: '1m',
    measurementStatus: MEASUREMENT_STATUS.MEASURED,
    anchorAt: ANCHOR,
    baselineAt: '2026-06-09T14:29:59.500Z',
    baselinePrice: 200.0,
    reactionPrice: 201.0,
    highPrice: 201.4,
    lowPrice: 199.8,
    volume: 12500,
    priceSource: 'fixture',
    measuredAt: MEASURED_AT,
    ...overrides,
  };
}

// --- migration ------------------------------------------------------------

test('all migrations apply cleanly and are idempotent with the runner', () => {
  const db = openMemoryDatabase();
  const first = runMigrations(db);
  assert.deepEqual(first.applied, [
    '001_initial',
    '002_sentiment_scores_phase3',
    '003_price_reactions_event_study',
    '004_paper_runtime_research',
    '005_paper_option_execution',
    '006_paper_broker_truth_performance',
    '007_paper_equity_sizing_decisions',
    '008_paper_cap_and_benchmark_metadata',
    '011_simplify',
    '012_exit_orders',
  ]);
  const second = runMigrations(db);
  assert.equal(second.applied.length, 0);
  assert.ok(second.skipped.includes('004_paper_runtime_research'));
  assert.ok(second.skipped.includes('006_paper_broker_truth_performance'));
  assert.ok(second.skipped.includes('007_paper_equity_sizing_decisions'));
  assert.ok(second.skipped.includes('008_paper_cap_and_benchmark_metadata'));
  assert.ok(second.skipped.includes('011_simplify'));
  assert.ok(second.skipped.includes('012_exit_orders'));
  closeDatabase(db);
});

test('rebuilt schema has the designed shape', () => {
  const db = freshDb();
  const cols = db.prepare("PRAGMA table_info('price_reactions')").all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  for (const name of [
    'measurement_status', 'anchor_at', 'baseline_at', 'baseline_price',
    'reaction_price', 'return_pct', 'price_source', 'measured_at',
  ]) {
    assert.ok(byName[name], `missing column: ${name}`);
  }
  assert.equal(byName.baseline_price.notnull, 0); // nullable now (was NOT NULL)
  assert.equal(byName.measurement_status.notnull, 1);
  closeDatabase(db);
});

// --- horizons and statuses ---------------------------------------------------

test('all canonical horizons accept measured rows', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  for (const horizon of HORIZONS) {
    const { replaced } = insertPriceReaction(db, eventId, measuredReaction({ horizon }));
    assert.equal(replaced, false);
  }
  const rows = listPriceReactionsForEvent(db, eventId);
  assert.deepEqual(rows.map((r) => r.horizon), ['10s', '1m', '5m', '30m', '1h', 'eod']);
  closeDatabase(db);
});

test('unknown horizon is rejected by writer and schema', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  assert.throws(() => insertPriceReaction(db, eventId, measuredReaction({ horizon: '2h' })), /horizon/);
  // schema CHECK is the backstop for any path that bypasses the writer
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO price_reactions (news_event_id, horizon, measurement_status, anchor_at, measured_at)
           VALUES (?, '2h', 'measured', ?, ?)`
        )
        .run(eventId, ANCHOR, MEASURED_AT),
    /CHECK/i
  );
  closeDatabase(db);
});

test('all measurement_status values store correctly; unavailable prices are NULL', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const statuses = ['no_baseline', 'no_reaction', 'market_closed', 'source_error'];
  const horizons = ['10s', '1m', '5m', '30m'];
  statuses.forEach((status, i) => {
    insertPriceReaction(db, eventId, {
      horizon: horizons[i],
      measurementStatus: status,
      anchorAt: ANCHOR,
      measuredAt: MEASURED_AT,
      priceSource: 'fixture',
      // no_reaction may carry the baseline it DID find:
      ...(status === 'no_reaction' ? { baselinePrice: 200.0, baselineAt: ANCHOR } : {}),
    });
    const row = getPriceReaction(db, eventId, horizons[i]);
    assert.equal(row.measurement_status, status);
    assert.equal(row.reaction_price, null);
    assert.equal(row.return_pct, null);
    if (status !== 'no_reaction') assert.equal(row.baseline_price, null);
  });
  insertPriceReaction(db, eventId, measuredReaction({ horizon: '1h' }));
  const counts = countPriceReactionsByStatus(db);
  assert.equal(counts.measured, 1);
  assert.equal(counts.no_baseline, 1);
  assert.equal(counts.no_reaction, 1);
  assert.equal(counts.market_closed, 1);
  assert.equal(counts.source_error, 1);
  closeDatabase(db);
});

// --- return calculation --------------------------------------------------------

test('measured return_pct is computed and stored when omitted', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  insertPriceReaction(db, eventId, measuredReaction({ baselinePrice: 200, reactionPrice: 201 }));
  const row = getPriceReaction(db, eventId, '1m');
  assert.ok(Math.abs(row.return_pct - 0.005) < 1e-12); // (201-200)/200
  // explicit returnPct is respected
  insertPriceReaction(db, eventId, measuredReaction({ horizon: '5m', returnPct: -0.0123 }));
  assert.equal(getPriceReaction(db, eventId, '5m').return_pct, -0.0123);
  closeDatabase(db);
});

// --- replace semantics -----------------------------------------------------------

test('re-measurement replaces instead of duplicating', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  const first = insertPriceReaction(db, eventId, measuredReaction({ reactionPrice: 201.0 }));
  assert.equal(first.replaced, false);
  const second = insertPriceReaction(db, eventId, measuredReaction({ reactionPrice: 202.0 }));
  assert.equal(second.replaced, true);
  const rows = listPriceReactionsForEvent(db, eventId);
  assert.equal(rows.length, 1); // no duplicate row
  assert.equal(rows[0].reaction_price, 202.0); // newest measurement wins
  closeDatabase(db);
});

// --- writer validation -----------------------------------------------------------

test('writer enforces status/price consistency and input validity', () => {
  const db = freshDb();
  const eventId = seedEvent(db);
  // measured without prices
  assert.throws(
    () => insertPriceReaction(db, eventId, measuredReaction({ baselinePrice: undefined })),
    /requires baselinePrice/
  );
  // non-measured carrying a reaction price
  assert.throws(
    () =>
      insertPriceReaction(db, eventId, {
        horizon: '1m', measurementStatus: 'market_closed',
        anchorAt: ANCHOR, measuredAt: MEASURED_AT, reactionPrice: 201,
      }),
    /must not carry/
  );
  assert.throws(() => insertPriceReaction(db, 0, measuredReaction()), /newsEventId/);
  assert.throws(() => insertPriceReaction(db, 99999, measuredReaction()), /FOREIGN KEY/i);
  assert.throws(
    () => insertPriceReaction(db, eventId, measuredReaction({ anchorAt: 'yesterday' })),
    /anchorAt/
  );
  assert.throws(
    () => insertPriceReaction(db, eventId, measuredReaction({ measurementStatus: 'maybe' })),
    /measurementStatus/
  );
  closeDatabase(db);
});

// --- PriceSource contract + fixture source ----------------------------------------

test('fixture price source satisfies the contract and filters/sorts trades', async () => {
  const source = createFixturePriceSource({
    tradesByTicker: {
      AAPL: [
        { price: 201.0, at: '2026-06-09T14:30:30.000Z', size: 100 },
        { price: 200.0, at: '2026-06-09T14:29:59.000Z', size: 50 },
        { price: 205.0, at: '2026-06-09T16:00:00.000Z', size: 10 }, // outside window
      ],
    },
  });
  validatePriceSource(source);
  assert.equal(source.name, 'fixture');
  const trades = await source.getTradesAround('aapl', '2026-06-09T14:29:00.000Z', '2026-06-09T14:31:00.000Z');
  assert.deepEqual(trades.map((t) => t.price), [200.0, 201.0]); // sorted, windowed, case-insensitive
  assert.deepEqual(await source.getTradesAround('MSFT', '2026-06-09T14:00:00Z', '2026-06-09T15:00:00Z'), []);
});

test('default fixture price source rejects and never touches the network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted');
  };
  try {
    const source = createFixturePriceSource(); // no trades injected
    validatePriceSource(source);
    await assert.rejects(() => source.getTradesAround('AAPL', ANCHOR, MEASURED_AT), /no trades configured/i);
    assert.throws(() => validatePriceSource({ name: 'x' }), /getTradesAround/);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
