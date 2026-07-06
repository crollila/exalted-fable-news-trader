// src/paper/optionExits.js — PURE decision logic for monitored PAPER option
// execution. No HTTP, no DB, no clock; the caller injects now/quote/config.
//
// PAPER-only and LONG-only: the bot holds long calls/puts and SELLS them to
// close. It NEVER sells to open. Prices cross the spread to stay marketable but
// are ALWAYS bounded limits — never unbounded market orders.

/** Broker order statuses that mean a terminal fill / terminal death. */
export const FILLED_STATUSES = new Set(['filled']);
export const DEAD_STATUSES = new Set(['canceled', 'cancelled', 'rejected', 'expired', 'done_for_day']);

/** Hard cap on sell-to-close requote attempts before a position is unresolved. */
export const MAX_EXIT_ATTEMPTS = 6;

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function minutesBetween(aMs, bMs) {
  const a = Number(aMs);
  const b = Number(bMs);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (a - b) / 60_000;
}

/** Marketable BUY limit: cross UP from the ask by slippage; bounded, >= 0.01. */
export function entryLimitPrice({ ask, slippagePct = 0.05 } = {}) {
  const a = Number(ask);
  if (!Number.isFinite(a) || a <= 0) return null;
  return Math.max(0.01, round2(a * (1 + Math.max(0, Number(slippagePct) || 0))));
}

/** Marketable SELL-to-close limit: cross DOWN from the bid; bounded, >= 0.01. */
export function exitLimitPrice({ bid, slippagePct = 0.05, aggressive = false } = {}) {
  const b = Number(bid);
  if (!Number.isFinite(b) || b <= 0) return null;
  const base = Math.max(0, Number(slippagePct) || 0);
  const buffer = aggressive ? Math.min(0.5, base * 3) : base;
  return Math.max(0.01, round2(b * (1 - buffer)));
}

/** Realized P&L for a long option (USD): (exit - entry) * 100 * contracts. */
export function realizedOptionPnl({ premiumEntry, premiumExit, contracts = 1 } = {}) {
  // Guard null/undefined explicitly — Number(null) is 0, which would fabricate P&L.
  if (premiumEntry === null || premiumEntry === undefined) return null;
  if (premiumExit === null || premiumExit === undefined) return null;
  const e = Number(premiumEntry);
  const x = Number(premiumExit);
  const q = Number(contracts) || 0;
  if (!Number.isFinite(e) || !Number.isFinite(x)) return null;
  return round2((x - e) * 100 * q);
}

/**
 * Classify a pending ENTRY (buy) order into a lifecycle action.
 * @returns {{action:'filled'|'dead'|'cancel_stale'|'wait', reason?:string}}
 */
export function classifyEntryOrder({ orderStatus, submittedAtMs, nowMs, timeoutMinutes = 10 } = {}) {
  const status = String(orderStatus ?? '').toLowerCase();
  if (FILLED_STATUSES.has(status)) return { action: 'filled' };
  if (DEAD_STATUSES.has(status)) return { action: 'dead', reason: `entry order ${status}` };
  const age = minutesBetween(nowMs, submittedAtMs);
  if (age !== null && age >= Number(timeoutMinutes)) {
    return { action: 'cancel_stale', reason: `entry unfilled ${Math.round(age)}m >= ${timeoutMinutes}m timeout` };
  }
  return { action: 'wait' };
}

/**
 * Decide the exit action for one OPEN bot long option given a fresh quote.
 * Deterministic priority: forced same-day close > stop-loss > take-profit >
 * max-hold > hold. `limitPrice` is a bid-derived marketable SELL limit (null
 * when there is no usable bid to price one).
 *
 * @returns {{action:'hold'|'take_profit'|'stop_loss'|'max_hold'|'forced_close', reason:string, limitPrice:number|null}}
 */
