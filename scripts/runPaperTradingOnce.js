// scripts/runPaperTradingOnce.js — MANUAL one-shot PAPER trade (Phase 5
// advanced: long/short equity + options + margin-aware risk).
//
//   Dry run (default; NO order):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT \
//       --classifier openai --allow-shorts --allow-options --options-mode plan_only
//
//   Execute PAPER orders (requires Alpaca paper creds in .env):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
//
// FLOW: select ONE recent real-model-scored event -> build an EQUITY proposal
// (long on up / short on down when --allow-shorts) AND, if --allow-options, an
// OPTION plan (buy call/put by explicit OCC --option-symbol or contract
// discovery) -> margin-aware risk gate (account snapshot + caps) -> DRY RUN
// reports only; --execute-paper submits PAPER equity orders only -> persist
// paper_trades (filled) / rejected_trades (refused) -> sanitized report.
//
// HARD SAFETY:
// - PAPER ONLY. The order client is hard-wired to the Alpaca paper endpoint;
//   no live endpoint exists and nothing consumes config.liveTradingEnabled.
// - DRY RUN IS THE DEFAULT. Equity orders go out ONLY with --execute-paper AND
//   creds. Option order submission is disabled until tested exit monitoring and
//   sell-to-close reporting exist; option execute_paper requests are rejected
//   after contract/quote/risk validation with a structured reason.
// - No uncapped trading: qty/contract caps + margin-aware notional/exposure/
//   daily caps. No spreads, no multi-leg, no uncovered option writing.
// - SANITIZED OUTPUT ONLY. Never raw model responses, raw payloads, API keys,
//   headers, request configs, or webhook URLs.

import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { loadStrategySettings } from '../src/config/strategySettings.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import {
  classifyBrokerOrderState,
  formatBrokerTruthLines,
  recordPerformanceSnapshot,
} from '../src/paper/brokerTruth.js';
import {
  assessProposal,
  insertPaperTrade,
  insertRejectedTrade,
  DEFAULT_QTY,
  MAX_QTY,
  DEFAULT_THRESHOLDS,
} from '../src/paper/paperTradeProposal.js';
import { proposeOption, DEFAULT_OPTION_CONTRACT_LIMIT } from '../src/paper/optionsProposal.js';
import { enrichOptionProposal } from '../src/paper/optionContracts.js';
import { entryLimitPrice, optionEntryBlocked } from '../src/paper/optionExits.js';
import { reconcileBotOptions } from '../src/paper/optionMonitor.js';
import {
  assessRisk,
  clampEquityQuantityToCaps,
  resolveCaps,
  resolveLearnedEquityEffectiveCaps,
  DEFAULT_CAPS,
} from '../src/paper/paperRisk.js';
import { deriveCapabilities, grossExposure, summarizeCapabilities } from '../src/paper/accountCapabilities.js';
import {
  getOwnedEquityExposureSnapshot,
  getPaperEventAttemptStats,
  insertDuplicateSuppressionAudit,
  insertEquitySizingDecision,
  insertPaperOptionTrade,
  listBrokerConfirmedEquityOutcomes,
  sweepStaleQueueEvents,
  markUnusableScoresTerminal,
  selectClassificationBacklog,
  countScoredInWindow,
  getProviderCursor,
  advanceProviderCursor,
  retainProviderCursor,
  maxPublishedAtForEvents,
} from '../src/database/paperRuntime.js';
import {
  resolveProviderSince,
  nextCursorValue,
  clampMaxPages,
  DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE,
  MAX_PROVIDER_MAX_PAGES_PER_CYCLE,
} from '../src/paper/providerCursors.js';
import {
  decideEquitySizing,
  formatSizingDecision,
  resolveEquitySizingSettings,
  scoreBucket,
  SIZING_MODES,
} from '../src/paper/equitySizing.js';
import {
  selectCandidateUniverse,
  DEFAULT_MAX_SYMBOLS_PER_CYCLE,
  MAX_SYMBOLS_PER_CYCLE,
} from '../src/paper/candidateUniverse.js';
import { MODEL_PROMPT_VERSION } from '../src/sentiment/modelClassifier.js';

export { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS, DEFAULT_CAPS };

const DEFAULT_SYMBOLS = ['AAPL'];
const OPTIONS_MODES = new Set(['plan_only', 'execute_paper']);
export const PAPER_CLASSIFIERS = Object.freeze(['openai', 'anthropic', 'real_model']);
export const DEFAULT_PAPER_FEATURES = Object.freeze({
  enableShorts: false,
  enableOptions: false,
  enableMargin: false,
});
export const DEFAULT_PAPER_INGEST_LIMIT = 20;
export const MAX_PAPER_INGEST_LIMIT = 50;
export const DEFAULT_PAPER_CLASSIFY_LIMIT = 5;
export const MAX_PAPER_CLASSIFY_LIMIT = 5;
export const DEFAULT_ENABLED_NEWS_PROVIDERS = Object.freeze(['alpaca', 'benzinga']);
export const SUPPORTED_LIVE_NEWS_PROVIDERS = Object.freeze(['alpaca', 'benzinga']);
export const DEFAULT_MAX_EVENTS_CLASSIFIED_PER_CYCLE = 10;
export const MAX_EVENTS_CLASSIFIED_PER_CYCLE_CAP = 50;
export const DEFAULT_MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE = 5;
export const MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE_CAP = 25;
export const DEFAULT_PROVIDER_COOLDOWN_MINUTES = 30;
export const DEFAULT_PROVIDER_MAX_FAILURES_BEFORE_COOLDOWN = 2;
export const DEFAULT_DUPLICATE_STORY_WINDOW_MINUTES = 20;
export const MAX_DUPLICATE_STORY_WINDOW_MINUTES = 390;
export { DEFAULT_MAX_SYMBOLS_PER_CYCLE, MAX_SYMBOLS_PER_CYCLE };
export const DEFAULT_NEWS_LOOKBACK_MINUTES = 60;
export const MAX_NEWS_LOOKBACK_MINUTES = 390;
// Durable backlog: max time an event may wait in the pending pipeline before it
// becomes a terminal `stale_expired` (independent of the provider fetch window).
export const DEFAULT_MAX_QUEUE_AGE_MINUTES = 120;
export const MAX_QUEUE_AGE_MINUTES_CAP = 1440;
export { DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE, MAX_PROVIDER_MAX_PAGES_PER_CYCLE };
/** Bound on backlog rows selected per cycle (deferred remainder waits for later cycles). */
export const BACKLOG_SELECT_LIMIT = 200;

export const PAPER_DECISION_OUTCOMES = Object.freeze({
  TRADE_ATTEMPTED: 'trade_attempted',
  NO_NEW_NEWS: 'no_new_news',
  NO_FRESH_REAL_MODEL_SCORE: 'no_fresh_real_model_score',
  ALL_FRESH_SCORES_FAILED_SIGNAL_THRESHOLDS: 'all_fresh_scores_failed_signal_thresholds',
  ALREADY_PROCESSED_EVENT: 'already_processed_event',
  RISK_REJECTION: 'risk_rejection',
  BROKER_SUBMISSION_ERROR: 'broker_submission_error',
  NO_ACTIVE_PROVIDER: 'no_active_provider',
});

/** Reference-price lookup window (free IEX feed is restricted for very recent data). */
const REF_PRICE_LAG_MIN = 16;
const REF_PRICE_SPAN_MIN = 10;
const MODEL_CLASSIFIER_NAMES = new Set(['openai', 'anthropic', 'real_model']);

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

