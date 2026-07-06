// tests/riskState.test.js — Daily-loss kill switch (risk_state table).
// Fully offline: in-memory DB, injected timestamps, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  assessDailyLoss,
  clearKillSwitch,
  computeRealizedDailyPnl,
  getRiskState,
  isKillSwitchActive,
  resolveDailyLossCap,
  tradingDay,
  tripKillSwitch,
  updateDailyLossState,
} from '../src/paper/riskState.js';
import {
  executeSelectedPaperTrade,
  PAPER_DECISION_OUTCOMES,
} from '../src/paper/tradeCycle.js';
import { parseArgs, riskCapDefaultsFromConfig } from '../scripts/runPaperTradingOnce.js';

const DAY = '2026-06-18';
const NOW_MS = Date.parse('2026-06-18T15:00:00.000Z');

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedScoredEvent(db, { ticker = 'AAPL' } = {}) {
  const ev = db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t', 'evt-ks', ?, 'H', '2026-06-18T14:00:00.000Z', '2026-06-18T14:00:00.000Z', 'earnings')`
  ).run(ticker);
  const eventId = Number(ev.lastInsertRowid);
  db.prepare(
    `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, sentiment_score, news_type,
        confidence, raw_response, parse_ok, parser_status, impact_score, direction, time_horizon, detail)
     VALUES (?, 'm', 'model_v1', 0.7, 'earnings', 0.9, 'raw', 1, 'parsed', 0.8, 'up', 'intraday', '{}')`
  ).run(eventId);
  return eventId;
}

function insertBrokerConfirmedTrade(db, { pnl, createdAt = `${DAY}T14:30:00.000Z` }) {
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at, broker_realized_pnl_usd)
     VALUES ('AAPL', 'buy', 1, 'closed', ?, ?)`
  ).run(createdAt, pnl);
}

// --- pure assessment ---------------------------------------------------------

test('assessDailyLoss trips only when the realized loss breaches the cap', () => {
  assert.equal(assessDailyLoss({ realizedPnlUsd: -101, maxDailyLossUsd: 100 }).exceeded, true);
  assert.equal(assessDailyLoss({ realizedPnlUsd: -100, maxDailyLossUsd: 100 }).exceeded, true); // at cap = halt
  assert.equal(assessDailyLoss({ realizedPnlUsd: -99.99, maxDailyLossUsd: 100 }).exceeded, false);
  assert.equal(assessDailyLoss({ realizedPnlUsd: 50, maxDailyLossUsd: 100 }).exceeded, false);
  assert.equal(assessDailyLoss({ realizedPnlUsd: -9999, maxDailyLossUsd: null }).exceeded, false); // no cap
  assert.equal(assessDailyLoss({ realizedPnlUsd: null, maxDailyLossUsd: 100 }).exceeded, false); // unknown pnl
});

test('resolveDailyLossCap prefers percent-of-equity and falls back to fixed USD', () => {
  // $1M account at 1% -> $10,000/day, NOT the $100 fallback.
  const pct = resolveDailyLossCap({
    account: { equity: 1_000_000 },
    maxDailyLossPct: 0.01,
    maxDailyLossUsd: 100,
  });
  assert.equal(pct.capUsd, 10000);
  assert.match(pct.basis, /1\.00% of equity/);

  // No broker equity (keyless dry run) -> fixed USD fallback.
  const usd = resolveDailyLossCap({ account: null, maxDailyLossPct: 0.01, maxDailyLossUsd: 100 });
  assert.equal(usd.capUsd, 100);
  assert.match(usd.basis, /equity unavailable/);

  // Nothing configured -> no cap.
  assert.equal(resolveDailyLossCap({}).capUsd, null);
});

// --- risk_state persistence --------------------------------------------------

test('trip/clear round-trips through risk_state and days are independent', () => {
  const db = freshDb();
  assert.equal(getRiskState(db, DAY), null);
  assert.equal(isKillSwitchActive(db, DAY), false);

  const tripped = tripKillSwitch(db, { day: DAY, reason: 'test halt', realizedPnlUsd: -123.45 });
  assert.equal(tripped.kill_switch_active, 1);
  assert.equal(tripped.kill_switch_reason, 'test halt');
  assert.equal(tripped.realized_pnl_usd, -123.45);
  assert.equal(isKillSwitchActive(db, DAY), true);

  // The NEXT trading day starts clean (per-day halt, self-clearing).
  assert.equal(isKillSwitchActive(db, '2026-06-19'), false);

  const cleared = clearKillSwitch(db, { day: DAY });
  assert.equal(cleared.kill_switch_active, 0);
  assert.equal(isKillSwitchActive(db, DAY), false);
  closeDatabase(db);
});

test('computeRealizedDailyPnl sums only broker-confirmed rows for the day', () => {
  const db = freshDb();
  insertBrokerConfirmedTrade(db, { pnl: -60 });
  insertBrokerConfirmedTrade(db, { pnl: -50 });
  insertBrokerConfirmedTrade(db, { pnl: 25, createdAt: '2026-06-17T14:30:00.000Z' }); // other day
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at)
     VALUES ('AAPL', 'buy', 1, 'open', '${DAY}T14:31:00.000Z')` // unconfirmed: no realized pnl
  ).run();
  const { realizedPnlUsd, confirmedRows } = computeRealizedDailyPnl(db, DAY);
  assert.equal(realizedPnlUsd, -110);
  assert.equal(confirmedRows, 2);
  closeDatabase(db);
});

