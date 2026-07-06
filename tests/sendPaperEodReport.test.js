// tests/sendPaperEodReport.test.js — Network-free tests for the end-of-day
// PAPER report. Importing the script runs NOTHING (CLI guard). The DB-touching
// tests use an in-memory database; the send path uses a FAKE Discord client, so
// npm test never touches the network and never posts to Discord.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { insertPaperTrade, insertRejectedTrade } from '../src/paper/paperTradeProposal.js';
import {
  insertBrokerAccountSnapshot,
  insertEquitySizingDecision,
  insertStrategyPerformanceSnapshot,
} from '../src/database/paperRuntime.js';
import {
  parseArgs,
  collectEodData,
  buildEodReport,
  runEodReport,
  EOD_TEST_MESSAGE,
} from '../scripts/sendPaperEodReport.js';

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

/** A fake Discord client that records what it was asked to send. */
function fakeDiscord() {
  const sent = [];
  return { sent, send: async ({ content }) => { sent.push(content); return { ok: true, status: 204 }; } };
}

function seedActivity(db) {
  insertPaperTrade(db, { ticker: 'AAPL', side: 'buy', quantity: 1, fillPrice: 201.5, tradeReason: 'long AAPL', status: 'open' });
  insertPaperTrade(db, { ticker: 'MSFT', side: 'buy', quantity: 2, fillPrice: null, tradeReason: 'long MSFT', status: 'open' });
  insertRejectedTrade(db, { ticker: 'NVDA', side: 'buy', quantity: 1, reason: 'direction "down" is not up (long-only slice; no shorts)' });
  insertRejectedTrade(db, { ticker: 'TSLA', side: 'buy', quantity: 1, reason: 'direction "down" is not up (long-only slice; no shorts)' });
  insertRejectedTrade(db, { ticker: 'AMD', side: 'buy', quantity: 1, reason: 'confidence 0.2 below threshold 0.6' });
}

function insertEvent(db, id) {
  return Number(db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t', ?, 'AAPL', 'H', '2026-06-18T14:00:00.000Z', '2026-06-18T14:00:00.000Z', 'earnings')`
  ).run(`evt-${id}`).lastInsertRowid);
}

function seedSufficientLosingSession(db) {
  const sessionId = Number(db.prepare(
    `INSERT INTO paper_runtime_sessions
       (session_date, started_at, ended_at, status, cycles, fresh_news_count,
        classification_count, classification_status_json, orders_submitted, order_status_json,
        model_request_count)
     VALUES
       ('2026-06-18', '2026-06-18T13:30:00.000Z', '2026-06-18T20:00:00.000Z',
        'closed', 10, 10, 10, '{"parsed":10}', 10, '{"filled":10}', 10)`
  ).run().lastInsertRowid);
  for (let i = 0; i < 10; i += 1) {
    const eventId = insertEvent(db, i);
    const trade = insertPaperTrade(db, {
      newsEventId: eventId,
      ticker: 'AAPL',
      side: 'buy',
      quantity: 1,
      fillPrice: 100,
      status: 'closed',
    });
    db.prepare('UPDATE paper_trades SET pnl_usd = -10, created_at = ? WHERE id = ?')
      .run(`2026-06-18T14:${String(i).padStart(2, '0')}:00.000Z`, trade.id);
  }
  const baseline = insertBrokerAccountSnapshot(db, {
    runtimeSessionId: sessionId,
    snapshotAt: '2026-06-18T13:30:00.000Z',
    snapshotKind: 'session_start',
    accountStatus: 'ACTIVE',
    equity: 10000,
    portfolioValue: 10000,
    dataQuality: 'complete',
  });
  const current = insertBrokerAccountSnapshot(db, {
    runtimeSessionId: sessionId,
    snapshotAt: '2026-06-18T20:00:00.000Z',
    snapshotKind: 'eod',
    accountStatus: 'ACTIVE',
    equity: 9900,
    portfolioValue: 9900,
    dataQuality: 'complete',
  });
  insertStrategyPerformanceSnapshot(db, {
    runtimeSessionId: sessionId,
    accountSnapshotId: current.id,
    baselineAccountSnapshotId: baseline.id,
    snapshotAt: '2026-06-18T20:00:00.000Z',
    snapshotKind: 'eod',
    brokerEquityBaseline: 10000,
    brokerEquityCurrent: 9900,
    brokerAccountReturnPct: -0.01,
    spyBaselinePrice: 500,
    spyCurrentPrice: 505,
    spyReturnPct: 0.01,
    brokerAccountExcessReturnPct: -0.02,
    botGrossExposure: 0,
    botRealizedPnlUsd: -100,
    botOpenPositionCount: 0,
    botOrdersSubmitted: 10,
    botOrdersFilled: 10,
    dataQuality: 'complete',
  });
  return sessionId;
}

