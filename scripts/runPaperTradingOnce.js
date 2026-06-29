// scripts/runPaperTradingOnce.js — MANUAL one-shot PAPER trade (Phase 5
// advanced: long/short equity + options + margin-aware risk).
//
//   Dry run (default; NO order):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT \
//       --classifier real_model --allow-shorts --allow-options --options-mode plan_only
//
//   Execute PAPER orders (requires Alpaca paper creds in .env):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
//
// FLOW: select ONE recent real-model-scored event -> build an EQUITY proposal
// (long on up / short on down when --allow-shorts) AND, if --allow-options, an
// OPTION proposal (buy call/put by explicit OCC --option-symbol) -> margin-aware
// risk gate (account snapshot + caps) -> DRY RUN reports only; --execute-paper
// submits PAPER orders -> persist paper_trades (filled) / rejected_trades
// (refused) -> sanitized report.
//
// HARD SAFETY:
// - PAPER ONLY. The order client is hard-wired to the Alpaca paper endpoint;
//   no live endpoint exists and nothing consumes config.liveTradingEnabled.
// - DRY RUN IS THE DEFAULT. Orders go out ONLY with --execute-paper AND creds.
//   Options additionally need --allow-options + --options-mode execute_paper +
//   a verified account options capability + an explicit --option-symbol.
// - No uncapped trading: qty/contract caps + margin-aware notional/exposure/
//   daily caps. No spreads, no multi-leg, no uncovered option writing.
// - SANITIZED OUTPUT ONLY. Never raw model responses, raw payloads, API keys,
//   headers, request configs, or webhook URLs.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadStrategySettings } from '../src/config/strategySettings.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import {
  assessProposal,
  insertPaperTrade,
  insertRejectedTrade,
  DEFAULT_QTY,
  MAX_QTY,
  DEFAULT_THRESHOLDS,
} from '../src/paper/paperTradeProposal.js';
import { proposeOption, DEFAULT_OPTION_CONTRACT_LIMIT } from '../src/paper/optionsProposal.js';
import { assessRisk, resolveCaps, DEFAULT_CAPS } from '../src/paper/paperRisk.js';
import { deriveCapabilities, summarizeCapabilities } from '../src/paper/accountCapabilities.js';
import { MODEL_PROMPT_VERSION } from '../src/sentiment/modelClassifier.js';

export { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS, DEFAULT_CAPS };

const DEFAULT_SYMBOLS = ['AAPL'];
const OPTIONS_MODES = new Set(['plan_only', 'execute_paper']);
export const PAPER_CLASSIFIERS = Object.freeze(['real_model']);
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
});

/** Reference-price lookup window (free IEX feed is restricted for very recent data). */
const REF_PRICE_LAG_MIN = 16;
const REF_PRICE_SPAN_MIN = 10;

function parseUnitFloat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
function parsePosNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parsePosInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function clampInt(value, fallback, lo, hi) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, lo), hi);
}
function cleanSymbols(value, fallback = DEFAULT_SYMBOLS) {
  const symbols = Array.isArray(value)
    ? value.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  return symbols.length > 0 ? [...new Set(symbols)] : [...fallback];
}

