// src/paper/brokerTruth.js - PAPER broker truth + aligned benchmark snapshots.
//
// This module is read/reconcile/report only. It never submits orders, never
// cancels orders, never touches live endpoints, and never treats broker-wide
// manual account activity as ExaltedFable-owned strategy exposure.

import {
  findBaselineBrokerAccountSnapshot,
  getBrokerAccountSnapshot,
  insertBrokerAccountSnapshot,
  insertStrategyPerformanceSnapshot,
  listPaperTradesForBrokerReconciliation,
  updatePaperOptionTrade,
  updatePaperTradeBrokerTruth,
} from '../database/paperRuntime.js';

const LEGACY_ORDER_RE = /paper order\s+([A-Za-z0-9_-]+)/i;
const OWNED_OPTION_ORDER_LIMIT = 500;
const BENCHMARK_LOOKBACK_MINUTES = 60;

function numOrNull(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function positiveNum(value) {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : null;
}

function round2(value) {
  const n = numOrNull(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function warningMessage(err) {
  return String(err?.message ?? err ?? 'unknown error');
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function optionLifecycle(row) {
  return row.lifecycle_state || (row.status === 'closed' ? 'closed' : row.status === 'canceled' ? 'canceled' : 'open');
}

function emptyOrderCounts() {
  return {
    submitted: 0,
    filled: 0,
    fullyFilled: 0,
    partiallyFilled: 0,
    open: 0,
    canceled: 0,
    rejected: 0,
    expired: 0,
    replaced: 0,
    unknown: 0,
    errors: 0,
  };
}

export function extractBrokerOrderId(row) {
  const direct = String(row?.broker_order_id ?? '').trim();
  if (direct) return direct;
  const legacy = LEGACY_ORDER_RE.exec(String(row?.trade_reason ?? ''));
  return legacy?.[1] ?? null;
}

export function classifyBrokerOrderState(orderOrStatus) {
  const order = typeof orderOrStatus === 'string' ? { status: orderOrStatus } : orderOrStatus;
  const status = String(order?.status ?? '').trim().toLowerCase();
  const filledQty = numOrNull(order?.filledQty);

  if (!status) return filledQty !== null && filledQty > 0 ? 'partially_filled' : 'unknown';
  if (status === 'filled') return 'filled';
  if (status === 'partially_filled') return 'partially_filled';
  if (status === 'canceled' || status === 'cancelled') return 'canceled';
  if (status === 'rejected') return 'rejected';
  if (status === 'expired') return 'expired';
  if (status === 'replaced') return 'replaced';
  if (status === 'done_for_day') return filledQty !== null && filledQty > 0 ? 'partially_filled' : 'expired';
  if (['new', 'accepted', 'accepted_for_bidding', 'pending_new', 'pending_replace', 'pending_cancel', 'held', 'stopped', 'suspended', 'calculated'].includes(status)) {
    return filledQty !== null && filledQty > 0 ? 'partially_filled' : 'pending';
  }
  return filledQty !== null && filledQty > 0 ? 'partially_filled' : 'unknown';
}

function countBrokerOrder(counts, order, state) {
  counts.submitted += 1;
  const filledQty = numOrNull(order?.filledQty);
  const hasFill = (filledQty !== null && filledQty > 0) || state === 'filled';
  if (hasFill) counts.filled += 1;
  if (state === 'filled') counts.fullyFilled += 1;
  else if (state === 'partially_filled') {
    counts.partiallyFilled += 1;
    counts.open += 1;
  } else if (state === 'pending') counts.open += 1;
  else if (state === 'canceled') counts.canceled += 1;
  else if (state === 'rejected') counts.rejected += 1;
  else if (state === 'expired') counts.expired += 1;
  else if (state === 'replaced') counts.replaced += 1;
  else counts.unknown += 1;
}

function positionMap(positions = []) {
  const map = new Map();
  for (const p of positions ?? []) {
    const sym = String(p?.symbol ?? '').trim().toUpperCase();
    if (sym) map.set(sym, p);
  }
  return map;
}

function brokerLocalStatus({ row, state, filledQty, positionsAvailable, position }) {
  if (row.status === 'closed') return 'closed';
  if (['canceled', 'rejected', 'expired'].includes(state) && !(filledQty > 0)) return 'canceled';
  if ((state === 'filled' || state === 'partially_filled') && positionsAvailable && !position) return 'closed';
  return 'open';
}

async function reconcileEquityRows(db, { paperClient, nowIso, positionsAvailable, positionsBySymbol, counts, warnings }) {
  const rows = listPaperTradesForBrokerReconciliation(db);
  for (const row of rows) {
    const brokerOrderId = extractBrokerOrderId(row);
    if (!brokerOrderId) continue;

    let order = null;
    try {
      order = await paperClient.getOrder(brokerOrderId);
    } catch (err) {
      counts.submitted += 1;
      counts.errors += 1;
      warnings.push(`equity order ${brokerOrderId} unavailable: ${warningMessage(err)}`);
      updatePaperTradeBrokerTruth(db, row.id, {
        brokerOrderId,
        brokerReconciledAt: nowIso,
        brokerPositionQty: positionsAvailable ? null : undefined,
        brokerPositionMarketValue: positionsAvailable ? null : undefined,
        brokerUnrealizedPl: positionsAvailable ? null : undefined,
      });
      continue;
    }

    const state = classifyBrokerOrderState(order);
    countBrokerOrder(counts, order, state);
    const symbol = String(row.ticker ?? order.symbol ?? '').trim().toUpperCase();
    const position = positionsBySymbol.get(symbol) ?? null;
    const filledQty = numOrNull(order.filledQty);
    const filledAvgPrice = numOrNull(order.filledAvgPrice);
    const status = brokerLocalStatus({ row, state, filledQty, positionsAvailable, position });
    const hasFill = filledQty !== null && filledQty > 0 && filledAvgPrice !== null;

    updatePaperTradeBrokerTruth(db, row.id, {
      brokerOrderId,
      brokerClientOrderId: order.clientOrderId ?? null,
      brokerOrderStatus: order.status ?? null,
      brokerOrderType: order.type ?? null,
      brokerSubmittedAt: order.submittedAt ?? null,
      brokerFilledQty: filledQty,
      brokerFilledAvgPrice: filledAvgPrice,
      brokerFilledAt: order.filledAt ?? null,
      brokerCanceledAt: order.canceledAt ?? null,
      brokerExpiredAt: order.expiredAt ?? null,
      brokerReplacedAt: order.replacedAt ?? null,
      brokerUpdatedAt: order.updatedAt ?? null,
      brokerReconciledAt: nowIso,
      brokerTruthState: state,
      brokerPositionQty: positionsAvailable ? numOrNull(position?.qty) : null,
      brokerPositionMarketValue: positionsAvailable ? numOrNull(position?.marketValue) : null,
      brokerUnrealizedPl: positionsAvailable ? numOrNull(position?.unrealizedPl) : null,
      fillPrice: hasFill ? filledAvgPrice : undefined,
      entryAt: hasFill ? (order.filledAt ?? order.submittedAt ?? row.entry_at ?? null) : undefined,
      status,
    });
  }
}

function realizedOptionPnl({ entryPrice, exitPrice, contracts }) {
  const entry = numOrNull(entryPrice);
  const exit = numOrNull(exitPrice);
  const qty = numOrNull(contracts);
  if (entry === null || exit === null || qty === null) return null;
  return round2((exit - entry) * 100 * qty);
}

function optionStatusFromOrder({ row, state, filledQty, positionsAvailable, position }) {
  const lifecycle = optionLifecycle(row);
  if (lifecycle === 'closed' || row.status === 'closed') return { status: 'closed', lifecycleState: 'closed' };
  if (['canceled', 'rejected', 'expired'].includes(state) && !(filledQty > 0)) {
    return { status: 'canceled', lifecycleState: 'canceled' };
  }
  if ((state === 'filled' || state === 'partially_filled') && positionsAvailable && !position) {
    return { status: 'closed', lifecycleState: 'closed' };
  }
  if ((state === 'filled' || state === 'partially_filled') && filledQty > 0) {
    return { status: 'open', lifecycleState: 'open' };
  }
  return { status: 'open', lifecycleState: lifecycle };
}

async function reconcileOptionRows(db, { paperClient, nowIso, positionsAvailable, positionsBySymbol, counts, warnings }) {
  const rows = db
    .prepare(
      `SELECT *
         FROM paper_option_trades
        WHERE entry_order_id IS NOT NULL
           OR exit_order_id IS NOT NULL
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(OWNED_OPTION_ORDER_LIMIT);

  for (const row of rows) {
    const symbol = String(row.option_symbol ?? '').trim().toUpperCase();
    const position = positionsBySymbol.get(symbol) ?? null;
    const basePositionUpdate = {
      brokerPositionQty: positionsAvailable ? numOrNull(position?.qty) : null,
      brokerPositionMarketValue: positionsAvailable ? numOrNull(position?.marketValue) : null,
      brokerUnrealizedPl: positionsAvailable ? numOrNull(position?.unrealizedPl) : null,
      lastCheckedAt: nowIso,
    };

    if (row.entry_order_id) {
      let order = null;
      try {
        order = await paperClient.getOrder(row.entry_order_id);
      } catch (err) {
        counts.submitted += 1;
        counts.errors += 1;
        warnings.push(`option entry order ${row.entry_order_id} unavailable: ${warningMessage(err)}`);
      }
      if (order) {
        const state = classifyBrokerOrderState(order);
        countBrokerOrder(counts, order, state);
        const filledQty = numOrNull(order.filledQty);
        const filledAvgPrice = numOrNull(order.filledAvgPrice);
        const filledAt = order.filledAt ?? null;
        const statusUpdate = optionStatusFromOrder({ row, state, filledQty, positionsAvailable, position });
        const notionalEntry =
          filledQty !== null && filledQty > 0 && filledAvgPrice !== null
            ? round2(filledQty * filledAvgPrice * 100)
            : undefined;
        const updates = {
          ...basePositionUpdate,
          entryOrderStatus: order.status ?? null,
          entryFilledQty: filledQty,
          entryFilledAvgPrice: filledAvgPrice,
          entryFilledAt: filledAt,
          ...statusUpdate,
        };
        const openedAt = filledAt ?? (filledQty !== null && filledQty > 0 ? order.submittedAt : null);
        if (openedAt) updates.openedAt = openedAt;
        if (filledAvgPrice !== null) updates.premiumEntry = filledAvgPrice;
        if (notionalEntry !== undefined) updates.notionalEntry = notionalEntry;
        updatePaperOptionTrade(db, row.id, updates);
      } else {
        updatePaperOptionTrade(db, row.id, basePositionUpdate);
      }
    } else {
      updatePaperOptionTrade(db, row.id, basePositionUpdate);
    }

    if (row.exit_order_id) {
      let order = null;
      try {
        order = await paperClient.getOrder(row.exit_order_id);
      } catch (err) {
        counts.submitted += 1;
        counts.errors += 1;
        warnings.push(`option exit order ${row.exit_order_id} unavailable: ${warningMessage(err)}`);
      }
      if (!order) continue;

      const state = classifyBrokerOrderState(order);
      countBrokerOrder(counts, order, state);
      const filledQty = numOrNull(order.filledQty);
      const filledAvgPrice = numOrNull(order.filledAvgPrice);
      const filledAt = order.filledAt ?? null;
      const updates = {
        lastCheckedAt: nowIso,
        exitOrderStatus: order.status ?? null,
        exitFilledQty: filledQty,
        exitFilledAvgPrice: filledAvgPrice,
        exitFilledAt: filledAt,
      };
      if (filledQty !== null && filledQty > 0 && filledAvgPrice !== null) {
        updates.status = 'closed';
        updates.lifecycleState = 'closed';
        updates.closedAt = filledAt ?? nowIso;
        updates.premiumExit = filledAvgPrice;
        updates.notionalExit = round2(filledQty * filledAvgPrice * 100);
        updates.realizedPnlUsd = realizedOptionPnl({
          entryPrice: row.entry_filled_avg_price ?? row.premium_entry,
          exitPrice: filledAvgPrice,
          contracts: filledQty,
        });
      }
      updatePaperOptionTrade(db, row.id, updates);
    }
  }
}

export async function reconcileBrokerTruth(
  db,
  { paperClient = null, nowMs = Date.now() } = {}
) {
  const nowIso = iso(nowMs);
  const warnings = [];
  const counts = emptyOrderCounts();

  if (!paperClient) {
    return {
      reconciledAt: nowIso,
      orders: counts,
      positionsAvailable: false,
      warnings: ['paper client unavailable; broker reconciliation skipped'],
      dataQuality: 'unavailable',
    };
  }

  let positions = [];
  let positionsAvailable = false;
  try {
    positions = await paperClient.getPositions();
    positionsAvailable = true;
  } catch (err) {
    warnings.push(`positions unavailable: ${warningMessage(err)}`);
  }
  const positionsBySymbol = positionMap(positions);

  await reconcileEquityRows(db, { paperClient, nowIso, positionsAvailable, positionsBySymbol, counts, warnings });
  await reconcileOptionRows(db, { paperClient, nowIso, positionsAvailable, positionsBySymbol, counts, warnings });

  return {
    reconciledAt: nowIso,
    orders: counts,
    positionsAvailable,
    warnings,
    dataQuality: warnings.length === 0 ? 'complete' : 'limited',
  };
}

export function calculateBotStrategyExposure(db, { positionsAvailable = true } = {}) {
  let grossExposure = 0;
  let openPositionCount = 0;
  let knownRealizedPnl = 0;
  let realizedPnlKnown = false;

  const equityRows = listPaperTradesForBrokerReconciliation(db);
  for (const row of equityRows) {
    const state = String(row.broker_truth_state ?? '').toLowerCase();
    const filledQty = positiveNum(row.broker_filled_qty);
    const fillPrice = positiveNum(row.broker_filled_avg_price);
    if (row.broker_realized_pnl_usd !== null && row.broker_realized_pnl_usd !== undefined) {
      knownRealizedPnl += Number(row.broker_realized_pnl_usd) || 0;
      realizedPnlKnown = true;
    }
    if (!positionsAvailable || row.status !== 'open' || !['filled', 'partially_filled'].includes(state)) continue;
    if (filledQty === null || fillPrice === null) continue;
    grossExposure += Math.abs(filledQty * fillPrice);
    openPositionCount += 1;
  }

  const optionRows = db
    .prepare(
      `SELECT *
         FROM paper_option_trades
        WHERE entry_order_id IS NOT NULL
           OR exit_order_id IS NOT NULL
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(OWNED_OPTION_ORDER_LIMIT);
  for (const row of optionRows) {
    if (row.realized_pnl_usd !== null && row.realized_pnl_usd !== undefined) {
      knownRealizedPnl += Number(row.realized_pnl_usd) || 0;
      realizedPnlKnown = true;
    }
    const lifecycle = optionLifecycle(row);
    if (!positionsAvailable || !['open', 'pending_exit', 'unresolved'].includes(lifecycle) || row.status !== 'open') continue;
    const filledQty = positiveNum(row.entry_filled_qty);
    const fillPrice = positiveNum(row.entry_filled_avg_price);
    if (filledQty === null || fillPrice === null) continue;
    grossExposure += Math.abs(filledQty * fillPrice * 100);
    openPositionCount += 1;
  }

  return {
    grossExposure: positionsAvailable ? round2(grossExposure) : null,
    openPositionCount,
    realizedPnlUsd: realizedPnlKnown ? round2(knownRealizedPnl) : null,
  };
}

export async function fetchAlignedBenchmarkPrice(
  priceSource,
  { ticker = 'SPY', targetAt, lookbackMinutes = BENCHMARK_LOOKBACK_MINUTES } = {}
) {
  if (!priceSource) return { available: false, price: null, at: null, warning: `${ticker} benchmark price source unavailable` };
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) return { available: false, price: null, at: null, warning: `${ticker} benchmark target timestamp invalid` };
  const fromIso = iso(targetMs - lookbackMinutes * 60_000);
  const toIso = iso(targetMs);
  try {
    const trades = await priceSource.getTradesAround(ticker, fromIso, toIso);
    const eligible = (Array.isArray(trades) ? trades : [])
      .filter((t) => positiveNum(t?.price) !== null && Date.parse(t?.at) <= targetMs)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = eligible[eligible.length - 1] ?? null;
    if (!latest) {
      return { available: false, price: null, at: null, warning: `${ticker} benchmark unavailable at ${targetAt}` };
    }
    return { available: true, price: Number(latest.price), at: latest.at, warning: null };
  } catch (err) {
    return { available: false, price: null, at: null, warning: `${ticker} benchmark unavailable: ${warningMessage(err)}` };
  }
}

function safeReturn(current, baseline) {
  const cur = numOrNull(current);
  const base = numOrNull(baseline);
  if (cur === null || base === null || base <= 0) return null;
  return (cur - base) / base;
}

export async function recordPerformanceSnapshot(
  db,
  {
    paperClient = null,
    priceSource = null,
    runtimeSessionId = null,
    nowMs = Date.now(),
    snapshotKind = 'reconcile',
    benchmarkTicker = 'SPY',
  } = {}
) {
  const snapshotAt = iso(nowMs);
  const warnings = [];
  const broker = await reconcileBrokerTruth(db, { paperClient, nowMs });
  warnings.push(...broker.warnings);

  let account = null;
  if (!paperClient) {
    warnings.push('paper client unavailable; account snapshot unavailable');
  } else {
    try {
      account = await paperClient.getAccount();
    } catch (err) {
      warnings.push(`account snapshot unavailable: ${warningMessage(err)}`);
    }
  }

  const accountSnapshot = insertBrokerAccountSnapshot(db, {
    runtimeSessionId,
    snapshotAt,
    snapshotKind,
    accountStatus: account?.status ?? null,
    equity: account?.equity ?? null,
    portfolioValue: account?.portfolioValue ?? null,
    cash: account?.cash ?? null,
    buyingPower: account?.buyingPower ?? null,
    dataQuality: account ? (broker.warnings.length === 0 ? 'complete' : 'limited') : 'unavailable',
    warnings,
  });

  const day = snapshotAt.slice(0, 10);
  let baseline = findBaselineBrokerAccountSnapshot(db, { runtimeSessionId, day });
  if (!baseline && accountSnapshot?.id) baseline = getBrokerAccountSnapshot(db, accountSnapshot.id);

  const currentEquity = numOrNull(account?.equity);
  const baselineEquity = numOrNull(baseline?.equity);
  const brokerAccountReturn = safeReturn(currentEquity, baselineEquity);
  if (currentEquity === null) warnings.push('broker account return unavailable: broker equity unavailable');
  else if (baselineEquity === null) warnings.push('broker account return unavailable: broker baseline equity unavailable');

  let spyBaseline = { available: false, price: null, at: null, warning: `${benchmarkTicker} benchmark baseline unavailable` };
  let spyCurrent = { available: false, price: null, at: null, warning: `${benchmarkTicker} benchmark current unavailable` };
  if (baseline?.snapshot_at) {
    spyBaseline = await fetchAlignedBenchmarkPrice(priceSource, { ticker: benchmarkTicker, targetAt: baseline.snapshot_at });
  }
  spyCurrent = await fetchAlignedBenchmarkPrice(priceSource, { ticker: benchmarkTicker, targetAt: snapshotAt });
  if (!spyBaseline.available && spyBaseline.warning) warnings.push(spyBaseline.warning);
  if (!spyCurrent.available && spyCurrent.warning) warnings.push(spyCurrent.warning);

  const spyReturn = safeReturn(spyCurrent.price, spyBaseline.price);
  if (spyReturn === null) warnings.push(`${benchmarkTicker} session return unavailable`);
  const brokerAccountExcessReturn =
    brokerAccountReturn !== null && spyReturn !== null ? brokerAccountReturn - spyReturn : null;
  if (brokerAccountExcessReturn === null) warnings.push(`broker account excess return versus ${benchmarkTicker} unavailable`);

  const exposure = calculateBotStrategyExposure(db, { positionsAvailable: broker.positionsAvailable });
  const dataQuality = account ? (warnings.length === 0 ? 'complete' : 'limited') : 'unavailable';
  const performanceSnapshot = insertStrategyPerformanceSnapshot(db, {
    runtimeSessionId,
    accountSnapshotId: accountSnapshot.id,
    baselineAccountSnapshotId: baseline?.id ?? null,
    snapshotAt,
    snapshotKind,
    brokerEquityBaseline: baselineEquity,
    brokerEquityCurrent: currentEquity,
    brokerPortfolioValueCurrent: account?.portfolioValue ?? null,
    brokerAccountReturnPct: brokerAccountReturn,
    spyBaselineAt: spyBaseline.at,
    spyBaselinePrice: spyBaseline.price,
    spyCurrentAt: spyCurrent.at,
    spyCurrentPrice: spyCurrent.price,
    spyReturnPct: spyReturn,
    brokerAccountExcessReturnPct: brokerAccountExcessReturn,
    botGrossExposure: exposure.grossExposure,
    botRealizedPnlUsd: exposure.realizedPnlUsd,
    botOpenPositionCount: exposure.openPositionCount,
    botOrdersSubmitted: broker.orders.submitted,
    botOrdersFilled: broker.orders.filled,
    botOrdersOpen: broker.orders.open,
    botOrdersCanceled: broker.orders.canceled,
    botOrdersRejected: broker.orders.rejected,
    botOrdersExpired: broker.orders.expired,
    botOrdersReplaced: broker.orders.replaced,
    dataQuality,
    warnings,
  });

  return {
    snapshotAt,
    accountSnapshotId: accountSnapshot.id,
    performanceSnapshotId: performanceSnapshot.id,
    broker,
    exposure,
    account,
    baseline,
    brokerAccountReturn,
    botReturn: null,
    botReturnUnavailableReason: 'unavailable: no bot-owned broker-confirmed capital baseline',
    spyReturn,
    brokerAccountExcessReturn,
    spyBaseline,
    spyCurrent,
    dataQuality,
    warnings,
  };
}

export function formatReturn(value) {
  const n = numOrNull(value);
  if (n === null) return 'unavailable';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtMoney(value) {
  const n = numOrNull(value);
  return n === null ? 'unavailable' : `$${round2(n).toFixed(2)}`;
}

export function formatBrokerTruthLines(performance) {
  if (!performance) return [];
  const orders = performance.broker?.orders ?? emptyOrderCounts();
  const exposure = performance.exposure ?? {};
  const warnings = performance.warnings ?? [];
  const realized = exposure.realizedPnlUsd === null || exposure.realizedPnlUsd === undefined
    ? 'unavailable'
    : fmtMoney(exposure.realizedPnlUsd);
  const lines = [
    'Broker truth / performance (PAPER-only)',
    `  orders:     submitted=${orders.submitted} broker-confirmed-fills=${orders.filled} ` +
      `open=${orders.open} canceled=${orders.canceled} rejected=${orders.rejected} ` +
      `expired=${orders.expired} replaced=${orders.replaced}`,
    `  exposure:   ExaltedFable-owned gross=${fmtMoney(exposure.grossExposure)} ` +
      `openPositions=${exposure.openPositionCount ?? 0}`,
    `  P&L:        broker-confirmed owned realized=${realized}`,
    `  session:    brokerAccount=${formatReturn(performance.brokerAccountReturn)} ` +
      `SPY=${formatReturn(performance.spyReturn)} accountExcess=${formatReturn(performance.brokerAccountExcessReturn)}`,
    `  ownedReturn:${performance.botReturnUnavailableReason ?? 'unavailable'}`,
    `  quality:    ${performance.dataQuality ?? 'limited'}`,
  ];
  if (warnings.length > 0) {
    for (const warning of warnings.slice(0, 5)) lines.push(`  warning:    ${warning}`);
    if (warnings.length > 5) lines.push(`  warning:    ${warnings.length - 5} additional warning(s) omitted`);
  }
  return lines;
}

export function hydratePerformanceSnapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshotAt: row.snapshot_at,
    runtimeSessionId: row.runtime_session_id,
    brokerEquityBaseline: row.broker_equity_baseline,
    brokerEquityCurrent: row.broker_equity_current,
    brokerPortfolioValueCurrent: row.broker_portfolio_value_current,
    brokerAccountReturn: row.broker_account_return_pct,
    botReturn: null,
    botReturnUnavailableReason: 'unavailable: no bot-owned broker-confirmed capital baseline',
    spyBaselineAt: row.spy_baseline_at,
    spyBaselinePrice: row.spy_baseline_price,
    spyCurrentAt: row.spy_current_at,
    spyCurrentPrice: row.spy_current_price,
    spyReturn: row.spy_return_pct,
    brokerAccountExcessReturn: row.broker_account_excess_return_pct,
    exposure: {
      grossExposure: row.bot_gross_exposure,
      openPositionCount: row.bot_open_position_count,
      realizedPnlUsd: row.bot_realized_pnl_usd,
    },
    broker: {
      orders: {
        submitted: row.bot_orders_submitted,
        filled: row.bot_orders_filled,
        open: row.bot_orders_open,
        canceled: row.bot_orders_canceled,
        rejected: row.bot_orders_rejected,
        expired: row.bot_orders_expired,
        replaced: row.bot_orders_replaced ?? 0,
      },
    },
    dataQuality: row.data_quality,
    warnings: parseJsonArray(row.warnings_json),
  };
}
