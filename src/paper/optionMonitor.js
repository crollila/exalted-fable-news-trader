// src/paper/optionMonitor.js — Orchestrates monitored PAPER option execution.
//
// Reconciles bot-owned option rows (paper_option_trades) against Alpaca PAPER
// orders/positions, applies deterministic exits, and submits bounded
// sell-to-close LIMIT orders. Design guarantees:
//
// - BOT-OWNED ONLY: it iterates rows THIS bot persisted and looks up matching
//   broker positions/orders by OCC symbol. It never enumerates or closes
//   untracked/manual account positions.
// - LONG-ONLY / NEVER SELL-TO-OPEN: it only submits a `sell` after verifying the
//   bot still holds that long option at the broker. If positions cannot be read,
//   it DEFERS exits rather than risk a naked sell.
// - PAPER-ONLY + BOUNDED: every order is a limit/day order on the paper client.
// - NON-FATAL: every broker call is wrapped; failures become structured outcomes
//   in the returned summary. No throw escapes reconcileBotOptions().

import { listActiveBotOptionTrades, updatePaperOptionTrade } from '../database/paperRuntime.js';
import {
  classifyEntryOrder,
  decideOptionExit,
  shouldRequoteExit,
  realizedOptionPnl,
  exitLimitPrice,
  round2,
  DEAD_STATUSES,
  MAX_EXIT_ATTEMPTS,
} from './optionExits.js';

