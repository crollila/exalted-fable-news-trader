// tests/runPaperTradingOnce.test.js — Network-free tests for the manual
// one-shot PAPER trade script. Importing the script runs NOTHING (CLI guard).
// runPaperTradeOnce is driven with a FAKE paper client + an in-memory DB, so
// the whole path runs offline. A fetch stub proves zero real network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { PAPER_BASE_URL, LIVE_BASE_URL_FORBIDDEN } from '../src/paper/alpacaPaperClient.js';
import {
  parseArgs,
  selectRecentScoredEvent,
  runPaperTradeOnce,
  buildPaperReport,
  MAX_QTY,
} from '../scripts/runPaperTradingOnce.js';

const INSERT_EVENT_SQL = `
  INSERT INTO news_events (provider, provider_event_id, ticker, headline,
    published_at, received_at, news_type)
  VALUES (@provider, @provider_event_id, @ticker, @headline,
    @published_at, @received_at, @news_type)
`;

const INSERT_SCORE_SQL = `
  INSERT INTO sentiment_scores (news_event_id, model, prompt_version,
    sentiment_score, news_type, confidence, raw_response, parse_ok,
    parser_status, impact_score, direction, time_horizon, detail)
  VALUES (@news_event_id, @model, @prompt_version, @sentiment_score, @news_type,
    @confidence, @raw_response, @parse_ok, @parser_status, @impact_score,
    @direction, @time_horizon, @detail)
`;

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

/** Seed one news event + one sentiment score; returns the event id. */
function seedScoredEvent(db, {
  ticker = 'AAPL',
  receivedAt = '2026-06-18T14:30:00.000Z',
  promptVersion = 'model_v1',
  model = 'claude-opus-4-8',
  direction = 'up',
  parserStatus = 'parsed',
  sentiment = 0.7,
  impact = 0.8,
  confidence = 0.9,
  rawResponse = 'RAW-MODEL-RESPONSE-MUST-NOT-PRINT',
} = {}) {
  const ev = db.prepare(INSERT_EVENT_SQL).run({
    provider: 'test',
    provider_event_id: `evt-${ticker}-${receivedAt}`,
    ticker,
    headline: 'SECRET-HEADLINE-MUST-NOT-PRINT',
    published_at: receivedAt,
    received_at: receivedAt,
    news_type: 'earnings',
  });
  const eventId = Number(ev.lastInsertRowid);
  db.prepare(INSERT_SCORE_SQL).run({
    news_event_id: eventId,
    model,
    prompt_version: promptVersion,
    sentiment_score: sentiment,
    news_type: 'earnings',
    confidence,
    raw_response: rawResponse,
    parse_ok: parserStatus === 'parsed' || parserStatus === 'fallback_used' ? 1 : 0,
    parser_status: parserStatus,
    impact_score: impact,
    direction,
    time_horizon: 'intraday',
    detail: JSON.stringify({ affected_symbols: [ticker], rationale: 'SECRET-RATIONALE', errors: [] }),
  });
  return eventId;
}

/** A fake paper client that records calls and returns a canned order. */
function fakePaperClient(order = { id: 'ord_1', status: 'accepted', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: null }) {
  const calls = [];
  return {
    calls,
    name: 'fake_paper',
    submitMarketOrder: async (o) => {
      calls.push(o);
      return { symbol: o.symbol, side: o.side, qty: o.qty, type: 'market', ...order };
    },
  };
}

const STRONG = { allowedSymbols: ['AAPL'] };

// --- arg parsing -----------------------------------------------------------

test('parseArgs defaults are conservative and dry-run', () => {
  assert.deepEqual(parseArgs([]), {
    symbols: ['AAPL'],
    qty: 1,
    eventId: null,
    executePaper: false, // dry run by default
    thresholds: {},
  });
});

test('parseArgs reads symbols/qty/event-id/thresholds and clamps qty', () => {
  const a = parseArgs([
    '--symbols', 'aapl, msft', '--qty', '99999', '--event-id', '12',
    '--confidence-threshold', '0.8', '--impact-threshold', '0.4', '--sentiment-threshold', '0.2',
  ]);
  assert.deepEqual(a.symbols, ['AAPL', 'MSFT']);
  assert.equal(a.qty, MAX_QTY); // clamped
  assert.equal(a.eventId, 12);
  assert.deepEqual(a.thresholds, { minConfidence: 0.8, minImpact: 0.4, minSentiment: 0.2 });
  assert.equal(a.executePaper, false);
});

