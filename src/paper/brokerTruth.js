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
  updatePaperTradeBrokerTruth,
} from '../database/paperRuntime.js';

const LEGACY_ORDER_RE = /paper order\s+([A-Za-z0-9_-]+)/i;
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
  const unavailable = (reason, extra = {}) => ({
    available: false,
    price: null,
    at: null,
    targetAt: targetAt ?? null,
    source: priceSource?.name ?? null,
    alignmentStatus: 'unavailable',
    unavailableReason: reason,
    warning: reason,
    ...extra,
  });
  if (!priceSource) return unavailable(`${ticker} benchmark price source unavailable`);
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) return unavailable(`${ticker} benchmark target timestamp invalid`);
  const fromIso = iso(targetMs - lookbackMinutes * 60_000);
  const toIso = iso(targetMs);
  const sourceName = priceSource.name ?? 'price_source';
  const aligned = (trade, source, alignmentStatus) => ({
    available: true,
    price: Number(trade.price),
    at: trade.at,
    targetAt: toIso,
    source,
    alignmentStatus,
    unavailableReason: null,
    warning: null,
    requestedFrom: fromIso,
    requestedTo: toIso,
  });

  let historicalWarning = null;
  try {
    const trades = await priceSource.getTradesAround(ticker, fromIso, toIso);
    const eligible = (Array.isArray(trades) ? trades : [])
      .filter((t) => positiveNum(t?.price) !== null && Date.parse(t?.at) <= targetMs)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = eligible[eligible.length - 1] ?? null;
    if (!latest) {
      historicalWarning = `${ticker} benchmark unavailable in aligned historical window ending ${targetAt}`;
    } else {
      return aligned(latest, `${sourceName}.historical_trades`, latest.at === toIso ? 'exact_target' : 'latest_at_or_before_target');
    }
  } catch (err) {
    historicalWarning = `${ticker} benchmark historical window unavailable: ${warningMessage(err)}`;
  }

  if (typeof priceSource.getLatestTrade === 'function') {
    try {
      const latest = await priceSource.getLatestTrade(ticker);
      const latestMs = Date.parse(latest?.at);
      const latestPrice = positiveNum(latest?.price);
      if (latestPrice === null || !Number.isFinite(latestMs)) {
        return unavailable(`${ticker} benchmark latest trade unavailable: malformed latest trade`, {
          requestedFrom: fromIso,
          requestedTo: toIso,
        });
      }
      if (latestMs > targetMs) {
        return unavailable(`${ticker} benchmark latest trade is after target timestamp (${latest.at} > ${targetAt})`, {
          requestedFrom: fromIso,
          requestedTo: toIso,
          source: `${sourceName}.latest_trade`,
        });
      }
      if (latestMs < Date.parse(fromIso)) {
        return unavailable(`${ticker} benchmark latest trade is stale before aligned lookback window (${latest.at} < ${fromIso})`, {
          requestedFrom: fromIso,
          requestedTo: toIso,
          source: `${sourceName}.latest_trade`,
        });
      }
      return aligned(latest, `${sourceName}.latest_trade`, latest.at === toIso ? 'exact_target' : 'latest_at_or_before_target');
    } catch (err) {
      return unavailable(`${ticker} benchmark latest trade unavailable: ${warningMessage(err)}`, {
        requestedFrom: fromIso,
        requestedTo: toIso,
        source: `${sourceName}.latest_trade`,
      });
    }
  }

  return unavailable(historicalWarning ?? `${ticker} benchmark unavailable at ${targetAt}`, {
    requestedFrom: fromIso,
    requestedTo: toIso,
  });
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

  let spyBaseline = {
    available: false,
    price: null,
    at: null,
    targetAt: baseline?.snapshot_at ?? null,
    source: null,
    alignmentStatus: 'unavailable',
    unavailableReason: `${benchmarkTicker} benchmark baseline unavailable`,
    warning: `${benchmarkTicker} benchmark baseline unavailable`,
  };
  let spyCurrent = {
    available: false,
    price: null,
    at: null,
    targetAt: snapshotAt,
    source: null,
    alignmentStatus: 'unavailable',
    unavailableReason: `${benchmarkTicker} benchmark current unavailable`,
    warning: `${benchmarkTicker} benchmark current unavailable`,
  };
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
    spyBaselineTargetAt: spyBaseline.targetAt ?? baseline?.snapshot_at ?? null,
    spyBaselineSource: spyBaseline.source ?? null,
    spyBaselineAlignmentStatus: spyBaseline.alignmentStatus ?? null,
    spyCurrentAt: spyCurrent.at,
    spyCurrentPrice: spyCurrent.price,
    spyCurrentTargetAt: spyCurrent.targetAt ?? snapshotAt,
    spyCurrentSource: spyCurrent.source ?? null,
    spyCurrentAlignmentStatus: spyCurrent.alignmentStatus ?? null,
    spyUnavailableReason: [spyBaseline, spyCurrent]
      .map((b) => b?.unavailableReason)
      .filter(Boolean)
      .join('; ') || null,
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
    spyUnavailableReason: [spyBaseline, spyCurrent]
      .map((b) => b?.unavailableReason)
      .filter(Boolean)
      .join('; ') || null,
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

function benchmarkLegLine(label, leg = {}) {
  return `${label}: target=${leg.targetAt ?? 'unavailable'} priceAt=${leg.at ?? 'unavailable'} ` +
    `source=${leg.source ?? 'unavailable'} align=${leg.alignmentStatus ?? 'unavailable'}`;
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
    `  benchmark:  ${benchmarkLegLine('baseline', performance.spyBaseline)}`,
    `  benchmark:  ${benchmarkLegLine('current', performance.spyCurrent)}`,
    `  benchmark unavailable: ${performance.spyUnavailableReason ?? 'none'}`,
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
    spyBaselineTargetAt: row.spy_baseline_target_at,
    spyBaselineSource: row.spy_baseline_source,
    spyBaselineAlignmentStatus: row.spy_baseline_alignment_status,
    spyCurrentAt: row.spy_current_at,
    spyCurrentPrice: row.spy_current_price,
    spyCurrentTargetAt: row.spy_current_target_at,
    spyCurrentSource: row.spy_current_source,
    spyCurrentAlignmentStatus: row.spy_current_alignment_status,
    spyUnavailableReason: row.spy_unavailable_reason,
    spyReturn: row.spy_return_pct,
    brokerAccountExcessReturn: row.broker_account_excess_return_pct,
    spyBaseline: {
      available: row.spy_baseline_price !== null && row.spy_baseline_price !== undefined,
      price: row.spy_baseline_price,
      at: row.spy_baseline_at,
      targetAt: row.spy_baseline_target_at,
      source: row.spy_baseline_source,
      alignmentStatus: row.spy_baseline_alignment_status,
      unavailableReason: row.spy_baseline_price === null || row.spy_baseline_price === undefined ? row.spy_unavailable_reason : null,
    },
    spyCurrent: {
      available: row.spy_current_price !== null && row.spy_current_price !== undefined,
      price: row.spy_current_price,
      at: row.spy_current_at,
      targetAt: row.spy_current_target_at,
      source: row.spy_current_source,
      alignmentStatus: row.spy_current_alignment_status,
      unavailableReason: row.spy_current_price === null || row.spy_current_price === undefined ? row.spy_unavailable_reason : null,
    },
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