// --- arg parsing -----------------------------------------------------------

test('parseArgs defaults to a local dry run (no send)', () => {
  assert.deepEqual(parseArgs([]), {
    day: null, sessionId: null, send: false, testMessage: false, dryRun: false,
  });
});

test('parseArgs reads --day, --send-discord, --test-message, --dry-run', () => {
  const a = parseArgs(['--day', '2026-06-18', '--session-id', '7', '--send-discord']);
  assert.equal(a.day, '2026-06-18');
  assert.equal(a.sessionId, 7);
  assert.equal(a.send, true);
  assert.equal(parseArgs(['--test-message']).testMessage, true);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  // A malformed day is ignored (stays null → all-time).
  assert.equal(parseArgs(['--day', 'nope']).day, null);
});

// --- data collection -------------------------------------------------------

test('collectEodData aggregates paper_trades and rejected_trades (all-time)', () => {
  const db = freshDb();
  seedActivity(db);
  const data = collectEodData(db, { day: null });
  assert.equal(data.ordersSubmitted, 2);
  assert.equal(data.longCount, 2);
  assert.equal(data.shortCount, 0);
  assert.equal(data.fills, 1); // only AAPL had a fill price
  assert.equal(data.rejectedCount, 3);
  assert.equal(data.proposals, 5);
  // Recurring reason surfaces first.
  assert.equal(data.rejectionReasons[0].n, 2);
  assert.match(data.rejectionReasons[0].reason, /is not up/);
  closeDatabase(db);
});

test('collectEodData filters by trading day when given one', () => {
  const db = freshDb();
  // Insert two rows on different days via explicit created_at.
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at)
     VALUES ('AAPL','buy',1,'open','2026-06-18T20:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at)
     VALUES ('AAPL','buy',1,'open','2026-06-17T20:00:00.000Z')`
  ).run();
  assert.equal(collectEodData(db, { day: '2026-06-18' }).ordersSubmitted, 1);
  assert.equal(collectEodData(db, { day: null }).ordersSubmitted, 2);
  closeDatabase(db);
});

test('collectEodData can isolate one runtime session from same-day history', () => {
  const db = freshDb();
  const sessionId = Number(db.prepare(
    `INSERT INTO paper_runtime_sessions
       (session_date, started_at, ended_at, status, cycles)
     VALUES ('2026-06-18', '2026-06-18T14:00:00.000Z', '2026-06-18T15:00:00.000Z', 'closed', 1)`
  ).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at)
     VALUES ('AAPL','buy',1,'open','2026-06-18T14:30:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO paper_trades (ticker, side, quantity, status, created_at)
     VALUES ('MSFT','buy',1,'open','2026-06-18T18:30:00.000Z')`
  ).run();
  assert.equal(collectEodData(db, { day: '2026-06-18' }).ordersSubmitted, 2);
  const scoped = collectEodData(db, { day: '2026-06-18', sessionId });
  assert.equal(scoped.ordersSubmitted, 1);
  assert.equal(scoped.session.sessionId, sessionId);
  assert.equal(scoped.evidenceScope, `session:${sessionId}`);
  closeDatabase(db);
});

// --- report rendering ------------------------------------------------------

