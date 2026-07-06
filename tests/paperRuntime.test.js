// tests/paperRuntime.test.js - PAPER runtime audit storage tests.
// No network, no timers beyond injected timestamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  startPaperRuntimeSession,
  updatePaperRuntimeSession,
  getPaperRuntimeSession,
  findOpenPaperRuntimeSession,
  insertBrokerAccountSnapshot,
  findBaselineBrokerAccountSnapshot,
  insertStrategyPerformanceSnapshot,
  getLatestStrategyPerformanceSnapshot,
  updatePaperTradeBrokerTruth,
  insertEquitySizingDecision,
  listEquitySizingDecisions,
  listBrokerConfirmedEquityOutcomes,
  getOwnedEquityExposureSnapshot,
  getPaperEventAttemptStats,
} from '../src/database/paperRuntime.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('paper runtime sessions persist sanitized counters and JSON maps', () => {
  const db = freshDb();
  const { id } = startPaperRuntimeSession(db, {
    sessionDate: '2026-06-18',
    startedAt: '2026-06-18T13:30:00.000Z',
  });
  const result = updatePaperRuntimeSession(db, id, {
    cycles: 3,
    freshNewsCount: 7,
    classificationCount: 5,
    classificationStatus: { parsed: 4, model_error: 1 },
    skippedReasons: { 'market closed': 2 },
    rejectedReasons: { 'confidence below threshold': 1 },
    ordersSubmitted: 1,
    orderStatus: { accepted: 1 },
    modelRequestCount: 5,
    eodReportStatus: 'sent',
    eodReportSentAt: '2026-06-18T20:01:00.000Z',
  });
  assert.equal(result.changes, 1);
  const row = getPaperRuntimeSession(db, id);
  assert.equal(row.cycles, 3);
  assert.equal(row.fresh_news_count, 7);
  assert.deepEqual(JSON.parse(row.classification_status_json), { parsed: 4, model_error: 1 });
  assert.deepEqual(JSON.parse(row.rejected_reason_json), { 'confidence below threshold': 1 });
  assert.equal(row.eod_report_status, 'sent');
  closeDatabase(db);
});

test('findOpenPaperRuntimeSession returns latest open session and ignores closed ones', () => {
  const db = freshDb();
  startPaperRuntimeSession(db, { sessionDate: '2026-06-18', startedAt: '2026-06-18T13:30:00.000Z' });
  const second = startPaperRuntimeSession(db, { sessionDate: '2026-06-18', startedAt: '2026-06-18T14:00:00.000Z' });
  startPaperRuntimeSession(db, { sessionDate: '2026-06-17', startedAt: '2026-06-17T13:30:00.000Z' });
  updatePaperRuntimeSession(db, 1, { status: 'closed' });
  const row = findOpenPaperRuntimeSession(db, '2026-06-18');
  assert.equal(row.id, second.id);
  updatePaperRuntimeSession(db, second.id, { status: 'closed', eodReportStatus: 'sent' });
  assert.equal(findOpenPaperRuntimeSession(db, '2026-06-18'), null);
  assert.equal(getPaperRuntimeSession(db, second.id).eod_report_status, 'sent');
  closeDatabase(db);
});

test('broker account and performance snapshot helpers persist additive truth fields', () => {
  const db = freshDb();
  const session = startPaperRuntimeSession(db, {
    sessionDate: '2026-06-18',
    startedAt: '2026-06-18T13:30:00.000Z',
  });
  const trade = db
    .prepare(
      `INSERT INTO paper_trades (ticker, side, quantity, status, broker_order_id)
       VALUES ('AAPL', 'buy', 1, 'open', 'ord_1')`
    )
    .run();
  assert.equal(updatePaperTradeBrokerTruth(db, trade.lastInsertRowid, {
    brokerOrderStatus: 'filled',
    brokerFilledQty: 1,
    brokerFilledAvgPrice: 200,
    brokerTruthState: 'filled',
  }).changes, 1);
  const tradeRow = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(trade.lastInsertRowid);
  assert.equal(tradeRow.broker_order_status, 'filled');
  assert.equal(tradeRow.broker_filled_avg_price, 200);

  const first = insertBrokerAccountSnapshot(db, {
    runtimeSessionId: session.id,
    snapshotAt: '2026-06-18T13:30:00.000Z',
    snapshotKind: 'session_start',
    accountStatus: 'ACTIVE',
    equity: 10000,
    portfolioValue: 10000,
    dataQuality: 'complete',
  });
  const second = insertBrokerAccountSnapshot(db, {
    runtimeSessionId: session.id,
    snapshotAt: '2026-06-18T14:30:00.000Z',
    snapshotKind: 'loop',
    accountStatus: 'ACTIVE',
    equity: 10100,
    portfolioValue: 10100,
    dataQuality: 'complete',
  });
  assert.equal(findBaselineBrokerAccountSnapshot(db, { runtimeSessionId: session.id }).id, first.id);

  const perf = insertStrategyPerformanceSnapshot(db, {
    runtimeSessionId: session.id,
    accountSnapshotId: second.id,
    baselineAccountSnapshotId: first.id,
    snapshotAt: '2026-06-18T14:30:00.000Z',
    brokerEquityBaseline: 10000,
    brokerEquityCurrent: 10100,
    brokerAccountReturnPct: 0.01,
    spyBaselinePrice: 500,
    spyCurrentPrice: 502,
    spyReturnPct: 0.004,
    brokerAccountExcessReturnPct: 0.006,
    botGrossExposure: 200,
    botOpenPositionCount: 1,
    botOrdersSubmitted: 1,
    botOrdersFilled: 1,
    dataQuality: 'complete',
  });
  const latest = getLatestStrategyPerformanceSnapshot(db, { runtimeSessionId: session.id });
  assert.equal(latest.id, perf.id);
  assert.equal(latest.bot_gross_exposure, 200);
  assert.equal(latest.broker_account_return_pct, 0.01);
  closeDatabase(db);
});

