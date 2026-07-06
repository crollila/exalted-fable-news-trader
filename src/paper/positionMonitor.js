// src/paper/positionMonitor.js — Close open PAPER equity positions when the
// exit policy says so (take-profit / stop-loss / max-hold).
//
// Runs at the START of every trade cycle, BEFORE new entries and regardless of
// the kill switch (closing positions reduces risk; the switch only blocks new
// entries). Dry-run cycles only REPORT would-exit decisions; orders are
// submitted only when executePaper is true and a paper client exists.
//
// Exit lifecycle on paper_trades (columns from migration 012):
// - decision -> submit market exit -> exit_order_id/status/submitted_at
// - broker-confirmed fill (immediately or a later poll) -> exit_price,
//   exit_at, exit_reason, pnl_usd, broker_realized_pnl_usd, status='closed'
// - canceled/rejected/expired without a fill -> exit_order_id cleared so the
//   next cycle can retry
// Current prices come from the broker positions snapshot (market value /
// quantity) — no extra market-data calls and no lagged-feed dependency.

import { classifyBrokerOrderState } from './brokerTruth.js';
import { assessExit, DEFAULT_EXIT_PARAMS } from './exitPolicy.js';

function finiteNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = finiteNum(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

/** Open bot-owned equity rows with a broker-confirmed entry fill (exitable). */
export function listOpenExitablePaperTrades(db, { limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT * FROM paper_trades
        WHERE status = 'open'
          AND broker_order_id IS NOT NULL
          AND broker_filled_qty IS NOT NULL AND broker_filled_qty > 0
          AND broker_filled_avg_price IS NOT NULL AND broker_filled_avg_price > 0
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(Number.parseInt(limit, 10) || 200);
}

/** Signed realized P&L for a completed round trip (short = entry - exit). */
export function realizedExitPnl({ side, entryPrice, exitPrice, quantity }) {
  const entry = finiteNum(entryPrice);
  const exit = finiteNum(exitPrice);
  const qty = finiteNum(quantity);
  if (entry === null || exit === null || qty === null) return null;
  const perShare = side === 'sell' ? entry - exit : exit - entry;
  return round2(perShare * qty);
}

function closeTradeRow(db, row, { exitPrice, exitAt, reason, orderStatus = null }) {
  const pnl = realizedExitPnl({
    side: row.side,
    entryPrice: row.broker_filled_avg_price,
    exitPrice,
    quantity: row.broker_filled_qty,
  });
  db.prepare(
    `UPDATE paper_trades
        SET status = 'closed',
            exit_price = @exitPrice,
            exit_at = @exitAt,
            exit_reason = @reason,
            pnl_usd = @pnl,
            broker_realized_pnl_usd = @pnl,
            exit_order_status = COALESCE(@orderStatus, exit_order_status)
      WHERE id = @id`
  ).run({ id: row.id, exitPrice: finiteNum(exitPrice), exitAt, reason, pnl, orderStatus });
  return pnl;
}

function recordExitOrder(db, rowId, { orderId, orderStatus, submittedAt, reason }) {
  db.prepare(
    `UPDATE paper_trades
        SET exit_order_id = @orderId,
            exit_order_status = @orderStatus,
            exit_submitted_at = @submittedAt,
            exit_reason = @reason
      WHERE id = @rowId`
  ).run({ rowId, orderId, orderStatus, submittedAt, reason });
}

function clearExitOrder(db, rowId, { orderStatus }) {
  db.prepare(
    `UPDATE paper_trades
        SET exit_order_id = NULL,
            exit_order_status = @orderStatus,
            exit_submitted_at = NULL
      WHERE id = @rowId`
  ).run({ rowId, orderStatus });
}

function positionMap(positions = []) {
  const map = new Map();
  for (const p of positions ?? []) {
    const sym = String(p?.symbol ?? '').trim().toUpperCase();
    if (sym) map.set(sym, p);
  }
  return map;
}

/** Effective per-share price from a broker position snapshot (sign-safe). */
export function positionPrice(position) {
  const qty = finiteNum(position?.qty);
  const marketValue = finiteNum(position?.marketValue);
  if (qty === null || qty === 0 || marketValue === null) return null;
  const price = Math.abs(marketValue / qty);
  return price > 0 ? price : null;
}

/**
 * One monitor pass over every open exitable position. Never throws for a
 * single-position failure — errors are counted and reported in lines.
 */
export async function monitorOpenEquityPositions(
  db,
  {
    paperClient = null,
    nowMs = Date.now(),
    executePaper = false,
    exitParams = DEFAULT_EXIT_PARAMS,
    exitParamsExplanation = null,
  } = {}
) {
  const result = {
    checked: 0, pendingPolled: 0, exitsPlanned: 0,
    exitsSubmitted: 0, exitsFilled: 0, errors: 0, lines: [],
  };
  const rows = listOpenExitablePaperTrades(db);
  if (rows.length === 0) return result;

  result.lines.push(
    `Position monitor: ${rows.length} open position(s); exits tp=${(exitParams.takeProfitPct * 100).toFixed(2)}% ` +
      `sl=${(exitParams.stopLossPct * 100).toFixed(2)}% maxHold=${exitParams.maxHoldMinutes}m` +
      `${exitParamsExplanation ? ` (${exitParamsExplanation})` : ''}`
  );

  let positionsBySymbol = null;
  if (paperClient) {
    try {
      positionsBySymbol = positionMap(await paperClient.getPositions());
    } catch (err) {
      result.lines.push(`  positions unavailable: ${err.message}`);
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  for (const row of rows) {
    result.checked += 1;
    const symbol = String(row.ticker ?? '').trim().toUpperCase();

    // 1. A pending exit order from an earlier pass: poll it to completion.
    if (row.exit_order_id && paperClient) {
      result.pendingPolled += 1;
      try {
        const order = await paperClient.getOrder(row.exit_order_id);
        const state = classifyBrokerOrderState(order);
        const filledQty = finiteNum(order.filledQty);
        const filledAvgPrice = finiteNum(order.filledAvgPrice);
        if (filledQty !== null && filledQty > 0 && filledAvgPrice !== null) {
          const pnl = closeTradeRow(db, row, {
            exitPrice: filledAvgPrice,
            exitAt: order.filledAt ?? nowIso,
            reason: row.exit_reason ?? 'exit_filled',
            orderStatus: order.status ?? null,
          });
          result.exitsFilled += 1;
          result.lines.push(`  ${symbol}: exit CONFIRMED at ${filledAvgPrice} (${row.exit_reason ?? 'exit'}) pnl=$${pnl}`);
        } else if (['canceled', 'rejected', 'expired'].includes(state)) {
          clearExitOrder(db, row.id, { orderStatus: order.status ?? state });
          result.lines.push(`  ${symbol}: exit order ${row.exit_order_id} ${state} with no fill — will retry`);
        }
      } catch (err) {
        result.errors += 1;
        result.lines.push(`  ${symbol}: exit order poll failed: ${err.message}`);
      }
      continue;
    }

    // 2. No pending exit: evaluate the exit policy.
    const position = positionsBySymbol?.get(symbol) ?? null;
    const decision = assessExit({
      side: row.side,
      entryPrice: row.broker_filled_avg_price,
      currentPrice: positionPrice(position),
      entryAt: row.entry_at ?? row.created_at,
      nowMs,
      params: exitParams,
    });
    if (!decision.exit) continue;

    result.exitsPlanned += 1;
    const retTxt = decision.returnPct === null ? 'n/a' : `${(decision.returnPct * 100).toFixed(2)}%`;
    if (!executePaper || !paperClient) {
      result.lines.push(`  ${symbol}: WOULD EXIT (${decision.reason}, return=${retTxt}) — dry run, no order sent`);
      continue;
    }

    // 3. Submit the market exit (sell closes a long; buy covers a short).
    const exitSide = row.side === 'buy' ? 'sell' : 'buy';
    try {
      const order = await paperClient.submitMarketOrder({
        symbol,
        qty: row.broker_filled_qty,
        side: exitSide,
      });
      result.exitsSubmitted += 1;
      const filledQty = finiteNum(order.filledQty);
      const filledAvgPrice = finiteNum(order.filledAvgPrice);
      if (filledQty !== null && filledQty > 0 && filledAvgPrice !== null) {
        const pnl = closeTradeRow(db, row, {
          exitPrice: filledAvgPrice,
          exitAt: order.filledAt ?? nowIso,
          reason: decision.reason,
          orderStatus: order.status ?? null,
        });
        result.exitsFilled += 1;
        result.lines.push(`  ${symbol}: EXITED ${decision.reason} at ${filledAvgPrice} (return=${retTxt}) pnl=$${pnl}`);
      } else {
        recordExitOrder(db, row.id, {
          orderId: order.id ?? null,
          orderStatus: order.status ?? null,
          submittedAt: order.submittedAt ?? nowIso,
          reason: decision.reason,
        });
        result.lines.push(`  ${symbol}: exit ${decision.reason} SUBMITTED (order ${order.id ?? '?'}, awaiting fill)`);
      }
    } catch (err) {
      result.errors += 1;
      result.lines.push(`  ${symbol}: exit submit failed: ${err.message}`);
    }
  }
  return result;
}