test('buildEodReport includes the required narrative sections and figures', () => {
  const db = freshDb();
  seedActivity(db);
  const text = buildEodReport(collectEodData(db, { day: null }), { day: '2026-06-18' }).join('\n');
  assert.match(text, /End-of-Day PAPER report \(2026-06-18\)/);
  assert.match(text, /PAPER trading only\. Live trading disabled\./);
  assert.match(text, /What the bot did/);
  assert.match(text, /Why it did it/);
  assert.match(text, /What went well/);
  assert.match(text, /What went poorly/);
  assert.match(text, /Mistakes \/ lessons/);
  assert.match(text, /Ideas for next trading day/);
  assert.match(text, /orders submitted:                2/);
  assert.match(text, /broker-confirmed fills:\s+unavailable/);
  assert.match(text, /Broker truth \/ benchmark \(PAPER\)/);
  assert.match(text, /rejected:                        3/);
  assert.ok(!text.includes('sparse qualifying signals (expected outside active hours)'));
  closeDatabase(db);
});

test('buildEodReport prints a safe placeholder when there is no activity', () => {
  const db = freshDb();
  const text = buildEodReport(collectEodData(db, { day: null }), {}).join('\n');
  assert.match(text, /No paper-trading records for this day yet/);
  assert.match(text, /proves Discord delivery/);
  assert.match(text, /Broker-truth snapshot: unavailable/);
  closeDatabase(db);
});

test('buildEodReport renders persisted broker-truth performance and SPY benchmark values', () => {
  const db = freshDb();
  seedActivity(db);
  insertStrategyPerformanceSnapshot(db, {
    snapshotAt: '2026-06-18T20:00:00.000Z',
    snapshotKind: 'eod',
    brokerEquityBaseline: 10000,
    brokerEquityCurrent: 10100,
    brokerAccountReturnPct: 0.01,
    spyBaselinePrice: 500,
    spyBaselineTargetAt: '2026-06-18T14:00:00.000Z',
    spyBaselineSource: 'alpaca_iex.historical_trades',
    spyBaselineAlignmentStatus: 'exact_target',
    spyCurrentPrice: 502.5,
    spyCurrentTargetAt: '2026-06-18T20:00:00.000Z',
    spyCurrentSource: 'alpaca_iex.latest_trade',
    spyCurrentAlignmentStatus: 'latest_at_or_before_target',
    spyReturnPct: 0.005,
    brokerAccountExcessReturnPct: 0.005,
    botGrossExposure: 201.5,
    botRealizedPnlUsd: 12.25,
    botOpenPositionCount: 1,
    botOrdersSubmitted: 2,
    botOrdersFilled: 1,
    botOrdersOpen: 1,
    dataQuality: 'complete',
  });
  const text = buildEodReport(collectEodData(db, { day: null }), { day: '2026-06-18' }).join('\n');
  assert.match(text, /submitted vs fills:\s+2 submitted \/ 1 broker-confirmed fill/);
  assert.match(text, /owned gross exposure:\s+\$201\.50/);
  assert.match(text, /broker-confirmed owned P&L:\s+\$12\.25/);
  assert.match(text, /broker account return:\s+1\.00%/);
  assert.match(text, /owned return:\s+unavailable/);
  assert.match(text, /SPY session return:\s+0\.50%/);
  assert.match(text, /account excess vs SPY:\s+0\.50%/);
  assert.match(text, /SPY baseline source:\s+alpaca_iex\.historical_trades/);
  assert.match(text, /SPY current source:\s+alpaca_iex\.latest_trade/);
  assert.match(text, /SPY current alignment:.*status=latest_at_or_before_target/);
  closeDatabase(db);
});

test('buildEodReport keeps missing broker exposure and benchmark values unavailable', () => {
  const db = freshDb();
  seedActivity(db);
  insertStrategyPerformanceSnapshot(db, {
    snapshotAt: '2026-06-18T20:00:00.000Z',
    snapshotKind: 'eod',
    brokerEquityBaseline: 10000,
    brokerEquityCurrent: 10050,
    brokerAccountReturnPct: 0.005,
    spyBaselinePrice: null,
    spyCurrentPrice: null,
    spyReturnPct: null,
    brokerAccountExcessReturnPct: null,
    botGrossExposure: null,
    botRealizedPnlUsd: null,
    botOpenPositionCount: 0,
    botOrdersSubmitted: 2,
    botOrdersFilled: 1,
    dataQuality: 'limited',
    warnings: ['positions unavailable: positions offline', 'SPY benchmark unavailable at baseline/current timestamp'],
  });
  const text = buildEodReport(collectEodData(db, { day: null }), { day: '2026-06-18' }).join('\n');
  assert.match(text, /owned gross exposure:\s+unavailable/);
  assert.match(text, /broker-confirmed owned P&L:\s+unavailable/);
  assert.match(text, /SPY session return:\s+unavailable/);
  assert.match(text, /account excess vs SPY:\s+unavailable/);
  assert.match(text, /positions unavailable: positions offline/);
  assert.match(text, /SPY benchmark unavailable at baseline\/current timestamp/);
  closeDatabase(db);
});

