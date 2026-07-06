// tests/runPaperTradingOnce.test.js — Network-free tests for the advanced
// one-shot PAPER path (long/short equity + options + margin risk). Importing
// the script runs NOTHING (CLI guard). The core is driven with injected account/
// capabilities/positions/referencePrice + a FAKE paper client, so everything is
// offline. A fetch stub proves zero real network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { getProviderCursor, listEventTerminals } from '../src/database/paperRuntime.js';
import { deriveCapabilities } from '../src/paper/accountCapabilities.js';
import { createMockProvider } from '../src/providers/mockProvider.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { createBenzingaNewsProvider } from '../src/providers/benzingaNewsProvider.js';
import {
  parseArgs,
  listRecentScoredEvents,
  selectRecentScoredEvent,
  runPaperDecisionCycle,
  runPaperTradeOnce,
  executeOneShot,
  buildPaperReport,
  buildDecisionCycleReport,
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

function fakePaperClient({
  asset = shortableAsset(),
  optionContracts = null,
  optionQuote = { symbol: 'AAPL260116C00150000', bid: 1.9, ask: 2.1, mid: 2 },
} = {}) {
  const calls = { equity: [], option: [], asset: [], contracts: [], quote: [] };
  return {
    calls,
    getAccount: async () => marginAccount({ equity: 100000, portfolioValue: 100000, cash: 50000, buyingPower: 100000 }),
    getPositions: async () => [],
    getAsset: async (symbol) => { calls.asset.push(symbol); return asset; },
    getOptionContracts: async (query) => {
      calls.contracts.push(query);
      return {
        contracts: optionContracts ?? [{
          symbol: 'AAPL260116C00150000',
          underlyingSymbol: 'AAPL',
          status: 'active',
          tradable: true,
          expirationDate: '2026-01-16',
          strikePrice: 150,
          type: 'call',
          openInterest: 100,
        }],
      };
    },
    getOptionQuote: async (query) => { calls.quote.push(query); return optionQuote; },
    getOrder: async (id) => { (calls.getOrder ??= []).push(id); return { id, status: 'filled', submittedAt: '2026-06-18T14:30:02.000Z', filledAvgPrice: 2.1 }; },
    cancelOrder: async (id) => { (calls.cancel ??= []).push(id); return { ok: true, status: 204 }; },
    submitMarketOrder: async (o) => { calls.equity.push(o); return { id: 'ord_eq', status: 'accepted', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: null }; },
    submitOptionLimitOrder: async (o) => { calls.option.push(o); return { id: 'ord_op', status: 'accepted', submittedAt: '2026-06-18T14:30:02.000Z', filledAvgPrice: null }; },
  };
}

/** An "option entry allowed" context for tests that exercise execution. */
const OPTION_ENTRY_OK = { blocked: false, reason: 'allowed (test)' };

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
    getTradesAround: async (symbol) => [{
      price: typeof price === 'object' ? price[symbol] ?? 200 : price,
      at: '2026-06-18T14:15:00.000Z',
      size: 1,
    }],
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

function rawAlpacaNews(id, { ticker = 'AAPL', headline = 'SECRET-HEADLINE-MUST-NOT-PRINT', createdAt = '2026-06-18T14:00:00.000Z' } = {}) {
  return {
    id,
    symbols: [ticker],
    headline,
    created_at: createdAt,
    summary: '',
    content: '',
    url: `https://example.test/alpaca/${id}`,
    author: 'Alpaca',
  };
}

function rawBenzingaNews(id, { ticker = 'AAPL', headline = 'SECRET-HEADLINE-MUST-NOT-PRINT', createdAt = 'Thu, 18 Jun 2026 10:00:00 -0400' } = {}) {
  return {
    id,
    stocks: [{ name: ticker }],
    title: headline,
    created: createdAt,
    teaser: '',
    body: '',
    url: `https://example.test/benzinga/${id}`,
    author: 'Benzinga',
    channels: [{ name: 'News' }],
  };
}

function alpacaProvider(items) {
  return createAlpacaNewsProvider({ fetchRawNews: async () => items });
}

function benzingaProvider(items) {
  return createBenzingaNewsProvider({ fetchRawNews: async () => items });
}

function failingProvider(name, message, status = null) {
  let calls = 0;
  const provider = {
    name,
    normalizeProviderItem: (x) => x,
    fetchNews: async () => {
      calls += 1;
      const err = new Error(message);
      if (status !== null) err.status = status;
      throw err;
    },
  };
  provider.calls = () => calls;
  return provider;
}

function realModelClassifier({
  direction = 'up', sentiment = 0.3, impact = 0.4, confidence = 0.6,
  parserStatus = 'parsed', onClassify = null, byTicker = {},
} = {}) {
  return {
    name: 'model',
    modelName: 'claude-opus-4-8',
    promptVersion: 'model_v1',
    classifyEvent: async (event) => {
      if (onClassify) await onClassify(event);
      const overrides = byTicker[event.ticker] ?? {};
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
          sentimentScore: overrides.sentiment ?? sentiment,
          impactScore: overrides.impact ?? impact,
          confidence: overrides.confidence ?? confidence,
          direction: overrides.direction ?? direction,
          timeHorizon: 'intraday',
          affectedSymbols: [event.ticker],
          rationale: 'SECRET-RATIONALE-MUST-NOT-PRINT',
        },
        rawModelResponse: 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
        errors: [],
      };
    },
  };
}