/** Map non-secret runtime strategy settings into paper script defaults. */
export function paperDefaultsFromStrategySettings(settings = {}) {
  const defaults = {};
  if (Array.isArray(settings.symbols)) defaults.symbols = cleanSymbols(settings.symbols);
  if (typeof settings.allow_shorts === 'boolean') defaults.allowShorts = settings.allow_shorts;
  if (typeof settings.allow_options === 'boolean') defaults.allowOptions = settings.allow_options;
  if (OPTIONS_MODES.has(settings.options_mode)) defaults.optionsMode = settings.options_mode;

  defaults.thresholds = {};
  if (parseUnitFloat(settings.confidence_threshold) !== null) defaults.thresholds.minConfidence = Number(settings.confidence_threshold);
  if (parseUnitFloat(settings.impact_threshold) !== null) defaults.thresholds.minImpact = Number(settings.impact_threshold);
  if (parseUnitFloat(settings.sentiment_threshold) !== null) defaults.thresholds.minSentiment = Number(settings.sentiment_threshold);
  if (Object.keys(defaults.thresholds).length === 0) delete defaults.thresholds;

  defaults.caps = {};
  if (parsePosNum(settings.max_order_notional) !== null) defaults.caps.maxOrderNotional = Number(settings.max_order_notional);
  if (parsePosNum(settings.max_symbol_exposure) !== null) defaults.caps.maxSymbolExposure = Number(settings.max_symbol_exposure);
  if (parsePosNum(settings.max_gross_exposure) !== null) defaults.caps.maxGrossExposure = Number(settings.max_gross_exposure);
  if (parsePosNum(settings.max_daily_paper_orders) !== null) defaults.caps.maxDailyPaperOrders = Number(settings.max_daily_paper_orders);
  if (parsePosNum(settings.max_daily_paper_notional) !== null) defaults.caps.maxDailyPaperNotional = Number(settings.max_daily_paper_notional);
  if (parsePosNum(settings.max_option_premium) !== null) {
    defaults.caps.maxOptionPremium = Number(settings.max_option_premium);
    defaults.optionMaxPremium = Number(settings.max_option_premium);
  }
  if (Object.keys(defaults.caps).length === 0) delete defaults.caps;
  return defaults;
}

/**
 * Parse CLI args. Exported for tests. Every numeric value is validated; unknown
 * flags are ignored; execution stays OFF unless --execute-paper is present.
 */
