// tests/exitPolicy.test.js — Exit policy: TP/SL/max-hold + learned adaptation.
// Pure module, fully offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessExit,
  positionReturnPct,
  resolveExitSettings,
  resolveLearnedExitParams,
  DEFAULT_EXIT_PARAMS,
  EXIT_RAILS,
} from '../src/paper/exitPolicy.js';

const NOW_MS = Date.parse('2026-06-18T15:00:00.000Z');
const params = { takeProfitPct: 0.04, stopLossPct: 0.035, maxHoldMinutes: 390 };

/** A broker-confirmed closed outcome row (per-trade return = pnl/(price*qty)). */
function outcome(returnPct, { price = 100, qty = 10 } = {}) {
  return {
    broker_filled_avg_price: price,
    broker_filled_qty: qty,
    broker_realized_pnl_usd: returnPct * price * qty,
  };
}

// --- return math -------------------------------------------------------------

test('positionReturnPct is signed correctly for longs and shorts', () => {
  assert.equal(positionReturnPct({ side: 'buy', entryPrice: 100, currentPrice: 104 }), 0.04);
  assert.equal(positionReturnPct({ side: 'buy', entryPrice: 100, currentPrice: 96 }), -0.04);
  // Short profits when price falls.
  assert.equal(positionReturnPct({ side: 'sell', entryPrice: 100, currentPrice: 96 }), 0.04);
  assert.equal(positionReturnPct({ side: 'sell', entryPrice: 100, currentPrice: 104 }), -0.04);
  assert.equal(positionReturnPct({ side: 'buy', entryPrice: 100, currentPrice: null }), null);
});

// --- exit decisions ----------------------------------------------------------

test('assessExit: stop-loss, take-profit, max-hold, and hold-on', () => {
  const entryAt = '2026-06-18T14:30:00.000Z'; // 30 minutes before NOW_MS
  const base = { side: 'buy', entryPrice: 100, entryAt, nowMs: NOW_MS, params };

  assert.equal(assessExit({ ...base, currentPrice: 96 }).reason, 'stop_loss');
  assert.equal(assessExit({ ...base, currentPrice: 104.5 }).reason, 'take_profit');
  assert.equal(assessExit({ ...base, currentPrice: 101 }).exit, false);
  // Stop-loss wins over max-hold when both apply.
  const old = assessExit({ ...base, currentPrice: 90, entryAt: '2026-06-17T14:30:00.000Z' });
  assert.equal(old.reason, 'stop_loss');
  // Max-hold triggers even without a usable current price.
  const stale = assessExit({ ...base, currentPrice: null, entryAt: '2026-06-17T14:30:00.000Z' });
  assert.equal(stale.reason, 'max_hold');
  // No price + young position -> hold.
  assert.equal(assessExit({ ...base, currentPrice: null }).exit, false);
});

test('assessExit handles shorts symmetrically', () => {
  const base = { side: 'sell', entryPrice: 100, entryAt: '2026-06-18T14:30:00.000Z', nowMs: NOW_MS, params };
  assert.equal(assessExit({ ...base, currentPrice: 104 }).reason, 'stop_loss');   // price rose against the short
  assert.equal(assessExit({ ...base, currentPrice: 95.5 }).reason, 'take_profit'); // price fell in favor
});

// --- settings ---------------------------------------------------------------

test('resolveExitSettings applies defaults and clamps into the hard rails', () => {
  const d = resolveExitSettings({});
  assert.equal(d.takeProfitPct, DEFAULT_EXIT_PARAMS.takeProfitPct);
  assert.equal(d.stopLossPct, DEFAULT_EXIT_PARAMS.stopLossPct);
  assert.equal(d.maxHoldMinutes, DEFAULT_EXIT_PARAMS.maxHoldMinutes);
  assert.equal(d.learningEnabled, true);

  const clamped = resolveExitSettings({
    exit_take_profit_pct: 5,      // way above rail
    exit_stop_loss_pct: 0.0001,   // below rail
    exit_max_hold_minutes: 99999, // above rail
    exit_learning_enabled: false,
    exit_min_sample_size: 25,
  });
  assert.equal(clamped.takeProfitPct, EXIT_RAILS.takeProfitPct.max);
  assert.equal(clamped.stopLossPct, EXIT_RAILS.stopLossPct.min);
  assert.equal(clamped.maxHoldMinutes, EXIT_RAILS.maxHoldMinutes.max);
  assert.equal(clamped.learningEnabled, false);
  assert.equal(clamped.minSampleSize, 25);
});

// --- learning ---------------------------------------------------------------

test('learning stays on base parameters until enough confirmed outcomes exist', () => {
  const few = resolveLearnedExitParams({ closedOutcomes: [outcome(0.02)], base: params, minSampleSize: 10 });
  assert.equal(few.mode, 'base');
  assert.deepEqual(few.params, params);
  assert.match(few.explanation, /insufficient/);

  const off = resolveLearnedExitParams({
    closedOutcomes: Array.from({ length: 20 }, () => outcome(0.02)),
    base: params,
    learningEnabled: false,
  });
  assert.equal(off.mode, 'base');
});

test('with evidence, stop/target adapt to the observed win/loss sizes — inside rails', () => {
  // Typical wins +6%, typical losses -2%: the stop should TIGHTEN below base
  // (1.5 x 2% = 3%) and the target should WIDEN above base (1.25 x 6% = 7.5%).
  const closedOutcomes = [
    ...Array.from({ length: 8 }, () => outcome(0.06)),
    ...Array.from({ length: 4 }, () => outcome(-0.02)),
  ];
  const learned = resolveLearnedExitParams({ closedOutcomes, base: params, minSampleSize: 10 });
  assert.equal(learned.mode, 'learned');
  assert.equal(learned.params.stopLossPct, 0.03);
  assert.equal(learned.params.takeProfitPct, 0.075);
  assert.equal(learned.params.maxHoldMinutes, params.maxHoldMinutes); // hold time not learned
  assert.equal(learned.diagnostics.sampleSize, 12);
  assert.ok(Math.abs(learned.diagnostics.winRate - 8 / 12) < 1e-9);
});

test('learned parameters are bounded: never further than 2.5x/0.5x base, never outside rails', () => {
  // Absurdly large observed moves must clamp to 2.5x base.
  const wild = resolveLearnedExitParams({
    closedOutcomes: [
      ...Array.from({ length: 10 }, () => outcome(0.9)),
      ...Array.from({ length: 10 }, () => outcome(-0.9)),
    ],
    base: params,
    minSampleSize: 10,
  });
  assert.equal(wild.params.takeProfitPct, Math.round(params.takeProfitPct * 2.5 * 10000) / 10000);
  assert.equal(wild.params.stopLossPct, Math.round(params.stopLossPct * 2.5 * 10000) / 10000);
  assert.ok(wild.params.stopLossPct <= EXIT_RAILS.stopLossPct.max);

  // Tiny observed moves clamp to 0.5x base.
  const tiny = resolveLearnedExitParams({
    closedOutcomes: [
      ...Array.from({ length: 10 }, () => outcome(0.001)),
      ...Array.from({ length: 10 }, () => outcome(-0.001)),
    ],
    base: params,
    minSampleSize: 10,
  });
  assert.equal(tiny.params.takeProfitPct, params.takeProfitPct * 0.5);
  assert.equal(tiny.params.stopLossPct, params.stopLossPct * 0.5);
});
