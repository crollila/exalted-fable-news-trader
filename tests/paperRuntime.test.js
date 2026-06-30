// tests/paperRuntime.test.js - PAPER runtime audit storage tests.
// No network, no timers beyond injected timestamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  insertPaperOptionTrade,
  closePaperOptionTrade,
  listPaperOptionTrades,
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
  insertRecommendationAudit,
  listRecommendationAudits,
  insertUniverseSelections,
  listUniverseSelections,
} from '../src/database/paperRuntime.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

test('paper option trade helper records a long call audit row and close policy outcome', () => {
  const db = freshDb();
  const { id } = insertPaperOptionTrade(db, {
    underlying: 'aapl',
    optionSymbol: 'AAPL260116C00150000',
    expiry: '2026-01-16',
    strike: 150,
    right: 'call',
    quantity: 1,
    premiumEntry: 2.5,
    notionalEntry: 250,
    strategy: 'long_call',
    strategyRationale: 'bullish_call from model direction up',
    exitPolicy: 'close at 50% gain, 50% loss, or before expiry',
  });
  assert.equal(id, 1);
  assert.equal(closePaperOptionTrade(db, {
    id,
    premiumExit: 3.75,
    notionalExit: 375,
    exitReason: 'take_profit_50pct',
    closedAt: '2026-01-12T20:00:00.000Z',
  }).changes, 1);
  const row = listPaperOptionTrades(db)[0];
  assert.equal(row.underlying, 'AAPL');
  assert.equal(row.option_symbol, 'AAPL260116C00150000');
  assert.equal(row.right, 'call');
  assert.equal(row.status, 'closed');
  assert.equal(row.exit_reason, 'take_profit_50pct');
  assert.equal(row.premium_exit, 3.75);
  closeDatabase(db);
});

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
    optionsUsed: 1,
    eodReportStatus: 'sent',
    eodReportSentAt: '2026-06-18T20:01:00.000Z',
  });
  assert.equal(result.changes, 1);
  const row = getPaperRuntimeSession(db, id);
  assert.equal(row.cycles, 3);
  assert.equal(row.fresh_news_count, 7);
  assert.deepEqual(JSON.parse(row.classification_status_json), { parsed: 4, model_error: 1 });
  assert.deepEqual(JSON.parse(row.rejected_reason_json), { 'confidence below threshold': 1 });
  assert.equal(row.options_used, 1);
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

test('recommendation audits persist versioned evidence summaries only', () => {
  const db = freshDb();
  const { id } = insertRecommendationAudit(db, {
    version: 'paper_research_v1',
    kind: 'constraint_suggestion',
    evidenceWindowStart: '2026-06-18',
    evidenceWindowEnd: '2026-06-18',
    sampleSize: 12,
    dataQuality: 'sufficient',
    observations: [{ slice: 'confidence>=0.75', outcome: '+1.2%' }],
    recommendations: [{ manualEditLine: 'PAPER_CONFIDENCE_THRESHOLD=0.65' }],
  });
  assert.equal(id, 1);
  const row = listRecommendationAudits(db, { kind: 'constraint_suggestion' })[0];
  assert.equal(row.version, 'paper_research_v1');
  assert.equal(row.sample_size, 12);
  assert.deepEqual(JSON.parse(row.recommendations_json), [
    { manualEditLine: 'PAPER_CONFIDENCE_THRESHOLD=0.65' },
  ]);
  closeDatabase(db);
});

test('universe selections record selected and skipped symbol rationale', () => {
  const db = freshDb();
  const cycleAt = '2026-06-18T14:00:00.000Z';
  assert.equal(insertUniverseSelections(db, [
    { cycleAt, symbol: 'aapl', selected: true, rankScore: 3.2, reasons: ['base universe'], source: 'base' },
    { cycleAt, symbol: 'tsla', selected: false, rankScore: 0.4, reasons: ['fresh news'], skippedReason: 'cap reached', source: 'news' },
  ]).inserted, 2);
  const rows = listUniverseSelections(db, { cycleAt });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'AAPL');
  assert.equal(rows[0].selected, 1);
  assert.deepEqual(JSON.parse(rows[1].reasons_json), ['fresh news']);
  assert.equal(rows[1].skipped_reason, 'cap reached');
  closeDatabase(db);
});
