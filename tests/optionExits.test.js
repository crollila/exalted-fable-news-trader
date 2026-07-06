// tests/optionExits.test.js — PURE option entry/exit decision logic. No I/O,
// no network, no DB; deterministic given injected now/quote/config.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entryLimitPrice, exitLimitPrice, classifyEntryOrder, decideOptionExit,
  optionEntryBlocked, shouldRequoteExit, realizedOptionPnl, MAX_EXIT_ATTEMPTS,
} from '../src/paper/optionExits.js';

const MIN = 60_000;
const cfg = {
  takeProfitPct: 0.5, stopLossPct: 0.5, maxHoldMinutes: 240,
  forceCloseBeforeCloseMinutes: 15, limitSlippagePct: 0.05,
};

test('entryLimitPrice crosses UP from the ask and stays bounded/positive', () => {
  assert.equal(entryLimitPrice({ ask: 2.0, slippagePct: 0.05 }), 2.1);
  assert.equal(entryLimitPrice({ ask: 0 }), null);
  assert.equal(entryLimitPrice({ ask: null }), null);
});

test('exitLimitPrice crosses DOWN from the bid; aggressive crosses further; floored at 0.01', () => {
  assert.equal(exitLimitPrice({ bid: 2.0, slippagePct: 0.05 }), 1.9);
  assert.ok(exitLimitPrice({ bid: 2.0, slippagePct: 0.05, aggressive: true }) < 1.9);
  assert.ok(exitLimitPrice({ bid: 0.01, slippagePct: 0.5 }) >= 0.01);
  assert.equal(exitLimitPrice({ bid: 0 }), null);
});

test('classifyEntryOrder: filled / dead / stale-timeout / wait', () => {
  assert.equal(classifyEntryOrder({ orderStatus: 'filled', submittedAtMs: 0, nowMs: MIN }).action, 'filled');
  assert.equal(classifyEntryOrder({ orderStatus: 'canceled', submittedAtMs: 0, nowMs: MIN }).action, 'dead');
  assert.equal(classifyEntryOrder({ orderStatus: 'rejected', submittedAtMs: 0, nowMs: MIN }).action, 'dead');
  assert.equal(classifyEntryOrder({ orderStatus: 'new', submittedAtMs: 0, nowMs: 11 * MIN, timeoutMinutes: 10 }).action, 'cancel_stale');
  assert.equal(classifyEntryOrder({ orderStatus: 'new', submittedAtMs: 0, nowMs: 2 * MIN, timeoutMinutes: 10 }).action, 'wait');
});

test('decideOptionExit priority: forced_close > stop_loss > take_profit > max_hold > hold', () => {
  const openedAtMs = 0;
  const forced = decideOptionExit({ premiumEntry: 2, quote: { bid: 2 }, nowMs: 100 * MIN, openedAtMs, sessionCloseMs: 110 * MIN, config: cfg });
  assert.equal(forced.action, 'forced_close');
  assert.ok(forced.limitPrice > 0);

  const far = 600 * MIN;
  assert.equal(decideOptionExit({ premiumEntry: 2, quote: { bid: 1.0 }, nowMs: 10 * MIN, openedAtMs, sessionCloseMs: far, config: cfg }).action, 'stop_loss');
  assert.equal(decideOptionExit({ premiumEntry: 2, quote: { bid: 3.0 }, nowMs: 10 * MIN, openedAtMs, sessionCloseMs: far, config: cfg }).action, 'take_profit');
  assert.equal(decideOptionExit({ premiumEntry: 2, quote: { bid: 2.1 }, nowMs: 300 * MIN, openedAtMs, sessionCloseMs: far, config: cfg }).action, 'max_hold');

  const hold = decideOptionExit({ premiumEntry: 2, quote: { bid: 2.1 }, nowMs: 10 * MIN, openedAtMs, sessionCloseMs: far, config: cfg });
  assert.equal(hold.action, 'hold');
  assert.equal(hold.limitPrice, null);
});

test('decideOptionExit with no usable bid holds, but a forced close still triggers (no limit)', () => {
  const noBid = decideOptionExit({ premiumEntry: 2, quote: { bid: 0 }, nowMs: 10 * MIN, openedAtMs: 0, sessionCloseMs: 600 * MIN, config: cfg });
  assert.equal(noBid.action, 'hold');
  const forcedNoBid = decideOptionExit({ premiumEntry: 2, quote: { bid: 0 }, nowMs: 100 * MIN, openedAtMs: 0, sessionCloseMs: 110 * MIN, config: cfg });
  assert.equal(forcedNoBid.action, 'forced_close');
  assert.equal(forcedNoBid.limitPrice, null);
});

test('optionEntryBlocked: closed session and pre-close cutoff block; mid-session allows', () => {
  assert.equal(optionEntryBlocked({ nowMs: 0, sessionOpen: false }).blocked, true);
  const cutoff = optionEntryBlocked({ nowMs: 100 * MIN, sessionOpen: true, sessionCloseMs: 110 * MIN, noEntryBeforeCloseMinutes: 30 });
  assert.equal(cutoff.blocked, true);
  assert.match(cutoff.reason, /pre-close cutoff/);
  assert.equal(optionEntryBlocked({ nowMs: 10 * MIN, sessionOpen: true, sessionCloseMs: 600 * MIN, noEntryBeforeCloseMinutes: 30 }).blocked, false);
});

test('shouldRequoteExit: filled / dead-requote / timeout-requote / wait', () => {
  assert.equal(shouldRequoteExit({ orderStatus: 'filled' }).action, 'filled');
  assert.equal(shouldRequoteExit({ orderStatus: 'canceled' }).action, 'requote');
  assert.equal(shouldRequoteExit({ orderStatus: 'new', exitSubmittedAtMs: 0, nowMs: 6 * MIN, exitRetryMinutes: 5 }).action, 'requote');
  assert.equal(shouldRequoteExit({ orderStatus: 'new', exitSubmittedAtMs: 0, nowMs: 2 * MIN, exitRetryMinutes: 5 }).action, 'wait');
});

test('realizedOptionPnl = (exit - entry) * 100 * contracts', () => {
  assert.equal(realizedOptionPnl({ premiumEntry: 2, premiumExit: 3, contracts: 1 }), 100);
  assert.equal(realizedOptionPnl({ premiumEntry: 2, premiumExit: 1.5, contracts: 2 }), -100);
  assert.equal(realizedOptionPnl({ premiumEntry: 2, premiumExit: null }), null);
  assert.ok(MAX_EXIT_ATTEMPTS >= 1);
});
