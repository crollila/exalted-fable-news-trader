// tests/constraintRecommendations.test.js — Pure tests; no network, no DB.
// Verifies the recommender is conservative, bounded, never enables live trading,
// and never auto-edits anything (it only returns recommendation objects).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConstraintRecommendations, formatRecommendationsSection, analyzeOutcomes,
  VARIABLE_SPECS, NO_AUTO_EDIT_CAUTION, DEFAULT_MIN_SAMPLE_SIZE,
} from '../src/paper/constraintRecommendations.js';

const rej = (reason, n) => ({ reason, n });
const baseData = (over = {}) => ({
  ordersSubmitted: 0, rejectedCount: 0, realizedPnl: 0, winningTrades: 0, losingTrades: 0,
  rejectionReasons: [], trades: [], proposals: 0, ...over,
});
const find = (recs, v) => recs.find((r) => r.variable === v);

test('no data -> no recommendations', () => {
  const { recommendations } = buildConstraintRecommendations({ data: baseData() });
  assert.deepEqual(recommendations, []);
});

test('insufficient evidence -> no change', () => {
  // A couple of harmless rejections below the repeat thresholds, no losses.
  const data = baseData({
    ordersSubmitted: 1, rejectedCount: 1, proposals: 2,
    rejectionReasons: [rej('confidence 0.2 below threshold 0.6', 1)],
  });
  assert.deepEqual(buildConstraintRecommendations({ data }).recommendations, []);
});

test('a losing day recommends reducing risk and tightening entries (bounded)', () => {
  const data = baseData({
    ordersSubmitted: 3, proposals: 3, realizedPnl: -120, winningTrades: 1, losingTrades: 2,
    trades: [{ pnl: -100 }, { pnl: -50 }, { pnl: 30 }],
  });
  const { recommendations } = buildConstraintRecommendations({
    data, current: { MAX_TRADE_NOTIONAL_PCT: 0.01, PAPER_CONFIDENCE_THRESHOLD: 0.6 },
  });
  const notional = find(recommendations, 'MAX_TRADE_NOTIONAL_PCT');
  assert.equal(notional.action, 'decrease');
  assert.equal(notional.recommendedValue, 0.0075); // -25% bounded
  assert.equal(notional.manualEditLine, 'MAX_TRADE_NOTIONAL_PCT=0.0075');
  const conf = find(recommendations, 'PAPER_CONFIDENCE_THRESHOLD');
  assert.equal(conf.recommendedValue, 0.65); // +0.05 bounded
});

test('repeated notional rejections recommend reducing per-trade notional', () => {
  const data = baseData({
    ordersSubmitted: 4, rejectedCount: 3, proposals: 7,
    rejectionReasons: [rej('order notional 1000 exceeds --max-order-notional 500', 3)],
  });
  const { recommendations } = buildConstraintRecommendations({ data, current: { MAX_TRADE_NOTIONAL_PCT: 0.01 } });
  assert.equal(find(recommendations, 'MAX_TRADE_NOTIONAL_PCT').action, 'decrease');
});

test('repeated exposure rejections recommend reducing total exposure', () => {
  const data = baseData({
    rejectedCount: 3, proposals: 3,
    rejectionReasons: [rej('gross exposure 6000 exceeds --max-gross-exposure 5000', 3)],
  });
  const { recommendations } = buildConstraintRecommendations({ data, current: { MAX_TOTAL_EXPOSURE_PCT: 0.2 } });
  const exp = find(recommendations, 'MAX_TOTAL_EXPOSURE_PCT');
  assert.equal(exp.action, 'decrease');
  assert.equal(exp.recommendedValue, 0.15); // 0.2 * 0.75
});

test('excessive order frequency recommends a lower daily trade cap', () => {
  const data = baseData({ ordersSubmitted: 15, proposals: 15 });
  const { recommendations } = buildConstraintRecommendations({ data, current: { MAX_TRADES_PER_DAY: 10 } });
  const cap = find(recommendations, 'MAX_TRADES_PER_DAY');
  assert.equal(cap.action, 'decrease');
  assert.equal(cap.recommendedValue, 8); // floor(10 * 0.8)
});

test('option refusals recommend keeping options plan_only', () => {
  const data = baseData({
    rejectedCount: 2, proposals: 2,
    rejectionReasons: [rej('option execution rejected: account options capability is absent/unknown', 2)],
  });
  const { recommendations } = buildConstraintRecommendations({ data });
  const opt = find(recommendations, 'PAPER_OPTIONS_MODE');
  assert.equal(opt.recommendedValue, 'plan_only');
  assert.equal(opt.manualEditLine, 'PAPER_OPTIONS_MODE=plan_only');
});