export function parseArgs(argv, defaults = {}) {
  const args = {
    symbols: cleanSymbols(defaults.symbols),
    qty: Math.min(parsePosInt(defaults.qty) ?? DEFAULT_QTY, MAX_QTY),
    eventId: null,
    executePaper: false,
    classifier: defaults.classifier ?? null,
    ingestLimit: clampInt(defaults.ingestLimit, DEFAULT_PAPER_INGEST_LIMIT, 1, MAX_PAPER_INGEST_LIMIT),
    classifyLimit: clampInt(defaults.classifyLimit, DEFAULT_PAPER_CLASSIFY_LIMIT, 1, MAX_PAPER_CLASSIFY_LIMIT),
    newsLookbackMinutes: clampInt(defaults.newsLookbackMinutes, DEFAULT_NEWS_LOOKBACK_MINUTES, 1, MAX_NEWS_LOOKBACK_MINUTES),
    allowShorts: defaults.allowShorts === true,
    allowOptions: defaults.allowOptions === true,
    optionsMode: OPTIONS_MODES.has(defaults.optionsMode) ? defaults.optionsMode : 'plan_only',
    optionSymbol: defaults.optionSymbol ?? null,
    optionExpiryDaysMin: parsePosInt(defaults.optionExpiryDaysMin),
    optionExpiryDaysMax: parsePosInt(defaults.optionExpiryDaysMax),
    optionMaxPremium: parsePosNum(defaults.optionMaxPremium),
    optionContractLimit: parsePosInt(defaults.optionContractLimit) ?? DEFAULT_OPTION_CONTRACT_LIMIT,
    thresholds: { ...(defaults.thresholds ?? {}) },
    caps: { ...(defaults.caps ?? {}) },
  };
  const setThresh = (key, v) => { const f = parseUnitFloat(v); if (f !== null) args.thresholds[key] = f; };
  const setCap = (key, v) => { const n = parsePosNum(v); if (n !== null) args.caps[key] = n; };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--symbols' && next) {
      args.symbols = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      i += 1;
    } else if (flag === '--qty' && next) {
      args.qty = Math.min(parsePosInt(next) ?? DEFAULT_QTY, MAX_QTY); i += 1;
    } else if (flag === '--event-id' && next) {
      args.eventId = parsePosInt(next); i += 1;
    } else if (flag === '--confidence-threshold' && next) { setThresh('minConfidence', next); i += 1; }
    else if (flag === '--impact-threshold' && next) { setThresh('minImpact', next); i += 1; }
    else if (flag === '--sentiment-threshold' && next) { setThresh('minSentiment', next); i += 1; }
    else if (flag === '--classifier' && next) { args.classifier = next.trim(); i += 1; }
    else if (flag === '--ingest-limit' && next) { args.ingestLimit = clampInt(next, DEFAULT_PAPER_INGEST_LIMIT, 1, MAX_PAPER_INGEST_LIMIT); i += 1; }
    else if (flag === '--classify-limit' && next) { args.classifyLimit = clampInt(next, DEFAULT_PAPER_CLASSIFY_LIMIT, 1, MAX_PAPER_CLASSIFY_LIMIT); i += 1; }
    else if (flag === '--news-lookback-minutes' && next) { args.newsLookbackMinutes = clampInt(next, DEFAULT_NEWS_LOOKBACK_MINUTES, 1, MAX_NEWS_LOOKBACK_MINUTES); i += 1; }
    else if (flag === '--allow-shorts') { args.allowShorts = true; }
    else if (flag === '--allow-options') { args.allowOptions = true; }
    else if (flag === '--options-mode' && next) {
      if (OPTIONS_MODES.has(next.trim())) args.optionsMode = next.trim(); i += 1;
    } else if (flag === '--option-symbol' && next) { args.optionSymbol = next.trim().toUpperCase(); i += 1; }
    else if (flag === '--option-expiry-days-min' && next) { args.optionExpiryDaysMin = parsePosInt(next); i += 1; }
    else if (flag === '--option-expiry-days-max' && next) { args.optionExpiryDaysMax = parsePosInt(next); i += 1; }
    else if (flag === '--option-max-premium' && next) {
      const n = parsePosNum(next); if (n !== null) { args.optionMaxPremium = n; args.caps.maxOptionPremium = n; } i += 1;
    } else if (flag === '--option-contract-limit' && next) {
      args.optionContractLimit = parsePosInt(next) ?? DEFAULT_OPTION_CONTRACT_LIMIT; i += 1;
    } else if (flag === '--max-order-notional' && next) { setCap('maxOrderNotional', next); i += 1; }
    else if (flag === '--max-symbol-exposure' && next) { setCap('maxSymbolExposure', next); i += 1; }
    else if (flag === '--max-gross-exposure' && next) { setCap('maxGrossExposure', next); i += 1; }
    else if (flag === '--max-daily-paper-orders' && next) { setCap('maxDailyPaperOrders', next); i += 1; }
    else if (flag === '--max-daily-paper-notional' && next) { setCap('maxDailyPaperNotional', next); i += 1; }
    else if (flag === '--execute-paper') { args.executePaper = true; }
  }
  if (args.symbols.length === 0) args.symbols = [...DEFAULT_SYMBOLS];
  return args;
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
function riskShape(proposal, kind) {
  return kind === 'option'
    ? { assetClass: 'option', side: 'buy', ticker: proposal.underlying, quantity: proposal.contracts }
    : { assetClass: 'equity', side: proposal.side, ticker: proposal.ticker, quantity: proposal.quantity };
}

/**
 * Process ONE proposal through risk + (dry-run|execute) + persistence. Never
 * throws on a submit failure — records a sanitized orderError instead.
 */
