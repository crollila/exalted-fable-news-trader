// tests/strategyLearning.test.js — Pure tests; no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStrategyRecommendations, buildResearchFocus, applyStrategyChanges, changesToNotes,
} from '../src/paper/strategyLearning.js';
import { DEFAULT_SETTINGS } from '../src/config/strategySettings.js';

const rej = (reason, n) => ({ reason, n });
const baseData = (over = {}) => ({
  ordersSubmitted: 0, rejectedCount: 0, realizedPnl: 0, winningTrades: 0, losingTrades: 0,
  rejectionReasons: [], trades: [], proposals: 0, worstTicker: null, ...over,
});
const find = (changes, f) => changes.find((c) => c.field === f);

test('no data -> no changes; research focus is benign', () => {
  const { changes, researchFocus } = buildStrategyRecommendations({ data: baseData(), settings: DEFAULT_SETTINGS });
  assert.deepEqual(changes, []);
  assert.match(researchFocus.reasons[0], /maintain/i);
});

test('a losing day reduces notional and tightens confidence (bounded, writeable)', () => {
  const data = baseData({ realizedPnl: -120, winningTrades: 1, losingTrades: 2, ordersSubmitted: 3, proposals: 3 });
  const { changes } = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, max_order_notional: 500, confidence_threshold: 0.6 } });
  const n = find(changes, 'max_order_notional');
  assert.equal(n.action, 'decrease');
  assert.equal(n.recommendedValue, 375); // 500 * 0.75
  assert.equal(n.writeable, true);
  assert.equal(n.envOnly, false);
  assert.equal(find(changes, 'confidence_threshold').recommendedValue, 0.65);
});

test('excessive orders reduce the daily order cap', () => {
  const data = baseData({ ordersSubmitted: 15, proposals: 15 });
  const { changes } = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, max_daily_paper_orders: 10 } });
  assert.equal(find(changes, 'max_daily_paper_orders').recommendedValue, 8); // floor(10*0.8)
});

test('option refusals keep options plan_only (or lower premium if already plan_only)', () => {
  const data = baseData({ rejectedCount: 2, proposals: 2, rejectionReasons: [rej('option execution rejected: ...', 2)] });
  const planMode = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, options_mode: 'execute_paper' } });
  assert.equal(find(planMode.changes, 'options_mode').recommendedValue, 'plan_only');
  const already = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, options_mode: 'plan_only', max_option_premium: 250 } });
  assert.equal(find(already.changes, 'max_option_premium').recommendedValue, 187.5); // 250*0.75
});

test('short refusals raise the sentiment threshold', () => {
  const data = baseData({ rejectedCount: 2, proposals: 2, rejectionReasons: [rej('short rejected: not margin/short eligible', 2)] });
  const { changes } = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, sentiment_threshold: 0.3 } });
  assert.equal(find(changes, 'sentiment_threshold').recommendedValue, 0.35);
});

test('strong positive evidence yields a SMALL bounded notional increase only', () => {
  const data = baseData({ ordersSubmitted: 12, proposals: 12, rejectedCount: 0, realizedPnl: 300, winningTrades: 10, losingTrades: 1 });
  const { changes } = buildStrategyRecommendations({ data, settings: { ...DEFAULT_SETTINGS, max_order_notional: 500 } });
  const n = find(changes, 'max_order_notional');
  assert.equal(n.action, 'increase');
  assert.equal(n.recommendedValue, 625); // 500 * 1.25
  assert.equal(n.urgency, 'monitor');
});

test('research focus reflects rejection categories', () => {
  const rf = buildResearchFocus({
    data: baseData({ worstTicker: 'NVDA', rejectionReasons: [rej('option ...', 2), rej('short ...', 1)] }),
    settings: DEFAULT_SETTINGS,
  });
  assert.ok(rf.symbolsToResearch.includes('NVDA'));
  assert.ok(rf.topicsToResearch.includes('options_chain'));
  assert.ok(rf.reasons.some((r) => /option/i.test(r)));
});

test('applyStrategyChanges applies only writeable fields; changesToNotes records them', () => {
  const changes = [{ field: 'max_order_notional', currentValue: 500, recommendedValue: 375, reason: 'r', confidence: 'medium', writeable: true }];
  const next = applyStrategyChanges(DEFAULT_SETTINGS, changes);
  assert.equal(next.max_order_notional, 375);
  const notes = changesToNotes(changes, { now: () => 'T' });
  assert.deepEqual(notes[0], { at: 'T', kind: 'learning_update', field: 'max_order_notional', from: 500, to: 375, reason: 'r', confidence: 'medium' });
});

test('all recommended numeric values stay positive and bounded', () => {
  const data = baseData({ realizedPnl: -999, losingTrades: 9, ordersSubmitted: 20, proposals: 20, rejectedCount: 9,
    rejectionReasons: [rej('--max-order-notional', 5), rej('--max-gross-exposure', 4)] });
  const { changes } = buildStrategyRecommendations({ data, settings: DEFAULT_SETTINGS });
  for (const c of changes) {
    // thresholds are in [0,1]; notional/count fields are floored at 1 — all stay positive.
    if (typeof c.recommendedValue === 'number') assert.ok(c.recommendedValue > 0);
    assert.ok(!/KEY|SECRET|TOKEN|WEBHOOK/i.test(`${c.field}=${c.recommendedValue}`));
  }
});