const OCC = 'AAPL260116C00150000'; // a call expiring 2026-01-16
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z'); // ~15 days before OCC expiry (pin the clock)
const ALL_PAPER_FEATURES = { enableShorts: true, enableOptions: true, enableMargin: true };

// --- arg parsing -----------------------------------------------------------

test('parseArgs defaults are conservative, dry-run, no shorts/options', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.symbols, ['AAPL']);
  assert.equal(a.qtyExplicit, false);
  assert.equal(a.executePaper, false);
  assert.equal(a.allowShorts, false);
  assert.equal(a.allowOptions, false);
  assert.deepEqual(a.paperFeatures, DEFAULT_PAPER_FEATURES);
  assert.equal(a.optionsMode, 'plan_only');
});

test('parseArgs reads advanced flags + caps and clamps qty', () => {
  const a = parseArgs([
    '--symbols', 'aapl,msft', '--qty', '99999', '--allow-shorts', '--allow-options',
    '--options-mode', 'execute_paper', '--option-symbol', OCC, '--option-max-premium', '250',
    '--max-order-notional', '500', '--max-gross-exposure', '5000', '--max-symbols-per-cycle', '2', '--execute-paper',
  ]);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.qty, MAX_QTY);
  assert.equal(a.qtyExplicit, true);
  assert.equal(a.allowShorts, true);
  assert.equal(a.allowOptions, true);
  assert.equal(a.optionsMode, 'execute_paper');
  assert.equal(a.optionSymbol, OCC);
  assert.equal(a.caps.maxOrderNotional, 500);
  assert.equal(a.maxSymbolsPerCycle, 2);
  assert.equal(a.caps.maxGrossExposure, 5000);
  assert.equal(a.caps.maxOptionPremium, 250);
  assert.equal(a.executePaper, true);
});

test('parseArgs rejects an invalid --options-mode (keeps plan_only)', () => {
  assert.equal(parseArgs(['--options-mode', 'yolo']).optionsMode, 'plan_only');
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
    allow_options: true,
    options_mode: 'plan_only',
    confidence_threshold: 0.52,
    impact_threshold: 0.33,
    sentiment_threshold: 0.18,
    max_order_notional: 250,
    sizing_cold_start_target_weight: 0.006,
  });
  const args = parseArgs(['--impact-threshold', '0.4'], defaults);
  assert.deepEqual(args.symbols, ['MSFT', 'AAPL']);
  assert.equal(args.allowShorts, true);
  assert.equal(args.allowOptions, true);
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
  assert.deepEqual(cycle.universe.selectedSymbols, ['AAPL']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_universe_selections').get().n, 1);
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

test('Alpaca succeeds while Benzinga fails; cycle continues with sanitized provider health', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('alpaca-ok')]) },
        { name: 'benzinga', provider: failingProvider('benzinga', 'HTTP 401 SECRET-KEY-MUST-NOT-PRINT', 401) },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(200),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.providerHealth.find((p) => p.name === 'alpaca').state, 'active');
  assert.equal(cycle.providerHealth.find((p) => p.name === 'benzinga').reason, 'HTTP 401');
  assert.equal(client.calls.equity.length, 1);
  assert.ok(!buildDecisionCycleReport(cycle).join('\n').includes('SECRET-KEY-MUST-NOT-PRINT'));
  closeDatabase(db);
});

test('Benzinga succeeds while Alpaca fails; cycle continues with Benzinga', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'MSFT', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: failingProvider('alpaca', 'HTTP 503 upstream noise', 503) },
        { name: 'benzinga', provider: benzingaProvider([rawBenzingaNews('bz-ok', { ticker: 'MSFT', headline: 'Microsoft Raises Outlook' })]) },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource({ MSFT: 200 }),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.providerHealth.find((p) => p.name === 'alpaca').reason, 'HTTP 503');
  assert.equal(cycle.providerHealth.find((p) => p.name === 'benzinga').state, 'active');
  assert.equal(client.calls.equity.length, 1);
  assert.equal(client.calls.equity[0].symbol, 'MSFT');
  closeDatabase(db);
});

test('both providers fail safely with no active provider result', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: failingProvider('alpaca', 'HTTP 500 noisy body', 500) },
        { name: 'benzinga', provider: failingProvider('benzinga', 'HTTP 429 rate limit token SECRET', 429) },
      ],
      classifier: realModelClassifier(),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.outcome, PAPER_DECISION_OUTCOMES.NO_ACTIVE_PROVIDER);
  assert.equal(cycle.providerHealth.filter((p) => p.state === 'active').length, 0);
  assert.ok(!JSON.stringify(cycle.providerHealth).includes('SECRET'));
  closeDatabase(db);
});