test('parseArgs sets executePaper ONLY when --execute-paper is present', () => {
  assert.equal(parseArgs(['--symbols', 'AAPL']).executePaper, false);
  assert.equal(parseArgs(['--execute-paper']).executePaper, true);
  // Out-of-range threshold floats are ignored (fall back to defaults).
  assert.deepEqual(parseArgs(['--confidence-threshold', '5']).thresholds, {});
});

// --- selection -------------------------------------------------------------

test('selectRecentScoredEvent picks the most recent model_v1 score within allowed symbols', () => {
  const db = freshDb();
  seedScoredEvent(db, { ticker: 'AAPL', receivedAt: '2026-06-18T14:00:00.000Z' });
  const newest = seedScoredEvent(db, { ticker: 'AAPL', receivedAt: '2026-06-18T15:00:00.000Z' });
  seedScoredEvent(db, { ticker: 'MSFT', receivedAt: '2026-06-18T16:00:00.000Z' }); // disallowed

  const sel = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  assert.equal(sel.event.id, newest); // most recent score id wins
  assert.equal(sel.event.ticker, 'AAPL');
  assert.equal(sel.score.direction, 'up');
  // Sanitized selection: raw_response is never selected.
  assert.ok(!Object.prototype.hasOwnProperty.call(sel.score, 'raw_response'));
  closeDatabase(db);
});

test('selectRecentScoredEvent excludes manual_baseline-only events and unknown symbols', () => {
  const db = freshDb();
  seedScoredEvent(db, { ticker: 'AAPL', promptVersion: 'manual_v1' }); // not model_v1
  assert.equal(selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] }), null);
  seedScoredEvent(db, { ticker: 'NVDA' });
  assert.equal(selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] }), null); // symbol filtered out
  closeDatabase(db);
});

test('selectRecentScoredEvent honors an explicit event id', () => {
  const db = freshDb();
  const a = seedScoredEvent(db, { ticker: 'AAPL', receivedAt: '2026-06-18T14:00:00.000Z' });
  seedScoredEvent(db, { ticker: 'AAPL', receivedAt: '2026-06-18T15:00:00.000Z' });
  const sel = selectRecentScoredEvent(db, { eventId: a, allowedSymbols: ['AAPL'] });
  assert.equal(sel.event.id, a);
  closeDatabase(db);
});

// --- dry run vs execute ----------------------------------------------------

test('default DRY RUN submits no order and writes nothing for an accepted proposal', async () => {
  const db = freshDb();
  const eventId = seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();

  const result = await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: client, executePaper: false });
  assert.equal(result.decision, 'accepted');
  assert.equal(result.mode, 'dry_run');
  assert.equal(client.calls.length, 0); // no order sent
  assert.equal(result.paperTradeId, null);
  assert.equal(result.rejectedTradeId, null);
  // Nothing persisted on an accepted dry run.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rejected_trades').get().n, 0);
  assert.equal(eventId, selected.event.id);
  closeDatabase(db);
});

test('--execute-paper submits a PAPER order and writes a paper_trades row', async () => {
  const db = freshDb();
  seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient({ id: 'ord_42', status: 'filled', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: 201.5 });

  const result = await runPaperTradeOnce(db, selected, { ...STRONG, qty: 2, paperClient: client, executePaper: true });
  assert.equal(result.decision, 'accepted');
  assert.equal(result.mode, 'execute_paper');
  assert.deepEqual(client.calls[0], { symbol: 'AAPL', qty: 2, side: 'buy' });
  assert.equal(result.order.id, 'ord_42');
  assert.ok(result.paperTradeId > 0);
  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(result.paperTradeId);
  assert.equal(row.side, 'buy');
  assert.equal(row.quantity, 2);
  assert.equal(row.fill_price, 201.5);
  assert.equal(row.status, 'open');
  closeDatabase(db);
});

