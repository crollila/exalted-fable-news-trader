// tests/runPaperTradingOnce.test.js — Network-free tests for the advanced
// one-shot PAPER path (long/short equity + options + margin risk). Importing
// the script runs NOTHING (CLI guard). The core is driven with injected account/
// capabilities/positions/referencePrice + a FAKE paper client, so everything is
// offline. A fetch stub proves zero real network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { deriveCapabilities } from '../src/paper/accountCapabilities.js';
import {
  parseArgs,
  selectRecentScoredEvent,
  runPaperTradeOnce,
  buildPaperReport,
  getDailyCounters,
  oneLineSummary,
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

function fakePaperClient() {
  const calls = { equity: [], option: [] };
  return {
    calls,
    submitMarketOrder: async (o) => { calls.equity.push(o); return { id: 'ord_eq', status: 'accepted', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: null }; },
    submitOptionMarketOrder: async (o) => { calls.option.push(o); return { id: 'ord_op', status: 'accepted', submittedAt: '2026-06-18T14:30:02.000Z', filledAvgPrice: null }; },
  };
}

const OCC = 'AAPL260116C00150000'; // a call expiring 2026-01-16
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z'); // ~15 days before OCC expiry (pin the clock)

// --- arg parsing -----------------------------------------------------------

test('parseArgs defaults are conservative, dry-run, no shorts/options', () => {
  const a = parseArgs([]);
  assert.deepEqual(a.symbols, ['AAPL']);
  assert.equal(a.executePaper, false);
  assert.equal(a.allowShorts, false);
  assert.equal(a.allowOptions, false);
  assert.equal(a.optionsMode, 'plan_only');
});

test('parseArgs reads advanced flags + caps and clamps qty', () => {
  const a = parseArgs([
    '--symbols', 'aapl,msft', '--qty', '99999', '--allow-shorts', '--allow-options',
    '--options-mode', 'execute_paper', '--option-symbol', OCC, '--option-max-premium', '250',
    '--max-order-notional', '500', '--max-gross-exposure', '5000', '--execute-paper',
  ]);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.qty, MAX_QTY);
  assert.equal(a.allowShorts, true);
  assert.equal(a.allowOptions, true);
  assert.equal(a.optionsMode, 'execute_paper');
  assert.equal(a.optionSymbol, OCC);
  assert.equal(a.caps.maxOrderNotional, 500);
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

// --- equity long: dry run vs execute ---------------------------------------

test('equity long DRY RUN (no account) accepts and writes nothing', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const result = await runPaperTradeOnce(db, selected, { paperClient: client, allowedSymbols: ['AAPL'], executePaper: false });
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.proposal.side, 'buy');
  assert.equal(client.calls.equity.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
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
    account, capabilities: deriveCapabilities(account), referencePrice: 200, qty: 1,
  });
  assert.equal(result.equity.decision, 'accepted');
  assert.equal(result.equity.risk.approved, true);
  assert.deepEqual(client.calls.equity[0], { symbol: 'AAPL', qty: 1, side: 'buy' });
  assert.ok(result.equity.paperTradeId > 0);
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

// --- margin caps -----------------------------------------------------------

test('an order exceeding --max-order-notional is rejected', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], executePaper: true, paperClient: fakePaperClient(),
    account, capabilities: deriveCapabilities(account), referencePrice: 1000, qty: 1,
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

test('options default to plan_only and never execute, even with --execute-paper', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'plan_only', optionSymbol: OCC,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
  });
  assert.equal(result.option.decision, 'plan');
  assert.equal(client.calls.option.length, 0); // never sent
  closeDatabase(db);
});

test('option EXECUTION needs allow-options + execute_paper + execute-paper + option symbol + capability', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: OCC,
    executePaper: true, paperClient: client, account, capabilities: deriveCapabilities(account), nowMs: NOW_MS,
  });
  assert.equal(result.option.decision, 'accepted');
  assert.equal(client.calls.option[0].optionSymbol, OCC);
  assert.ok(result.option.paperTradeId > 0);
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
  });
  assert.equal(result.option.decision, 'rejected');
  assert.match(result.option.risk.reason, /options capability is absent\/unknown/);
  closeDatabase(db);
});

test('option execution without --option-symbol is refused (no contract discovery)', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'up' });
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const account = marginAccount();
  const result = await runPaperTradeOnce(db, selected, {
    allowedSymbols: ['AAPL'], allowOptions: true, optionsMode: 'execute_paper', optionSymbol: null,
    executePaper: true, paperClient: fakePaperClient(), account, capabilities: deriveCapabilities(account),
  });
  assert.equal(result.option.decision, 'rejected');
  assert.match(result.option.proposal.reason, /requires --option-symbol/);
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