test('cooldown skips repeatedly failing providers without hammering them', async () => {
  const db = freshDb();
  const providerStates = {};
  const alpaca = failingProvider('alpaca', 'HTTP 500 first failure', 500);
  const args = parseArgs([
    '--symbols', 'AAPL', '--classifier', 'openai',
    '--provider-max-failures-before-cooldown', '1',
    '--provider-cooldown-minutes', '30',
  ]);
  await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: alpaca }], classifier: realModelClassifier(), providerStates },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  const second = await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: alpaca }], classifier: realModelClassifier(), providerStates },
    args,
    { nowMs: Date.parse('2026-06-18T14:45:00.000Z') }
  );
  assert.equal(alpaca.calls(), 1);
  assert.match(second.providerHealth[0].reason, /cooldown until/);
  closeDatabase(db);
});

test('two independent qualified stories both reach paper risk evaluation', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL,MSFT', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [{
        name: 'alpaca',
        provider: alpacaProvider([
          rawAlpacaNews('aapl-1', { ticker: 'AAPL', headline: 'Apple Raises Outlook' }),
          rawAlpacaNews('msft-1', { ticker: 'MSFT', headline: 'Microsoft Raises Outlook' }),
        ]),
      }],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource({ AAPL: 100, MSFT: 100 }),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.batch.trades.length, 2);
  assert.equal(cycle.batch.trades.filter((t) => t.result.equity.risk?.approved).length, 2);
  assert.equal(client.calls.equity.length, 2);
  closeDatabase(db);
});

test('first approved batch event can consume budget and reject a later event', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs([
    '--symbols', 'AAPL,MSFT', '--classifier', 'openai', '--execute-paper', '--qty', '1',
    '--max-daily-paper-notional', '500',
  ]);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [{
        name: 'alpaca',
        provider: alpacaProvider([
          rawAlpacaNews('aapl-budget', { ticker: 'AAPL', headline: 'Apple Wins Contract' }),
          rawAlpacaNews('msft-budget', { ticker: 'MSFT', headline: 'Microsoft Wins Contract' }),
        ]),
      }],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource({ AAPL: 400, MSFT: 400 }),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.batch.trades.length, 2);
  assert.equal(cycle.batch.trades[0].result.equity.decision, 'accepted');
  assert.equal(cycle.batch.trades[1].result.equity.decision, 'rejected');
  assert.match(cycle.batch.trades[1].result.equity.risk.reason, /daily paper notional/);
  assert.equal(client.calls.equity.length, 1);
  assert.equal(cycle.batch.budgetEffects.length, 1);
  closeDatabase(db);
});

test('same story from Alpaca and Benzinga creates one attempt and one suppression audit', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const headline = 'SECRET-DUPLICATE-HEADLINE-MUST-NOT-PRINT';
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('same-1', { headline })]) },
        { name: 'benzinga', provider: benzingaProvider([rawBenzingaNews('same-2', { headline })]) },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(200),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.duplicateSuppressions.length, 1);
  assert.equal(cycle.batch.trades.length, 1);
  assert.equal(client.calls.equity.length, 1);
  const audit = db.prepare('SELECT * FROM paper_duplicate_suppression_audits').get();
  assert.equal(audit.suppressed_provider, 'benzinga');
  assert.equal(audit.kept_provider, 'alpaca');
  assert.match(audit.reason, /suppressed because equivalent alpaca story/);
  const printable = [
    ...buildDecisionCycleReport(cycle),
    JSON.stringify(audit),
  ].join('\n');
  assert.ok(!printable.includes(headline));
  assert.ok(!printable.includes('SECRET-DUPLICATE'));
  assert.ok(!printable.includes('raw_payload'));
  closeDatabase(db);
});