function ms(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isDead(status) {
  return DEAD_STATUSES.has(String(status ?? '').toLowerCase());
}

function isLong(position) {
  if (!position) return false;
  const qty = Number(position.qty);
  const side = String(position.side ?? '').toLowerCase();
  return (Number.isFinite(qty) && qty > 0) || side === 'long';
}

function exitLimitFromQuote(quote, opt, aggressive) {
  return exitLimitPrice({ bid: quote?.bid, slippagePct: opt.limitSlippagePct, aggressive });
}

export function emptyMonitorSummary() {
  return {
    checked: 0,
    entriesFilled: 0,
    entriesCanceled: 0,
    exitsSubmitted: 0,
    exitsFilled: 0,
    requotes: 0,
    unresolved: 0,
    holding: 0,
    pendingEntry: 0,
    pendingExit: 0,
    errors: [],
    events: [],
  };
}

/** Load bot-relevant option positions by OCC symbol. */
async function loadOptionPositions(paperClient) {
  try {
    const positions = await paperClient.getPositions();
    const map = new Map();
    for (const p of positions ?? []) {
      const sym = String(p?.symbol ?? '').toUpperCase();
      if (sym) map.set(sym, p);
    }
    return { ok: true, map };
  } catch (err) {
    return { ok: false, map: new Map(), error: err.message };
  }
}

/**
 * Reconcile every active bot-owned option row once. Injected paperClient + db so
 * tests run fully offline. Returns a sanitized summary (counts + event lines).
 *
 * @param {object} db
 * @param {object} deps
 * @param {object} deps.paperClient   getOrder/cancelOrder/getOptionQuote/submitOptionLimitOrder/getPositions
 * @param {object} deps.config        loadConfig() result (uses config.optionExecution)
 * @param {number} deps.nowMs
 * @param {{isOpen?:boolean, sessionCloseMs?:number|null}} deps.session
 * @param {(line:string)=>void} [deps.onLog]
 */
export async function reconcileBotOptions(
  db,
  { paperClient = null, config = {}, nowMs = Date.now(), session = {}, onLog = () => {} } = {}
) {
  const summary = emptyMonitorSummary();
  if (!paperClient) return summary;

  const opt = config.optionExecution ?? config ?? {};
  const sessionCloseMs = Number.isFinite(Number(session.sessionCloseMs)) ? Number(session.sessionCloseMs) : null;
  const log = (line) => { summary.events.push(line); onLog(line); };

  const rows = listActiveBotOptionTrades(db);
  if (rows.length === 0) return summary;

  const positions = await loadOptionPositions(paperClient);
  if (!positions.ok) summary.errors.push(`positions unavailable: ${positions.error}`);

  for (const row of rows) {
    summary.checked += 1;
    try {
      await reconcileOne(db, row, { paperClient, opt, nowMs, sessionCloseMs, positions, summary, log });
    } catch (err) {
      summary.errors.push(`option ${row.option_symbol}: ${err.message}`);
      log(`option ${row.option_symbol} reconcile error: ${err.message}`);
    }
  }
  return summary;
}

async function reconcileOne(db, row, ctx) {
  const { paperClient, opt, nowMs, sessionCloseMs, positions, summary, log } = ctx;
  const id = Number(row.id);
  const symbol = String(row.option_symbol).toUpperCase();
  const state = row.lifecycle_state || (row.status === 'open' ? 'open' : row.status);
  const nowIso = new Date(nowMs).toISOString();
  const touch = (updates = {}) => updatePaperOptionTrade(db, id, { lastCheckedAt: nowIso, ...updates });
  const pastClose = sessionCloseMs !== null && nowMs >= sessionCloseMs;

  // ---------------- pending_entry: poll buy; fill->open, stale->cancel --------
  if (state === 'pending_entry') {
    summary.pendingEntry += 1;
    if (!row.entry_order_id) {
      touch({ lifecycleState: 'unresolved', status: 'open', exitReason: 'pending_entry without a broker order id' });
      summary.unresolved += 1;
      log(`option ${symbol}: pending_entry with no order id -> unresolved`);
      return;
    }
    let order;
    try { order = await paperClient.getOrder(row.entry_order_id); }
    catch (err) { summary.errors.push(`entry poll ${symbol}: ${err.message}`); return; }
    const decision = classifyEntryOrder({
      orderStatus: order.status,
      submittedAtMs: ms(order.submittedAt) ?? ms(row.created_at),
      nowMs,
      timeoutMinutes: opt.entryTimeoutMinutes,
    });
    if (decision.action === 'filled') {
      const fillPx = order.filledAvgPrice ?? row.premium_entry ?? row.entry_limit_price ?? null;
      const notional = fillPx !== null ? round2(Number(fillPx) * 100 * Number(row.quantity)) : row.notional_entry;
      touch({
        lifecycleState: 'open', status: 'open', entryOrderStatus: 'filled',
        openedAt: order.submittedAt ?? nowIso, premiumEntry: fillPx, notionalEntry: notional ?? null,
      });
      summary.entriesFilled += 1;
      log(`option ${symbol}: entry FILLED @ ${fillPx ?? '?'} -> open`);
      return;
    }
    if (decision.action === 'dead') {
      touch({ lifecycleState: 'canceled', status: 'canceled', entryOrderStatus: order.status });
      summary.entriesCanceled += 1;
      log(`option ${symbol}: entry ${order.status} -> canceled (no position)`);
      return;
    }
    if (decision.action === 'cancel_stale') {
      let canceled = false;
      try { await paperClient.cancelOrder(row.entry_order_id); canceled = true; }
      catch (err) { summary.errors.push(`entry cancel ${symbol}: ${err.message}`); }
      if (canceled) {
        touch({ lifecycleState: 'canceled', status: 'canceled', entryOrderStatus: 'canceled' });
        summary.entriesCanceled += 1;
        log(`option ${symbol}: ${decision.reason} -> canceled`);
      } else {
        touch({ entryOrderStatus: order.status });
      }
      return;
    }
    touch({ entryOrderStatus: order.status });
    return;
  }

  // ---------------- open: value via quote; deterministic exit -> sell ---------
  if (state === 'open') {
    summary.holding += 1;
    const position = positions.map.get(symbol);
    if (positions.ok && !isLong(position)) {
      touch({
        lifecycleState: 'closed', status: 'closed', closedAt: nowIso,
        exitReason: 'position not held at broker (reconciled closed)',
      });
      log(`option ${symbol}: no broker long position -> reconciled closed`);
      return;
    }
    let quote = null;
    try { quote = await paperClient.getOptionQuote({ underlyingSymbol: row.underlying, optionSymbol: symbol }); }
    catch (err) { summary.errors.push(`quote ${symbol}: ${err.message}`); }
    const decision = decideOptionExit({
      premiumEntry: row.premium_entry, quote, nowMs,
      openedAtMs: ms(row.opened_at) ?? ms(row.created_at), sessionCloseMs, config: opt,
    });
    if (decision.action === 'hold') { touch({}); return; }

    if (!positions.ok) { summary.errors.push(`exit deferred ${symbol}: positions unavailable (no naked sell)`); return; }
    if (!isLong(position)) {
      touch({ lifecycleState: 'closed', status: 'closed', closedAt: nowIso, exitReason: 'no holding to close' });
      return;
    }
    if (decision.limitPrice === null) {
      if (decision.action === 'forced_close') {
        touch({ lifecycleState: 'unresolved', status: 'open', exitReason: 'forced close but no usable bid to price a limit' });
        summary.unresolved += 1;
        log(`option ${symbol}: UNRESOLVED — forced close without a usable bid`);
      } else { touch({}); }
      return;
    }
    const qty = Math.min(Number(row.quantity), Math.max(1, Math.floor(Number(position?.qty) || Number(row.quantity))));
    let order;
    try { order = await paperClient.submitOptionLimitOrder({ optionSymbol: symbol, qty, side: 'sell', limitPrice: decision.limitPrice }); }
    catch (err) { summary.errors.push(`exit submit ${symbol}: ${err.message}`); return; }
    touch({
      lifecycleState: 'pending_exit', exitOrderId: order.id, exitOrderStatus: order.status,
      exitLimitPrice: decision.limitPrice, exitReason: decision.action,
      exitAttempts: Number(row.exit_attempts || 0) + 1,
    });
    summary.exitsSubmitted += 1;
    log(`option ${symbol}: ${decision.action} -> sell-to-close ${qty} @ limit ${decision.limitPrice} (order ${order.id ?? '?'})`);
    return;
  }

  // ---------------- pending_exit: poll sell; fill->closed, else requote -------
  if (state === 'pending_exit') {
    summary.pendingExit += 1;
    let order = null;
    if (row.exit_order_id) {
      try { order = await paperClient.getOrder(row.exit_order_id); }
      catch (err) { summary.errors.push(`exit poll ${symbol}: ${err.message}`); return; }
    }
    const decision = shouldRequoteExit({
      orderStatus: order?.status,
      exitSubmittedAtMs: ms(order?.submittedAt) ?? ms(row.last_checked_at),
      nowMs,
      exitRetryMinutes: opt.exitRetryMinutes,
    });
    if (decision.action === 'filled') {
      const exitPx = order.filledAvgPrice ?? row.exit_limit_price ?? null;
      const notionalExit = exitPx !== null ? round2(Number(exitPx) * 100 * Number(row.quantity)) : null;
      const pnl = realizedOptionPnl({ premiumEntry: row.premium_entry, premiumExit: exitPx, contracts: row.quantity });
      touch({
        lifecycleState: 'closed', status: 'closed', exitOrderStatus: 'filled',
        premiumExit: exitPx, notionalExit, realizedPnlUsd: pnl, closedAt: nowIso,
      });
      summary.exitsFilled += 1;
      log(`option ${symbol}: exit FILLED @ ${exitPx ?? '?'} pnl ${pnl ?? '?'} -> closed`);
      return;
    }
    if (decision.action === 'wait') { touch({ exitOrderStatus: order?.status }); return; }

    // requote: cancel any still-live order, then resubmit a fresh marketable sell.
    if (row.exit_order_id && !isDead(order?.status)) {
      try { await paperClient.cancelOrder(row.exit_order_id); }
      catch (err) { summary.errors.push(`exit cancel ${symbol}: ${err.message}`); }
    }
    const attempts = Number(row.exit_attempts || 0);
    if (attempts >= MAX_EXIT_ATTEMPTS && pastClose) {
      touch({ lifecycleState: 'unresolved', status: 'open', exitReason: `unfilled after ${attempts} attempts past close` });
      summary.unresolved += 1;
      log(`option ${symbol}: UNRESOLVED — sell-to-close unfilled after ${attempts} attempts`);
      return;
    }
    const position = positions.map.get(symbol);
    if (positions.ok && !isLong(position)) {
      const pnl = realizedOptionPnl({ premiumEntry: row.premium_entry, premiumExit: row.exit_limit_price, contracts: row.quantity });
      touch({ lifecycleState: 'closed', status: 'closed', exitOrderStatus: 'filled', realizedPnlUsd: pnl, closedAt: nowIso, exitReason: 'position closed at broker during requote' });
      summary.exitsFilled += 1;
      return;
    }
    if (!positions.ok) { summary.errors.push(`requote deferred ${symbol}: positions unavailable`); return; }
    let quote = null;
    try { quote = await paperClient.getOptionQuote({ underlyingSymbol: row.underlying, optionSymbol: symbol }); }
    catch (err) { summary.errors.push(`requote quote ${symbol}: ${err.message}`); }
    const limitPrice = exitLimitFromQuote(quote, opt, pastClose);
    if (limitPrice === null) {
      touch({ lifecycleState: 'unresolved', status: 'open', exitReason: 'requote without a usable bid to price a limit', exitAttempts: attempts + 1 });
      summary.unresolved += 1;
      log(`option ${symbol}: UNRESOLVED — requote without a usable bid`);
      return;
    }
    const qty = Math.min(Number(row.quantity), Math.max(1, Math.floor(Number(position?.qty) || Number(row.quantity))));
    let order2;
    try { order2 = await paperClient.submitOptionLimitOrder({ optionSymbol: symbol, qty, side: 'sell', limitPrice }); }
    catch (err) { summary.errors.push(`requote submit ${symbol}: ${err.message}`); touch({ exitAttempts: attempts + 1 }); return; }
    touch({ exitOrderId: order2.id, exitOrderStatus: order2.status, exitLimitPrice: limitPrice, exitAttempts: attempts + 1 });
    summary.requotes += 1;
    log(`option ${symbol}: requote sell-to-close ${qty} @ limit ${limitPrice} (order ${order2.id ?? '?'})`);
    return;
  }

  // ---------------- unresolved: keep loudly reported; no auto action ----------
  if (state === 'unresolved') { summary.unresolved += 1; }
}
