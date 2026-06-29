// tests/paperTradeProposal.test.js — Network-free tests for the conservative
// paper-trade proposal/risk gate and the paper_trades / rejected_trades writers.
// assessProposal is pure; the writers use an in-memory DB. No network anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  assessProposal,
  summarizeScore,
  insertPaperTrade,
  insertRejectedTrade,
  clampQty,
  DEFAULT_QTY,
  MAX_QTY,
  DEFAULT_THRESHOLDS,
} from '../src/paper/paperTradeProposal.js';

const EVENT = { id: 7, ticker: 'AAPL' };

/** A score that clears every conservative gate for a long. */
function strongLong(extra = {}) {
  return {
    model: 'claude-opus-4-8',
    prompt_version: 'model_v1',
    direction: 'up',
    parser_status: 'parsed',
    sentiment_score: 0.7,
    impact_score: 0.8,
    confidence: 0.9,
    news_type: 'earnings',
    ...extra,
  };
}

function freshDb() {
  const db = openMemoryDatabase();
  runMigrations(db);
  return db;
}

// --- quantity clamping -----------------------------------------------------

test('clampQty defaults, caps, and rejects junk', () => {
  assert.equal(clampQty(undefined), DEFAULT_QTY);
  assert.equal(DEFAULT_QTY, 1);
  assert.equal(clampQty(5), 5);
  assert.equal(clampQty(99999), MAX_QTY);
  assert.equal(MAX_QTY, 100);
  assert.equal(clampQty(0), DEFAULT_QTY);
  assert.equal(clampQty('nope'), DEFAULT_QTY);
  assert.equal(clampQty(-4), DEFAULT_QTY);
});

// --- acceptance ------------------------------------------------------------

test('assessProposal accepts a strong long signal as an equity market BUY', () => {
  const p = assessProposal({ event: EVENT, score: strongLong(), qty: 3, allowedSymbols: ['AAPL'] });
  assert.equal(p.accepted, true);
  assert.equal(p.assetClass, 'equity');
  assert.equal(p.side, 'buy');
  assert.equal(p.quantity, 3);
  assert.equal(p.ticker, 'AAPL');
  assert.match(p.reason, /long AAPL: direction up/);
});

test('assessProposal clamps quantity to the hard cap', () => {
  const p = assessProposal({ event: EVENT, score: strongLong(), qty: 99999, allowedSymbols: ['AAPL'] });
  assert.equal(p.quantity, MAX_QTY);
});

// --- rejections ------------------------------------------------------------

test('assessProposal rejects when the symbol is not in the CLI allow-list', () => {
  const p = assessProposal({ event: EVENT, score: strongLong(), allowedSymbols: ['MSFT'] });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /not in allowed list/);
});

test('assessProposal rejects unclear/none direction as not actionable', () => {
  for (const direction of ['unclear', null]) {
    const p = assessProposal({ event: EVENT, score: strongLong({ direction }), allowedSymbols: ['AAPL'] });
    assert.equal(p.accepted, false);
    assert.match(p.reason, /not actionable/);
  }
});

test('assessProposal rejects a down direction unless --allow-shorts is set', () => {
  const noShort = assessProposal({
    event: EVENT, score: strongLong({ direction: 'down', sentiment_score: -0.7 }), allowedSymbols: ['AAPL'],
  });
  assert.equal(noShort.accepted, false);
  assert.match(noShort.reason, /requires --allow-shorts/);
});

test('assessProposal accepts a short on direction down + allowShorts + negative sentiment', () => {
  const p = assessProposal({
    event: EVENT, score: strongLong({ direction: 'down', sentiment_score: -0.7 }),
    allowedSymbols: ['AAPL'], allowShorts: true, qty: 2,
  });
  assert.equal(p.accepted, true);
  assert.equal(p.side, 'sell');
  assert.equal(p.quantity, 2);
  assert.match(p.reason, /short AAPL/);
});

test('a short still requires sentiment below the negative threshold', () => {
  const p = assessProposal({
    event: EVENT, score: strongLong({ direction: 'down', sentiment_score: 0.2 }), // not negative enough
    allowedSymbols: ['AAPL'], allowShorts: true,
  });
  assert.equal(p.accepted, false);
  assert.match(p.reason, /not below short threshold/);
});

test('assessProposal rejects unusable parser_status', () => {
  for (const parser_status of ['malformed_json', 'model_error', 'invalid_score_range', null]) {
    const p = assessProposal({ event: EVENT, score: strongLong({ parser_status }), allowedSymbols: ['AAPL'] });
    assert.equal(p.accepted, false);
    assert.match(p.reason, /not usable/);
  }
});