test('manual one-shot behavior remains single-event', async () => {
  const db = freshDb();
  seedScoredEvent(db, { ticker: 'AAPL', sentiment: 0.3 });
  seedScoredEvent(db, { ticker: 'MSFT', sentiment: 0.4 });
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL,MSFT', '--execute-paper', '--qty', '1']);
  const one = await executeOneShot(db, {
    args,
    paperClient: client,
    priceSource: fakePriceSource({ AAPL: 100, MSFT: 100 }),
    nowMs: Date.parse('2026-06-18T14:30:00.000Z'),
  });
  assert.ok(one.selected);
  assert.equal(client.calls.equity.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
  closeDatabase(db);
});

// --- batch accounting: failed submission must not hold a reservation --------

test('a failed broker submission releases its provisional reservation for later batch events', async () => {
  // AAA is risk-approved but its broker submit throws (no order placed); BBB is a
  // separate valid event. With a daily order cap of 1, a phantom reservation from
  // the FAILED AAA submission would wrongly reject the valid BBB order.
  const db = freshDb();
  const client = fakePaperClient();
  let submits = 0;
  client.submitMarketOrder = async (o) => {
    submits += 1;
    client.calls.equity.push(o);
    if (submits === 1) throw new Error('sanitized submit failure');
    return { id: `ord_${submits}`, status: 'accepted', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: null };
  };
  const args = parseArgs([
    '--symbols', 'AAA,BBB', '--classifier', 'openai', '--execute-paper', '--qty', '1',
    '--max-daily-paper-orders', '1',
  ]);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [{
        name: 'alpaca',
        provider: alpacaProvider([
          rawAlpacaNews('aaa-fail', { ticker: 'AAA', headline: 'AAA Wins Major Contract One' }),
          rawAlpacaNews('bbb-ok', { ticker: 'BBB', headline: 'BBB Wins Major Contract Two' }),
        ]),
      }],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(100),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.batch.trades.length, 2);
  const aaa = cycle.batch.trades.find((t) => t.selected.event.ticker === 'AAA').result.equity;
  const bbb = cycle.batch.trades.find((t) => t.selected.event.ticker === 'BBB').result.equity;
  assert.ok(aaa.orderError, 'AAA submission should have failed');
  assert.ok(!aaa.order, 'AAA must not have an order');
  assert.equal(bbb.decision, 'accepted');
  assert.ok(bbb.order, 'BBB valid order must not be blocked by the failed AAA reservation');
  assert.equal(cycle.batch.budgetEffects.length, 1); // only BBB reserved real budget
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1); // BBB only
  closeDatabase(db);
});

// --- provider cooldown expiry + recovery ------------------------------------

test('a cooled-down provider is not hammered, then re-enters after cooldown expires', async () => {
  const db = freshDb();
  const providerStates = {};
  const args = parseArgs([
    '--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1',
    '--provider-max-failures-before-cooldown', '1', '--provider-cooldown-minutes', '30',
  ]);
  let recoveredCalls = 0;
  const recoveredProvider = createAlpacaNewsProvider({
    fetchRawNews: async () => { recoveredCalls += 1; return [rawAlpacaNews('recovered', { ticker: 'AAPL', headline: 'Apple Wins Recovery Contract' })]; },
  });
  // Cycle 1: provider fails -> cooldown begins (T0+30m).
  const c1 = await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: failingProvider('alpaca', 'HTTP 500 boom', 500) }], classifier: realModelClassifier(), providerStates },
    args,
    { nowMs: Date.parse('2026-06-18T14:00:00.000Z') }
  );
  assert.equal(c1.providerHealth[0].state, 'failed');
  // Cycle 2 (within cooldown): even a now-working provider must be skipped, not called.
  const c2 = await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: recoveredProvider }], classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100), providerStates },
    args,
    { nowMs: Date.parse('2026-06-18T14:15:00.000Z') }
  );
  assert.match(c2.providerHealth[0].reason, /cooldown until/);
  assert.equal(recoveredCalls, 0, 'provider must not be hammered during cooldown');
  // Cycle 3 (after cooldown): same-named provider recovers and ingests safely.
  const c3 = await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: recoveredProvider }], classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100), providerStates },
    args,
    { nowMs: Date.parse('2026-06-18T14:31:00.000Z') }
  );
  assert.equal(recoveredCalls, 1, 'provider is retried once cooldown expires');
  assert.equal(c3.providerHealth[0].state, 'active');
  assert.equal(c3.providerHealth[0].reason, 'ok');
  closeDatabase(db);
});

test('a provider missing its key shows unavailable/missing-key while the other provider continues', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('a1', { headline: 'Apple Wins Major Contract' })]) },
        { name: 'benzinga', provider: null, unavailableReason: 'missing key' },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(100),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  const bz = cycle.providerHealth.find((p) => p.name === 'benzinga');
  assert.equal(bz.state, 'unavailable');
  assert.equal(bz.reason, 'missing key');
  assert.equal(cycle.providerHealth.find((p) => p.name === 'alpaca').state, 'active');
  assert.equal(client.calls.equity.length, 1); // alpaca continues
  closeDatabase(db);
});

// --- "every qualifying story" queue integrity -------------------------------