test('buildEodReport renders equity sizing decisions and cold-start warnings', () => {
  const db = freshDb();
  seedActivity(db);
  insertEquitySizingDecision(db, {
    ticker: 'AAPL',
    side: 'buy',
    sizingMode: 'cold_start',
    evidenceTier: 'none',
    evidenceCount: 0,
    evidenceQuality: 'limited',
    requestedTargetWeight: 0.0075,
    requestedNotional: 500,
    requestedQuantity: 5,
    approvedTargetWeight: 0.005,
    approvedNotional: 500,
    approvedQuantity: 5,
    referencePrice: 100,
    accountEquity: 100000,
    currentOwnedExposure: 0,
    riskApproved: true,
    riskReason: 'approved: notional 500 within all caps',
    explanation: 'cold-start sizing: no comparable broker-confirmed outcomes yet',
    warnings: ['cold-start allocation used'],
    effectiveRiskCaps: {
      orderCap: {
        source: 'learned_max_weight_no_explicit_dollar_cap',
        value: 1000,
        learnedPercentCap: 1000,
        explicitDollarCap: null,
      },
      activeCaps: [
        {
          key: 'maxOrderNotional',
          source: 'learned_max_weight_no_explicit_dollar_cap',
          value: 1000,
          remainingNotional: 1000,
          allowedQuantity: 10,
          clamped: false,
        },
      ],
      clampReasons: [],
    },
  });
  const text = buildEodReport(collectEodData(db, { day: null }), { day: '2026-06-18' }).join('\n');
  assert.match(text, /Equity sizing decisions \(PAPER equities only\)/);
  assert.match(text, /cold\/evidence\/abstain:\s+1 \/ 0 \/ 0/);
  assert.match(text, /AAPL buy cold_start/);
  assert.match(text, /requested=5 \(\$500\.00, 0\.75%\)/);
  assert.match(text, /effective order cap: source=learned_max_weight_no_explicit_dollar_cap value=\$1000\.00/);
  assert.match(text, /cap maxOrderNotional: source=learned_max_weight_no_explicit_dollar_cap value=\$1000\.00/);
  assert.match(text, /cold-start allocation used/);
  closeDatabase(db);
});

