// tests/equitySizing.test.js - Pure learned PAPER equity sizing tests.
// No database, no HTTP, no timers. Broker-confirmed outcomes are injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideEquitySizing,
  selectComparableEvidence,
  SIZING_MODES,
} from '../src/paper/equitySizing.js';

const SIGNAL = Object.freeze({
  ticker: 'AAPL',
  side: 'buy',
  direction: 'up',
  confidence: 0.9,
  impact: 0.8,
  sentiment: 0.7,
  newsType: 'earnings',
  model: 'claude-opus-4-8',
  promptVersion: 'model_v1',
});

function outcome(id, overrides = {}) {
  return {
    news_event_id: id,
    ticker: 'AAPL',
    side: 'buy',
    direction: 'up',
    confidence: 0.9,
    impact: 0.8,
    sentiment_score: 0.7,
    news_type: 'earnings',
    model: 'claude-opus-4-8',
    prompt_version: 'model_v1',
    broker_filled_qty: 2,
    broker_filled_avg_price: 100,
    broker_realized_pnl_usd: 10,
    ...overrides,
  };
}

test('cold start requests a conservative portfolio target when price and equity are valid', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: 100,
    account: { equity: 100000, buyingPower: 100000, cash: 100000 },
    caps: { maxOrderNotional: 1000, maxDailyPaperNotional: 5000 },
    daily: { orders: 0, notional: 0 },
  });
  assert.equal(d.mode, SIZING_MODES.COLD_START);
  assert.ok(d.requestedTargetWeight > 0);
  assert.ok(d.requestedTargetWeight <= 0.01);
  assert.ok(d.requestedQuantity > 1);
  assert.equal(d.evidenceCount, 0);
});

test('missing reference price abstains instead of falling back to one share', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: null,
    account: { equity: 100000 },
  });
  assert.equal(d.mode, SIZING_MODES.ABSTAIN);
  assert.equal(d.requestedQuantity, 0);
  assert.match(d.reason, /reference price unavailable/);
});

test('comparable evidence does not mix model or prompt versions', () => {
  const evidence = selectComparableEvidence({
    signal: SIGNAL,
    minSampleSize: 3,
    historicalOutcomes: [
      outcome(1),
      outcome(2),
      outcome(3, { prompt_version: 'model_v2' }),
      outcome(4, { model: 'different-model' }),
    ],
  });
  assert.equal(evidence.sufficient, false);
  assert.equal(evidence.summary.count, 2);
});

test('duplicate evidence and missing realized outcomes cannot inflate samples', () => {
  const evidence = selectComparableEvidence({
    signal: SIGNAL,
    minSampleSize: 2,
    historicalOutcomes: [
      outcome(1, { broker_realized_pnl_usd: 10 }),
      outcome(1, { broker_realized_pnl_usd: 25 }),
      outcome(2, { broker_realized_pnl_usd: null }),
      outcome(3, { broker_filled_avg_price: null }),
    ],
  });
  assert.equal(evidence.sufficient, false);
  assert.equal(evidence.summary.count, 1);
});

test('direct sizing settings cannot raise learned targets above one percent', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: 100,
    account: { equity: 100000, buyingPower: 100000, cash: 100000 },
    settings: {
      sizing_cold_start_target_weight: 0.2,
      sizing_max_target_weight: 0.2,
      sizing_enable_confidence_scaling: false,
      sizing_enable_impact_scaling: false,
    },
  });
  assert.equal(d.mode, SIZING_MODES.COLD_START);
  assert.equal(d.requestedTargetWeight, 0.01);
  assert.equal(d.requestedQuantity, 10);
});

test('sufficient positive comparable evidence uses evidence-weighted sizing', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: 50,
    account: { equity: 100000, buyingPower: 100000 },
    settings: { sizing_min_comparable_sample_size: 3 },
    historicalOutcomes: [outcome(1), outcome(2), outcome(3), outcome(4)],
  });
  assert.equal(d.mode, SIZING_MODES.EVIDENCE_WEIGHTED);
  assert.equal(d.evidenceQuality, 'sufficient');
  assert.equal(d.evidenceCount, 4);
  assert.ok(d.requestedQuantity > 1);
});

test('losing sparse comparable evidence abstains', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: 50,
    account: { equity: 100000, buyingPower: 100000 },
    historicalOutcomes: [outcome(1, { broker_realized_pnl_usd: -5 })],
  });
  assert.equal(d.mode, SIZING_MODES.ABSTAIN);
  assert.equal(d.requestedQuantity, 0);
  assert.match(d.reason, /losing or uncertain/);
});

test('duplicate or stale event attempts abstain and carry a warning', () => {
  const d = decideEquitySizing({
    signal: SIGNAL,
    referencePrice: 50,
    account: { equity: 100000 },
    duplicateAttempt: true,
  });
  assert.equal(d.mode, SIZING_MODES.ABSTAIN);
  assert.equal(d.requestedQuantity, 0);
  assert.match(d.warnings.join(' '), /duplicate\/stale/);
});