test('12 fresh events are processed in a bounded batch (classify<=10, attempt<=5, distinct, once each)', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ', 'KKK', 'LLL'];
  const items = tickers.map((t, i) => rawAlpacaNews(`evt-${i}`, { ticker: t, headline: `${t} Wins Major Contract Number ${i}` }));
  const args = parseArgs(['--symbols', tickers.join(','), '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    { providers: [{ name: 'alpaca', provider: alpacaProvider(items) }], classifier: realModelClassifier(), paperClient: client, priceSource: fakePriceSource(100) },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.ingestion.inserted, 12);
  assert.equal(cycle.classification.selectedIds.length, 10); // classify cap
  assert.equal(cycle.batch.trades.length, 5); // attempt cap
  assert.equal(client.calls.equity.length, 5);
  const tradedTickers = db.prepare('SELECT ticker FROM paper_trades ORDER BY ticker').all().map((r) => r.ticker);
  assert.equal(tradedTickers.length, 5);
  assert.equal(new Set(tradedTickers).size, 5); // distinct, none attempted twice
  closeDatabase(db);
});

test('durable backlog carry-forward: deferred events drain across cycles, nothing lost, no resubmits', async () => {
  // 12 fresh events with classify=10 / attempt=5. Cycle 1 processes only the caps;
  // the rest enter a durable pending pipeline and drain in later cycles. No
  // successfully submitted event is ever retried, and no event silently vanishes.
  const db = freshDb();
  const client = fakePaperClient();
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ', 'KKK', 'LLL'];
  const items = tickers.map((t, i) => rawAlpacaNews(`evt-${i}`, { ticker: t, headline: `${t} Wins Major Contract Number ${i}` }));
  const opts = { providers: [{ name: 'alpaca', provider: alpacaProvider(items) }], classifier: realModelClassifier(), paperClient: client, priceSource: fakePriceSource(100) };
  // Raise the daily ORDER cap (a separate hard risk limit) so this test exercises
  // the attempt-cap carry-forward in isolation, not the daily cap.
  const args = parseArgs(['--symbols', tickers.join(','), '--classifier', 'openai', '--execute-paper', '--qty', '1', '--max-daily-paper-orders', '50']);
  const unscored = () => db.prepare('SELECT COUNT(*) AS n FROM news_events n WHERE NOT EXISTS (SELECT 1 FROM sentiment_scores s WHERE s.news_event_id = n.id)').get().n;
  const trades = () => db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n;

  // Cycle 1: only the caps run — classify 10, attempt 5. Deferred: 2 unscored, 5 scored-unattempted.
  const c1 = await runPaperDecisionCycle(db, opts, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  assert.equal(c1.ingestion.inserted, 12);
  assert.equal(c1.backlog.classified, 10);
  assert.equal(c1.backlog.attempted, 5);
  assert.equal(c1.backlog.deferredByClassificationCap, 2);
  assert.equal(c1.backlog.deferredByAttemptCap, 5);
  assert.equal(unscored(), 2);
  assert.equal(trades(), 5);

  // Cycle 2: re-poll SAME window — all 12 are DB-duplicates (0 new inserts), but the
  // durable backlog still drains: the 2 remaining classify, 5 more attempt.
  const c2 = await runPaperDecisionCycle(db, opts, args, { nowMs: Date.parse('2026-06-18T14:45:00.000Z') });
  assert.equal(c2.ingestion.inserted, 0);
  assert.notEqual(c2.outcome, PAPER_DECISION_OUTCOMES.NO_NEW_NEWS);
  assert.equal(c2.outcome, PAPER_DECISION_OUTCOMES.TRADE_ATTEMPTED);
  assert.ok(c2.backlog.carriedForward >= 7, `carried-forward backlog surfaced (${c2.backlog.carriedForward})`);
  assert.equal(c2.backlog.classified, 2); // the last 2 unscored are drained
  assert.equal(c2.backlog.attempted, 5);
  assert.equal(unscored(), 0);
  assert.equal(trades(), 10);

  // Cycle 3: the final 2 deferred events attempt; the backlog is now empty.
  const c3 = await runPaperDecisionCycle(db, opts, args, { nowMs: Date.parse('2026-06-18T15:00:00.000Z') });
  assert.equal(c3.backlog.attempted, 2);
  assert.equal(trades(), 12);

  // No event silently disappeared and none was submitted twice: 12 distinct tickers.
  const tradedTickers = db.prepare('SELECT ticker FROM paper_trades').all().map((r) => r.ticker);
  assert.equal(tradedTickers.length, 12);
  assert.equal(new Set(tradedTickers).size, 12);
  closeDatabase(db);
});

// --- duplicate suppression correctness --------------------------------------

test('cross-provider duplicates suppress despite case/punctuation/whitespace differences', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('a1', { headline: 'Apple Inc. Wins Huge Contract!' })]) },
        { name: 'benzinga', provider: benzingaProvider([rawBenzingaNews('b1', { headline: '  apple inc,  wins   huge contract  ' })]) },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(100),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.duplicateSuppressions.length, 1);
  assert.equal(cycle.batch.trades.length, 1);
  assert.equal(client.calls.equity.length, 1);
  closeDatabase(db);
});

test('genuinely different stories on the same ticker/bucket/direction are NOT suppressed', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(
    db,
    {
      providers: [
        { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('a1', { headline: 'Apple Wins Major Cloud Contract Today' })]) },
        { name: 'benzinga', provider: benzingaProvider([rawBenzingaNews('b1', { headline: 'Apple Faces Fresh Antitrust Probe Abroad' })]) },
      ],
      classifier: realModelClassifier(),
      paperClient: client,
      priceSource: fakePriceSource(100),
    },
    args,
    { nowMs: Date.parse('2026-06-18T14:30:00.000Z') }
  );
  assert.equal(cycle.duplicateSuppressions.length, 0);
  assert.equal(cycle.independentCandidates.length, 2);
  assert.equal(cycle.batch.trades.length, 2);
  closeDatabase(db);
});