test('assessProposal rejects sub-threshold confidence, impact, and sentiment', () => {
  const lowConf = assessProposal({ event: EVENT, score: strongLong({ confidence: 0.1 }), allowedSymbols: ['AAPL'] });
  assert.match(lowConf.reason, /confidence .* below threshold/);

  const lowImpact = assessProposal({ event: EVENT, score: strongLong({ impact_score: 0.1 }), allowedSymbols: ['AAPL'] });
  assert.match(lowImpact.reason, /impact .* below threshold/);

  const lowSent = assessProposal({ event: EVENT, score: strongLong({ sentiment_score: 0.0 }), allowedSymbols: ['AAPL'] });
  assert.match(lowSent.reason, /sentiment .* below long threshold/);
});

test('the neutral manual-baseline score (direction unclear, zeros) always rejects', () => {
  const neutral = {
    model: 'manual_baseline', prompt_version: 'manual_v1', direction: 'unclear',
    parser_status: 'parsed', sentiment_score: 0, impact_score: 0, confidence: 0,
  };
  const p = assessProposal({ event: EVENT, score: neutral, allowedSymbols: ['AAPL'] });
  assert.equal(p.accepted, false);
});

test('custom thresholds tighten the gate', () => {
  const strict = assessProposal({
    event: EVENT,
    score: strongLong({ confidence: 0.65 }),
    allowedSymbols: ['AAPL'],
    thresholds: { minConfidence: 0.8 },
  });
  assert.equal(strict.accepted, false);
  assert.match(strict.reason, /confidence .* below threshold 0.8/);
  // Defaults remain conservative.
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    minConfidence: 0.55,
    minImpact: 0.35,
    minSentiment: 0.2,
  });
});

// --- sanitization ----------------------------------------------------------

test('summarizeScore strips raw_response / detail and keeps only a numeric whitelist', () => {
  const s = summarizeScore({
    model: 'm', prompt_version: 'model_v1', direction: 'up', parser_status: 'parsed',
    sentiment_score: 0.5, impact_score: 0.6, confidence: 0.7,
    raw_response: 'RAW-MUST-NOT-APPEAR', detail: { rationale: 'SECRET-RATIONALE' },
  });
  assert.deepEqual(s, {
    model: 'm', promptVersion: 'model_v1', direction: 'up', parserStatus: 'parsed',
    newsType: null, sentiment: 0.5, impact: 0.6, confidence: 0.7,
  });
  const text = JSON.stringify(assessProposal({ event: EVENT, score: {
    ...strongLong(), raw_response: 'RAW-MUST-NOT-APPEAR',
  }, allowedSymbols: ['AAPL'] }));
  assert.ok(!text.includes('RAW-MUST-NOT-APPEAR'));
});

// --- writers ---------------------------------------------------------------

test('insertRejectedTrade stores a row and requires a non-empty reason', () => {
  const db = freshDb();
  const { id } = insertRejectedTrade(db, {
    newsEventId: null, ticker: 'AAPL', side: 'buy', quantity: 1, reason: 'direction not up',
  });
  const row = db.prepare('SELECT * FROM rejected_trades WHERE id = ?').get(id);
  assert.equal(row.ticker, 'AAPL');
  assert.equal(row.reason, 'direction not up');
  assert.throws(() => insertRejectedTrade(db, { ticker: 'AAPL', reason: '' }), /reason is required/);
  assert.throws(() => insertRejectedTrade(db, { ticker: '', reason: 'x' }), /ticker is required/);
  closeDatabase(db);
});

test('insertPaperTrade stores a row and validates side/quantity', () => {
  const db = freshDb();
  const { id } = insertPaperTrade(db, {
    newsEventId: null, ticker: 'AAPL', side: 'buy', quantity: 2,
    fillPrice: 201.5, entryAt: '2026-06-18T14:30:00.000Z', tradeReason: 'long AAPL', status: 'open',
  });
  const row = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id);
  assert.equal(row.ticker, 'AAPL');
  assert.equal(row.side, 'buy');
  assert.equal(row.quantity, 2);
  assert.equal(row.status, 'open');
  assert.throws(() => insertPaperTrade(db, { ticker: 'AAPL', side: 'short', quantity: 1 }), /buy\/sell/);
  assert.throws(() => insertPaperTrade(db, { ticker: 'AAPL', side: 'buy', quantity: 0 }), /quantity must be > 0/);
  closeDatabase(db);
});