test('updateDailyLossState trips once and records the realized P&L', () => {
  const db = freshDb();
  insertBrokerConfirmedTrade(db, { pnl: -150 });
  const first = updateDailyLossState(db, { day: DAY, maxDailyLossUsd: 100 });
  assert.equal(first.tripped, true);
  assert.equal(isKillSwitchActive(db, DAY), true);
  const second = updateDailyLossState(db, { day: DAY, maxDailyLossUsd: 100 });
  assert.equal(second.tripped, false);
  assert.equal(second.alreadyActive, true);
  const row = getRiskState(db, DAY);
  assert.equal(row.realized_pnl_usd, -150);
  assert.match(row.kill_switch_reason, /MAX_DAILY_LOSS_USD/);
  closeDatabase(db);
});

// --- trade-cycle integration ---------------------------------------------------

test('an active kill switch refuses the proposal and logs a rejected trade', async () => {
  const db = freshDb();
  const eventId = seedScoredEvent(db);
  tripKillSwitch(db, { day: DAY, reason: 'test halt' });
  const args = parseArgs(['--symbols', 'AAPL', '--event-id', String(eventId)]);
  const selected = { event: { id: eventId, ticker: 'AAPL' }, score: {} };
  const trade = await executeSelectedPaperTrade(db, selected, { args, nowMs: NOW_MS });
  assert.equal(trade.result.equity, null);
  assert.equal(trade.result.killSwitch.active, true);
  assert.ok(trade.lines.some((l) => l.includes('KILL SWITCH ACTIVE')));
  const rejection = db.prepare('SELECT * FROM rejected_trades WHERE news_event_id = ?').get(eventId);
  assert.match(rejection.reason, /kill switch active/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  closeDatabase(db);
});

test('a breaching day trips the switch after the attempt and reports it', async () => {
  const db = freshDb();
  const eventId = seedScoredEvent(db);
  insertBrokerConfirmedTrade(db, { pnl: -500 }); // prior confirmed loss today
  const args = parseArgs(['--symbols', 'AAPL', '--event-id', String(eventId), '--max-daily-loss', '100']);
  const selected = { event: { id: eventId, ticker: 'AAPL' }, score: { direction: 'up', sentiment_score: 0.7, impact_score: 0.8, confidence: 0.9, parser_status: 'parsed' } };
  const trade = await executeSelectedPaperTrade(db, selected, { args, nowMs: NOW_MS });
  assert.equal(trade.result.killSwitch.tripped, true);
  assert.ok(trade.lines.some((l) => l.includes('KILL SWITCH TRIPPED')));
  assert.equal(isKillSwitchActive(db, DAY), true);
  closeDatabase(db);
});

test('parseArgs folds MAX_DAILY_LOSS default and --max-daily-loss wins', () => {
  assert.equal(parseArgs([], { maxDailyLossUsd: 100 }).maxDailyLossUsd, 100);
  assert.equal(parseArgs(['--max-daily-loss', '250'], { maxDailyLossUsd: 100 }).maxDailyLossUsd, 250);
  assert.equal(parseArgs([]).maxDailyLossUsd, null);
});

test('tradingDay derives the UTC date', () => {
  assert.equal(tradingDay(Date.parse('2026-06-18T23:59:59.000Z')), '2026-06-18');
  assert.equal(tradingDay(Date.parse('2026-06-19T00:00:01.000Z')), '2026-06-19');
});

test('legacy .env risk knobs become real cap defaults; settings/CLI still win', () => {
  const caps = riskCapDefaultsFromConfig({
    risk: { maxPositionSizeUsd: 500, maxTradesPerDay: 10, maxTotalExposureUsd: 1000, maxDailyLossUsd: 100 },
  });
  assert.deepEqual(caps, { maxOrderNotional: 500, maxDailyPaperOrders: 10, maxGrossExposure: 1000 });
  // CLI flag beats the env-derived default.
  const args = parseArgs(['--max-order-notional', '250'], { caps });
  assert.equal(args.caps.maxOrderNotional, 250);
  assert.equal(args.caps.maxDailyPaperOrders, 10);
});