test('repeated cycles do not create duplicate suppression rows indefinitely', async () => {
  const db = freshDb();
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const opts = {
    providers: [
      { name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('a1', { headline: 'Apple Wins Huge Contract' })]) },
      { name: 'benzinga', provider: benzingaProvider([rawBenzingaNews('b1', { headline: 'Apple Wins Huge Contract' })]) },
    ],
    classifier: realModelClassifier(),
    paperClient: client,
    priceSource: fakePriceSource(100),
  };
  await runPaperDecisionCycle(db, opts, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  await runPaperDecisionCycle(db, opts, args, { nowMs: Date.parse('2026-06-18T14:45:00.000Z') });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_duplicate_suppression_audits').get().n, 1);
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
    paperFeatures: { enableShorts: false, enableOptions: false, enableMargin: false },
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

// --- options ---------------------------------------------------------------

test('options are disabled unless --allow-options', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, { allowedSymbols: ['AAPL'], allowOptions: false });
  assert.equal(result.option.decision, 'disabled');
  closeDatabase(db);
});

test('options with CLI flag are rejected when PAPER_ENABLE_OPTIONS=false', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'],
    allowOptions: true,
    optionsMode: 'execute_paper',
    optionSymbol: OCC,
    paperFeatures: { enableShorts: false, enableOptions: false, enableMargin: false },
  });
  assert.equal(result.option.decision, 'rejected');
  assert.match(result.option.proposal.reason, /PAPER_ENABLE_OPTIONS=false/);
  assert.ok(result.option.rejectedTradeId > 0);
  closeDatabase(db);
});

test('options default to plan_only and never execute, even with --execute-paper', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'plan_only', optionSymbol: OCC,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES,
  });
  assert.equal(result.option.decision, 'plan');
  assert.equal(client.calls.option.length, 0); // never sent
  closeDatabase(db);
});

test('option execute_paper submits a bounded BUY/limit/day and persists a pending_entry row', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: OCC,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES, optionEntry: OPTION_ENTRY_OK, optionConfig: { limitSlippagePct: 0.05 },
  });
  assert.equal(result.option.decision, 'accepted');
  assert.equal(result.option.risk.approved, true);
  assert.equal(client.calls.option.length, 1);
  // A bounded LONG buy/limit order — never a market order, never sell-to-open.
  assert.equal(client.calls.option[0].side, 'buy');
  assert.equal(client.calls.option[0].optionSymbol, OCC);
  assert.ok(client.calls.option[0].limitPrice > 0);
  assert.ok(result.option.paperOptionTradeId > 0);
  const row = db.prepare('SELECT * FROM paper_option_trades WHERE id = ?').get(result.option.paperOptionTradeId);
  assert.equal(row.lifecycle_state, 'pending_entry');
  assert.equal(row.entry_order_id, 'ord_op');
  assert.equal(row.right, 'call');
  assert.equal(row.strategy, 'long_call');
  closeDatabase(db);
});

test('option entry is BLOCKED outside a valid session / inside the pre-close cutoff', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: OCC,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES,
    optionEntry: { blocked: true, reason: 'option entry blocked: within 30m pre-close cutoff' },
  });
  assert.equal(result.option.decision, 'rejected');
  assert.equal(client.calls.option.length, 0); // nothing submitted
  assert.ok(result.option.rejectedTradeId > 0);
  assert.match(
    db.prepare('SELECT reason FROM rejected_trades WHERE id = ?').get(result.option.rejectedTradeId).reason,
    /pre-close cutoff/
  );
  closeDatabase(db);
});

test('option execution is refused when the account lacks options capability', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount({ optionsTradingLevel: null, optionsApprovedLevel: null });
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: OCC,
    executePaper: true, paperClient: fakePaperClient(), account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES,
  });
  assert.equal(result.option.decision, 'rejected');
  assert.match(result.option.risk.reason, /options capability is absent\/unknown/);
  closeDatabase(db);
});

test('option execute_paper without --option-symbol discovers a contract then submits a long entry', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const client = fakePaperClient();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: null,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES, optionEntry: OPTION_ENTRY_OK,
  });
  assert.equal(result.option.decision, 'accepted');
  assert.equal(result.option.proposal.optionSymbol, OCC); // discovered
  assert.equal(client.calls.contracts.length, 1);
  assert.equal(client.calls.quote[0].optionSymbol, OCC);
  assert.equal(client.calls.option.length, 1);
  assert.equal(client.calls.option[0].side, 'buy');
  assert.match(result.option.proposal.reason, /premium/);
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