export function decideOptionExit({
  premiumEntry, quote, nowMs, openedAtMs, sessionCloseMs = null, config = {},
} = {}) {
  const {
    takeProfitPct = 0.5,
    stopLossPct = 0.5,
    maxHoldMinutes = 240,
    forceCloseBeforeCloseMinutes = 15,
    limitSlippagePct = 0.05,
  } = config;
  const bid = Number(quote?.bid);
  const entry = Number(premiumEntry);
  const hasBid = Number.isFinite(bid) && bid > 0;
  const sellLimit = (aggressive) =>
    hasBid ? exitLimitPrice({ bid, slippagePct: limitSlippagePct, aggressive }) : null;

  const closeMs = Number(sessionCloseMs);
  const forced =
    Number.isFinite(closeMs) && Number(nowMs) >= closeMs - Number(forceCloseBeforeCloseMinutes) * 60_000;
  if (forced) {
    return {
      action: 'forced_close',
      reason: 'mandatory same-day flatten before market close',
      limitPrice: sellLimit(true),
    };
  }

  if (!hasBid || !Number.isFinite(entry) || entry <= 0) {
    return { action: 'hold', reason: 'no usable bid/entry to evaluate exit; holding', limitPrice: null };
  }
  if (bid <= entry * (1 - Number(stopLossPct))) {
    return {
      action: 'stop_loss',
      reason: `bid ${round2(bid)} <= stop ${round2(entry * (1 - Number(stopLossPct)))}`,
      limitPrice: sellLimit(false),
    };
  }
  if (bid >= entry * (1 + Number(takeProfitPct))) {
    return {
      action: 'take_profit',
      reason: `bid ${round2(bid)} >= target ${round2(entry * (1 + Number(takeProfitPct)))}`,
      limitPrice: sellLimit(false),
    };
  }
  const age = minutesBetween(nowMs, openedAtMs);
  if (age !== null && age >= Number(maxHoldMinutes)) {
    return { action: 'max_hold', reason: `held ${Math.round(age)}m >= ${maxHoldMinutes}m`, limitPrice: sellLimit(false) };
  }
  return { action: 'hold', reason: 'within thresholds; holding', limitPrice: null };
}

/**
 * Whether a NEW option entry must be blocked right now (outside a valid regular
 * session, or within the pre-close no-entry cutoff). Fail-closed.
 * @returns {{blocked:boolean, reason:string}}
 */
export function optionEntryBlocked({
  nowMs, sessionOpen = false, sessionCloseMs = null, noEntryBeforeCloseMinutes = 30,
} = {}) {
  if (!sessionOpen) return { blocked: true, reason: 'option entry blocked: market session not open' };
  const closeMs = Number(sessionCloseMs);
  if (Number.isFinite(closeMs) && Number(nowMs) >= closeMs - Number(noEntryBeforeCloseMinutes) * 60_000) {
    return { blocked: true, reason: `option entry blocked: within ${noEntryBeforeCloseMinutes}m pre-close cutoff` };
  }
  return { blocked: false, reason: 'option entry allowed' };
}

/**
 * Decide what to do with a PENDING-EXIT (sell-to-close) order this cycle.
 * @returns {{action:'filled'|'requote'|'wait', reason?:string}}
 */
export function shouldRequoteExit({ orderStatus, exitSubmittedAtMs, nowMs, exitRetryMinutes = 5 } = {}) {
  const status = String(orderStatus ?? '').toLowerCase();
  if (FILLED_STATUSES.has(status)) return { action: 'filled' };
  if (DEAD_STATUSES.has(status)) return { action: 'requote', reason: `exit order ${status}; requote` };
  const age = minutesBetween(nowMs, exitSubmittedAtMs);
  if (age !== null && age >= Number(exitRetryMinutes)) {
    return { action: 'requote', reason: `exit unfilled ${Math.round(age)}m >= ${exitRetryMinutes}m; cancel+requote` };
  }
  return { action: 'wait' };
}