test('short/margin refusals recommend raising the sentiment threshold', () => {
  const data = baseData({
    rejectedCount: 2, proposals: 2,
    rejectionReasons: [rej('short rejected: account is not margin/short eligible', 2)],
  });
  const { recommendations } = buildConstraintRecommendations({ data });
  const s = find(recommendations, 'PAPER_SENTIMENT_THRESHOLD');
  assert.equal(s.action, 'increase');
  assert.equal(s.recommendedValue, 0.35); // start 0.3 + 0.05
});

test('strong positive evidence may recommend a SMALL bounded increase only', () => {
  const data = baseData({
    ordersSubmitted: 12, proposals: 12, rejectedCount: 0, realizedPnl: 250,
    winningTrades: 10, losingTrades: 1,
  });
  const { recommendations } = buildConstraintRecommendations({
    data, current: { MAX_TRADE_NOTIONAL_PCT: 0.01 }, minSampleSize: DEFAULT_MIN_SAMPLE_SIZE,
  });
  const inc = find(recommendations, 'MAX_TRADE_NOTIONAL_PCT');
  assert.equal(inc.action, 'increase');
  assert.equal(inc.recommendedValue, 0.0125); // +25% bounded
  assert.equal(inc.urgency, 'monitor'); // never urgent for an increase
});

test('a small winning sample does NOT trigger an increase (needs minSampleSize)', () => {
  const data = baseData({ ordersSubmitted: 3, proposals: 3, rejectedCount: 0, realizedPnl: 50, winningTrades: 3, losingTrades: 0 });
  const { recommendations } = buildConstraintRecommendations({ data, current: { MAX_TRADE_NOTIONAL_PCT: 0.01 } });
  assert.equal(find(recommendations, 'MAX_TRADE_NOTIONAL_PCT'), undefined);
});

test('never recommends enabling live trading; recommends keeping it false if on', () => {
  const data = baseData({ realizedPnl: -10, losingTrades: 1, ordersSubmitted: 1, proposals: 1 });
  const { recommendations } = buildConstraintRecommendations({ data, current: { LIVE_TRADING_ENABLED: 'true' } });
  const live = find(recommendations, 'LIVE_TRADING_ENABLED');
  assert.equal(live.recommendedValue, 'false');
  for (const r of recommendations) assert.notEqual(r.manualEditLine, 'LIVE_TRADING_ENABLED=true');
});

test('all recommended values stay within the variable bounds', () => {
  const data = baseData({
    realizedPnl: -500, losingTrades: 9, winningTrades: 0, ordersSubmitted: 9, proposals: 9,
    rejectionReasons: [rej('order notional exceeds --max-order-notional', 5), rej('gross exposure exceeds --max-gross-exposure', 4)],
    rejectedCount: 9,
  });
  const { recommendations } = buildConstraintRecommendations({
    data, current: { MAX_TRADE_NOTIONAL_PCT: 0.01, MAX_TOTAL_EXPOSURE_PCT: 0.2, PAPER_CONFIDENCE_THRESHOLD: 0.6, MAX_DAILY_LOSS_PCT: 0.02 },
  });
  for (const r of recommendations) {
    const spec = VARIABLE_SPECS[r.variable];
    if (spec && (spec.kind === 'pct' || spec.kind === 'count' || spec.kind === 'threshold')) {
      const v = Number(r.recommendedValue);
      assert.ok(v >= spec.floor && v <= spec.ceil, `${r.variable}=${v} out of [${spec.floor}, ${spec.ceil}]`);
    }
    // No recommendation line is ever a secret or an enable-live directive.
    assert.ok(!/KEY|SECRET|TOKEN|WEBHOOK/i.test(r.manualEditLine));
    assert.ok(!/LIVE_TRADING_ENABLED=true/.test(r.manualEditLine));
  }
});

test('formatRecommendationsSection: header always present; no-change + caution messages', () => {
  const empty = formatRecommendationsSection([]).join('\n');
  assert.match(empty, /Recommended manual \.env changes/);
  assert.match(empty, /No manual \.env constraint changes recommended today\./);

  const withRecs = formatRecommendationsSection([{
    variable: 'MAX_TRADES_PER_DAY', action: 'decrease', currentValue: 10, recommendedValue: 8,
    reason: 'too many orders', confidence: 'medium', urgency: 'recommended',
    evidence: { winningTrades: 0, losingTrades: 0, ordersSubmitted: 15, rejectedCount: 0 },
    manualEditLine: 'MAX_TRADES_PER_DAY=8',
  }]).join('\n');
  assert.match(withRecs, /MAX_TRADES_PER_DAY=8/);
  assert.match(withRecs, new RegExp(NO_AUTO_EDIT_CAUTION.replace(/[.]/g, '\\.')));
});

test('analyzeOutcomes categorizes rejection reasons', () => {
  const a = analyzeOutcomes(baseData({
    rejectionReasons: [rej('exceeds --max-order-notional', 2), rej('short rejected: not eligible', 1)],
  }));
  assert.equal(a.categories.notional, 2);
  assert.equal(a.categories.shorts, 1);
});