test('buildPaperReport is sanitized (no raw response/headline/rationale) and shows both legs', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'plan_only', optionSymbol: OCC,
    account, capabilities: deriveCapabilities(account), referencePrice: 200, nowMs: NOW_MS,
    paperFeatures: ALL_PAPER_FEATURES,
  });
  const text = buildPaperReport(result, selected).join('\n');
  assert.match(text, /PAPER-only — live trading disabled/);
  assert.match(text, /equity:/);
  assert.match(text, /option:/);
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

// --- durable per-provider cursors + terminal dispositions -------------------

function recordingAlpacaProvider(items) {
  const seen = [];
  const provider = createAlpacaNewsProvider({ fetchRawNews: async (opts) => { seen.push(opts); return items; } });
  return { seen, provider };
}

function insertScoredEventAt(db, { ticker = 'AAPL', receivedAt, publishedAt = receivedAt, parserStatus = 'parsed' } = {}) {
  const ev = db.prepare(INSERT_EVENT_SQL).run({
    provider: 'alpaca', provider_event_id: `seed-${ticker}-${receivedAt}`, ticker,
    headline: 'Seeded Headline', published_at: publishedAt, received_at: receivedAt, news_type: 'earnings',
  });
  const id = Number(ev.lastInsertRowid);
  db.prepare(INSERT_SCORE_SQL).run({
    news_event_id: id, model: 'claude-opus-4-8', prompt_version: 'model_v1', sentiment_score: 0.7,
    news_type: 'earnings', confidence: 0.9, raw_response: 'x', parse_ok: 1, parser_status: parserStatus,
    impact_score: 0.8, direction: 'up', time_horizon: 'intraday', detail: '{}',
  });
  return id;
}

test('per-provider cursor advances to the newest published watermark after a successful ingest', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  await runPaperDecisionCycle(db, {
    providers: [{ name: 'alpaca', provider: alpacaProvider([
      rawAlpacaNews('a-old', { headline: 'Apple Older Contract News', createdAt: '2026-06-18T13:50:00.000Z' }),
      rawAlpacaNews('a-new', { headline: 'Apple Newer Contract News', createdAt: '2026-06-18T14:05:00.000Z' }),
    ]) }],
    classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100),
  }, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  const cursor = getProviderCursor(db, 'alpaca');
  assert.equal(cursor.cursor_value, '2026-06-18T14:05:00.000Z'); // newest published_at persisted
  assert.equal(cursor.last_status, 'ok');
  closeDatabase(db);
});

test('failed/401/403/429/timeout/malformed responses all retain the prior cursor', async () => {
  const seedArgs = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  const failArgs = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  for (const [msg, status] of [
    ['HTTP 401 unauthorized', 401],
    ['HTTP 403 forbidden', 403],
    ['HTTP 429 rate limit', 429],
    ['request failed: timeout', null],
    ['unexpected payload malformed response', null],
  ]) {
    const db = freshDb();
    await runPaperDecisionCycle(db, {
      providers: [{ name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('seed', { createdAt: '2026-06-18T14:05:00.000Z' })]) }],
      classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100),
    }, seedArgs, { nowMs: Date.parse('2026-06-18T14:10:00.000Z') });
    const before = getProviderCursor(db, 'alpaca').cursor_value;
    assert.equal(before, '2026-06-18T14:05:00.000Z');
    await runPaperDecisionCycle(db, {
      providers: [{ name: 'alpaca', provider: failingProvider('alpaca', msg, status) }],
      classifier: realModelClassifier(),
    }, failArgs, { nowMs: Date.parse('2026-06-18T14:20:00.000Z') });
    const after = getProviderCursor(db, 'alpaca');
    assert.equal(after.cursor_value, before, `cursor retained after "${msg}"`);
    assert.notEqual(after.last_status, 'ok');
    closeDatabase(db);
  }
});

test('a cooled-down provider retains its cursor and is not re-fetched', async () => {
  const db = freshDb();
  const providerStates = {};
  const failing = failingProvider('alpaca', 'HTTP 500 boom', 500);
  const args = parseArgs([
    '--symbols', 'AAPL', '--classifier', 'openai',
    '--provider-max-failures-before-cooldown', '1', '--provider-cooldown-minutes', '30',
  ]);
  await runPaperDecisionCycle(db, { providers: [{ name: 'alpaca', provider: failing }], classifier: realModelClassifier(), providerStates }, args, { nowMs: Date.parse('2026-06-18T14:00:00.000Z') });
  const c2 = await runPaperDecisionCycle(db, { providers: [{ name: 'alpaca', provider: failing }], classifier: realModelClassifier(), providerStates }, args, { nowMs: Date.parse('2026-06-18T14:15:00.000Z') });
  assert.match(c2.providerHealth[0].reason, /cooldown until/);
  const cursor = getProviderCursor(db, 'alpaca');
  assert.equal(cursor.cursor_value, null);
  assert.equal(cursor.last_status, 'cooldown');
  assert.equal(failing.calls(), 1); // not hammered during cooldown
  closeDatabase(db);
});