test('a risk rejection writes rejected_trades and never sends an order (even with --execute-paper)', async () => {
  const db = freshDb();
  seedScoredEvent(db, { direction: 'down' }); // long-only slice -> reject
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient();

  const result = await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: client, executePaper: true });
  assert.equal(result.decision, 'rejected');
  assert.equal(client.calls.length, 0); // refused before any order
  assert.ok(result.rejectedTradeId > 0);
  const row = db.prepare('SELECT * FROM rejected_trades WHERE id = ?').get(result.rejectedTradeId);
  assert.match(row.reason, /is not up/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  closeDatabase(db);
});

test('execute with no paper client fails safely (no order, no paper_trades row)', async () => {
  const db = freshDb();
  seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: null, executePaper: true });
  assert.equal(result.decision, 'accepted');
  assert.match(result.orderError, /not configured/);
  assert.equal(result.paperTradeId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  closeDatabase(db);
});

test('a paper order error is recorded (sanitized) and no paper_trades row is written', async () => {
  const db = freshDb();
  seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const throwingClient = {
    name: 'fake_paper',
    submitMarketOrder: async () => {
      throw new Error('alpacaPaperClient: HTTP 403 [redacted]'); // client already sanitizes
    },
  };
  const result = await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: throwingClient, executePaper: true });
  assert.equal(result.order, null);
  assert.match(result.orderError, /HTTP 403/);
  assert.equal(result.paperTradeId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get().n, 0);
  closeDatabase(db);
});

// --- report sanitization ---------------------------------------------------

test('buildPaperReport is sanitized and surfaces the decision/order', async () => {
  const db = freshDb();
  seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const client = fakePaperClient({ id: 'ord_7', status: 'filled', submittedAt: '2026-06-18T14:30:01.000Z', filledAvgPrice: 200.1 });
  const result = await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: client, executePaper: true });

  const text = buildPaperReport(result, selected).join('\n');
  assert.match(text, /PAPER-only — live trading disabled/);
  assert.match(text, /mode:       EXECUTE PAPER/);
  assert.match(text, /decision:   ACCEPTED/);
  assert.match(text, /order:      id ord_7 status filled/);
  assert.match(text, /paper_trades id/);
  // No secrets / raw model text / headline reach the report.
  assert.ok(!text.includes('RAW-MODEL-RESPONSE-MUST-NOT-PRINT'));
  assert.ok(!text.includes('SECRET-HEADLINE-MUST-NOT-PRINT'));
  assert.ok(!text.includes('SECRET-RATIONALE'));
  closeDatabase(db);
});

test('dry-run report nudges toward --execute-paper without sending anything', async () => {
  const db = freshDb();
  seedScoredEvent(db);
  const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
  const result = await runPaperTradeOnce(db, selected, { ...STRONG, executePaper: false });
  const text = buildPaperReport(result, selected).join('\n');
  assert.match(text, /DRY RUN \(no order\)/);
  assert.match(text, /pass --execute-paper/);
  closeDatabase(db);
});

// --- live-trading impossibility & no-network -------------------------------

test('the script module exposes no live endpoint and the paper host is paper-only', () => {
  assert.ok(PAPER_BASE_URL.startsWith('https://paper-api.alpaca.markets'));
  assert.ok(!PAPER_BASE_URL.startsWith(LIVE_BASE_URL_FORBIDDEN));
});

test('the full path runs with zero real network', async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network attempted in paper trading test');
  };
  try {
    const db = freshDb();
    seedScoredEvent(db);
    const selected = selectRecentScoredEvent(db, { allowedSymbols: ['AAPL'] });
    // dry run + execute-with-fake-client both avoid real fetch.
    await runPaperTradeOnce(db, selected, { ...STRONG, executePaper: false });
    await runPaperTradeOnce(db, selected, { ...STRONG, paperClient: fakePaperClient(), executePaper: true });
    assert.equal(networkCalls, 0);
    closeDatabase(db);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('importing the script performs no network and requires no credentials', () => {
  assert.equal(typeof runPaperTradeOnce, 'function');
  assert.equal(typeof selectRecentScoredEvent, 'function');
  assert.equal(typeof buildPaperReport, 'function');
});