test('buildEodReport renders sanitized sizing fixture variants truthfully', () => {
  const db = freshDb();
  seedActivity(db);
  insertEquitySizingDecision(db, {
    ticker: 'AAPL',
    side: 'buy',
    sizingMode: 'cold_start',
    evidenceTier: 'none',
    evidenceCount: 0,
    evidenceQuality: 'limited',
    requestedTargetWeight: 0.0075,
    requestedNotional: 500,
    requestedQuantity: 5,
    approvedTargetWeight: 0.005,
    approvedNotional: 500,
    approvedQuantity: 5,
    riskApproved: true,
    riskReason: 'approved: notional 500 within all caps',
    explanation: 'cold-start sizing: no comparable broker-confirmed outcomes yet',
    warnings: ['cold-start allocation used'],
  });
  insertEquitySizingDecision(db, {
    ticker: 'MSFT',
    side: 'buy',
    sizingMode: 'evidence_weighted',
    evidenceTier: 'news_type_direction_score',
    evidenceCount: 12,
    evidenceQuality: 'sufficient',
    requestedTargetWeight: 0.01,
    requestedNotional: 1000,
    requestedQuantity: 10,
    approvedTargetWeight: 0.005,
    approvedNotional: 500,
    approvedQuantity: 5,
    riskApproved: true,
    riskReason: 'approved: notional 500 within all caps',
    explanation: 'evidence-weighted sizing from 12 broker-confirmed outcomes',
    warnings: ['learned equity quantity 10 clamped to 5 by deterministic risk caps'],
  });
  insertEquitySizingDecision(db, {
    ticker: 'TSLA',
    side: 'buy',
    sizingMode: 'abstain',
    evidenceTier: 'direction_score',
    evidenceCount: 3,
    evidenceQuality: 'limited',
    requestedQuantity: 0,
    approvedQuantity: 0,
    riskApproved: false,
    riskReason: 'abstain: sparse comparable direction_score outcomes are losing or uncertain',
    explanation: 'abstain: sparse comparable direction_score outcomes are losing or uncertain',
    warnings: ['insufficient/negative comparable evidence'],
  });
  insertEquitySizingDecision(db, {
    ticker: 'NVDA',
    side: 'buy',
    manualOverride: true,
    sizingMode: 'abstain',
    evidenceTier: 'manual_override',
    evidenceCount: 0,
    evidenceQuality: 'manual_override',
    requestedTargetWeight: 0.002,
    requestedNotional: 200,
    requestedQuantity: 2,
    approvedTargetWeight: 0.002,
    approvedNotional: 200,
    approvedQuantity: 2,
    riskApproved: true,
    riskReason: 'approved: notional 200 within all caps',
    explanation: 'manual --qty override: learned sizing not applied',
    warnings: ['manual --qty override bypassed learned equity sizing'],
  });
  insertEquitySizingDecision(db, {
    ticker: 'AMZN',
    side: 'buy',
    sizingMode: 'abstain',
    evidenceTier: 'none',
    evidenceCount: 0,
    evidenceQuality: 'none',
    requestedQuantity: 0,
    approvedQuantity: 0,
    riskApproved: false,
    riskReason: 'abstain: valid reference price unavailable for learned equity sizing',
    explanation: 'abstain: valid reference price unavailable for learned equity sizing',
    warnings: ['missing reference price blocked learned sizing'],
  });

  const text = buildEodReport(collectEodData(db, { day: null }), { day: '2026-06-18' }).join('\n');
  assert.match(text, /cold\/evidence\/abstain:\s+1 \/ 1 \/ 3/);
  assert.match(text, /manual --qty override:\s+1/);
  assert.match(text, /AAPL buy cold_start .*requested=5 \(\$500\.00, 0\.75%\).*approved=5 \(\$500\.00, 0\.50%\)/);
  assert.match(text, /MSFT buy evidence_weighted .*requested=10 \(\$1000\.00, 1\.00%\).*approved=5 \(\$500\.00, 0\.50%\)/);
  assert.match(text, /TSLA buy abstain .*requested=0 \(unavailable, unavailable\).*approved=0 \(unavailable, unavailable\)/);
  assert.match(text, /NVDA buy manual_override .*requested=2 \(\$200\.00, 0\.20%\).*approved=2 \(\$200\.00, 0\.20%\)/);
  assert.match(text, /AMZN buy abstain .*reference price unavailable/);
  assert.match(text, /learned equity quantity 10 clamped to 5 by deterministic risk caps/);
  assert.match(text, /manual --qty override bypassed learned equity sizing/);
  assert.doesNotMatch(text, /RAW-MODEL-RESPONSE|SECRET-HEADLINE|api[_-]?key|request object/i);
  closeDatabase(db);
});

test('an empty day still renders a delivery-proving no-trade report', () => {
  const db = freshDb();
  const empty = buildEodReport(collectEodData(db, { day: null }), {}).join('\n');
  assert.match(empty, /No paper-trading records for this day yet/);
  assert.match(empty, /PAPER trading only\. Live trading disabled\./);
  closeDatabase(db);
});

// --- send vs dry run -------------------------------------------------------

test('runEodReport dry run builds the report and sends nothing', async () => {
  const db = freshDb();
  seedActivity(db);
  const discord = fakeDiscord();
  const result = await runEodReport(db, { day: null, send: false, discordClient: discord });
  assert.equal(result.sent, false);
  assert.equal(discord.sent.length, 0);
  assert.ok(result.content.includes('End-of-Day PAPER report'));
  closeDatabase(db);
});