test('a recovered provider resumes its delta fetch from the retained cursor', async () => {
  const db = freshDb();
  const rec = recordingAlpacaProvider([rawAlpacaNews('r1', { createdAt: '2026-06-18T14:25:00.000Z' })]);
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  await runPaperDecisionCycle(db, { providers: [{ name: 'alpaca', provider: rec.provider }], classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100) }, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  const cursorValue = getProviderCursor(db, 'alpaca').cursor_value;
  assert.equal(cursorValue, '2026-06-18T14:25:00.000Z');
  // Cycle 1 (no prior cursor) fetches from the lookback floor.
  assert.equal(rec.seen[0].since, new Date(Date.parse('2026-06-18T14:30:00.000Z') - 60 * 60000).toISOString());
  // Cycle 2 resumes from the retained cursor (newer than the lookback floor).
  await runPaperDecisionCycle(db, { providers: [{ name: 'alpaca', provider: rec.provider }], classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(100) }, args, { nowMs: Date.parse('2026-06-18T14:40:00.000Z') });
  assert.equal(rec.seen[1].since, cursorValue);
  assert.equal(rec.seen[1].maxPages, 3); // bounded pagination requested by default
  closeDatabase(db);
});

test('Alpaca-only and Benzinga-only modes each ingest, advance their own cursor, and drain', async () => {
  for (const [name, provider, ticker] of [
    ['alpaca', alpacaProvider([rawAlpacaNews('solo', { ticker: 'AAPL', headline: 'Apple Solo Contract Win', createdAt: '2026-06-18T14:05:00.000Z' })]), 'AAPL'],
    ['benzinga', benzingaProvider([rawBenzingaNews('solo', { ticker: 'MSFT', headline: 'Microsoft Solo Contract Win' })]), 'MSFT'],
  ]) {
    const db = freshDb();
    const client = fakePaperClient();
    const args = parseArgs(['--symbols', ticker, '--classifier', 'openai', '--execute-paper', '--qty', '1']);
    const cycle = await runPaperDecisionCycle(db, { providers: [{ name, provider }], classifier: realModelClassifier(), paperClient: client, priceSource: fakePriceSource({ [ticker]: 100 }) }, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
    assert.equal(cycle.providerHealth.find((p) => p.name === name).state, 'active');
    assert.equal(client.calls.equity.length, 1);
    assert.ok(getProviderCursor(db, name).cursor_value);
    closeDatabase(db);
  }
});

test('one-shot --event-id still selects and trades the explicit event', async () => {
  const db = freshDb();
  const id = seedScoredEvent(db, { ticker: 'AAPL', sentiment: 0.7 });
  const client = fakePaperClient();
  const args = parseArgs(['--symbols', 'AAPL', '--event-id', String(id), '--execute-paper', '--qty', '1']);
  const cycle = await runPaperDecisionCycle(db, { paperClient: client, priceSource: fakePriceSource(200) }, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  assert.equal(cycle.selected.event.id, id);
  assert.equal(client.calls.equity.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 1);
  closeDatabase(db);
});

test('stale backlog entries become terminal stale_expired with a sanitized reason and drop out', async () => {
  const db = freshDb();
  const nowMs = Date.parse('2026-06-18T14:30:00.000Z'); // queue age 120m => floor 12:30
  const staleId = insertScoredEventAt(db, { ticker: 'AAPL', receivedAt: '2026-06-18T12:25:00.000Z' });
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai', '--execute-paper', '--qty', '1']);
  await runPaperDecisionCycle(db, { providers: [{ name: 'alpaca', provider: alpacaProvider([]) }], classifier: realModelClassifier(), paperClient: fakePaperClient(), priceSource: fakePriceSource(200) }, args, { nowMs });
  const terminals = listEventTerminals(db, { state: 'stale_expired' });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].news_event_id, staleId);
  assert.equal(terminals[0].queue_age_minutes, 120);
  assert.match(terminals[0].reason, /exceeded max queue age 120 minutes without a terminal paper decision/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades WHERE news_event_id = ?').get(staleId).n, 0);
  closeDatabase(db);
});

test('an unusable model score becomes a terminal provider_invalid', async () => {
  const db = freshDb();
  const args = parseArgs(['--symbols', 'AAPL', '--classifier', 'openai']);
  const cycle = await runPaperDecisionCycle(db, {
    providers: [{ name: 'alpaca', provider: alpacaProvider([rawAlpacaNews('bad', { headline: 'Apple Ambiguous Item' })]) }],
    classifier: realModelClassifier({ parserStatus: 'model_error' }),
  }, args, { nowMs: Date.parse('2026-06-18T14:30:00.000Z') });
  const terminals = listEventTerminals(db, { state: 'provider_invalid' });
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].reason, /parser_status model_error not usable/);
  assert.equal(cycle.backlog.providerInvalid, 1);
  closeDatabase(db);
});
