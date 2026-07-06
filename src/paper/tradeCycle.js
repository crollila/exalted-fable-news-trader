// src/paper/tradeCycle.js — The PAPER trading decision cycle.
//
// Everything that turns a scored news event into a (dry-run or executed) PAPER
// equity order lives here: event selection, learned sizing, risk gating, order
// submission, persistence, and sanitized reporting. The CLI wrappers
// (scripts/runPaperTradingOnce.js, scripts/runPaperTradingLoop.js) parse args
// and fetch real clients; this module is dependency-injected so tests run
// fully offline.
//
// HARD SAFETY (inherited from the modules this composes):
// - PAPER ONLY. The order client is hard-wired to the Alpaca paper endpoint.
// - DRY RUN IS THE DEFAULT. Orders go out ONLY when executePaper is true.
// - No uncapped trading: qty caps + margin-aware notional/exposure/daily caps.
// - SANITIZED OUTPUT ONLY. Never raw model responses, payloads, or secrets.

import { ingestNews } from '../ingestion/ingestNews.js';
import { classifyAndStore } from '../ingestion/classifyNews.js';
import { classifyBrokerOrderState } from './brokerTruth.js';
import {
  assessProposal,
  insertPaperTrade,
  insertRejectedTrade,
  DEFAULT_QTY,
  MAX_QTY,
} from './paperTradeProposal.js';
import {
  assessRisk,
  clampEquityQuantityToCaps,
  resolveCaps,
  resolveLearnedEquityEffectiveCaps,
} from './paperRisk.js';
import { deriveCapabilities, summarizeCapabilities } from './accountCapabilities.js';
import {
  getOwnedEquityExposureSnapshot,
  getPaperEventAttemptStats,
  insertEquitySizingDecision,
  listBrokerConfirmedEquityOutcomes,
} from '../database/paperRuntime.js';
import {
  decideEquitySizing,
  formatSizingDecision,
  resolveEquitySizingSettings,
  scoreBucket,
  SIZING_MODES,
} from './equitySizing.js';
import {
  getRiskState,
  isKillSwitchActive,
  resolveDailyLossCap,
  tradingDay,
  updateDailyLossState,
} from './riskState.js';
import { resolveExitSettings, resolveLearnedExitParams } from './exitPolicy.js';
import { monitorOpenEquityPositions } from './positionMonitor.js';
import { MODEL_PROMPT_VERSION } from '../sentiment/modelClassifier.js';

export const DEFAULT_SYMBOLS = Object.freeze(['AAPL']);
export const PAPER_CLASSIFIERS = Object.freeze(['openai', 'anthropic', 'real_model']);
export const DEFAULT_PAPER_FEATURES = Object.freeze({
  enableShorts: false,
  enableMargin: false,
});
export const DEFAULT_PAPER_INGEST_LIMIT = 20;
export const MAX_PAPER_INGEST_LIMIT = 50;
export const DEFAULT_PAPER_CLASSIFY_LIMIT = 5;
export const MAX_PAPER_CLASSIFY_LIMIT = 5;
export const DEFAULT_NEWS_LOOKBACK_MINUTES = 60;
export const MAX_NEWS_LOOKBACK_MINUTES = 390;

export const PAPER_DECISION_OUTCOMES = Object.freeze({
  TRADE_ATTEMPTED: 'trade_attempted',
  NO_NEW_NEWS: 'no_new_news',
  NO_FRESH_REAL_MODEL_SCORE: 'no_fresh_real_model_score',
  ALL_FRESH_SCORES_FAILED_SIGNAL_THRESHOLDS: 'all_fresh_scores_failed_signal_thresholds',
  ALREADY_PROCESSED_EVENT: 'already_processed_event',
  RISK_REJECTION: 'risk_rejection',
  BROKER_SUBMISSION_ERROR: 'broker_submission_error',
  KILL_SWITCH_ACTIVE: 'kill_switch_active',
});

/** Reference-price lookup window (free IEX feed is restricted for very recent data). */
const REF_PRICE_LAG_MIN = 16;
const REF_PRICE_SPAN_MIN = 10;
const MODEL_CLASSIFIER_NAMES = new Set(['openai', 'anthropic', 'real_model']);

/** Clamp an integer-ish value into [lo, hi]; junk/non-positive -> fallback. */
export function clampInt(value, fallback, lo, hi) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

export function resolvePaperFeatures(features = {}) {
  return {
    enableShorts: features.enableShorts === true,
    enableMargin: features.enableMargin === true,
  };
}

/** The parseArgs([]) shape, for callers that run a cycle without CLI args. */
function defaultCycleArgs() {
  return {
    symbols: [...DEFAULT_SYMBOLS],
    qty: DEFAULT_QTY,
    qtyExplicit: false,
    eventId: null,
    executePaper: false,
    classifier: null,
    ingestLimit: DEFAULT_PAPER_INGEST_LIMIT,
    classifyLimit: DEFAULT_PAPER_CLASSIFY_LIMIT,
    newsLookbackMinutes: DEFAULT_NEWS_LOOKBACK_MINUTES,
    allowShorts: false,
    thresholds: {},
    caps: {},
    sizingSettings: {},
    paperFeatures: resolvePaperFeatures(DEFAULT_PAPER_FEATURES),
  };
}