async function processProposal(db, proposal, ctx) {
  const {
    kind, capabilities, account, positions, caps, daily, referencePrice,
    executePaper, paperClient, planOnly = false,
  } = ctx;
  const sub = {
    kind, proposal, risk: null, decision: 'rejected',
    rejectedTradeId: null, paperTradeId: null, order: null, orderError: null,
  };

  // Score/intent gate already decided acceptance.
  if (!proposal.accepted) {
    sub.rejectedTradeId = insertRejectedTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.underlying ?? proposal.ticker,
      side: kind === 'option' ? 'buy' : proposal.side,
      quantity: proposal.contracts ?? proposal.quantity ?? null,
      reason: proposal.reason,
    }).id;
    return sub;
  }

  // Margin-aware risk gate (run when we have an account snapshot, or when we are
  // about to execute — a real order is never sent without a risk pass).
  const haveAccount = Boolean(capabilities && capabilities.available);
  if (haveAccount || executePaper) {
    sub.risk = assessRisk({
      proposal: riskShape(proposal, kind),
      capabilities: capabilities ?? { available: false },
      account, positions, caps, daily, referencePrice, executePaper,
    });
    if (!sub.risk.approved) {
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId,
        ticker: proposal.underlying ?? proposal.ticker,
        side: kind === 'option' ? 'buy' : proposal.side,
        quantity: proposal.contracts ?? proposal.quantity ?? null,
        reason: sub.risk.reason,
      }).id;
      return sub;
    }
  }

  sub.decision = 'accepted';
  if (planOnly) { sub.decision = 'plan'; return sub; } // options plan_only never executes
  if (!executePaper) return sub; // dry run: nothing sent or stored
  if (!paperClient) { sub.orderError = 'paper client not configured — no order sent'; return sub; }

  try {
    const order =
      kind === 'option'
        ? await paperClient.submitOptionMarketOrder({ optionSymbol: proposal.optionSymbol, qty: proposal.contracts, side: 'buy' })
        : await paperClient.submitMarketOrder({ symbol: proposal.ticker, qty: proposal.quantity, side: proposal.side });
    sub.order = order;
    sub.paperTradeId = insertPaperTrade(db, {
      newsEventId: proposal.eventId,
      ticker: proposal.underlying ?? proposal.ticker,
      side: kind === 'option' ? 'buy' : proposal.side,
      quantity: proposal.contracts ?? proposal.quantity,
      fillPrice: order.filledAvgPrice ?? null,
      entryAt: order.submittedAt ?? new Date().toISOString(),
      tradeReason:
        (kind === 'option' ? `[option ${proposal.intent} ${proposal.optionSymbol}] ` : '') +
        `${proposal.reason}; paper order ${order.id ?? '?'} status ${order.status ?? '?'}`,
      status: 'open',
    }).id;
  } catch (err) {
    sub.orderError = err.message; // already sanitized by the client
  }
  return sub;
}

/**
 * Core one-shot logic, dependency-injected so tests run fully offline. Account/
 * positions/capabilities/referencePrice/daily are passed in; the script's
 * main()/loop fetch them from the real clients.
 */
