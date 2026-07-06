// tests/runPaperTradingOnce.test.js — Network-free tests for the one-shot
// PAPER path (long/short equity + margin risk). Importing the script runs
// NOTHING (CLI guard). The core is driven with injected account/capabilities/
// positions/referencePrice + a FAKE paper client, so everything is offline.
// A fetch stub proves zero real network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { deriveCapabilities } from '../src/paper/accountCapabilities.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import {
  parseArgs,
  listRecentScoredEvents,
  selectRecentScoredEvent,
  runPaperDecisionCycle,
  runPaperTradeOnce,
  buildPaperReport,
  getDailyCounters,
  oneLineSummary,
  oneLineDecisionSummary,
  paperDefaultsFromStrategySettings,
  DEFAULT_PAPER_FEATURES,
  PAPER_DECISION_OUTCOMES,
  MAX_QTY,
} from '../scripts/runPaperTradingOnce.js';

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)`;
const INSERT_SCORE_SQL = `
  INSERT INTO sentiment_scores (news_event_id, model, prompt_version,
    sentiment_score, news_type, confidence, raw_response, parse_ok,
    parser_status, impact_score, direction, time_horizon, detail)
  VALUES (@news_event_id, @model, @prompt_version, @sentiment_score, @news_type,
    @confidence, @raw_response, @parse_ok, @parser_status, @impact_score,
    @direction, @time_horizon, @detail)`;

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

function seedScoredEvent(db, {
  ticker = 'AAPL', direction = 'up', sentiment = 0.7, impact = 0.8, confidence = 0.9,
  parserStatus = 'parsed', promptVersion = 'model_v1', rawResponse = 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
} = {}) {
  const ev = db.prepare(INSERT_EVENT_SQL).run({
    provider: 'test', provider_event_id: `evt-${ticker}-${direction}-${sentiment}`, ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT', published_at: '2026-06-18T14:00:00.000Z',
    received_at: '2026-06-18T14:00:00.000Z', news_type: 'earnings',
  });
  const eventId = Number(ev.lastInsertRowid);
  db.prepare(INSERT_SCORE_SQL).run({
    news_event_id: eventId, model: 'claude-opus-4-8', prompt_version: promptVersion,
    sentiment_score: sentiment, news_type: 'earnings', confidence,
    raw_response: rawResponse, parse_ok: 1, parser_status: parserStatus,
    impact_score: impact, direction, time_horizon: 'intraday',
    detail: JSON.stringify({ affected_symbols: [ticker], rationale: 'SECRET-RATIONALE', errors: [] }),
  });
  return eventId;
}

function marginAccount(over = {}) {
  return {
    id: 'a1', status: 'ACTIVE', equity: 30000, cash: 10000, buyingPower: 60000, multiplier: 2,
    portfolioValue: 30000, patternDayTrader: false, tradingBlocked: false, accountBlocked: false,
    optionsTradingLevel: 2, optionsApprovedLevel: 2, ...over,
  };
}
const cashAccount = (over = {}) => marginAccount({ multiplier: 1, optionsTradingLevel: null, optionsApprovedLevel: null, ...over });

function shortableAsset(over = {}) {
  return { symbol: 'AAPL', status: 'active', tradable: true, shortable: true, easyToBorrow: true, ...over };
}

function fakePaperClient({ asset = shortableAsset() } = {}) {
  const calls = { equity: [], asset: [] };
  return {
    calls,
    getAccount: async () => marginAccount({ equity: 100000, portfolioValue: 100000, cash: 50000, buyingPower: 100000 }),
    getPositions: async () => [],
    getAsset: async (symbol) => { calls.asset.push(symbol); return asset; },
    getOrder: async (id) => { (calls.getOrder ??= []).push(id); return { id, status: 'filled', submittedAt: '2026-06-18T14:30:02.000Z', filledAvgPrice: 2.1 }; },
    cancelOrder: async (id) => { (calls.cancel ??= []).push(id); return { ok: true, status: 204 }; },
    submitMarketOrder: async (o) => { calls.equity.push(o); return { id: 'ord_eq', status: 'accepted', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: null }; },
  };
}

function throwingPaperClient(message = 'sanitized submit failure') {
  const client = fakePaperClient();
  client.submitMarketOrder = async (o) => {
    client.calls.equity.push(o);
    throw new Error(message);
  };
  return client;
}

function fakePriceSource(price = 200) {
  return {
    name: 'fake-price',
    getTradesAround: async () => [{ price, at: '2026-06-18T14:15:00.000Z', size: 1 }],
  };
}

function rawNews(id, over = {}) {
  return {
    id,
    symbols: ['AAPL'],
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    created_at: '2026-06-18T14:00:00.000Z',
    received_at: '2026-06-18T14:00:01.000Z',
    type: 'earnings',
    ...over,
  };
}

function realModelClassifier({ direction = 'up', sentiment = 0.3, impact = 0.4, confidence = 0.6, parserStatus = 'parsed', onClassify = null } = {}) {
  return {
    name: 'model',
    modelName: 'claude-opus-4-8',
    promptVersion: 'model_v1',
    classifyEvent: async (event) => {
      if (onClassify) await onClassify(event);
      if (parserStatus !== 'parsed') {
        return {
          promptVersion: 'model_v1',
          modelName: 'claude-opus-4-8',
          parserStatus,
          output: null,
          rawModelResponse: '',
          errors: ['test classifier failure'],
        };
      }
      return {
        promptVersion: 'model_v1',
        modelName: 'claude-opus-4-8',
        parserStatus: 'parsed',
        output: {
          newsType: 'earnings',
          sentimentScore: sentiment,
          impactScore: impact,
          confidence,
          direction,
          timeHorizon: 'intraday',
          affectedSymbols: ['AAPL'],
          rationale: 'SECRET-RATIONALE-MUST-NOT-PRINT',
        },
        rawModelResponse: 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
        errors: [],
      };
    },
  };
}

const ALL_PAPER_FEATURES = { enableShorts: true, enableMargin: true };

// --- arg parsing -----------------------------------------------------------

test('parseArgs defaults are conservative, dry-run, no shorts', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.symbols, ['AAPL']);
  assert.equal(a.qtyExplicit, false);
  assert.equal(a.executePaper, false);
  assert.equal(a.allowShorts, false);
  assert.deepEqual(a.paperFeatures, DEFAULT_PAPER_FEATURES);
});

test('parseArgs reads advanced flags + caps and clamps qty', () => {
  const a = parseArgs([
    '--symbols', 'aapl,msft', '--qty', '99999', '--allow-shorts',
    '--max-order-notional', '500', '--max-gross-exposure', '5000', '--execute-paper',
  ]);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.qty, MAX_QTY);
  assert.equal(a.qtyExplicit, true);
  assert.equal(a.allowShorts, true);
  assert.equal(a.caps.maxOrderNotional, 500);
  assert.equal(a.caps.maxGrossExposure, 5000);
  assert.equal(a.executePaper, true);
});

// --- selection -------------------------------------------------------------

test('selectRecentScoredEvent picks the most recent model_v1 score in allowed symbols', () => {
  const db = freshDb();
  seedScoredEvent(db, { ticker: 'AAPL' });
  const newest = seedScoredEvent(db, { ticker: 'AAPL', sentiment: 0.6 });
  seedScoredEvent(db, { ticker: 'TSLA' });
  const sel = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  assert.equal(sel.event.id, newest);
  assert.ok(!Object.prototype.hasOwnProperty.call(sel.score, 'raw_response'));
  closeDatabase(db);
});

test('default selection excludes already rejected/traded events; explicit event id overrides', () => {
  const db = freshDb();
  const oldId = seedScoredEvent(db, { ticker: 'AAPL', sentiment: 0.25 });
  const processedId = seedScoredEvent(db, { ticker: 'AAPL', sentiment: 0.3 });
  db.prepare(
    `INSERT INTO rejected_trades (news_event_id, ticker, side, quantity, reason)
     VALUES (?, 'AAPL', 'buy', 1, 'impact 0.1 below threshold 0.35')`
  ).run(processedId);

  const defaultSel = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  assert.equal(defaultSel.event.id, oldId);

  const explicit = selectRecentScoredEvent(db, { eventId: processedId, allowedSymbols: ['AAPL'] });
  assert.equal(explicit.event.id, processedId);

  const list = listRecentScoredEvents(db, { allowedSymbols: ['AAPL'], excludeProcessed: false });
  assert.deepEqual(list.map((s) => s.event.id), [processedId, oldId]);
  closeDatabase(db);
});

test('paperDefaultsFromStrategySettings maps non-secret runtime settings into CLI defaults', () => {
  const defaults = paperDefaultsFromStrategySettings({
    symbols: ['msft', 'aapl', 'aapl'],
    allow_shorts: true,
    confidence_threshold: 0.52,
    impact_threshold: 0.33,
    sentiment_threshold: 0.18,
    max_order_notional: 250,
    sizing_cold_start_target_weight: 0.006,
  });
  const args = parseArgs(['--impact-threshold', '0.4'], defaults);
  assert.deepEqual(args.symbols, ['MSFT', 'AAPL']);
  assert.equal(args.allowShorts, true);
  assert.equal(args.thresholds.minConfidence, 0.52);
  assert.equal(args.thresholds.minImpact, 0.4); // CLI wins over settings default
  assert.equal(args.thresholds.minSentiment, 0.18);
  assert.equal(args.caps.maxOrderNotional, 250);
  assert.equal(args.sizingSettings.sizing_cold_start_target_weight, 0.006);
  assert.equal(args.executePaper, false); // settings cannot enable execution
});

// --- equity long: dry run vs execute ---------------------------------------

test('equity long DRY RUN with manual qty override accepts and sends no order', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const result = await runPaperTradeOnce(db, selected, { paperClient: client, allowedSymbols: ['AAPL'], qtyExplicit: true, executePaper: false });
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.manualQtyOverride, true);
  assert.equal(result.equity.proposal.side, 'buy');
  assert.equal(client.calls.equity.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rejected_trades').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_equity_sizing_decisions').get().n, 1);
  closeDatabase(db);
});

test('equity long without manual qty rejects when learned sizing lacks broker equity and price', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, { allowedSymbols: ['AAPL'], executePaper: false });
  assert.equal(result.equity.decision, 'rejected');
  assert.equal(result.equity.sizingDecision.mode, 'abstain');
  assert.match(result.equity.proposal.reason, /learned equity sizing rejected/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rejected_trades').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_equity_sizing_decisions').get().n, 1);
  closeDatabase(db);
});

test('equity long EXECUTE submits a buy and writes paper_trades (margin account, price within caps)', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    paperClient: client, allowedSymbols: ['AAPL'], executePaper: true,
    account, capabilities: deriveCapabilities(account), referencePrice: 200, qty: 1, qtyExplicit: true,
  });
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.risk.approved, true);
  assert.deepEqual(client.calls.equity[0], { symbol: 'AAPL', qty: 1, side: 'buy' });
  assert.ok(result.equity.paperTradeId > 0);
  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(result.equity.paperTradeId);
  assert.equal(row.broker_order_id, 'ord_eq');
  assert.equal(row.broker_order_status, 'accepted');
  assert.equal(row.broker_truth_state, 'pending');
  assert.equal(row.fill_price, null);
  const sizing = db.prepare('SELECT * FROM paper_equity_sizing_decisions WHERE paper_trade_id = ?').get(result.equity.paperTradeId);
  assert.equal(sizing.manual_override, 1);
  assert.equal(sizing.approved_quantity, 1);
  closeDatabase(db);
});

test('equity long EXECUTE defaults to learned cold-start target sizing when --qty is absent', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount({ equity: 100000, portfolioValue: 100000, cash: 50000, buyingPower: 100000 });
  const result = await runPaperTradeOnce(db, selected, {
    paperClient: client, allowedSymbols: ['AAPL'], executePaper: true,
    account, capabilities: deriveCapabilities(account), referencePrice: 100,
    caps: { maxOrderNotional: 500 },
    sizingSettings: {
      sizing_enable_confidence_scaling: false,
      sizing_enable_impact_scaling: false,
    },
  });
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.sizingDecision.mode, 'cold_start');
  assert.equal(result.equity.sizingDecision.requestedTargetWeight, 0.0075);
  assert.equal(result.equity.sizingDecision.requestedQuantity, 7);
  assert.equal(result.equity.risk.approved, true);
  assert.deepEqual(client.calls.equity[0], { symbol: 'AAPL', qty: 5, side: 'buy' });
  const sizing = db.prepare('SELECT * FROM paper_equity_sizing_decisions WHERE paper_trade_id = ?').get(result.equity.paperTradeId);
  assert.equal(sizing.manual_override, 0);
  assert.equal(sizing.sizing_mode, 'cold_start');
  assert.equal(sizing.requested_quantity, 7);
  assert.equal(sizing.requested_notional, 700);
  assert.equal(sizing.approved_quantity, 5);
  assert.equal(sizing.approved_notional, 500);
  assert.match(sizing.warnings_json, /clamped to 5 by deterministic risk caps/);
  closeDatabase(db);
});

test('learned MSFT target is not reduced to one share by implicit fixed-dollar order cap', async () => {
  const db = freshDb();
  seedScoredEvent(db, {
    ticker: 'MSFT',
    direction: 'up',
    confidence: 0.6,
    impact: 0.4666666667,
    sentiment: 0.7,
  });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['MSFT'] });
  const client = fakePaperClient();
  const account = marginAccount({
    equity: 1_000_000,
    portfolioValue: 1_000_000,
    cash: 1_000_000,
    buyingPower: 1_000_000,
  });
  const result = await runPaperTradeOnce(db, selected, {
    paperClient: client,
    allowedSymbols: ['MSFT'],
    executePaper: true,
    account,
    capabilities: deriveCapabilities(account),
    referencePrice: 371.35,
    caps: {
      maxSymbolExposure: 1_000_000,
      maxGrossExposure: 1_000_000,
      maxDailyPaperNotional: 1_000_000,
    },
  });

  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.sizingDecision.requestedTargetWeight, 0.0044);
  assert.equal(result.equity.sizingDecision.requestedQuantity, 11);
  assert.equal(result.equity.proposal.quantity, 11);
  assert.deepEqual(client.calls.equity[0], { symbol: 'MSFT', qty: 11, side: 'buy' });

  const sizing = db.prepare('SELECT * FROM paper_equity_sizing_decisions WHERE paper_trade_id = ?').get(result.equity.paperTradeId);
  const capReport = JSON.parse(sizing.effective_risk_caps_json);
  assert.equal(sizing.requested_quantity, 11);
  assert.equal(sizing.approved_quantity, 11);
  assert.equal(capReport.orderCap.value, 10000);
  assert.equal(capReport.orderCap.source, 'learned_max_weight_no_explicit_dollar_cap');
  assert.equal(capReport.activeCaps.find((c) => c.key === 'maxOrderNotional').clamped, false);
  assert.doesNotMatch(sizing.warnings_json, /clamped to 1/);

  const reportText = buildPaperReport(result, selected).join('\n');
  assert.match(reportText, /requested:\s+qty=11 notional=\$4084\.85 weight=0\.44%/);
  assert.match(reportText, /approved:\s+qty=11 notional=\$4084\.85 weight=0\.41%/);
  assert.match(reportText, /order cap: source=learned_max_weight_no_explicit_dollar_cap value=\$10000\.00/);
  closeDatabase(db);
});

// --- fresh decision cycle orchestration -----------------------------------

test('fresh ingest/classify/trade cycle reaches the fake PAPER submit client', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      provider: createMockProvider([rawNews('fresh-pass')]),
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(200),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );

  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.TRADE_ATTEMPTED);
  assert.equal(cycle.ingestion.inserted, 1);
  assert.equal(cycle.classification.stored, 1);
  assert.equal(client.calls.equity.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
  const hb = oneLineDecisionSummary(cycle, Date.parse('2026-06-18T14:30:00.000Z'));
  assert.match(hb, /event=\d+ AAPL age=30m/);
  assert.ok(!hb.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('fresh score below a default threshold is logged as a rejection', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      provider: createMockProvider([rawNews('fresh-low-impact')]),
      classifier: realModelClassifier({ impact: 0.1 }),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );

  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.ALL_FRESH_SCORES_FAILED_SIGNAL_THRESHOLDS);
  assert.match(cycle.skipReason, /failed signal thresholds/);
  const row = db.prepare('SELECT reason FROM rejected_trades').get();
  assert.match(row.reason, /impact 0.1 below threshold 0.35/);
  closeDatabase(db);
});

test('decision cycle distinguishes no new news', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  const cycle = await runPaperDecisionCycle(
    db,
    { provider: createMockProvider([]), classifier: realModelClassifier() },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.NO_NEW_NEWS);
  assert.match(cycle.skipReason, /no new news/);
  closeDatabase(db);
});

test('decision cycle distinguishes no fresh real-model score', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL']); // no model classifier requested
  const cycle = await runPaperDecisionCycle(
    db,
    { provider: createMockProvider([rawNews('fresh-no-model')]), classifier: null },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE);
  assert.match(cycle.skipReason, /model classifier/);
  closeDatabase(db);
});

test('decision cycle distinguishes already processed fresh scored events', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  const classifier = realModelClassifier({
    onClassify: async (event) => {
      db.prepare(
        `INSERT INTO rejected_trades (news_event_id, ticker, side, quantity, reason)
         VALUES (?, ?, 'buy', 1, 'already tested')`
      ).run(event.id, event.ticker);
    },
  });
  const cycle = await runPaperDecisionCycle(
    db,
    { provider: createMockProvider([rawNews('fresh-processed')]), classifier },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.ALREADY_PROCESSED_EVENT);
  assert.match(cycle.skipReason, /already have paper_trades or rejected_trades/);
  closeDatabase(db);
});

test('decision cycle distinguishes risk rejection from signal rejection', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      provider: createMockProvider([rawNews('fresh-risk')]),
      classifier: realModelClassifier(),
      paperClient: fakePaperClient(),
      priceSource: null, // execute mode cannot verify notional without a reference price
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.RISK_REJECTION);
  assert.equal(cycle.trade.result.equity.sizingDecision.mode, 'abstain');
  assert.equal(cycle.trade.result.equity.risk, null);
  assert.match(cycle.trade.result.equity.proposal.reason, /reference price unavailable/);
  closeDatabase(db);
});

test('decision cycle distinguishes broker submission errors', async () => {
  const db = freshDb();
  const client = throwingPaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      provider: createMockProvider([rawNews('fresh-broker')]),
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(200),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.BROKER_SUBMISSION_ERROR);
  assert.equal(client.calls.equity.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  const sizing = db.prepare('SELECT * FROM paper_equity_sizing_decisions').get();
  assert.equal(sizing.risk_approved, 0);
  assert.equal(sizing.approved_quantity, 0);
  assert.match(sizing.risk_reason, /sanitized submit failure/);
  closeDatabase(db);
});

test('explicit --event-id override deliberately retests a processed scored event', async () => {
  const db = freshDb();
  const eventId = seedScoredEvent(db, { direction: 'up', impact: 0.4, sentiment: 0.3, confidence: 0.6 });
  db.prepare(
    `INSERT INTO rejected_trades (news_event_id, ticker, side, quantity, reason)
     VALUES (?, 'AAPL', 'buy', 1, 'prior rejection')`
  ).run(eventId);
  const args = parseArgs(['--symbols', 'AAPL', '--event-id', String(eventId), '--qty', '1']);
  const cycle = await runPaperDecisionCycle(db, {}, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.TRADE_ATTEMPTED);
  assert.equal(cycle.selected.event.id, eventId);
  assert.equal(cycle.trade.result.equity.decision, 'accepted');
  closeDatabase(db);
});

// --- equity short ----------------------------------------------------------

test('equity short EXECUTE requires allowShorts + a short-eligible margin account', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'down', sentiment: -0.7 });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    paperClient: client, allowedSymbols: ['AAPL'], allowShorts: true, executePaper: true,
    account, capabilities: deriveCapabilities(account), referencePrice: 100, qty: 1,
    paperFeatures: ALL_PAPER_FEATURES,
  });
  assert.equal(result.equity.proposal.side, 'sell');
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(client.calls.equity[0].side, 'sell');
  closeDatabase(db);
});

test('short is rejected on a cash account (not margin/short eligible) and logged', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'down', sentiment: -0.7 });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = cashAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowShorts: true, executePaper: true,
    account, capabilities: deriveCapabilities(account), referencePrice: 100, paperClient: fakePaperClient(),
    paperFeatures: ALL_PAPER_FEATURES,
  });
  assert.equal(result.equity.decision, 'rejected');
  assert.match(result.equity.risk.reason, /margin\/short eligible/);
  assert.ok(result.equity.rejectedTradeId > 0);
  closeDatabase(db);
});

test('short without --allow-shorts is rejected at the proposal gate', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'down', sentiment: -0.7 });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, { allowedSymbols: ['AAPL'], allowShorts: false });
  assert.equal(result.equity.decision, 'rejected');
  assert.match(result.equity.proposal.reason, /requires --allow-shorts/);
  closeDatabase(db);
});

test('short with CLI flag is still rejected when PAPER_ENABLE_SHORTS=false', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'down', sentiment: -0.7 });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'],
    allowShorts: true,
    paperFeatures: { enableShorts: false, enableMargin: false },
  });
  assert.equal(result.equity.decision, 'rejected');
  assert.match(result.equity.proposal.reason, /PAPER_ENABLE_SHORTS=false/);
  assert.ok(result.equity.rejectedTradeId > 0);
  closeDatabase(db);
});

// --- margin caps -----------------------------------------------------------

test('an order exceeding --max-order-notional is rejected', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], executePaper: true, paperClient: fakePaperClient(),
    account, capabilities: deriveCapabilities(account), referencePrice: 1000, qty: 1, qtyExplicit: true,
    caps: { maxOrderNotional: 500 },
  });
  assert.equal(result.equity.decision, 'rejected');
  assert.match(result.equity.risk.reason, /max-order-notional/);
  closeDatabase(db);
});

// --- reports / counters / no-network ---------------------------------------

test('getDailyCounters counts today and sums notional', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO paper_trades (ticker, side, quantity, fill_price, status, created_at) VALUES ('AAPL','buy',2,100,'open','2026-06-18T20:00:00.000Z')`).run();
  db.prepare(`INSERT INTO paper_trades (ticker, side, quantity, fill_price, status, created_at) VALUES ('AAPL','buy',1,50,'open','2026-06-17T20:00:00.000Z')`).run();
  const d = getDailyCounters(db, '2026-06-18');
  assert.equal(d.orders, 1);
  assert.equal(d.notional, 200);
  closeDatabase(db);
});

test('buildPaperReport is sanitized (no raw response/headline/rationale)', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'],
    account, capabilities: deriveCapabilities(account), referencePrice: 200,
    paperFeatures: ALL_PAPER_FEATURES,
  });
  const text = buildPaperReport(result, selected).join('\n');
  assert.match(text, /PAPER-only — live trading disabled/);
  assert.match(text, /equity:/);
  assert.ok(!text.includes('RAW-MODEL-RESPONSE-MUST-NOT-PRINT'));
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  assert.ok(!text.includes('SECRET-RATIONALE'));
  assert.match(oneLineSummary(result), /equity buy/);
  closeDatabase(db);
});

test('the full path runs with zero real network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error('network attempted'); };
  try {
    const db = freshDb();
    seedScoredEvent(db, { direction: 'up' });
    const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
    const account = marginAccount();
    await runPaperTradeOnce(db, selected, {
      paperClient: fakePaperClient(), allowedSymbols: ['AAPL'], executePaper: true,
      account, capabilities: deriveCapabilities(account), referencePrice: 200,
    });
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runPaperTradeOnce, 'function');
  assert.equal(typeof buildPaperReport, 'function');
});