test('equity sizing audits and evidence helpers use only broker-confirmed bot-owned rows', () => {
  const db = freshDb();
  const eventId = Number(db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t', 'sizing-1', 'AAPL', 'H', '2026-06-18T14:00:00.000Z', '2026-06-18T14:00:00.000Z', 'earnings')`
  ).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO sentiment_scores
       (news_event_id, model, prompt_version, sentiment_score, news_type,
        confidence, raw_response, parse_ok, parser_status, impact_score, direction)
     VALUES (?, 'claude-opus-4-8', 'model_v1', 0.7, 'earnings',
        0.9, '{}', 1, 'parsed', 0.8, 'up')`
  ).run(eventId);
  const ownedClosed = db.prepare(
    `INSERT INTO paper_trades
       (news_event_id, ticker, side, quantity, status, broker_order_id,
        broker_truth_state, broker_filled_qty, broker_filled_avg_price,
        broker_realized_pnl_usd, trade_reason)
     VALUES (?, 'AAPL', 'buy', 2, 'closed', 'ord-owned', 'filled', 2, 100, 12, 'paper order ord-owned')`
  ).run(eventId).lastInsertRowid;
  db.prepare(
    `INSERT INTO paper_trades
       (news_event_id, ticker, side, quantity, status, broker_truth_state,
        broker_filled_qty, broker_filled_avg_price, broker_realized_pnl_usd)
     VALUES (?, 'AAPL', 'buy', 1, 'closed', 'filled', 1, 100, 99)`
  ).run(eventId);
  const manualOwned = db.prepare(
    `INSERT INTO paper_trades
       (news_event_id, ticker, side, quantity, status, broker_order_id,
        broker_truth_state, broker_filled_qty, broker_filled_avg_price,
        broker_realized_pnl_usd, trade_reason)
     VALUES (?, 'AAPL', 'buy', 1, 'closed', 'ord-manual-override', 'filled', 1, 100, 8, 'paper order ord-manual-override')`
  ).run(eventId).lastInsertRowid;
  db.prepare(
    `INSERT INTO paper_trades
       (news_event_id, ticker, side, quantity, status, broker_order_id,
        broker_truth_state, broker_filled_qty, broker_filled_avg_price,
        broker_realized_pnl_usd)
     VALUES (?, 'AAPL', 'buy', 3, 'open', 'ord-open', 'filled', 3, 101, 777)`
  ).run(eventId);

  const audit = insertEquitySizingDecision(db, {
    paperTradeId: ownedClosed,
    newsEventId: eventId,
    ticker: 'aapl',
    side: 'buy',
    sizingMode: 'cold_start',
    evidenceQuality: 'limited',
    requestedTargetWeight: 0.0075,
    requestedNotional: 300,
    requestedQuantity: 3,
    approvedNotional: 300,
    approvedQuantity: 3,
    explanation: 'cold-start sizing: no comparable broker-confirmed outcomes yet',
    warnings: ['cold start'],
  });
  insertEquitySizingDecision(db, {
    paperTradeId: manualOwned,
    newsEventId: eventId,
    ticker: 'AAPL',
    side: 'buy',
    manualOverride: true,
    sizingMode: 'abstain',
    evidenceQuality: 'manual_override',
    requestedQuantity: 1,
    approvedQuantity: 1,
    explanation: 'manual --qty override; learned sizing not applied',
  });
  assert.equal(audit.id, 1);
  const decisions = listEquitySizingDecisions(db);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.some((d) => d.ticker === 'AAPL' && d.manual_override === 0));
  assert.ok(decisions.some((d) => d.ticker === 'AAPL' && d.manual_override === 1));

  const outcomes = listBrokerConfirmedEquityOutcomes(db);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].broker_order_id, undefined);
  assert.equal(outcomes[0].broker_realized_pnl_usd, 12);

  const exposure = getOwnedEquityExposureSnapshot(db);
  assert.equal(exposure.openPositionCount, 1);
  assert.equal(exposure.byTickerSide['AAPL|buy'], 303);
  assert.equal(exposure.dataQuality, 'broker_confirmed');

  const attempts = getPaperEventAttemptStats(db, eventId);
  assert.equal(attempts.tradeAttempts, 4);
  assert.equal(attempts.duplicateAttempt, true);
  closeDatabase(db);
});