test('runEodReport with send posts the full report through the Discord client', async () => {
  const db = freshDb();
  seedActivity(db);
  const discord = fakeDiscord();
  const result = await runEodReport(db, { day: null, send: true, discordClient: discord });
  assert.equal(result.sent, true);
  assert.equal(discord.sent.length, 1);
  assert.ok(discord.sent[0].includes('End-of-Day PAPER report'));
  closeDatabase(db);
});

test('runEodReport --test-message sends only the short test string', async () => {
  const db = freshDb();
  const discord = fakeDiscord();
  const result = await runEodReport(db, { testMessage: true, discordClient: discord });
  assert.equal(result.sent, true);
  assert.equal(discord.sent[0], EOD_TEST_MESSAGE);
  closeDatabase(db);
});

test('runEodReport refuses to send without a configured Discord client', async () => {
  const db = freshDb();
  await assert.rejects(() => runEodReport(db, { send: true, discordClient: null }), /not configured/);
  closeDatabase(db);
});

// --- sanitization & no-network ---------------------------------------------

test('the report never leaks raw model responses or headlines', async () => {
  const db = freshDb();
  // Seed a sentiment score with a raw response + a news headline; the EOD report
  // must never surface either (it does not join those tables).
  db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t','e1','AAPL','SECRET-HEADLINE-MUST-NOT-PRINT','2026-06-18T14:00:00.000Z','2026-06-18T14:00:00.000Z','other')`
  ).run();
  db.prepare(
    `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parse_ok, parser_status)
     VALUES (1,'m','model_v1','RAW-MODEL-RESPONSE-MUST-NOT-PRINT',1,'parsed')`
  ).run();
  seedActivity(db);
  const result = await runEodReport(db, { day: null, send: false });
  assert.ok(!result.content.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  assert.ok(!result.content.includes('RAW-MODEL-RESPONSE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('the full path runs with zero real network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted in EOD report test');
  };
  try {
    const db = freshDb();
    seedActivity(db);
    await runEodReport(db, { day: null, send: false });
    await runEodReport(db, { day: null, send: true, discordClient: fakeDiscord() });
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- data quality ------------------------------------------------------------

test('duplicate event replay is flagged as limited data quality', async () => {
  const db = freshDb();
  const sessionId = Number(db.prepare(
    `INSERT INTO paper_runtime_sessions
       (session_date, started_at, ended_at, status, cycles)
     VALUES ('2026-06-18', '2026-06-18T13:30:00.000Z', '2026-06-18T20:00:00.000Z', 'closed', 3)`
  ).run().lastInsertRowid);
  const eventId = insertEvent(db, 'dup');
  for (let i = 0; i < 3; i += 1) {
    const rejection = insertRejectedTrade(db, {
      newsEventId: eventId,
      ticker: 'AAPL',
      side: 'buy',
      quantity: 1,
      reason: 'confidence 0.2 below threshold 0.6',
    });
    db.prepare('UPDATE rejected_trades SET created_at = ? WHERE id = ?')
      .run(`2026-06-18T14:0${i}:00.000Z`, rejection.id);
  }
  const r = await runEodReport(db, { day: '2026-06-18', sessionId });
  assert.equal(r.dataQuality.status, 'limited');
  assert.match(r.content, /duplicate\/stale event replay/);
  closeDatabase(db);
});

test('the report adds no secrets/raw content', async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO news_events (provider, provider_event_id, ticker, headline, published_at, received_at, news_type)
     VALUES ('t','e1','AAPL','SECRET-HEADLINE-MUST-NOT-PRINT','2026-06-18T14:00:00.000Z','2026-06-18T14:00:00.000Z','other')`
  ).run();
  db.prepare(
    `INSERT INTO sentiment_scores (news_event_id, model, prompt_version, raw_response, parse_ok, parser_status)
     VALUES (1,'m','model_v1','RAW-MODEL-RESPONSE-MUST-NOT-PRINT',1,'parsed')`
  ).run();
  seedActivity(db);
  const r = await runEodReport(db, { day: null });
  assert.ok(!r.content.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  assert.ok(!r.content.includes('RAW-MODEL-RESPONSE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runEodReport, 'function');
  assert.equal(typeof collectEodData, 'function');
  assert.equal(typeof buildEodReport, 'function');
});