/** List recent scored events (whitelisted columns only). */
export function listRecentScoredEvents(
  db,
  {
    eventId = null,
    eventIds = null,
    allowedSymbols = [],
    promptVersion = MODEL_PROMPT_VERSION,
    excludeProcessed = true,
    limit = 25,
  } = {}
) {
  const symbols = (allowedSymbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const explicitEventId = Number.isInteger(eventId) && eventId > 0;
  const conds = ['s.prompt_version = ?'];
  const params = [promptVersion];
  if (explicitEventId) {
    conds.push('n.id = ?');
    params.push(eventId);
  } else if (Array.isArray(eventIds) && eventIds.length > 0) {
    const cleanIds = eventIds.filter((id) => Number.isInteger(id) && id > 0);
    if (cleanIds.length === 0) return [];
    conds.push(`n.id IN (${cleanIds.map(() => '?').join(', ')})`);
    params.push(...cleanIds);
  }
  if (symbols.length > 0) {
    conds.push(`n.ticker IN (${symbols.map(() => '?').join(', ')})`);
    params.push(...symbols);
  }
  if (excludeProcessed && !explicitEventId) {
    conds.push('NOT EXISTS (SELECT 1 FROM paper_trades pt WHERE pt.news_event_id = n.id)');
    conds.push('NOT EXISTS (SELECT 1 FROM rejected_trades rt WHERE rt.news_event_id = n.id)');
  }
  const cap = clampInt(limit, 25, 1, 100);
  return db
    .prepare(
      `SELECT n.id AS event_id, n.ticker AS ticker,
              n.published_at AS published_at, n.received_at AS received_at,
              s.model AS model, s.prompt_version AS prompt_version,
              s.sentiment_score AS sentiment_score, s.impact_score AS impact_score,
              s.confidence AS confidence, s.direction AS direction,
              s.parser_status AS parser_status, s.news_type AS news_type
         FROM news_events n
         JOIN sentiment_scores s ON s.news_event_id = n.id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.id DESC
        LIMIT ?`
    )
    .all(...params, cap)
    .map((row) => ({
      event: { id: row.event_id, ticker: row.ticker },
      freshness: { publishedAt: row.published_at, receivedAt: row.received_at },
      score: {
        model: row.model, prompt_version: row.prompt_version,
        sentiment_score: row.sentiment_score, impact_score: row.impact_score,
        confidence: row.confidence, direction: row.direction,
        parser_status: row.parser_status, news_type: row.news_type,
      },
    }));
}

/** Select ONE recent scored event (whitelisted columns only). */
export function selectRecentScoredEvent(db, opts = {}) {
  return listRecentScoredEvents(db, { ...opts, limit: 1 })[0] ?? null;
}

/** Today's paper-order counters from the DB, for daily caps. Read-only. */
export function getDailyCounters(db, day = new Date().toISOString().slice(0, 10)) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(COALESCE(fill_price,0)*quantity),0) AS notional
         FROM paper_trades WHERE substr(created_at,1,10) = ?`
    )
    .get(day);
  return { orders: Number(row?.orders ?? 0), notional: Number(row?.notional ?? 0) };
}

/** Map a proposal to the shape paperRisk expects. */
function riskShape(proposal) {
  return { assetClass: 'equity', side: proposal.side, ticker: proposal.ticker, quantity: proposal.quantity };
}

function finiteNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = finiteNum(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

function money(value) {
  const n = finiteNum(value);
  return n === null ? 'unavailable' : `$${round2(n).toFixed(2)}`;
}

function pct(value) {
  const n = finiteNum(value);
  return n === null ? 'unavailable' : `${(n * 100).toFixed(2)}%`;
}

function approvedSizingValues(sub, result = {}) {
  const qty = sub?.decision === 'accepted' ? Number(sub?.proposal?.quantity) || 0 : 0;
  const notional =
    sub?.risk?.estNotional !== null && sub?.risk?.estNotional !== undefined
      ? finiteNum(sub.risk.estNotional)
      : result?.referencePrice !== null && result?.referencePrice !== undefined
        ? round2(qty * Number(result.referencePrice))
        : null;
  const equity = finiteNum(
    sub?.sizingDecision?.diagnostics?.accountEquity ??
    result?.capabilities?.equity
  );
  return {
    qty,
    notional,
    weight: notional !== null && equity !== null && equity > 0 ? notional / equity : null,
  };
}

function capReportLines(report = {}) {
  const active = Array.isArray(report?.activeCaps) ? report.activeCaps : [];
  return active.map((cap) => {
    const used = cap.used === null || cap.used === undefined ? '' : ` used=${money(cap.used)}`;
    return `    cap:       ${cap.key} source=${cap.source ?? 'unknown'} value=${money(cap.value)}${used} ` +
      `remaining=${money(cap.remainingNotional)} allows=${cap.allowedQuantity ?? 'n/a'} ` +
      `clamp=${cap.clamped ? 'yes' : 'no'} reason=${cap.reason ?? 'unavailable'}`;
  });
}

function equitySignalFromProposal(proposal) {
  const score = proposal?.score ?? {};
  return {
    ticker: proposal?.ticker,
    side: proposal?.side,
    direction: score.direction,
    confidence: score.confidence,
    impact: score.impact,
    sentiment: score.sentiment,
    newsType: score.newsType,
    model: score.model,
    promptVersion: score.promptVersion,
  };
}

function currentExposureForProposal(snapshot, proposal) {
  const ticker = String(proposal?.ticker ?? '').trim().toUpperCase();
  const side = String(proposal?.side ?? '').trim();
  return finiteNum(snapshot?.byTickerSide?.[`${ticker}|${side}`]) ?? 0;
}

function manualSizingDecision({ proposal, qty, referencePrice, account, currentOwnedExposure }) {
  const ref = finiteNum(referencePrice);
  const equity = finiteNum(account?.equity ?? account?.portfolioValue);
  const requestedNotional = ref !== null ? round2(ref * qty) : null;
  const requestedTargetWeight = requestedNotional !== null && equity !== null && equity > 0
    ? requestedNotional / equity
    : null;
  return {
    mode: SIZING_MODES.ABSTAIN,
    requestedTargetWeight,
    requestedNotional,
    requestedQuantity: qty,
    evidenceCount: 0,
    evidenceQuality: 'manual_override',
    evidenceTier: 'manual_override',
    reason: 'manual --qty override; learned equity sizing not applied',
    warnings: ['manual --qty override bypassed learned equity sizing'],
    diagnostics: {
      referencePrice: ref,
      accountEquity: equity,
      currentExposure: currentOwnedExposure,
    },
  };
}

function withSizingDecision(
  proposal,
  sizingDecision,
  {
    account = null,
    positions = [],
    caps = {},
    capSources = {},
    daily = { orders: 0, notional: 0 },
    referencePrice = null,
    paperFeatures = DEFAULT_PAPER_FEATURES,
    maxQty = MAX_QTY,
  } = {}
) {
  if (!proposal.accepted || !sizingDecision) return proposal;
  if (sizingDecision.mode === SIZING_MODES.ABSTAIN || !(Number(sizingDecision.requestedQuantity) > 0)) {
    return {
      ...proposal,
      accepted: false,
      quantity: null,
      reason: `learned equity sizing rejected: ${sizingDecision.reason}`,
    };
  }
  const requestedQty = Math.floor(Number(sizingDecision.requestedQuantity));
  const cappedQty = Math.min(Math.max(1, requestedQty), maxQty);
  const clamp = clampEquityQuantityToCaps({
    proposal: { ...proposal, assetClass: 'equity', quantity: cappedQty },
    account,
    positions,
    caps,
    capSources,
    daily,
    referencePrice,
    marginEnabled: resolvePaperFeatures(paperFeatures).enableMargin,
  });
  const qty = clamp.quantity;
  const clampWarnings = [];
  const hardQuantityCaps = [];
  if (cappedQty < requestedQty) {
    const reason = `learned quantity ${requestedQty} clamped to hard quantity cap ${maxQty}`;
    clampWarnings.push(reason);
    hardQuantityCaps.push({
      key: 'maxQuantity',
      label: 'hard quantity cap',
      source: 'MAX_QTY',
      value: maxQty,
      used: null,
      remainingNotional: null,
      allowedQuantity: cappedQty,
      clamped: true,
      reason,
    });
  }
  if (qty < cappedQty) {
    const reasons = clamp.clampReasons?.length > 0 ? clamp.clampReasons : [clamp.reason];
    clampWarnings.push(clamp.reason, ...reasons);
  }
  const orderCap = capSources.maxOrderNotional ?? null;
  sizingDecision.effectiveRiskCaps = {
    orderCap,
    activeCaps: [...hardQuantityCaps, ...(clamp.capReport ?? [])],
    clampReasons: clampWarnings,
  };
  if (orderCap) {
    clampWarnings.unshift(
      `effective order cap source=${orderCap.source} value=${money(orderCap.value)} ` +
      `learnedPctCap=${money(orderCap.learnedPercentCap)} explicitDollarCap=${money(orderCap.explicitDollarCap)}`
    );
  }
  if (clampWarnings.length > 0) {
    sizingDecision.warnings = [
      ...(sizingDecision.warnings ?? []),
      ...clampWarnings,
    ];
  }
  if (qty <= 0) {
    return {
      ...proposal,
      accepted: false,
      quantity: null,
      reason: `learned equity sizing rejected: ${clamp.reason}`,
    };
  }
  return {
    ...proposal,
    quantity: qty,
    reason: `${proposal.reason}; sizing ${formatSizingDecision(sizingDecision)}; approved qty=${qty}`,
  };
}

function insertSizingAuditIfPresent(db, sub, ctx) {
  if (sub.kind !== 'equity' || !sub.sizingDecision) return;
  const proposal = sub.proposal ?? {};
  const decision = sub.sizingDecision;
  const accountEquity = finiteNum(ctx.account?.equity ?? ctx.account?.portfolioValue);
  const brokerRejectedNoFill =
    ['canceled', 'rejected', 'expired'].includes(sub.brokerTruthState) && sub.brokerHasFill !== true;
  const executionFailureReason =
    sub.orderError ??
    (brokerRejectedNoFill ? `broker ${sub.brokerTruthState} with no confirmed fill` : null);
  const approved =
    sub.decision === 'accepted' &&
    (!sub.risk || sub.risk.approved) &&
    !executionFailureReason;
  const approvedQuantity = approved ? Number(proposal.quantity) || null : 0;
  const approvedNotional =
    approved && sub.risk?.estNotional !== null && sub.risk?.estNotional !== undefined
      ? finiteNum(sub.risk.estNotional)
      : approved && ctx.referencePrice !== null && ctx.referencePrice !== undefined
        ? round2((Number(proposal.quantity) || 0) * Number(ctx.referencePrice))
        : null;
  const approvedTargetWeight = approvedNotional !== null && accountEquity !== null && accountEquity > 0
    ? approvedNotional / accountEquity
    : null;
  const signal = equitySignalFromProposal(proposal);
  const warnings = [
    ...(decision.warnings ?? []),
    ...(ctx.dataQualityWarnings ?? []),
  ];
  const riskReason = executionFailureReason ?? sub.risk?.reason ?? (sub.decision === 'rejected' ? proposal.reason : 'accepted');
  const explanation = ctx.manualQtyOverride
    ? `manual --qty override: requested qty ${proposal.quantity}; learned sizing not applied`
    : formatSizingDecision(decision);
  sub.sizingAuditId = insertEquitySizingDecision(db, {
    paperTradeId: sub.paperTradeId,
    rejectedTradeId: sub.rejectedTradeId,
    newsEventId: proposal.eventId,
    ticker: proposal.ticker,
    side: proposal.side,
    manualOverride: ctx.manualQtyOverride === true,
    sizingMode: decision.mode,
    evidenceTier: decision.evidenceTier,
    evidenceCount: decision.evidenceCount,
    evidenceQuality: decision.evidenceQuality,
    model: signal.model,
    promptVersion: signal.promptVersion,
    newsType: signal.newsType,
    direction: signal.direction,
    scoreBucket: scoreBucket(signal),
    requestedTargetWeight: decision.requestedTargetWeight,
    requestedNotional: decision.requestedNotional,
    requestedQuantity: decision.requestedQuantity,
    approvedTargetWeight,
    approvedNotional,
    approvedQuantity,
    referencePrice: ctx.referencePrice,
    accountEquity,
    currentOwnedExposure: ctx.currentOwnedExposure,
    riskApproved: executionFailureReason ? false : sub.risk ? sub.risk.approved === true : approved ? true : false,
    riskReason,
    explanation,
    warnings,
    effectiveRiskCaps: decision.effectiveRiskCaps ?? null,
  }).id;
}

/**
 * Process ONE proposal through risk + (dry-run|execute) + persistence. Never
 * throws on a submit failure — records a sanitized orderError instead.
 */
async function processProposal(db, proposal, ctx) {
  const {
    kind, capabilities, account, positions, caps, daily, referencePrice,
    executePaper, paperClient, paperFeatures = DEFAULT_PAPER_FEATURES,
    asset = null,
    nowMs = Date.now(), sizingDecision = null, manualQtyOverride = false,
    currentOwnedExposure = 0, dataQualityWarnings = [],
  } = ctx;
  const sub = {
    kind, proposal, risk: null, decision: 'rejected',
    rejectedTradeId: null, paperTradeId: null,
    order: null, orderError: null,
    brokerTruthState: null, brokerHasFill: false,
    sizingDecision, manualQtyOverride, sizingAuditId: null,
  };

  // Score/intent gate already decided acceptance.
  if (!proposal.accepted) {
    sub.rejectedTradeId = insertRejectedTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.ticker,
      side: proposal.side,
      quantity: proposal.quantity ?? null,
      reason: proposal.reason,
    }).id;
    insertSizingAuditIfPresent(db, sub, {
      account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
    });
    return sub;
  }

  // Margin-aware risk gate (run when we have an account snapshot, or when we are
  // about to execute — a real order is never sent without a risk pass).
  const haveAccount = Boolean(capabilities && capabilities.available);
  const needsMandatoryRisk = proposal.side === 'sell';
  if (haveAccount || executePaper || needsMandatoryRisk) {
    sub.risk = assessRisk({
      proposal: riskShape(proposal),
      capabilities: capabilities ?? { available: false },
      account, positions, caps, daily, referencePrice, executePaper,
      asset,
      marginEnabled: resolvePaperFeatures(paperFeatures).enableMargin,
    });
    if (!sub.risk.approved) {
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId,
        ticker: proposal.ticker,
        side: proposal.side,
        quantity: proposal.quantity ?? null,
        reason: sub.risk.reason,
      }).id;
      insertSizingAuditIfPresent(db, sub, {
        account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
      });
      return sub;
    }
  }

  sub.decision = 'accepted';
  if (!executePaper) {
    insertSizingAuditIfPresent(db, sub, {
      account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
    });
    return sub;
  } // dry run: no order sent
  if (!paperClient) {
    sub.orderError = 'paper client not configured — no order sent';
    insertSizingAuditIfPresent(db, sub, {
      account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
    });
    return sub;
  }

  // EQUITY entry: single-leg market/day.
  try {
    const order = await paperClient.submitMarketOrder({ symbol: proposal.ticker, qty: proposal.quantity, side: proposal.side });
    sub.order = order;
    const brokerState = classifyBrokerOrderState(order);
    const filledQty = Number(order.filledQty);
    const filledAvgPrice = Number(order.filledAvgPrice);
    const hasBrokerFill = Number.isFinite(filledQty) && filledQty > 0 && Number.isFinite(filledAvgPrice);
    sub.brokerTruthState = brokerState;
    sub.brokerHasFill = hasBrokerFill;
    const localStatus =
      ['canceled', 'rejected', 'expired'].includes(brokerState) && !hasBrokerFill ? 'canceled' : 'open';
    sub.paperTradeId = insertPaperTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.ticker,
      side: proposal.side,
      quantity: proposal.quantity,
      fillPrice: hasBrokerFill ? order.filledAvgPrice : null,
      entryAt: hasBrokerFill ? (order.filledAt ?? order.submittedAt ?? new Date(nowMs).toISOString()) : null,
      tradeReason: `${proposal.reason}; paper order ${order.id ?? '?'} status ${order.status ?? '?'}`,
      status: localStatus,
      brokerOrderId: order.id ?? null,
      brokerClientOrderId: order.clientOrderId ?? null,
      brokerOrderStatus: order.status ?? null,
      brokerOrderType: order.type ?? null,
      brokerSubmittedAt: order.submittedAt ?? null,
      brokerFilledQty: order.filledQty ?? null,
      brokerFilledAvgPrice: order.filledAvgPrice ?? null,
      brokerFilledAt: order.filledAt ?? null,
      brokerUpdatedAt: order.updatedAt ?? null,
      brokerReconciledAt: new Date(nowMs).toISOString(),
      brokerTruthState: brokerState,
    }).id;
  } catch (err) {
    sub.orderError = err.message; // already sanitized by the client
  }
  insertSizingAuditIfPresent(db, sub, {
    account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
  });
  return sub;
}

/**
 * Core one-shot logic, dependency-injected so tests run fully offline. Account/
 * positions/capabilities/referencePrice/daily are passed in; the CLI wrappers
 * fetch them from the real clients.
 */
export async function runPaperTradeOnce(db, { event, score }, deps = {}) {
  const {
    paperClient = null, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {}, allowShorts = false,
    qtyExplicit = false, sizingSettings = {},
    caps = {}, account = null, positions = [], capabilities = null, referencePrice = null,
    daily = { orders: 0, notional: 0 }, executePaper = false,
    nowMs = Date.now(), paperFeatures = DEFAULT_PAPER_FEATURES, asset = null,
    historicalEquityOutcomes = [], ownedEquityExposure = null, eventAttemptStats = null,
  } = deps;
  const features = resolvePaperFeatures(paperFeatures);
  const effectiveCaps = caps;
  const normalizedSizingSettings = resolveEquitySizingSettings(sizingSettings);
  let learnedEquityCapContext = null;
  let equityCapsForRisk = effectiveCaps;
  let equityCapSources = {};
  let resolvedAsset = asset;

  const result = {
    mode: executePaper ? 'execute_paper' : 'dry_run',
    capabilities: capabilities ? summarizeCapabilities(capabilities) : null,
    referencePrice,
    equity: null,
  };

  let equityProposal = assessProposal({
    event,
    score,
    qty,
    allowedSymbols,
    thresholds,
    allowShorts,
    shortsEnabled: features.enableShorts,
  });
  let equitySizingDecision = null;
  let currentOwnedExposure = 0;
  const dataQualityWarnings = [];
  if (equityProposal.accepted) {
    const exposureSnapshot = ownedEquityExposure ?? { byTickerSide: {}, dataQuality: 'unavailable' };
    currentOwnedExposure = currentExposureForProposal(exposureSnapshot, equityProposal);
    if (exposureSnapshot.dataQuality && exposureSnapshot.dataQuality !== 'broker_confirmed') {
      dataQualityWarnings.push(`owned exposure snapshot quality: ${exposureSnapshot.dataQuality}`);
    }
    if (qtyExplicit) {
      equitySizingDecision = manualSizingDecision({
        proposal: equityProposal,
        qty: equityProposal.quantity,
        referencePrice,
        account,
        currentOwnedExposure,
      });
    } else {
      learnedEquityCapContext = resolveLearnedEquityEffectiveCaps({
        caps: effectiveCaps,
        account,
        maxTargetWeight: normalizedSizingSettings.sizing_max_target_weight,
      });
      equityCapsForRisk = learnedEquityCapContext.caps;
      equityCapSources = learnedEquityCapContext.capSources;
      equitySizingDecision = decideEquitySizing({
        signal: equitySignalFromProposal(equityProposal),
        referencePrice,
        account,
        caps: resolveCaps(equityCapsForRisk),
        daily,
        settings: normalizedSizingSettings,
        currentOwnedExposure,
        historicalOutcomes: historicalEquityOutcomes,
        duplicateAttempt: eventAttemptStats?.duplicateAttempt === true,
        dataQualityWarnings,
      });
      equityProposal = withSizingDecision(equityProposal, equitySizingDecision, {
        account,
        positions,
        caps: equityCapsForRisk,
        capSources: equityCapSources,
        daily,
        referencePrice,
        paperFeatures: features,
      });
    }
  }
  if (!resolvedAsset && paperClient && equityProposal.side === 'sell') {
    resolvedAsset = await fetchAssetState(paperClient, event?.ticker);
  }
  result.equity = await processProposal(db, equityProposal, {
    kind: 'equity', capabilities, account, positions, caps: equityCapsForRisk, daily, referencePrice,
    executePaper, paperClient, paperFeatures: features, asset: resolvedAsset,
    sizingDecision: equitySizingDecision,
    manualQtyOverride: qtyExplicit,
    currentOwnedExposure,
    dataQualityWarnings,
  });
  return result;
}

/** Best-effort latest reference price via the existing trades source. null on any issue. */
export async function fetchReferencePrice(priceSource, symbol, nowMs = Date.now()) {
  if (!priceSource) return null;
  try {
    const toMs = nowMs - REF_PRICE_LAG_MIN * 60_000;
    const fromMs = toMs - REF_PRICE_SPAN_MIN * 60_000;
    const trades = await priceSource.getTradesAround(symbol, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
    if (Array.isArray(trades) && trades.length > 0) return trades[trades.length - 1].price ?? null;
  } catch {
    /* sanitized: a price lookup failure just yields null (risk fail-safe handles it) */
  }
  return null;
}

/**
 * Fetch account + positions and derive capabilities. Best-effort: returns nulls
 * if the client is absent or the calls fail (sanitized). No throw escapes.
 */
export async function fetchAccountState(paperClient) {
  if (!paperClient) return { account: null, positions: [], capabilities: deriveCapabilities(null) };
  let account = null;
  let positions = [];
  try { account = await paperClient.getAccount(); } catch { account = null; }
  try { positions = await paperClient.getPositions(); } catch { positions = []; }
  return { account, positions, capabilities: deriveCapabilities(account) };
}

/** Best-effort asset/tradability snapshot. null means unavailable/fail-closed later. */
export async function fetchAssetState(paperClient, symbol) {
  if (!paperClient) return null;
  try {
    return await paperClient.getAsset(symbol);
  } catch {
    return null;
  }
}

/** Fetch account/reference state and run the paper-trade core. */
export async function executeSelectedPaperTrade(
  db,
  selected,
  { args, paperClient = null, priceSource = null, nowMs = Date.now() }
) {
  // KILL SWITCH (CLAUDE.md risk rule): when the day's switch is active, refuse
  // every proposal outright — dry runs included — and log the rejection.
  const day = tradingDay(nowMs);
  if (isKillSwitchActive(db, day)) {
    const state = getRiskState(db, day);
    const reason = `kill switch active for ${day}: ${state?.kill_switch_reason ?? 'manual/daily-loss halt'}`;
    const rejectedTradeId = insertRejectedTrade(db, {
      newsEventId: selected.event.id,
      ticker: selected.event.ticker,
      side: null,
      quantity: null,
      reason,
    }).id;
    const result = {
      mode: args.executePaper ? 'execute_paper' : 'dry_run',
      killSwitch: { active: true, tripped: false, reason },
      equity: null,
    };
    return {
      selected,
      result,
      lines: [
        'Paper trading one-shot (manual, PAPER-only — live trading disabled)',
        `  ⛔ KILL SWITCH ACTIVE — no proposal evaluated (${reason})`,
        `    logged:     rejected_trades id ${rejectedTradeId}`,
      ],
    };
  }

  const { account, positions, capabilities } = await fetchAccountState(paperClient);
  const asset = await fetchAssetState(paperClient, selected.event.ticker);
  const referencePrice = await fetchReferencePrice(priceSource, selected.event.ticker, nowMs);
  const daily = getDailyCounters(db);
  const historicalEquityOutcomes = listBrokerConfirmedEquityOutcomes(db);
  const ownedEquityExposure = getOwnedEquityExposureSnapshot(db);
  const eventAttemptStats = getPaperEventAttemptStats(db, selected.event.id);
  const result = await runPaperTradeOnce(db, selected, {
    paperClient, account, positions, capabilities, referencePrice,
    daily, nowMs,
    qty: args.qty, qtyExplicit: args.qtyExplicit, sizingSettings: args.sizingSettings,
    allowedSymbols: args.symbols, thresholds: args.thresholds, allowShorts: args.allowShorts,
    caps: args.caps, executePaper: args.executePaper,
    historicalEquityOutcomes, ownedEquityExposure, eventAttemptStats,
    asset,
    paperFeatures: args.paperFeatures ?? DEFAULT_PAPER_FEATURES,
  });

  // After the attempt, refresh the day's realized-loss state and trip the
  // switch when the daily loss cap is breached (halts the REST of the day).
  // Percent-of-equity is preferred; fixed USD is the keyless fallback.
  const lossCap = resolveDailyLossCap({
    account,
    maxDailyLossPct: args.maxDailyLossPct ?? null,
    maxDailyLossUsd: args.maxDailyLossUsd ?? null,
  });
  const lossState = updateDailyLossState(db, {
    day,
    maxDailyLossUsd: lossCap.capUsd,
    capBasis: lossCap.basis,
  });
  result.killSwitch = {
    active: lossState.tripped || lossState.alreadyActive,
    tripped: lossState.tripped,
    reason: lossState.reason,
  };
  const lines = buildPaperReport(result, selected);
  if (lossState.tripped) {
    lines.push(`  ⛔ KILL SWITCH TRIPPED: ${lossState.reason} — no further paper trades today.`);
  }
  return { selected, result, lines };
}

/**
 * One exit-monitor pass with learned parameters: exits run BEFORE new entries
 * every cycle and regardless of the kill switch (closing risk is always
 * allowed). Returns the monitor result (never throws).
 */
export async function runExitMonitor(db, { paperClient = null, nowMs = Date.now(), args = {} } = {}) {
  const base = resolveExitSettings(args.exitSettings ?? {});
  const learned = resolveLearnedExitParams({
    closedOutcomes: listBrokerConfirmedEquityOutcomes(db),
    base,
    learningEnabled: base.learningEnabled,
    minSampleSize: base.minSampleSize,
  });
  const monitor = await monitorOpenEquityPositions(db, {
    paperClient,
    nowMs,
    executePaper: args.executePaper === true,
    exitParams: learned.params,
    exitParamsExplanation: learned.mode === 'learned' ? learned.explanation : null,
  });
  return { ...monitor, exitParams: learned.params, exitParamsMode: learned.mode };
}

function hasSignalPass(selected, args) {
  const features = resolvePaperFeatures(args.paperFeatures ?? DEFAULT_PAPER_FEATURES);
  const equity = assessProposal({
    event: selected.event,
    score: selected.score,
    qty: args.qty,
    allowedSymbols: args.symbols,
    thresholds: args.thresholds,
    allowShorts: args.allowShorts,
    shortsEnabled: features.enableShorts,
  });
  return equity.accepted;
}

function tradeOutcome(result) {
  if (result?.killSwitch?.active && !result?.equity) return PAPER_DECISION_OUTCOMES.KILL_SWITCH_ACTIVE;
  const subs = [result?.equity].filter(Boolean);
  if (subs.some((s) => s.orderError)) return PAPER_DECISION_OUTCOMES.BROKER_SUBMISSION_ERROR;
  if (subs.some((s) => s.decision === 'rejected' && s.risk && !s.risk.approved)) {
    return PAPER_DECISION_OUTCOMES.RISK_REJECTION;
  }
  if (subs.some((s) => s.decision === 'rejected' && s.sizingDecision?.mode === SIZING_MODES.ABSTAIN)) {
    return PAPER_DECISION_OUTCOMES.RISK_REJECTION;
  }
  return PAPER_DECISION_OUTCOMES.TRADE_ATTEMPTED;
}

function ageLabel(receivedAt, nowMs) {
  const ts = Date.parse(receivedAt);
  if (!Number.isFinite(ts)) return 'unknown';
  const minutes = Math.max(0, Math.round((nowMs - ts) / 60_000));
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 72) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function statusLine(statusCounts = {}) {
  const entries = Object.entries(statusCounts);
  if (entries.length === 0) return '(none)';
  return entries.sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(' ');
}

/**
 * Fresh loop cycle: ingest recent Alpaca news, score newly inserted events with
 * the explicitly requested model classifier, then attempt a PAPER trade on
 * a fresh, unprocessed scored event. All collaborators are injected for tests.
 */
export async function runPaperDecisionCycle(
  db,
  { provider = null, classifier = null, paperClient = null, priceSource = null, providerSkipReason = null } = {},
  args = defaultCycleArgs(),
  { nowMs = Date.now() } = {}
) {
  const base = {
    mode: args.executePaper ? 'execute_paper' : 'dry_run',
    outcome: null,
    skipReason: null,
    exits: null,
    ingestion: null,
    classification: null,
    freshCandidates: [],
    selected: null,
    trade: null,
    lines: [],
  };
  // Exits FIRST: manage what we already hold before considering new entries.
  base.exits = await runExitMonitor(db, { paperClient, nowMs, args });
  const since = new Date(nowMs - args.newsLookbackMinutes * 60_000).toISOString();
  const cycleArgs = args;

  if (Number.isInteger(args.eventId) && args.eventId > 0) {
    const selected = selectRecentScoredEvent(db, {
      eventId: args.eventId,
      allowedSymbols: cycleArgs.symbols,
      excludeProcessed: false,
    });
    if (!selected) {
      return {
        ...base,
        outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
        skipReason: `explicit event ${args.eventId} has no ${MODEL_PROMPT_VERSION} score in allowed symbols`,
      };
    }
    const trade = await executeSelectedPaperTrade(db, selected, { args: cycleArgs, paperClient, priceSource, nowMs });
    return { ...base, outcome: tradeOutcome(trade.result), selected, trade, lines: trade.lines };
  }

  if (!provider) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_NEW_NEWS,
      skipReason: providerSkipReason ?? 'Alpaca News provider not configured',
    };
  }

  const until = new Date(nowMs).toISOString();
  const ingestion = await ingestNews(db, provider, {
    symbols: cycleArgs.symbols,
    limit: args.ingestLimit,
    since,
    until,
  });
  base.ingestion = { ...ingestion, since, until };
  if ((ingestion.insertedIds ?? []).length === 0) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_NEW_NEWS,
      skipReason: `no new news inserted (fetched=${ingestion.fetched} duplicates=${ingestion.duplicates} failed=${ingestion.failed})`,
    };
  }

  if (!MODEL_CLASSIFIER_NAMES.has(args.classifier) || !classifier || classifier.promptVersion !== MODEL_PROMPT_VERSION) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
      skipReason: 'model classifier was not requested/configured for this loop iteration',
    };
  }

  const idsToClassify = ingestion.insertedIds.slice(0, args.classifyLimit);
  const classification = await classifyAndStore(db, classifier, { eventIds: idsToClassify });
  base.classification = {
    ...classification,
    selectedIds: idsToClassify,
    model: classifier.modelName,
    promptVersion: classifier.promptVersion,
  };

  const scored = listRecentScoredEvents(db, {
    eventIds: idsToClassify,
    allowedSymbols: cycleArgs.symbols,
    promptVersion: MODEL_PROMPT_VERSION,
    excludeProcessed: false,
    limit: args.classifyLimit,
  });
  const usable = scored.filter((c) => ['parsed', 'fallback_used'].includes(c.score.parser_status));
  if (usable.length === 0) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
      freshCandidates: scored,
      skipReason: `no fresh usable ${MODEL_PROMPT_VERSION} score (statuses=${statusLine(classification.statusCounts)})`,
    };
  }

  const unprocessed = listRecentScoredEvents(db, {
    eventIds: idsToClassify,
    allowedSymbols: cycleArgs.symbols,
    promptVersion: MODEL_PROMPT_VERSION,
    excludeProcessed: true,
    limit: args.classifyLimit,
  }).filter((c) => ['parsed', 'fallback_used'].includes(c.score.parser_status));
  if (unprocessed.length === 0) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.ALREADY_PROCESSED_EVENT,
      freshCandidates: usable,
      skipReason: 'all fresh scored events already have paper_trades or rejected_trades records',
    };
  }

  const selected = unprocessed.find((c) => hasSignalPass(c, cycleArgs));
  const candidate = selected ?? unprocessed[0];
  const trade = await executeSelectedPaperTrade(db, candidate, { args: cycleArgs, paperClient, priceSource, nowMs });
  const outcome = selected
    ? tradeOutcome(trade.result)
    : PAPER_DECISION_OUTCOMES.ALL_FRESH_SCORES_FAILED_SIGNAL_THRESHOLDS;
  return {
    ...base,
    outcome,
    skipReason: selected ? null : 'all fresh usable scores failed signal thresholds',
    freshCandidates: unprocessed,
    selected: candidate,
    trade,
    lines: trade.lines,
  };
}

export function oneLineDecisionSummary(cycle, nowMs = Date.now()) {
  const ing = cycle?.ingestion
    ? `ingest fetched=${cycle.ingestion.fetched} inserted=${cycle.ingestion.inserted} dup=${cycle.ingestion.duplicates}`
    : 'ingest skipped';
  const cls = cycle?.classification
    ? `classify stored=${cycle.classification.stored} statuses=${statusLine(cycle.classification.statusCounts)}`
    : 'classify skipped';
  const selected = cycle?.selected
    ? `event=${cycle.selected.event.id} ${cycle.selected.event.ticker} age=${ageLabel(cycle.selected.freshness?.receivedAt, nowMs)}`
    : 'event=(none)';
  const skip = cycle?.skipReason ? `skip=${cycle.skipReason}` : oneLineSummary(cycle?.trade?.result);
  return `${cycle?.outcome ?? 'unknown'}; ${ing}; ${cls}; ${selected}; ${skip}`;
}

export function buildDecisionCycleReport(cycle, nowMs = Date.now()) {
  const lines = [
    'Paper trading decision cycle (fresh ingest/classify/trade, PAPER-only)',
    `  outcome:    ${cycle.outcome ?? 'unknown'}`,
  ];
  if (cycle.exits && cycle.exits.checked > 0) {
    lines.push(
      `  exits:      checked=${cycle.exits.checked} planned=${cycle.exits.exitsPlanned} ` +
        `submitted=${cycle.exits.exitsSubmitted} filled=${cycle.exits.exitsFilled} errors=${cycle.exits.errors}`
    );
    lines.push(...cycle.exits.lines.map((line) => `  ${line}`));
  }
  if (cycle.ingestion) {
    lines.push(
      `  ingest:     fetched=${cycle.ingestion.fetched} inserted=${cycle.ingestion.inserted} ` +
        `duplicates=${cycle.ingestion.duplicates} failed=${cycle.ingestion.failed}`
    );
  }
  if (cycle.classification) {
    lines.push(
      `  classify:   selected=${cycle.classification.selectedIds?.length ?? 0} stored=${cycle.classification.stored} ` +
        `statuses=${statusLine(cycle.classification.statusCounts)}`
    );
  }
  if (cycle.selected) {
    lines.push(
      `  selected:   event ${cycle.selected.event.id} ${cycle.selected.event.ticker} ` +
        `freshness=${ageLabel(cycle.selected.freshness?.receivedAt, nowMs)}`
    );
  }
  if (cycle.skipReason) lines.push(`  skip:       ${cycle.skipReason}`);
  if (cycle.lines?.length > 0) lines.push(...cycle.lines.map((line) => `  ${line}`));
  return lines;
}

/** One short sanitized summary line for loop heartbeats. */
export function oneLineSummary(result) {
  if (result?.killSwitch?.active && !result?.equity) return 'kill switch active — proposal refused';
  const e = result.equity;
  const sizeTxt = e?.manualQtyOverride
    ? ` manual-qty=${e?.proposal?.quantity ?? '?'}`
    : e?.sizingDecision
      ? ` size=${e.sizingDecision.mode} qty=${e.proposal?.quantity ?? e.sizingDecision.requestedQuantity ?? '?'}`
      : '';
  const eqTxt = `equity ${e?.proposal?.side ?? '?'} ${e?.decision ?? '?'}${sizeTxt}`;
  return eqTxt;
}

function subLines(label, sub, result = {}) {
  if (!sub) return [];
  const p = sub.proposal;
  const lines = [
    `  ${label}:     ${sub.decision.toUpperCase()} — ${p.reason}`,
  ];
  if (label === 'equity' && sub.sizingDecision) {
    const approvedQty = sub.decision === 'accepted' ? p.quantity : 0;
    const approved = approvedSizingValues(sub, result);
    const requestedQty = sub.sizingDecision.requestedQuantity ?? 0;
    const requestedNotional = sub.sizingDecision.requestedNotional;
    const requestedWeight = sub.sizingDecision.requestedTargetWeight;
    const caps = sub.sizingDecision.effectiveRiskCaps ?? {};
    lines.push(
      `    sizing:    ${sub.manualQtyOverride ? 'manual --qty override' : formatSizingDecision(sub.sizingDecision)}`,
      `    requested: qty=${requestedQty} notional=${money(requestedNotional)} weight=${pct(requestedWeight)}`,
      `    approved:  qty=${approvedQty} notional=${money(approved.notional)} weight=${pct(approved.weight)} audit=${sub.sizingAuditId ?? 'pending'}`
    );
    if (caps.orderCap) {
      lines.push(
        `    order cap: source=${caps.orderCap.source ?? 'unknown'} value=${money(caps.orderCap.value)} ` +
        `learnedPct=${money(caps.orderCap.learnedPercentCap)} explicitDollar=${money(caps.orderCap.explicitDollarCap)}`
      );
    }
    lines.push(...capReportLines(caps));
    for (const reason of (caps.clampReasons ?? []).slice(0, 5)) {
      lines.push(`    clamp:    ${reason}`);
    }
    if (sub.sizingDecision.warnings?.length > 0) {
      lines.push(`    sizing warnings: ${sub.sizingDecision.warnings.slice(0, 3).join('; ')}`);
    }
  }
  if (sub.risk) lines.push(`    risk:       ${sub.risk.approved ? 'approved' : 'REJECTED'} — ${sub.risk.reason} (est notional ${sub.risk.estNotional ?? 'n/a'})`);
  if (sub.rejectedTradeId !== null) lines.push(`    logged:     rejected_trades id ${sub.rejectedTradeId}`);
  if (sub.order) lines.push(`    order:      id ${sub.order.id ?? '?'} status ${sub.order.status ?? '?'}${sub.order.filledAvgPrice !== null ? ` filledAvgPrice ${sub.order.filledAvgPrice}` : ''}`);
  if (sub.paperTradeId !== null) lines.push(`    logged:     paper_trades id ${sub.paperTradeId}`);
  if (sub.orderError) lines.push(`    order error: ${sub.orderError}`);
  return lines;
}

/** Build the sanitized report lines. Whitelist only — no raw text can leak. */
export function buildPaperReport(result, selected) {
  const cap = result.capabilities;
  const s = result.equity?.proposal?.score ?? {};
  const lines = [
    'Paper trading one-shot (manual, PAPER-only — live trading disabled)',
    `  mode:       ${result.mode === 'execute_paper' ? 'EXECUTE PAPER' : 'DRY RUN (no order)'}`,
    `  account:    ${cap
      ? `equity=${cap.equity ?? '?'} buyingPower=${cap.buyingPower ?? '?'} mult=${cap.multiplier ?? '?'} ` +
        `short=${cap.shortEligible ? 'yes' : 'no'} options=${cap.optionsEligible ? `L${cap.optionsLevel}` : 'no'}` +
        `${cap.blocked ? ' BLOCKED' : ''}`
      : '(not fetched — dry run without paper credentials)'}`,
    `  event:      ${selected?.event?.id ?? '?'} ${selected?.event?.ticker ?? '(none)'}`,
    `  score:      model "${s.model ?? '?'}" prompt "${s.promptVersion ?? '?'}"  ` +
      `dir=${s.direction ?? '?'} status=${s.parserStatus ?? '?'} ` +
      `sentiment=${s.sentiment ?? '?'} impact=${s.impact ?? '?'} confidence=${s.confidence ?? '?'}`,
  ];
  lines.push(...subLines('equity', result.equity, result));
  if (result.mode === 'dry_run') {
    lines.push('  (DRY RUN — pass --execute-paper to actually submit PAPER orders)');
  }
  return lines;
}

/**
 * High-level one-shot used by BOTH the one-shot CLI and the loop: select an
 * event, fetch account state + a reference price from the injected clients, and
 * run the trade logic. Returns { selected, result, lines }.
 */
export async function executeOneShot(db, {
  args, paperClient = null, priceSource = null, nowMs = Date.now(),
}) {
  // Exits FIRST: manage open positions before considering a new entry.
  const exits = await runExitMonitor(db, { paperClient, nowMs, args });
  const exitLines = exits.checked > 0 ? exits.lines : [];

  const selected = selectRecentScoredEvent(db, {
    eventId: args.eventId,
    allowedSymbols: args.symbols,
    excludeProcessed: true,
  });
  if (!selected) {
    return { selected: null, result: null, exits, lines: [
      ...exitLines,
      `No eligible scored event found (need a ${MODEL_PROMPT_VERSION} score on one of [${args.symbols.join(',')}]).`,
    ] };
  }
  const trade = await executeSelectedPaperTrade(db, selected, { args, paperClient, priceSource, nowMs });
  return { selected, result: trade.result, exits, lines: [...exitLines, ...trade.lines] };
}