function cleanProviders(value, fallback = DEFAULT_ENABLED_NEWS_PROVIDERS) {
  const allowed = new Set(SUPPORTED_LIVE_NEWS_PROVIDERS);
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const providers = [...new Set(raw
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => allowed.has(s)))];
  return providers.length > 0 ? providers : [...fallback];
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
  defaults.sizingSettings = {};
  for (const key of [
    'sizing_min_comparable_sample_size',
    'sizing_cold_start_target_weight',
    'sizing_max_target_weight',
    'sizing_enable_confidence_scaling',
    'sizing_enable_impact_scaling',
  ]) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) defaults.sizingSettings[key] = settings[key];
  }
  if (Object.keys(defaults.sizingSettings).length === 0) delete defaults.sizingSettings;
  if (Array.isArray(settings.enabled_news_providers)) defaults.enabledProviders = cleanProviders(settings.enabled_news_providers);
  if (parsePosInt(settings.max_events_classified_per_cycle) !== null) {
    defaults.maxEventsClassifiedPerCycle = Number(settings.max_events_classified_per_cycle);
  }
  if (parsePosInt(settings.max_qualifying_events_attempted_per_cycle) !== null) {
    defaults.maxQualifyingEventsAttemptedPerCycle = Number(settings.max_qualifying_events_attempted_per_cycle);
  }
  if (parsePosInt(settings.provider_cooldown_minutes) !== null) {
    defaults.providerCooldownMinutes = Number(settings.provider_cooldown_minutes);
  }
  if (parsePosInt(settings.provider_max_failures_before_cooldown) !== null) {
    defaults.providerMaxFailuresBeforeCooldown = Number(settings.provider_max_failures_before_cooldown);
  }
  if (parsePosInt(settings.duplicate_story_window_minutes) !== null) {
    defaults.duplicateStoryWindowMinutes = Number(settings.duplicate_story_window_minutes);
  }
  if (parsePosInt(settings.max_queue_age_minutes) !== null) {
    defaults.maxQueueAgeMinutes = Number(settings.max_queue_age_minutes);
  }
  if (parsePosInt(settings.provider_max_pages_per_cycle) !== null) {
    defaults.providerMaxPagesPerCycle = Number(settings.provider_max_pages_per_cycle);
  }
  return defaults;
}

export function paperFeaturesFromConfig(config = {}) {
  return {
    enableShorts: config?.paperCapabilities?.enableShorts === true,
    enableOptions: config?.paperCapabilities?.enableOptions === true,
    enableMargin: config?.paperCapabilities?.enableMargin === true,
  };
}

function resolvePaperFeatures(features = {}) {
  return {
    enableShorts: features.enableShorts === true,
    enableOptions: features.enableOptions === true,
    enableMargin: features.enableMargin === true,
  };
}

/**
 * Parse CLI args. Exported for tests. Every numeric value is validated; unknown
 * flags are ignored; execution stays OFF unless --execute-paper is present.
 */