export async function runPaperTradeOnce(db, { event, score }, deps = {}) {
  const {
    paperClient = null, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {}, allowShorts = false,
    allowOptions = false, optionsMode = 'plan_only', optionSymbol = null, optionMaxPremium = null,
    optionContractLimit = DEFAULT_OPTION_CONTRACT_LIMIT, optionExpiryDaysMin = null, optionExpiryDaysMax = null,
    caps = {}, account = null, positions = [], capabilities = null, referencePrice = null,
    optionReferencePrice = null, daily = { orders: 0, notional: 0 }, executePaper = false, nowMs = Date.now(),
  } = deps;

  const result = {
    mode: executePaper ? 'execute_paper' : 'dry_run',
    capabilities: capabilities ? summarizeCapabilities(capabilities) : null,
    referencePrice,
    equity: null,
    option: null,
  };

  const equityProposal = assessProposal({ event, score, qty, allowedSymbols, thresholds, allowShorts });
  result.equity = await processProposal(db, equityProposal, {
    kind: 'equity', capabilities, account, positions, caps, daily, referencePrice, executePaper, paperClient,
  });

  const optionProposal = proposeOption({
    event, score, allowOptions, optionsMode, optionSymbol, allowedSymbols, thresholds,
    optionContractLimit, optionExpiryDaysMin, optionExpiryDaysMax, optionMaxPremium, nowMs,
  });
  if (optionProposal.enabled) {
    result.option = await processProposal(db, optionProposal, {
      kind: 'option', capabilities, account, positions, caps, daily,
      referencePrice: optionReferencePrice, executePaper, paperClient, planOnly: optionProposal.planOnly,
    });
  } else {
    result.option = {
      kind: 'option', proposal: optionProposal, risk: null, decision: 'disabled',
      rejectedTradeId: null, paperTradeId: null, order: null, orderError: null,
    };
  }
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

/** Fetch account/reference state and run the existing paper-trade core. */
export async function executeSelectedPaperTrade(
  db,
  selected,
  { args, paperClient = null, priceSource = null, nowMs = Date.now() }
) {
  const { account, positions, capabilities } = await fetchAccountState(paperClient);
  const referencePrice = await fetchReferencePrice(priceSource, selected.event.ticker, nowMs);
  const daily = getDailyCounters(db);
  const result = await runPaperTradeOnce(db, selected, {
    paperClient, account, positions, capabilities, referencePrice,
    daily, nowMs,
    qty: args.qty, allowedSymbols: args.symbols, thresholds: args.thresholds, allowShorts: args.allowShorts,
    allowOptions: args.allowOptions, optionsMode: args.optionsMode, optionSymbol: args.optionSymbol,
    optionMaxPremium: args.optionMaxPremium, optionContractLimit: args.optionContractLimit,
    optionExpiryDaysMin: args.optionExpiryDaysMin, optionExpiryDaysMax: args.optionExpiryDaysMax,
    caps: args.caps, executePaper: args.executePaper,
  });
  return { selected, result, lines: buildPaperReport(result, selected) };
}

function hasSignalPass(selected, args, nowMs) {
  const equity = assessProposal({
    event: selected.event,
    score: selected.score,
    qty: args.qty,
    allowedSymbols: args.symbols,
    thresholds: args.thresholds,
    allowShorts: args.allowShorts,
  });
  if (equity.accepted) return true;
  const option = proposeOption({
    event: selected.event,
    score: selected.score,
    allowOptions: args.allowOptions,
    optionsMode: args.optionsMode,
    optionSymbol: args.optionSymbol,
    allowedSymbols: args.symbols,
    thresholds: args.thresholds,
    optionContractLimit: args.optionContractLimit,
    optionExpiryDaysMin: args.optionExpiryDaysMin,
    optionExpiryDaysMax: args.optionExpiryDaysMax,
    optionMaxPremium: args.optionMaxPremium,
    nowMs,
  });
  return option.enabled && option.accepted;
}

function tradeOutcome(result) {
  const subs = [result?.equity, result?.option].filter(Boolean);
  if (subs.some((s) => s.orderError)) return PAPER_DECISION_OUTCOMES.BROKER_SUBMISSION_ERROR;
  if (subs.some((s) => s.decision === 'rejected' && s.risk && !s.risk.approved)) {
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
 * the explicitly requested real-model classifier, then attempt a PAPER trade on
 * a fresh, unprocessed scored event. All collaborators are injected for tests.
 */
export async function runPaperDecisionCycle(
  db,
  { provider = null, classifier = null, paperClient = null, priceSource = null, providerSkipReason = null } = {},
  args = parseArgs([]),
  { nowMs = Date.now() } = {}
) {
  const base = {
    mode: args.executePaper ? 'execute_paper' : 'dry_run',
    outcome: null,
    skipReason: null,
    ingestion: null,
    classification: null,
    freshCandidates: [],
    selected: null,
    trade: null,
    lines: [],
  };

  if (Number.isInteger(args.eventId) && args.eventId > 0) {
    const selected = selectRecentScoredEvent(db, {
      eventId: args.eventId,
      allowedSymbols: args.symbols,
      excludeProcessed: false,
    });
    if (!selected) {
      return {
        ...base,
        outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
        skipReason: `explicit event ${args.eventId} has no ${MODEL_PROMPT_VERSION} score in allowed symbols`,
      };
    }
    const trade = await executeSelectedPaperTrade(db, selected, { args, paperClient, priceSource, nowMs });
    return { ...base, outcome: tradeOutcome(trade.result), selected, trade, lines: trade.lines };
  }

  if (!provider) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_NEW_NEWS,
      skipReason: providerSkipReason ?? 'Alpaca News provider not configured',
    };
  }

  const since = new Date(nowMs - args.newsLookbackMinutes * 60_000).toISOString();
  const until = new Date(nowMs).toISOString();
  const ingestion = await ingestNews(db, provider, {
    symbols: args.symbols,
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

  if (args.classifier !== 'real_model' || !classifier || classifier.promptVersion !== MODEL_PROMPT_VERSION) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
      skipReason: 'real_model classifier was not requested/configured for this loop iteration',
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
    allowedSymbols: args.symbols,
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
    allowedSymbols: args.symbols,
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

  const selected = unprocessed.find((c) => hasSignalPass(c, args, nowMs));
  const candidate = selected ?? unprocessed[0];
  const trade = await executeSelectedPaperTrade(db, candidate, { args, paperClient, priceSource, nowMs });
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

/** One short sanitized summary line per asset class, for loop heartbeats. */
export function oneLineSummary(result) {
  const e = result.equity;
  const eqTxt = `equity ${e?.proposal?.side ?? '?'} ${e?.decision ?? '?'}`;
  let opTxt = 'option off';
  if (result.option && result.option.decision !== 'disabled') {
    opTxt = `option ${result.option.proposal?.intent ?? '?'} ${result.option.decision}`;
  }
  return `${eqTxt}; ${opTxt}`;
}

function subLines(label, sub) {
  if (!sub) return [];
  if (sub.decision === 'disabled') return [`  ${label}:     disabled (--allow-options not set)`];
  const p = sub.proposal;
  const lines = [
    `  ${label}:     ${sub.decision.toUpperCase()} — ${p.reason}`,
  ];
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
  lines.push(...subLines('equity', result.equity));
  lines.push(...subLines('option', result.option));
  if (result.mode === 'dry_run') {
    lines.push('  (DRY RUN — pass --execute-paper to actually submit PAPER orders)');
  }
  return lines;
}

/**
 * High-level one-shot used by BOTH the script main() and the loop: select an
 * event, fetch account state + a reference price from the injected clients, and
 * run the trade logic. Returns { selected, result, lines }.
 */
export async function executeOneShot(db, { args, paperClient = null, priceSource = null, nowMs = Date.now() }) {
  const selected = selectRecentScoredEvent(db, {
    eventId: args.eventId,
    allowedSymbols: args.symbols,
    excludeProcessed: true,
  });
  if (!selected) {
    return { selected: null, result: null, lines: [
      `No eligible scored event found (need a ${MODEL_PROMPT_VERSION} score on one of [${args.symbols.join(',')}]).`,
    ] };
  }
  const trade = await executeSelectedPaperTrade(db, selected, { args, paperClient, priceSource, nowMs });
  return { selected, result: trade.result, lines: trade.lines };
}

async function main() {
  const config = loadConfig();
  const strategy = loadStrategySettings();
  const defaults = strategy.source === 'runtime' ? paperDefaultsFromStrategySettings(strategy.settings) : {};
  const args = parseArgs(process.argv.slice(2), defaults);

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);

    const hasCreds = Boolean(config.alpacaPaper.keyId && config.alpacaPaper.secretKey);
    if (args.executePaper && !hasCreds) {
      console.error(
        'Paper order NOT SENT: Alpaca PAPER credentials are not configured.\n' +
          'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env, or omit --execute-paper.'
      );
      process.exitCode = 1;
      return;
    }
    // Construct clients only when credentialed (account snapshot + reference
    // price improve dry-run reporting too, but require keys).
    const paperClient = hasCreds ? createAlpacaPaperClient(config) : null;
    const priceSource = hasCreds ? createAlpacaTradesPriceSource(config) : null;

    const { lines, result } = await executeOneShot(db, { args, paperClient, priceSource });
    for (const line of lines) console.log(line);
    if (!result) return;

    const orderErr = result.equity?.orderError || result.option?.orderError;
    if (orderErr) {
      console.log('Paper trading completed WITH AN ORDER ERROR (see above).');
      process.exitCode = 1;
    } else {
      console.log('Paper trading COMPLETE (research/paper-only; no live trading).');
    }
  } catch (err) {
    console.error(`Paper trading FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
