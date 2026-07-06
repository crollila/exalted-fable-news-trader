// scripts/runPaperTradingOnce.js — MANUAL one-shot PAPER equity trade (CLI).
//
//   Dry run (default; NO order):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL,MSFT \
//       --classifier openai --allow-shorts
//
//   Execute PAPER orders (requires Alpaca paper creds in .env):
//     node --env-file=.env scripts/runPaperTradingOnce.js --symbols AAPL --execute-paper
//
// This file is only the CLI: it parses flags, maps strategy-settings defaults,
// builds real clients, and calls the trade cycle. All trading logic lives in
// src/paper/tradeCycle.js (dependency-injected, offline-testable).
//
// HARD SAFETY:
// - PAPER ONLY. The order client is hard-wired to the Alpaca paper endpoint;
//   no live endpoint exists and nothing consumes config.liveTradingEnabled.
// - DRY RUN IS THE DEFAULT. Orders go out ONLY with --execute-paper AND creds.
// - No uncapped trading: qty caps + margin-aware notional/exposure/daily caps.
// - SANITIZED OUTPUT ONLY. Never raw model responses, raw payloads, API keys,
//   headers, request configs, or webhook URLs.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadStrategySettings } from '../src/config/strategySettings.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import { formatBrokerTruthLines, recordPerformanceSnapshot } from '../src/paper/brokerTruth.js';
import { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS } from '../src/paper/paperTradeProposal.js';
import { DEFAULT_CAPS } from '../src/paper/paperRisk.js';
import {
  clampInt,
  executeOneShot,
  resolvePaperFeatures,
  DEFAULT_SYMBOLS,
  DEFAULT_PAPER_FEATURES,
  DEFAULT_PAPER_INGEST_LIMIT,
  MAX_PAPER_INGEST_LIMIT,
  DEFAULT_PAPER_CLASSIFY_LIMIT,
  MAX_PAPER_CLASSIFY_LIMIT,
  DEFAULT_NEWS_LOOKBACK_MINUTES,
  MAX_NEWS_LOOKBACK_MINUTES,
} from '../src/paper/tradeCycle.js';

// The trade cycle's public surface stays importable from this script so the
// loop script and existing tests keep working unchanged.
export {
  PAPER_CLASSIFIERS,
  DEFAULT_PAPER_FEATURES,
  DEFAULT_PAPER_INGEST_LIMIT,
  MAX_PAPER_INGEST_LIMIT,
  DEFAULT_PAPER_CLASSIFY_LIMIT,
  MAX_PAPER_CLASSIFY_LIMIT,
  DEFAULT_NEWS_LOOKBACK_MINUTES,
  MAX_NEWS_LOOKBACK_MINUTES,
  PAPER_DECISION_OUTCOMES,
  listRecentScoredEvents,
  selectRecentScoredEvent,
  getDailyCounters,
  runPaperTradeOnce,
  fetchReferencePrice,
  fetchAccountState,
  fetchAssetState,
  executeSelectedPaperTrade,
  runPaperDecisionCycle,
  oneLineDecisionSummary,
  buildDecisionCycleReport,
  oneLineSummary,
  buildPaperReport,
  executeOneShot,
} from '../src/paper/tradeCycle.js';
export { DEFAULT_QTY, MAX_QTY, DEFAULT_THRESHOLDS, DEFAULT_CAPS };

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
  return defaults;
}

export function paperFeaturesFromConfig(config = {}) {
  return {
    enableShorts: config?.paperCapabilities?.enableShorts === true,
    enableMargin: config?.paperCapabilities?.enableMargin === true,
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
    newsLookbackMinutes: clampInt(defaults.newsLookbackMinutes, DEFAULT_NEWS_LOOKBACK_MINUTES, 1, MAX_NEWS_LOOKBACK_MINUTES),
    allowShorts: defaults.allowShorts === true,
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
    else if (flag === '--classify-limit' && next) { args.classifyLimit = clampInt(next, DEFAULT_PAPER_CLASSIFY_LIMIT, 1, MAX_PAPER_CLASSIFY_LIMIT); i += 1; }
    else if (flag === '--news-lookback-minutes' && next) { args.newsLookbackMinutes = clampInt(next, DEFAULT_NEWS_LOOKBACK_MINUTES, 1, MAX_NEWS_LOOKBACK_MINUTES); i += 1; }
    else if (flag === '--allow-shorts') { args.allowShorts = true; }
    else if (flag === '--max-order-notional' && next) { setCap('maxOrderNotional', next); i += 1; }
    else if (flag === '--max-symbol-exposure' && next) { setCap('maxSymbolExposure', next); i += 1; }
    else if (flag === '--max-gross-exposure' && next) { setCap('maxGrossExposure', next); i += 1; }
    else if (flag === '--max-daily-paper-orders' && next) { setCap('maxDailyPaperOrders', next); i += 1; }
    else if (flag === '--max-daily-paper-notional' && next) { setCap('maxDailyPaperNotional', next); i += 1; }
    else if (flag === '--execute-paper') { args.executePaper = true; }
  }
  if (args.symbols.length === 0) args.symbols = [...DEFAULT_SYMBOLS];
  return args;
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

    const nowMs = Date.now();
    const { lines, result } = await executeOneShot(db, { args, paperClient, priceSource, nowMs });
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

    const orderErr = result.equity?.orderError;
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