export function parseArgs(argv, defaults = {}) {
  const args = {
    symbols: cleanSymbols(defaults.symbols),
    qty: Math.min(parsePosInt(defaults.qty) ?? DEFAULT_QTY, MAX_QTY),
    qtyExplicit: false,
    eventId: null,
    executePaper: false,
    classifier: defaults.classifier ?? null,
    ingestLimit: clampInt(defaults.ingestLimit, DEFAULT_PAPER_INGEST_LIMIT, 1, MAX_PAPER_INGEST_LIMIT),
    classifyLimit: clampInt(defaults.classifyLimit, DEFAULT_PAPER_CLASSIFY_LIMIT, 1, MAX_PAPER_CLASSIFY_LIMIT),
    classifyLimitExplicit: Object.prototype.hasOwnProperty.call(defaults, 'classifyLimit'),
    enabledProviders: cleanProviders(defaults.enabledProviders),
    maxEventsClassifiedPerCycle: clampInt(
      defaults.maxEventsClassifiedPerCycle,
      DEFAULT_MAX_EVENTS_CLASSIFIED_PER_CYCLE,
      1,
      MAX_EVENTS_CLASSIFIED_PER_CYCLE_CAP
    ),
    maxQualifyingEventsAttemptedPerCycle: clampInt(
      defaults.maxQualifyingEventsAttemptedPerCycle,
      DEFAULT_MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE,
      1,
      MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE_CAP
    ),
    providerCooldownMinutes: clampInt(defaults.providerCooldownMinutes, DEFAULT_PROVIDER_COOLDOWN_MINUTES, 1, 1440),
    providerMaxFailuresBeforeCooldown: clampInt(
      defaults.providerMaxFailuresBeforeCooldown,
      DEFAULT_PROVIDER_MAX_FAILURES_BEFORE_COOLDOWN,
      1,
      20
    ),
    duplicateStoryWindowMinutes: clampInt(
      defaults.duplicateStoryWindowMinutes,
      DEFAULT_DUPLICATE_STORY_WINDOW_MINUTES,
      1,
      MAX_DUPLICATE_STORY_WINDOW_MINUTES
    ),
    maxQueueAgeMinutes: clampInt(defaults.maxQueueAgeMinutes, DEFAULT_MAX_QUEUE_AGE_MINUTES, 5, MAX_QUEUE_AGE_MINUTES_CAP),
    providerMaxPagesPerCycle: clampMaxPages(defaults.providerMaxPagesPerCycle, DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE),
    maxSymbolsPerCycle: clampInt(defaults.maxSymbolsPerCycle, DEFAULT_MAX_SYMBOLS_PER_CYCLE, 1, MAX_SYMBOLS_PER_CYCLE),
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
    sizingSettings: { ...(defaults.sizingSettings ?? {}) },
    paperFeatures: resolvePaperFeatures(defaults.paperFeatures ?? DEFAULT_PAPER_FEATURES),
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
      args.qty = Math.min(parsePosInt(next) ?? DEFAULT_QTY, MAX_QTY); args.qtyExplicit = true; i += 1;
    } else if (flag === '--event-id' && next) {
      args.eventId = parsePosInt(next); i += 1;
    } else if (flag === '--confidence-threshold' && next) { setThresh('minConfidence', next); i += 1; }
    else if (flag === '--impact-threshold' && next) { setThresh('minImpact', next); i += 1; }
    else if (flag === '--sentiment-threshold' && next) { setThresh('minSentiment', next); i += 1; }
    else if (flag === '--classifier' && next) { args.classifier = next.trim(); i += 1; }
    else if (flag === '--ingest-limit' && next) { args.ingestLimit = clampInt(next, DEFAULT_PAPER_INGEST_LIMIT, 1, MAX_PAPER_INGEST_LIMIT); i += 1; }
    else if (flag === '--classify-limit' && next) { args.classifyLimit = clampInt(next, DEFAULT_PAPER_CLASSIFY_LIMIT, 1, MAX_PAPER_CLASSIFY_LIMIT); args.classifyLimitExplicit = true; i += 1; }
    else if (flag === '--enabled-providers' && next) { args.enabledProviders = cleanProviders(next); i += 1; }
    else if (flag === '--max-events-classified-per-cycle' && next) {
      args.maxEventsClassifiedPerCycle = clampInt(next, DEFAULT_MAX_EVENTS_CLASSIFIED_PER_CYCLE, 1, MAX_EVENTS_CLASSIFIED_PER_CYCLE_CAP); i += 1;
    }
    else if (flag === '--max-qualifying-events-attempted-per-cycle' && next) {
      args.maxQualifyingEventsAttemptedPerCycle = clampInt(next, DEFAULT_MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE, 1, MAX_QUALIFYING_EVENTS_ATTEMPTED_PER_CYCLE_CAP); i += 1;
    }
    else if (flag === '--provider-cooldown-minutes' && next) {
      args.providerCooldownMinutes = clampInt(next, DEFAULT_PROVIDER_COOLDOWN_MINUTES, 1, 1440); i += 1;
    }
    else if (flag === '--provider-max-failures-before-cooldown' && next) {
      args.providerMaxFailuresBeforeCooldown = clampInt(next, DEFAULT_PROVIDER_MAX_FAILURES_BEFORE_COOLDOWN, 1, 20); i += 1;
    }
    else if (flag === '--duplicate-story-window-minutes' && next) {
      args.duplicateStoryWindowMinutes = clampInt(next, DEFAULT_DUPLICATE_STORY_WINDOW_MINUTES, 1, MAX_DUPLICATE_STORY_WINDOW_MINUTES); i += 1;
    }
    else if (flag === '--max-queue-age-minutes' && next) {
      args.maxQueueAgeMinutes = clampInt(next, DEFAULT_MAX_QUEUE_AGE_MINUTES, 5, MAX_QUEUE_AGE_MINUTES_CAP); i += 1;
    }
    else if (flag === '--provider-max-pages-per-cycle' && next) {
      args.providerMaxPagesPerCycle = clampMaxPages(next, DEFAULT_PROVIDER_MAX_PAGES_PER_CYCLE); i += 1;
    }
    else if (flag === '--max-symbols-per-cycle' && next) { args.maxSymbolsPerCycle = clampInt(next, DEFAULT_MAX_SYMBOLS_PER_CYCLE, 1, MAX_SYMBOLS_PER_CYCLE); i += 1; }
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
    sinceReceived = null,
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
  if (sinceReceived && !explicitEventId) {
    conds.push('n.received_at >= ?');
    params.push(sinceReceived);
  }
  if (excludeProcessed && !explicitEventId) {
    // Terminal via any durable source: submitted/pending (paper_trades),
    // signal/risk rejected (rejected_trades), duplicate-suppressed, or
    // stale_expired/provider_invalid (paper_event_terminals). Non-terminal
    // scored events (incl. prior cycles) remain proposal-backlog eligible.
    conds.push('NOT EXISTS (SELECT 1 FROM paper_trades pt WHERE pt.news_event_id = n.id)');
    conds.push('NOT EXISTS (SELECT 1 FROM rejected_trades rt WHERE rt.news_event_id = n.id)');
    conds.push('NOT EXISTS (SELECT 1 FROM paper_duplicate_suppression_audits d WHERE d.suppressed_news_event_id = n.id)');
    conds.push('NOT EXISTS (SELECT 1 FROM paper_event_terminals te WHERE te.news_event_id = n.id)');
  }
  const cap = clampInt(limit, 25, 1, 500);
  return db
    .prepare(
      `SELECT n.id AS event_id, n.ticker AS ticker,
              n.provider AS provider, n.provider_event_id AS provider_event_id,
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
    event: {
      id: row.event_id,
      ticker: row.ticker,
      provider: row.provider,
      providerEventId: row.provider_event_id,
    },
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
    executePaper, paperClient, planOnly = false, paperFeatures = DEFAULT_PAPER_FEATURES,
    asset = null, optionEntry = { blocked: true, reason: 'option entry context unavailable' }, optionConfig = {},
    nowMs = Date.now(), sizingDecision = null, manualQtyOverride = false,
    currentOwnedExposure = 0, dataQualityWarnings = [],
  } = ctx;
  const sub = {
    kind, proposal, risk: null, decision: 'rejected',
    rejectedTradeId: null, paperTradeId: null, paperOptionTradeId: null,
    order: null, orderError: null,
    brokerTruthState: null, brokerHasFill: false,
    sizingDecision, manualQtyOverride, sizingAuditId: null,
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
    insertSizingAuditIfPresent(db, sub, {
      account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
    });
    return sub;
  }

  // Margin-aware risk gate (run when we have an account snapshot, or when we are
  // about to execute — a real order is never sent without a risk pass).
  const haveAccount = Boolean(capabilities && capabilities.available);
  const needsMandatoryRisk = kind === 'option' || proposal.side === 'sell';
  if (haveAccount || executePaper || needsMandatoryRisk) {
    sub.risk = assessRisk({
      proposal: riskShape(proposal, kind),
      capabilities: capabilities ?? { available: false },
      account, positions, caps, daily, referencePrice, executePaper,
      asset,
      marginEnabled: resolvePaperFeatures(paperFeatures).enableMargin,
    });
    if (!sub.risk.approved) {
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId,
        ticker: proposal.underlying ?? proposal.ticker,
        side: kind === 'option' ? 'buy' : proposal.side,
        quantity: proposal.contracts ?? proposal.quantity ?? null,
        reason: sub.risk.reason,
      }).id;
      insertSizingAuditIfPresent(db, sub, {
        account, referencePrice, currentOwnedExposure, dataQualityWarnings, manualQtyOverride,
      });
      return sub;
    }
  }

  sub.decision = 'accepted';
  if (planOnly) { sub.decision = 'plan'; return sub; } // options plan_only never executes
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

  // OPTION entry: a bounded LONG buy/limit/day, persisted as `pending_entry` for
  // the monitor to reconcile (fills, stale-cancel, deterministic exits). It is
  // NEVER a market order and is gated by a valid session / pre-close cutoff.
  if (kind === 'option') {
    if (optionEntry && optionEntry.blocked) {
      sub.decision = 'rejected';
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId, ticker: proposal.underlying ?? proposal.ticker,
        side: 'buy', quantity: proposal.contracts ?? null, reason: optionEntry.reason,
      }).id;
      return sub;
    }
    const ask = proposal.premiumEntry ?? proposal.quoteAsk ?? null;
    const limitPrice = entryLimitPrice({ ask, slippagePct: optionConfig.limitSlippagePct });
    if (limitPrice === null) {
      sub.decision = 'rejected';
      sub.rejectedTradeId = insertRejectedTrade(db, {
        newsEventId: proposal.eventId, ticker: proposal.underlying ?? proposal.ticker,
        side: 'buy', quantity: proposal.contracts ?? null,
        reason: 'option entry blocked: no usable ask to price a bounded limit',
      }).id;
      return sub;
    }
    try {
      const order = await paperClient.submitOptionLimitOrder({
        optionSymbol: proposal.optionSymbol, qty: proposal.contracts, side: 'buy', limitPrice,
      });
      sub.order = order;
      sub.paperOptionTradeId = insertPaperOptionTrade(db, {
        newsEventId: proposal.eventId,
        underlying: proposal.underlying,
        optionSymbol: proposal.optionSymbol,
        expiry: proposal.expiry,
        strike: proposal.strike,
        right: proposal.right,
        quantity: proposal.contracts,
        premiumEntry: proposal.premiumEntry,
        notionalEntry: proposal.notionalEntry,
        strategy: proposal.strategy,
        strategyRationale: proposal.strategyRationale,
        exitPolicy: proposal.exitPolicy,
        status: 'open',
        lifecycleState: 'pending_entry',
        entryOrderId: order.id,
        entryOrderStatus: order.status,
        entryLimitPrice: limitPrice,
      }).id;
    } catch (err) {
      sub.orderError = err.message; // already sanitized by the client
    }
    return sub;
  }

  // EQUITY entry: single-leg market/day (unchanged).
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
 * positions/capabilities/referencePrice/daily are passed in; the script's
 * main()/loop fetch them from the real clients.
 */
export async function runPaperTradeOnce(db, { event, score }, deps = {}) {
  const {
    paperClient = null, qty = DEFAULT_QTY, allowedSymbols = [], thresholds = {}, allowShorts = false,
    qtyExplicit = false, sizingSettings = {},
    allowOptions = false, optionsMode = 'plan_only', optionSymbol = null, optionMaxPremium = null,
    optionContractLimit = DEFAULT_OPTION_CONTRACT_LIMIT, optionExpiryDaysMin = null, optionExpiryDaysMax = null,
    caps = {}, account = null, positions = [], capabilities = null, referencePrice = null,
    optionReferencePrice = null, daily = { orders: 0, notional: 0 }, executePaper = false,
    nowMs = Date.now(), paperFeatures = DEFAULT_PAPER_FEATURES, asset = null,
    optionEntry = { blocked: true, reason: 'option entry context unavailable' }, optionConfig = {},
    historicalEquityOutcomes = [], ownedEquityExposure = null, eventAttemptStats = null,
  } = deps;
  const features = resolvePaperFeatures(paperFeatures);
  const effectiveCaps =
    optionMaxPremium !== null && optionMaxPremium !== undefined
      ? { ...caps, maxOptionPremium: optionMaxPremium }
      : caps;
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
    option: null,
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

  let optionProposal = proposeOption({
    event, score, allowOptions, optionsEnabled: features.enableOptions, optionsMode, optionSymbol, allowedSymbols, thresholds,
    optionContractLimit, optionExpiryDaysMin, optionExpiryDaysMax, optionMaxPremium, nowMs,
  });
  if (optionProposal.enabled && optionProposal.accepted) {
    optionProposal = await enrichOptionProposal({
      proposal: optionProposal,
      paperClient,
      underlyingAsset: resolvedAsset,
      optionSymbol,
      optionMaxPremium,
      optionExpiryDaysMin,
      optionExpiryDaysMax,
      nowMs,
    });
  }
  if (optionProposal.enabled) {
    result.option = await processProposal(db, optionProposal, {
      kind: 'option', capabilities, account, positions, caps: effectiveCaps, daily,
      referencePrice: optionProposal.premiumEntry ?? optionReferencePrice, executePaper, paperClient,
      planOnly: optionProposal.planOnly, paperFeatures: features,
      asset: resolvedAsset, optionEntry, optionConfig,
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

/** Best-effort asset/tradability snapshot. null means unavailable/fail-closed later. */
export async function fetchAssetState(paperClient, symbol) {
  if (!paperClient) return null;
  try {
    return await paperClient.getAsset(symbol);
  } catch {
    return null;
  }
}

/** Fetch account/reference state and run the existing paper-trade core. */
export async function executeSelectedPaperTrade(
  db,
  selected,
  {
    args, paperClient = null, priceSource = null, nowMs = Date.now(),
    optionEntry = { blocked: true, reason: 'option entry context unavailable' }, optionConfig = {},
  }
) {
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
    allowOptions: args.allowOptions, optionsMode: args.optionsMode, optionSymbol: args.optionSymbol,
    optionMaxPremium: args.optionMaxPremium, optionContractLimit: args.optionContractLimit,
    optionExpiryDaysMin: args.optionExpiryDaysMin, optionExpiryDaysMax: args.optionExpiryDaysMax,
    caps: args.caps, executePaper: args.executePaper,
    historicalEquityOutcomes, ownedEquityExposure, eventAttemptStats,
    asset,
    paperFeatures: args.paperFeatures ?? DEFAULT_PAPER_FEATURES,
    optionEntry, optionConfig,
  });
  return { selected, result, lines: buildPaperReport(result, selected) };
}

function hasSignalPass(selected, args, nowMs) {
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
  if (equity.accepted) return true;
  const option = proposeOption({
    event: selected.event,
    score: selected.score,
    allowOptions: args.allowOptions,
    optionsEnabled: features.enableOptions,
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

function batchCounts(cycle = {}) {
  const trades = cycle?.batch?.trades ?? [];
  const subs = trades.flatMap((t) => [t.result?.equity, t.result?.option].filter(Boolean));
  return {
    independent: cycle?.independentCandidates?.length ?? 0,
    attempted: trades.length,
    approved: subs.filter((s) => s.decision === 'accepted' || s.decision === 'plan').length,
    submitted: subs.filter((s) => s.order).length,
    riskRejected: subs.filter((s) =>
      s.decision === 'rejected' && (
        (s.risk && s.risk.approved === false) ||
        s.sizingDecision?.mode === SIZING_MODES.ABSTAIN
      )
    ).length,
    duplicateSuppressed: cycle?.duplicateSuppressions?.length ?? 0,
  };
}

function providerFailureReason(err) {
  const status = Number(err?.status);
  const msg = String(err?.message ?? '').toLowerCase();
  const statusMatch = msg.match(/http\s+(\d{3})/i);
  const code = Number.isFinite(status) && status > 0
    ? status
    : statusMatch ? Number(statusMatch[1]) : null;
  if (code === 401 || code === 403) return { state: 'failed', reason: `HTTP ${code}` };
  if (code === 429) return { state: 'rate-limited', reason: 'HTTP 429' };
  if (code !== null && code >= 500) return { state: 'failed', reason: `HTTP ${code}` };
  if (/not configured|missing key|api key|credentials/.test(msg)) return { state: 'unavailable', reason: 'missing key' };
  if (/timeout|abort/.test(msg)) return { state: 'failed', reason: 'timeout' };
  if (/malformed|unexpected payload|not valid json|invalid json/.test(msg)) {
    return { state: 'failed', reason: 'malformed response' };
  }
  return { state: 'failed', reason: 'request failed' };
}

function providerHealthLine(row = {}) {
  const counts = `fetched=${row.fetched ?? 0} inserted=${row.inserted ?? 0} duplicate=${row.duplicates ?? 0} failed=${row.failed ?? 0}`;
  const pages = row.pages ? ` pages=${row.pages}${row.truncated ? ' TRUNCATED' : ''}` : '';
  const cursor = row.cursorAdvancedTo ? ` cursor->${row.cursorAdvancedTo}` : '';
  return `${row.name ?? 'unknown'}=${row.state ?? 'unknown'} reason=${row.reason ?? 'ok'} ${counts}${pages}${cursor}`;
}

function normalizeProviderDescriptors({ provider = null, providers = null } = {}, args = {}) {
  if (provider) {
    return [{
      name: provider.name,
      provider,
      enabled: true,
      unavailableReason: null,
    }];
  }
  const enabled = new Set(cleanProviders(args.enabledProviders));
  const raw = Array.isArray(providers)
    ? providers
    : providers && typeof providers === 'object'
      ? Object.entries(providers).map(([name, value]) => (
        value?.provider || Object.prototype.hasOwnProperty.call(value ?? {}, 'enabled')
          ? { name, ...value }
          : { name, provider: value }
      ))
      : SUPPORTED_LIVE_NEWS_PROVIDERS.map((name) => ({ name, provider: null }));
  return raw.map((entry) => {
    const name = String(entry?.name ?? entry?.provider?.name ?? '').trim().toLowerCase();
    return {
      name,
      provider: entry?.provider ?? null,
      enabled: entry?.enabled === false ? false : enabled.has(name),
      unavailableReason: entry?.unavailableReason ?? entry?.reason ?? null,
    };
  }).filter((entry) => entry.name);
}

function providerRuntimeState(providerStates, name) {
  if (!providerStates[name]) {
    providerStates[name] = { consecutiveFailures: 0, cooldownUntilMs: null, lastState: null };
  }
  return providerStates[name];
}

async function ingestFromProviders(db, descriptors, fetchOptions, args, { providerStates = {}, nowMs = Date.now() } = {}) {
  const results = [];
  const attemptedAt = new Date(nowMs).toISOString();
  const maxPages = clampMaxPages(args.providerMaxPagesPerCycle);
  for (const desc of descriptors) {
    const state = providerRuntimeState(providerStates, desc.name);
    // Durable per-provider cursor: resume delta fetch from the retained
    // watermark (never widened past the lookback floor); advance only after a
    // successful, persisted ingest; retain on any failure/cooldown.
    const cursor = getProviderCursor(db, desc.name);
    const cursorValue = cursor?.cursor_value ?? null;
    const providerSince = resolveProviderSince({ cursorValue, fallbackSinceIso: fetchOptions.since, nowMs });
    const base = {
      name: desc.name,
      state: 'unavailable',
      reason: null,
      fetched: 0,
      inserted: 0,
      duplicates: 0,
      failed: 0,
      insertedIds: [],
      errors: [],
      since: providerSince,
      until: fetchOptions.until,
      cursorValue,
      cursorAdvancedTo: null,
      pages: 0,
      truncated: false,
      cooldownUntil: state.cooldownUntilMs ? new Date(state.cooldownUntilMs).toISOString() : null,
    };
    if (!desc.enabled) {
      // Never attempted a fetch: no cursor to touch.
      results.push({ ...base, state: 'disabled', reason: 'disabled by configuration' });
      continue;
    }
    if (!desc.provider) {
      results.push({ ...base, state: 'unavailable', reason: desc.unavailableReason ?? 'missing key' });
      continue;
    }
    if (state.cooldownUntilMs && state.cooldownUntilMs > nowMs) {
      const cooldownState = state.lastState === 'rate-limited' ? 'rate-limited' : 'failed';
      retainProviderCursor(db, { provider: desc.name, status: 'cooldown', attemptedAt });
      results.push({
        ...base,
        state: cooldownState,
        reason: `cooldown until ${new Date(state.cooldownUntilMs).toISOString()}`,
        cooldownUntil: new Date(state.cooldownUntilMs).toISOString(),
      });
      continue;
    }
    try {
      const summary = await ingestNews(db, desc.provider, { ...fetchOptions, since: providerSince, maxPages });
      state.consecutiveFailures = 0;
      state.cooldownUntilMs = null;
      state.lastState = 'active';
      const meta = desc.provider?.lastFetchMeta ?? { pages: 1, truncated: false };
      const watermark = nextCursorValue({
        priorCursor: cursorValue,
        maxPublishedAt: maxPublishedAtForEvents(db, summary.insertedIds),
      });
      const advanced = watermark && watermark !== cursorValue ? watermark : null;
      advanceProviderCursor(db, {
        provider: desc.name,
        cursorValue: advanced, // null => watermark unchanged (COALESCE keeps prior)
        status: meta.truncated ? 'truncated' : summary.inserted > 0 ? 'ok' : 'empty',
        pages: Number(meta.pages) || 1,
        truncated: meta.truncated === true,
        attemptedAt,
      });
      results.push({
        ...base,
        ...summary,
        name: desc.name,
        state: 'active',
        reason: meta.truncated ? 'ok (truncated: more pages remain)' : 'ok',
        pages: Number(meta.pages) || 1,
        truncated: meta.truncated === true,
        cursorAdvancedTo: advanced,
      });
    } catch (err) {
      const failure = providerFailureReason(err);
      state.consecutiveFailures += 1;
      state.lastState = failure.state;
      const shouldCooldown =
        failure.state === 'rate-limited' ||
        state.consecutiveFailures >= args.providerMaxFailuresBeforeCooldown;
      if (shouldCooldown) {
        state.cooldownUntilMs = nowMs + args.providerCooldownMinutes * 60_000;
      }
      // Failed/malformed/rate-limited response: retain the prior cursor.
      retainProviderCursor(db, {
        provider: desc.name,
        status: failure.state === 'rate-limited' ? 'rate_limited' : 'failed',
        attemptedAt,
      });
      results.push({
        ...base,
        state: failure.state,
        reason: failure.reason,
        failed: 1,
        cooldownUntil: state.cooldownUntilMs ? new Date(state.cooldownUntilMs).toISOString() : null,
      });
    }
  }
  return results;
}

function classifyCap(args = {}) {
  const maxEvents = Math.min(
    Number(args.maxEventsClassifiedPerCycle) || DEFAULT_MAX_EVENTS_CLASSIFIED_PER_CYCLE,
    MAX_EVENTS_CLASSIFIED_PER_CYCLE_CAP
  );
  return args.classifyLimitExplicit
    ? Math.min(Number(args.classifyLimit) || DEFAULT_PAPER_CLASSIFY_LIMIT, maxEvents)
    : maxEvents;
}

function absScore(score = {}) {
  return Math.abs(Number(score.sentiment_score ?? score.sentimentScore ?? 0) || 0);
}

function rankFreshCandidates(candidates = []) {
  return [...candidates].sort((a, b) => (
    (Number(b.score?.impact_score) || 0) - (Number(a.score?.impact_score) || 0) ||
    (Number(b.score?.confidence) || 0) - (Number(a.score?.confidence) || 0) ||
    absScore(b.score) - absScore(a.score) ||
    (Date.parse(a.freshness?.receivedAt) || 0) - (Date.parse(b.freshness?.receivedAt) || 0) ||
    Number(a.event?.id ?? 0) - Number(b.event?.id ?? 0)
  ));
}

const HEADLINE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'after', 'into', 'over',
  'says', 'said', 'its', 'his', 'her', 'their', 'will', 'new', 'news', 'update',
  'shares', 'stock', 'stocks', 'company', 'inc', 'corp', 'ltd', 'plc',
]);

function headlineFingerprint(headline) {
  const tokens = String(headline ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z0-9#]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !HEADLINE_STOP_WORDS.has(token))
    .slice(0, 14);
  return tokens.length > 0 ? tokens.join('-') : 'empty';
}

function signalIdentity(meta, score, windowMinutes) {
  const publishedMs = Date.parse(meta?.published_at);
  const windowMs = Math.max(1, Number(windowMinutes) || DEFAULT_DUPLICATE_STORY_WINDOW_MINUTES) * 60_000;
  const bucket = Number.isFinite(publishedMs) ? Math.floor(publishedMs / windowMs) : 0;
  const ticker = String(meta?.ticker ?? '').trim().toUpperCase();
  const direction = String(score?.direction ?? '').trim().toLowerCase();
  const headline = headlineFingerprint(meta?.headline);
  const rawKey = [ticker, direction, bucket, headline].join('|');
  const hash = createHash('sha256').update(rawKey).digest('hex').slice(0, 32);
  return {
    key: rawKey,
    hash,
    summary: `ticker=${ticker || 'unknown'} direction=${direction || 'unknown'} bucket=${bucket} headlineHash=${hash.slice(0, 12)}`,
  };
}

function loadNewsMeta(db, eventId) {
  return db
    .prepare(
      `SELECT id, provider, provider_event_id, ticker, headline, published_at, received_at
         FROM news_events
        WHERE id = ?`
    )
    .get(eventId) ?? null;
}

function suppressDuplicateSignals(db, candidates, { windowMinutes = DEFAULT_DUPLICATE_STORY_WINDOW_MINUTES } = {}) {
  const kept = [];
  const suppressions = [];
  const seen = new Map();
  for (const candidate of candidates) {
    const meta = loadNewsMeta(db, candidate.event.id);
    if (!meta) continue;
    const identity = signalIdentity(meta, candidate.score, windowMinutes);
    const existing = seen.get(identity.key);
    if (existing && existing.meta.provider !== meta.provider) {
      const reason =
        `${meta.provider} event ${meta.provider_event_id ?? meta.id} suppressed because equivalent ` +
        `${existing.meta.provider} story ${existing.meta.provider_event_id ?? existing.meta.id} was already processed`;
      const audit = insertDuplicateSuppressionAudit(db, {
        suppressedNewsEventId: meta.id,
        suppressedProvider: meta.provider,
        suppressedProviderEventId: meta.provider_event_id,
        keptNewsEventId: existing.meta.id,
        keptProvider: existing.meta.provider,
        keptProviderEventId: existing.meta.provider_event_id,
        signalIdentityHash: identity.hash,
        identitySummary: identity.summary,
        duplicateWindowMinutes: windowMinutes,
        reason,
      });
      suppressions.push({
        id: audit.id,
        suppressedEventId: meta.id,
        suppressedProvider: meta.provider,
        suppressedProviderEventId: meta.provider_event_id,
        keptEventId: existing.meta.id,
        keptProvider: existing.meta.provider,
        keptProviderEventId: existing.meta.provider_event_id,
        signalIdentityHash: identity.hash,
        reason,
      });
      continue;
    }
    seen.set(identity.key, { candidate, meta, identity });
    kept.push(candidate);
  }
  return { kept, suppressions };
}

function cloneAccount(account) {
  return account ? { ...account } : null;
}

function clonePositions(positions = []) {
  return (positions ?? []).map((p) => ({ ...p }));
}

function cloneOwnedExposure(snapshot) {
  return {
    byTickerSide: { ...(snapshot?.byTickerSide ?? {}) },
    grossExposure: Number(snapshot?.grossExposure ?? 0) || 0,
    openPositionCount: Number(snapshot?.openPositionCount ?? 0) || 0,
    dataQuality: snapshot?.dataQuality ?? 'unavailable',
  };
}

function reserveNotionalFromSub(sub, referencePrice) {
  const riskNotional = finiteNum(sub?.risk?.estNotional);
  if (riskNotional !== null && riskNotional > 0) return riskNotional;
  if (sub?.kind === 'equity') {
    const px = finiteNum(referencePrice);
    const qty = finiteNum(sub?.proposal?.quantity);
    return px !== null && qty !== null ? round2(px * qty) : null;
  }
  return finiteNum(sub?.proposal?.notionalEntry);
}

function reserveBatchBudget(ledger, selected, result) {
  const effects = [];
  for (const sub of [result?.equity, result?.option].filter(Boolean)) {
    if (sub.decision !== 'accepted') continue;
    // A failed broker submission (orderError set, no order placed) consumed no
    // buying power, exposure, or daily slots. Release its provisional reservation
    // so later batch proposals are evaluated against real headroom rather than a
    // phantom hold. Dry-run accepted subs have no orderError and still reserve so
    // the simulated batch budget stays realistic for subsequent members.
    if (sub.orderError) continue;
    const estNotional = reserveNotionalFromSub(sub, result.referencePrice);
    if (estNotional === null || estNotional <= 0) continue;
    const symbol = String(sub.proposal?.ticker ?? sub.proposal?.underlying ?? selected?.event?.ticker ?? '').toUpperCase();
    const side = sub.kind === 'option' ? 'buy' : sub.proposal?.side;
    const before = {
      dailyOrders: ledger.daily.orders,
      dailyNotional: round2(ledger.daily.notional),
      buyingPower: finiteNum(ledger.account?.buyingPower),
      cash: finiteNum(ledger.account?.cash),
      grossExposure: round2(grossExposure(ledger.positions)),
    };
    ledger.daily.orders += 1;
    ledger.daily.notional = round2((ledger.daily.notional ?? 0) + estNotional);
    ledger.positions.push({
      symbol,
      assetClass: sub.kind === 'option' ? 'us_option' : 'us_equity',
      marketValue: side === 'sell' ? -estNotional : estNotional,
    });
    if (ledger.account && side !== 'sell') {
      if (typeof ledger.account.buyingPower === 'number') {
        ledger.account.buyingPower = round2(Math.max(0, ledger.account.buyingPower - estNotional));
      }
      if (typeof ledger.account.cash === 'number') {
        ledger.account.cash = round2(Math.max(0, ledger.account.cash - estNotional));
      }
    }
    if (sub.kind === 'equity') {
      const key = `${symbol}|${side}`;
      ledger.ownedEquityExposure.byTickerSide[key] = round2(
        (ledger.ownedEquityExposure.byTickerSide[key] ?? 0) + estNotional
      );
      ledger.ownedEquityExposure.grossExposure = round2(
        (ledger.ownedEquityExposure.grossExposure ?? 0) + estNotional
      );
    }
    const after = {
      dailyOrders: ledger.daily.orders,
      dailyNotional: ledger.daily.notional,
      buyingPower: finiteNum(ledger.account?.buyingPower),
      cash: finiteNum(ledger.account?.cash),
      grossExposure: round2(grossExposure(ledger.positions)),
    };
    effects.push({ eventId: selected?.event?.id, ticker: symbol, side, estNotional: round2(estNotional), before, after });
  }
  return effects;
}

async function executeBatchPaperTrades(
  db,
  candidates,
  {
    args,
    paperClient = null,
    priceSource = null,
    nowMs = Date.now(),
    optionEntry = { blocked: true, reason: 'option entry context unavailable' },
    optionConfig = {},
  }
) {
  const { account, positions, capabilities } = await fetchAccountState(paperClient);
  const daily = getDailyCounters(db);
  const ledger = {
    account: cloneAccount(account),
    positions: clonePositions(positions),
    daily: { ...daily },
    ownedEquityExposure: cloneOwnedExposure(getOwnedEquityExposureSnapshot(db)),
  };
  const historicalEquityOutcomes = listBrokerConfirmedEquityOutcomes(db);
  const referenceCache = new Map();
  const assetCache = new Map();
  const trades = [];
  const budgetEffects = [];
  for (const selected of candidates.slice(0, args.maxQualifyingEventsAttemptedPerCycle)) {
    const symbol = selected.event.ticker;
    if (!referenceCache.has(symbol)) {
      referenceCache.set(symbol, await fetchReferencePrice(priceSource, symbol, nowMs));
    }
    if (!assetCache.has(symbol)) {
      assetCache.set(symbol, await fetchAssetState(paperClient, symbol));
    }
    const result = await runPaperTradeOnce(db, selected, {
      paperClient,
      account: ledger.account,
      positions: ledger.positions,
      capabilities,
      referencePrice: referenceCache.get(symbol),
      daily: ledger.daily,
      nowMs,
      qty: args.qty,
      qtyExplicit: args.qtyExplicit,
      sizingSettings: args.sizingSettings,
      allowedSymbols: args.symbols,
      thresholds: args.thresholds,
      allowShorts: args.allowShorts,
      allowOptions: args.allowOptions,
      optionsMode: args.optionsMode,
      optionSymbol: args.optionSymbol,
      optionMaxPremium: args.optionMaxPremium,
      optionContractLimit: args.optionContractLimit,
      optionExpiryDaysMin: args.optionExpiryDaysMin,
      optionExpiryDaysMax: args.optionExpiryDaysMax,
      caps: args.caps,
      executePaper: args.executePaper,
      historicalEquityOutcomes,
      ownedEquityExposure: ledger.ownedEquityExposure,
      eventAttemptStats: getPaperEventAttemptStats(db, selected.event.id),
      asset: assetCache.get(symbol),
      paperFeatures: args.paperFeatures ?? DEFAULT_PAPER_FEATURES,
      optionEntry,
      optionConfig,
    });
    const effects = reserveBatchBudget(ledger, selected, result);
    budgetEffects.push(...effects);
    trades.push({ selected, result, lines: buildPaperReport(result, selected), budgetEffects: effects });
  }
  return {
    trades,
    budgetEffects,
    attempted: trades.length,
    finalDaily: ledger.daily,
    finalBuyingPower: finiteNum(ledger.account?.buyingPower),
    finalGrossExposure: round2(grossExposure(ledger.positions)),
  };
}

/**
 * Durably terminalize signal-threshold failures. Each candidate here already
 * failed BOTH the equity and option gates (hasSignalPass === false), so the
 * equity reject reason is the signal-rejection reason. Recording a
 * rejected_trades row makes the event terminal (never re-evaluated) and honors
 * the log-every-rejection rule. No account/price/broker calls — pure gate.
 * @returns {{ count: number, reasons: string[] }}
 */
function recordSignalRejections(db, candidates, args) {
  const features = resolvePaperFeatures(args.paperFeatures ?? DEFAULT_PAPER_FEATURES);
  const reasons = [];
  for (const c of candidates ?? []) {
    const equity = assessProposal({
      event: c.event,
      score: c.score,
      qty: args.qty,
      allowedSymbols: args.symbols,
      thresholds: args.thresholds,
      allowShorts: args.allowShorts,
      shortsEnabled: features.enableShorts,
    });
    insertRejectedTrade(db, {
      newsEventId: c.event.id,
      ticker: c.event.ticker,
      side: equity.side,
      quantity: equity.quantity,
      reason: equity.reason,
    });
    reasons.push(equity.reason);
  }
  return { count: reasons.length, reasons };
}

/**
 * Fresh loop cycle: sweep aged-out queue entries, ingest recent live-news
 * providers (per-provider cursor + bounded pagination), then classify and
 * attempt the durable backlog (this cycle's inserts PLUS eligible prior-cycle
 * events) under the per-cycle caps. All collaborators are injected for tests.
 */
export async function runPaperDecisionCycle(
  db,
  {
    provider = null,
    providers = null,
    classifier = null,
    paperClient = null,
    priceSource = null,
    providerSkipReason = null,
    providerStates = {},
  } = {},
  args = parseArgs([]),
  { nowMs = Date.now(), optionEntry = { blocked: true, reason: 'option entry context unavailable' }, optionConfig = {} } = {}
) {
  const base = {
    mode: args.executePaper ? 'execute_paper' : 'dry_run',
    outcome: null,
    skipReason: null,
    universe: null,
    ingestion: null,
    providerHealth: [],
    classification: null,
    freshCandidates: [],
    independentCandidates: [],
    duplicateSuppressions: [],
    batch: null,
    selected: null,
    trade: null,
    staleExpired: { count: 0 },
    signalRejections: { count: 0, reasons: [] },
    backlog: null,
    lines: [],
  };
  const since = new Date(nowMs - args.newsLookbackMinutes * 60_000).toISOString();
  const universe = selectCandidateUniverse(db, {
    baseSymbols: args.symbols,
    since,
    maxSymbols: args.maxSymbolsPerCycle,
    cycleAt: new Date(nowMs).toISOString(),
  });
  const cycleArgs = { ...args, symbols: universe.selectedSymbols.length > 0 ? universe.selectedSymbols : args.symbols };
  base.universe = universe;

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
    const trade = await executeSelectedPaperTrade(db, selected, { args: cycleArgs, paperClient, priceSource, nowMs, optionEntry, optionConfig });
    return { ...base, outcome: tradeOutcome(trade.result), selected, trade, lines: trade.lines };
  }

  const until = new Date(nowMs).toISOString();
  // Durable stale sweep FIRST: aged-out, unresolved queue entries become a
  // terminal stale_expired regardless of provider health, so backlog never
  // accumulates forever even during a provider outage.
  const staleFloorIso = new Date(nowMs - args.maxQueueAgeMinutes * 60_000).toISOString();
  const staleLowerIso = new Date(nowMs - 2 * args.maxQueueAgeMinutes * 60_000).toISOString();
  const staleExpired = sweepStaleQueueEvents(db, {
    queueFloorIso: staleFloorIso,
    lowerBoundIso: staleLowerIso,
    queueAgeMinutes: args.maxQueueAgeMinutes,
    promptVersion: MODEL_PROMPT_VERSION,
  });
  base.staleExpired = staleExpired;

  const providerDescriptors = normalizeProviderDescriptors({ provider, providers }, cycleArgs);
  const providerHealth = await ingestFromProviders(db, providerDescriptors, {
    symbols: cycleArgs.symbols,
    limit: args.ingestLimit,
    since,
    until,
  }, cycleArgs, { providerStates, nowMs });
  base.providerHealth = providerHealth;
  const activeProviders = providerHealth.filter((p) => p.state === 'active').length;
  const insertedIds = providerHealth.flatMap((p) => p.insertedIds ?? []);
  const ingestion = {
    provider: providerHealth.map((p) => p.name).join(',') || 'none',
    fetched: providerHealth.reduce((s, p) => s + (Number(p.fetched) || 0), 0),
    inserted: providerHealth.reduce((s, p) => s + (Number(p.inserted) || 0), 0),
    duplicates: providerHealth.reduce((s, p) => s + (Number(p.duplicates) || 0), 0),
    failed: providerHealth.reduce((s, p) => s + (Number(p.failed) || 0), 0),
    insertedIds,
    errors: providerHealth.flatMap((p) => p.errors ?? []),
    since,
    until,
  };
  base.ingestion = ingestion;

  // Backlog carried INTO this cycle (before we classify/attempt). This is what
  // makes carry-forward durable: eligibility is derived from the database, so
  // prior-cycle unscored/scored events are re-selected until they reach a
  // terminal state or age out. Recency-bounded to the max queue age.
  const classifyBacklog = selectClassificationBacklog(db, {
    promptVersion: MODEL_PROMPT_VERSION,
    allowedSymbols: cycleArgs.symbols,
    sinceReceivedIso: staleFloorIso,
    limit: BACKLOG_SELECT_LIMIT,
  });
  const proposalBacklogPre = listRecentScoredEvents(db, {
    allowedSymbols: cycleArgs.symbols,
    promptVersion: MODEL_PROMPT_VERSION,
    excludeProcessed: true,
    sinceReceived: staleFloorIso,
    limit: BACKLOG_SELECT_LIMIT,
  }).filter((c) => ['parsed', 'fallback_used'].includes(c.score.parser_status));
  const carriedForward = Math.max(0, classifyBacklog.length - insertedIds.length) + proposalBacklogPre.length;
  const hasBacklog = classifyBacklog.length > 0 || proposalBacklogPre.length > 0;

  const backlogCounts = (over = {}) => ({
    carriedForward,
    newlyInserted: insertedIds.length,
    classified: 0,
    proposalEligible: 0,
    attempted: 0,
    deferredByClassificationCap: 0,
    deferredByAttemptCap: 0,
    staleExpired: staleExpired.count,
    providerInvalid: 0,
    terminalRejections: 0,
    duplicateSuppressions: 0,
    submitted: 0,
    ...over,
  });

  if (activeProviders === 0 && !hasBacklog) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_ACTIVE_PROVIDER,
      backlog: backlogCounts(),
      skipReason: providerSkipReason ?? 'no active provider',
    };
  }
  if (insertedIds.length === 0 && !hasBacklog) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_NEW_NEWS,
      backlog: backlogCounts(),
      skipReason: `no new news inserted and no backlog (fetched=${ingestion.fetched} duplicates=${ingestion.duplicates} failed=${ingestion.failed})`,
    };
  }
  if (!MODEL_CLASSIFIER_NAMES.has(args.classifier) || !classifier || classifier.promptVersion !== MODEL_PROMPT_VERSION) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
      backlog: backlogCounts(),
      skipReason: 'model classifier was not requested/configured for this loop iteration',
    };
  }

  // CLASSIFICATION BACKLOG: process up to the per-cycle cap, oldest first. Events
  // beyond the cap stay unscored and eligible next cycle. Freshly-classified
  // events with an unusable score become a durable provider_invalid terminal.
  const idsToClassify = classifyBacklog.slice(0, classifyCap(cycleArgs)).map((r) => r.id);
  const classification = idsToClassify.length > 0
    ? await classifyAndStore(db, classifier, { eventIds: idsToClassify })
    : { requested: 0, classified: 0, stored: 0, skipped: 0, failed: 0, statusCounts: {}, errors: [] };
  base.classification = {
    ...classification,
    selectedIds: idsToClassify,
    model: classifier.modelName,
    promptVersion: classifier.promptVersion,
  };
  const deferredByClassificationCap = Math.max(0, classifyBacklog.length - idsToClassify.length);
  const providerInvalid = markUnusableScoresTerminal(db, idsToClassify, MODEL_PROMPT_VERSION).count;

  // PROPOSAL BACKLOG: fresh scored-but-not-yet-terminal events (incl. prior
  // cycles). This drains deferred work before losing it.
  const proposalBacklog = listRecentScoredEvents(db, {
    allowedSymbols: cycleArgs.symbols,
    promptVersion: MODEL_PROMPT_VERSION,
    excludeProcessed: true,
    sinceReceived: staleFloorIso,
    limit: BACKLOG_SELECT_LIMIT,
  }).filter((c) => ['parsed', 'fallback_used'].includes(c.score.parser_status));

  const backlogAfterClassify = (over = {}) => backlogCounts({
    classified: classification.stored,
    proposalEligible: proposalBacklog.length,
    deferredByClassificationCap,
    providerInvalid,
    ...over,
  });

  if (proposalBacklog.length === 0) {
    const scoredInWindow = countScoredInWindow(db, {
      promptVersion: MODEL_PROMPT_VERSION,
      allowedSymbols: cycleArgs.symbols,
      sinceReceivedIso: staleFloorIso,
    });
    const alreadyTerminal = scoredInWindow > 0;
    return {
      ...base,
      outcome: alreadyTerminal
        ? PAPER_DECISION_OUTCOMES.ALREADY_PROCESSED_EVENT
        : PAPER_DECISION_OUTCOMES.NO_FRESH_REAL_MODEL_SCORE,
      backlog: backlogAfterClassify(),
      skipReason: alreadyTerminal
        ? 'all in-window scored events already have paper_trades or rejected_trades (or duplicate-suppressed/stale) records'
        : `no usable ${MODEL_PROMPT_VERSION} score available (statuses=${statusLine(classification.statusCounts)})`,
    };
  }

  // Rank the proposal backlog, then durably terminalize signal failures so they
  // are recorded once (log-everything rule) and never re-evaluated.
  const ranked = rankFreshCandidates(proposalBacklog);
  const signalPasses = ranked.filter((c) => hasSignalPass(c, cycleArgs, nowMs));
  const signalFails = ranked.filter((c) => !hasSignalPass(c, cycleArgs, nowMs));
  const signalRejections = recordSignalRejections(db, signalFails, cycleArgs);
  base.signalRejections = signalRejections;

  if (signalPasses.length === 0) {
    return {
      ...base,
      outcome: PAPER_DECISION_OUTCOMES.ALL_FRESH_SCORES_FAILED_SIGNAL_THRESHOLDS,
      skipReason: 'all usable scored backlog events failed signal thresholds',
      freshCandidates: ranked,
      backlog: backlogAfterClassify({ terminalRejections: signalRejections.count }),
    };
  }

  const deduped = suppressDuplicateSignals(db, signalPasses, {
    windowMinutes: cycleArgs.duplicateStoryWindowMinutes,
  });
  const independent = deduped.kept;
  const batchCandidates = independent.slice(0, cycleArgs.maxQualifyingEventsAttemptedPerCycle);
  const batch = await executeBatchPaperTrades(db, batchCandidates, {
    args: cycleArgs, paperClient, priceSource, nowMs, optionEntry, optionConfig,
  });
  const selected = batch.trades[0]?.selected ?? independent[0] ?? null;
  const trade = batch.trades[0] ?? null;
  const outcomes = batch.trades.map((t) => tradeOutcome(t.result));
  const outcome = outcomes.includes(PAPER_DECISION_OUTCOMES.BROKER_SUBMISSION_ERROR)
    ? PAPER_DECISION_OUTCOMES.BROKER_SUBMISSION_ERROR
    : outcomes.includes(PAPER_DECISION_OUTCOMES.RISK_REJECTION)
      ? PAPER_DECISION_OUTCOMES.RISK_REJECTION
      : PAPER_DECISION_OUTCOMES.TRADE_ATTEMPTED;
  const batchSubs = batch.trades.flatMap((t) => [t.result?.equity, t.result?.option].filter(Boolean));
  const submitted = batchSubs.filter((s) => s.order).length;
  const riskRejected = batchSubs.filter((s) =>
    s.decision === 'rejected' && ((s.risk && s.risk.approved === false) || s.sizingDecision?.mode === SIZING_MODES.ABSTAIN)
  ).length;
  return {
    ...base,
    outcome,
    skipReason: batch.trades.length > 0 ? null : 'no independent qualifying event remained after duplicate suppression',
    freshCandidates: ranked,
    independentCandidates: independent,
    duplicateSuppressions: deduped.suppressions,
    batch,
    selected,
    trade,
    backlog: backlogAfterClassify({
      attempted: batch.trades.length,
      deferredByAttemptCap: Math.max(0, independent.length - batch.trades.length),
      duplicateSuppressions: deduped.suppressions.length,
      terminalRejections: signalRejections.count + riskRejected,
      submitted,
    }),
    lines: batch.trades.flatMap((t) => t.lines),
  };
}

export function oneLineDecisionSummary(cycle, nowMs = Date.now()) {
  const counts = batchCounts(cycle);
  const providers = (cycle?.providerHealth ?? []).length > 0
    ? `providers ${cycle.providerHealth.map((p) => `${p.name}=${p.state}`).join(',')}`
    : 'providers skipped';
  const ing = cycle?.ingestion
    ? `ingest fetched=${cycle.ingestion.fetched} inserted=${cycle.ingestion.inserted} dup=${cycle.ingestion.duplicates}`
    : 'ingest skipped';
  const cls = cycle?.classification
    ? `classify stored=${cycle.classification.stored} statuses=${statusLine(cycle.classification.statusCounts)}`
    : 'classify skipped';
  const selected = cycle?.selected
    ? `event=${cycle.selected.event.id} ${cycle.selected.event.ticker} age=${ageLabel(cycle.selected.freshness?.receivedAt, nowMs)}`
    : 'event=(none)';
  const universe = cycle?.universe
    ? `universe selected=${cycle.universe.selectedSymbols.join(',') || '(none)'}`
    : 'universe skipped';
  const batch = counts.attempted > 0
    ? `batch independent=${counts.independent} attempted=${counts.attempted} approved=${counts.approved} submitted=${counts.submitted} riskRejected=${counts.riskRejected} dupSuppressed=${counts.duplicateSuppressed}`
    : 'batch attempted=0';
  const b = cycle?.backlog;
  const backlog = b
    ? `backlog carried=${b.carriedForward} new=${b.newlyInserted} classified=${b.classified} attempted=${b.attempted} ` +
      `deferClassify=${b.deferredByClassificationCap} deferAttempt=${b.deferredByAttemptCap} stale=${b.staleExpired}`
    : 'backlog n/a';
  const skip = cycle?.skipReason ? `skip=${cycle.skipReason}` : cycle?.trade?.result ? oneLineSummary(cycle.trade.result) : batch;
  return `${cycle?.outcome ?? 'unknown'}; ${universe}; ${providers}; ${ing}; ${cls}; ${backlog}; ${selected}; ${batch}; ${skip}`;
}

export function buildDecisionCycleReport(cycle, nowMs = Date.now()) {
  const counts = batchCounts(cycle);
  const lines = [
    'Paper trading decision cycle (fresh multi-provider batch, PAPER-only)',
    `  outcome:    ${cycle.outcome ?? 'unknown'}`,
  ];
  if ((cycle.providerHealth ?? []).length > 0) {
    lines.push('  providers:');
    for (const row of cycle.providerHealth) lines.push(`    ${providerHealthLine(row)}`);
  }
  if (cycle.ingestion) {
    lines.push(
      `  ingest:     fetched=${cycle.ingestion.fetched} inserted=${cycle.ingestion.inserted} ` +
        `duplicates=${cycle.ingestion.duplicates} failed=${cycle.ingestion.failed}`
    );
  }
  if (cycle.universe) {
    const skipped = cycle.universe.ranked.filter((r) => !r.selected).map((r) => `${r.symbol}:${r.skippedReason}`);
    lines.push(
      `  universe:   selected=${cycle.universe.selectedSymbols.join(',') || '(none)'} ` +
        `skipped=${skipped.join(',') || '(none)'}`
    );
  }
  if (cycle.classification) {
    lines.push(
      `  classify:   selected=${cycle.classification.selectedIds?.length ?? 0} stored=${cycle.classification.stored} ` +
        `statuses=${statusLine(cycle.classification.statusCounts)}`
    );
  }
  if (cycle.backlog) {
    const b = cycle.backlog;
    lines.push(
      `  backlog:    carriedForward=${b.carriedForward} newlyInserted=${b.newlyInserted} classified=${b.classified} ` +
        `proposalEligible=${b.proposalEligible} attempted=${b.attempted} submitted=${b.submitted}`,
      `              deferredByClassifyCap=${b.deferredByClassificationCap} deferredByAttemptCap=${b.deferredByAttemptCap} ` +
        `staleExpired=${b.staleExpired} providerInvalid=${b.providerInvalid} terminalRejections=${b.terminalRejections} ` +
        `duplicateSuppressed=${b.duplicateSuppressions}`
    );
  }
  lines.push(
    `  batch:      independent=${counts.independent} attempted=${counts.attempted} approved=${counts.approved} ` +
      `submitted=${counts.submitted} riskRejected=${counts.riskRejected} duplicateSuppressed=${counts.duplicateSuppressed}`
  );
  if ((cycle.duplicateSuppressions ?? []).length > 0) {
    lines.push('  suppressions:');
    for (const s of cycle.duplicateSuppressions.slice(0, 10)) lines.push(`    ${s.reason}`);
  }
  if ((cycle.batch?.budgetEffects ?? []).length > 0) {
    lines.push('  batch budget reservations:');
    for (const b of cycle.batch.budgetEffects.slice(0, 10)) {
      lines.push(
        `    event ${b.eventId} ${b.ticker} ${b.side} reserved=${money(b.estNotional)} ` +
        `daily=${money(b.before.dailyNotional)}->${money(b.after.dailyNotional)} ` +
        `gross=${money(b.before.grossExposure)}->${money(b.after.grossExposure)} ` +
        `buyingPower=${money(b.before.buyingPower)}->${money(b.after.buyingPower)}`
      );
    }
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
  const sizeTxt = e?.manualQtyOverride
    ? ` manual-qty=${e?.proposal?.quantity ?? '?'}`
    : e?.sizingDecision
      ? ` size=${e.sizingDecision.mode} qty=${e.proposal?.quantity ?? e.sizingDecision.requestedQuantity ?? '?'}`
      : '';
  const eqTxt = `equity ${e?.proposal?.side ?? '?'} ${e?.decision ?? '?'}${sizeTxt}`;
  let opTxt = 'option off';
  if (result.option && result.option.decision !== 'disabled') {
    opTxt = `option ${result.option.proposal?.intent ?? '?'} ${result.option.decision}`;
  }
  return `${eqTxt}; ${opTxt}`;
}

function subLines(label, sub, result = {}) {
  if (!sub) return [];
  if (sub.decision === 'disabled') return [`  ${label}:     disabled (--allow-options not set)`];
  const p = sub.proposal;
  const lines = [
    `  ${label}:     ${sub.decision.toUpperCase()} — ${p.reason}`,
  ];
  if (label === 'option' && p.optionSymbol) {
    lines.push(
      `    contract:   ${p.optionSymbol} ${p.right ?? '?'} strike ${p.strike ?? '?'} exp ${p.expiry ?? '?'}`,
      `    premium:    entry=${p.premiumEntry ?? '?'} notional=${p.notionalEntry ?? '?'} bid=${p.quoteBid ?? '?'} ask=${p.quoteAsk ?? '?'}`,
      `    exit:       ${p.exitPolicy ?? '(none)'}`
    );
  }
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
  if (sub.paperOptionTradeId !== null) lines.push(`    logged:     paper_option_trades id ${sub.paperOptionTradeId}`);
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
  lines.push(...subLines('option', result.option, result));
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
export async function executeOneShot(db, {
  args, paperClient = null, priceSource = null, nowMs = Date.now(),
  optionEntry = { blocked: true, reason: 'option entry context unavailable' }, optionConfig = {},
}) {
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
  const trade = await executeSelectedPaperTrade(db, selected, { args, paperClient, priceSource, nowMs, optionEntry, optionConfig });
  return { selected, result: trade.result, lines: trade.lines };
}

async function main() {
  const config = loadConfig();
  const strategy = loadStrategySettings();
  const defaults = strategy.source === 'runtime' ? paperDefaultsFromStrategySettings(strategy.settings) : {};
  const args = parseArgs(process.argv.slice(2), {
    ...defaults,
    paperFeatures: paperFeaturesFromConfig(config),
  });

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

    // Resolve the current session (for the option-entry/pre-close gate) and
    // reconcile any bot-owned open options BEFORE considering a new entry.
    const optionConfig = config.optionExecution;
    const nowMs = Date.now();
    let session = { isOpen: false, sessionCloseMs: null };
    if (paperClient) {
      try {
        const clock = await paperClient.getClock();
        const closeMs = Date.parse(clock?.nextClose);
        session = { isOpen: clock?.isOpen === true, sessionCloseMs: Number.isFinite(closeMs) ? closeMs : null };
      } catch { /* clock unavailable -> option entry stays blocked (fail closed) */ }
      const mon = await reconcileBotOptions(db, {
        paperClient, config, nowMs, session,
        onLog: (line) => console.log(`  [option-monitor] ${line}`),
      });
      if (mon.checked > 0) {
        console.log(
          `Option monitor: checked ${mon.checked} (exits submitted ${mon.exitsSubmitted}, ` +
            `closed ${mon.exitsFilled}, unresolved ${mon.unresolved}).`
        );
      }
    }
    const optionEntry = optionEntryBlocked({
      nowMs, sessionOpen: session.isOpen, sessionCloseMs: session.sessionCloseMs,
      noEntryBeforeCloseMinutes: optionConfig.noEntryBeforeCloseMinutes,
    });

    const { lines, result } = await executeOneShot(db, { args, paperClient, priceSource, nowMs, optionEntry, optionConfig });
    for (const line of lines) console.log(line);
    if (paperClient) {
      const performance = await recordPerformanceSnapshot(db, {
        paperClient,
        priceSource,
        nowMs,
        snapshotKind: 'one_shot',
      });
      for (const line of formatBrokerTruthLines(performance)) console.log(line);
    }
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
