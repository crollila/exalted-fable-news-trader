// scripts/runPaperTradingLoop.js — MANUAL market-hours PAPER loop (Phase 5).
//
//   Dry run (default; NO orders):
//     node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL,MSFT \
//       --classifier openai --interval-minutes 15
//
//   Execute PAPER orders during market hours (requires paper creds):
//     node --env-file=.env scripts/runPaperTradingLoop.js --symbols AAPL --execute-paper \
//       --interval-minutes 15 --send-discord-eod-report
//
// PAPER-only. It REUSES the one-shot logic (executeOneShot) each iteration —
// no trade logic is duplicated here. It runs only during valid US regular equity
// sessions, preferring Alpaca clock/calendar state and falling back to an
// explicit local Mon-Fri regular-hours approximation when the clock is
// unavailable. It enforces a >= 5-minute interval, prints sanitized state
// transitions/heartbeats, runs continuously by default until Ctrl+C, and accepts
// --max-iterations only as an explicit debug cap. Live trading is
// impossible/disabled throughout.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadStrategySettings } from '../src/config/strategySettings.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import {
  startPaperRuntimeSession,
  updatePaperRuntimeSession,
  getPaperRuntimeSession,
  findOpenPaperRuntimeSession,
} from '../src/database/paperRuntime.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { createAlpacaPaperClient } from '../src/paper/alpacaPaperClient.js';
import { formatBrokerTruthLines, recordPerformanceSnapshot } from '../src/paper/brokerTruth.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import { createDiscordWebhookClient } from '../src/notifications/discordWebhookClient.js';
import { isMarketOpen, marketStatusLabel, HOLIDAY_LIMITATION_NOTE } from '../src/paper/marketHours.js';
import {
  runPaperLoop,
  resolveMarketSession,
  clampIntervalMinutes,
  clampMaxIterations,
  MIN_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
} from '../src/paper/paperTradingLoop.js';
import {
  parseArgs as parseOnceArgs,
  runPaperDecisionCycle,
  oneLineDecisionSummary,
  buildDecisionCycleReport,
  paperDefaultsFromStrategySettings,
  paperFeaturesFromConfig,
  riskCapDefaultsFromConfig,
} from './runPaperTradingOnce.js';
import { buildClassifier } from './classifyNewsOnce.js';
import { runEodReport } from './sendPaperEodReport.js';

export { MIN_INTERVAL_MINUTES };

function createInterruptibleSleep(shouldStop) {
  let wakeCurrent = null;
  return {
    sleep: (ms) => new Promise((resolve) => {
      if (shouldStop() || ms <= 0) { resolve(); return; }
      const timer = setTimeout(() => {
        wakeCurrent = null;
        resolve();
      }, ms);
      wakeCurrent = () => {
        clearTimeout(timer);
        wakeCurrent = null;
        resolve();
      };
    }),
    wake: () => { if (wakeCurrent) wakeCurrent(); },
  };
}

function emptySessionStats(sessionDate, sessionId = null) {
  return {
    sessionDate,
    sessionId,
    cycles: 0,
    freshNewsCount: 0,
    classificationCount: 0,
    classificationStatus: {},
    skippedReasons: {},
    rejectedReasons: {},
    ordersSubmitted: 0,
    orderStatus: {},
    modelRequestCount: 0,
    shortsUsed: 0,
    marginUsed: 0,
    eodSent: false,
  };
}

function inc(map, key, amount = 1) {
  const k = String(key ?? 'unknown');
  map[k] = (map[k] ?? 0) + amount;
}

function mergeCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source ?? {})) inc(target, key, Number(value) || 0);
}

function parseJsonMap(text) {
  try {
    const parsed = JSON.parse(text ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function countTradeSub(stats, sub) {
  if (!sub) return;
  if (sub.rejectedTradeId !== null) inc(stats.rejectedReasons, sub.risk?.reason ?? sub.proposal?.reason ?? 'rejected');
  if (sub.order) {
    stats.ordersSubmitted += 1;
    inc(stats.orderStatus, sub.order.status ?? 'unknown');
  }
}

function applyCycleStats(stats, cycle, args) {
  stats.cycles += 1;
  stats.freshNewsCount += Number(cycle?.ingestion?.inserted ?? 0);
  stats.classificationCount += Number(cycle?.classification?.stored ?? 0);
  stats.modelRequestCount += Number(cycle?.classification?.selectedIds?.length ?? 0);
  mergeCounts(stats.classificationStatus, cycle?.classification?.statusCounts);
  if (cycle?.skipReason) inc(stats.skippedReasons, cycle.skipReason);
  countTradeSub(stats, cycle?.trade?.result?.equity);
  if (cycle?.trade?.result?.equity?.proposal?.side === 'sell' && cycle.trade.result.equity.decision === 'accepted') {
    stats.shortsUsed += 1;
  }
  if (args?.paperFeatures?.enableMargin) stats.marginUsed = 1;
}

function persistSessionStats(db, stats, status = 'open', extra = {}) {
  if (!stats?.sessionId) return;
  updatePaperRuntimeSession(db, stats.sessionId, {
    status,
    cycles: stats.cycles,
    freshNewsCount: stats.freshNewsCount,
    classificationCount: stats.classificationCount,
    classificationStatus: stats.classificationStatus,
    skippedReasons: stats.skippedReasons,
    rejectedReasons: stats.rejectedReasons,
    ordersSubmitted: stats.ordersSubmitted,
    orderStatus: stats.orderStatus,
    modelRequestCount: stats.modelRequestCount,
    shortsUsed: stats.shortsUsed,
    marginUsed: stats.marginUsed,
    ...extra,
  });
}

/**
 * Parse loop CLI args. The trade flags are parsed by the one-shot parser (so the
 * loop and one-shot stay in lockstep); the loop adds its own scheduling flags.
 */
export function parseArgs(argv, defaults = {}) {
  const base = parseOnceArgs(argv, defaults);
  const loop = {
    intervalMinutes: clampIntervalMinutes(defaults.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
    maxIterations: clampMaxIterations(defaults.maxIterations),
    runOutsideMarketHours: false,
    deprecatedRunOutsideMarketHours: false,
    sendDiscordEod: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--interval-minutes' && next) { loop.intervalMinutes = clampIntervalMinutes(next); i += 1; }
    else if (flag === '--max-iterations' && next) { loop.maxIterations = clampMaxIterations(next); i += 1; }
    else if (flag === '--run-outside-market-hours' && next) {
      loop.deprecatedRunOutsideMarketHours = String(next).trim().toLowerCase() === 'true'; i += 1;
    } else if (flag === '--send-discord-eod-report') { loop.sendDiscordEod = true; }
  }
  return { ...base, ...loop };
}

async function main() {
  const config = loadConfig();
  const strategy = loadStrategySettings();
  const paperDefaults = strategy.source === 'runtime' ? paperDefaultsFromStrategySettings(strategy.settings) : {};
  const loopDefaults = strategy.source === 'runtime'
    ? {
      intervalMinutes: strategy.settings.interval_minutes,
      ...(strategy.settings.max_iterations ? { maxIterations: strategy.settings.max_iterations } : {}),
    }
    : {};
  const args = parseArgs(process.argv.slice(2), {
    ...paperDefaults,
    ...loopDefaults,
    caps: { ...riskCapDefaultsFromConfig(config), ...(paperDefaults.caps ?? {}) },
    maxDailyLossUsd: config.risk?.maxDailyLossUsd,
    paperFeatures: paperFeaturesFromConfig(config),
  });
  const hasPaperCreds = Boolean(config.alpacaPaper.keyId && config.alpacaPaper.secretKey);
  const hasAlpacaNewsCreds = Boolean(config.alpacaNews.keyId && config.alpacaNews.secretKey);

  if (args.executePaper && !hasPaperCreds) {
    console.error(
      'Loop NOT STARTED in execute mode: Alpaca PAPER credentials are not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env, or omit --execute-paper.'
    );
    process.exitCode = 1;
    return;
  }

  console.log('Paper trading loop (manual, PAPER-only — live trading disabled)');
  console.log(`  ${HOLIDAY_LIMITATION_NOTE}`);
  // Graceful shutdown: SIGINT/SIGTERM flips a flag the loop checks each turn.
  let stopRequested = false;
  const sleeper = createInterruptibleSleep(() => stopRequested);
  const onSignal = () => {
    if (!stopRequested) console.log('\nShutdown requested — finishing current iteration, then exiting…');
    stopRequested = true;
    sleeper.wake();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);

    let provider = null;
    let providerSkipReason = null;
    if (hasAlpacaNewsCreds) {
      provider = createAlpacaNewsProvider({ fetchRawNews: createAlpacaNewsHttpTransport(config) });
    } else {
      providerSkipReason = 'Alpaca credentials not configured for news ingest';
    }
    const wantsModelClassifier = ['openai', 'anthropic', 'real_model'].includes(args.classifier);
    const classifier = wantsModelClassifier
      ? buildClassifier(args.classifier, config, { onWarning: (msg) => console.error(msg) })
      : null;
    const paperClient = hasPaperCreds ? createAlpacaPaperClient(config) : null;
    const priceSource = hasPaperCreds ? createAlpacaTradesPriceSource(config) : null;

    const classifierLabel = classifier
      ? `classifier=${classifier.name} model=${classifier.modelName}`
      : `classifier=${args.classifier ?? '(not requested)'}`;
    console.log(
      `  symbols=${args.symbols.join(',')} mode=${args.executePaper ? 'EXECUTE-PAPER' : 'DRY-RUN'} ` +
        `interval=${args.intervalMinutes}m max-iter=${args.maxIterations ?? 'continuous'} ` +
        `${classifierLabel} ingest-limit=${args.ingestLimit} ` +
        `classify-limit=${args.classifyLimit} lookback=${args.newsLookbackMinutes}m ` +
        `shorts=${args.allowShorts ? 'on' : 'off'} ` +
        `outside-hours=${args.runOutsideMarketHours ? 'yes' : 'no'}`
    );
    if (args.deprecatedRunOutsideMarketHours) {
      console.error('--run-outside-market-hours is deprecated and ignored: market-closed cycles never call news/model/price/order APIs.');
    }

    let currentStats = null;
    const ensureSession = (nowMs) => {
      if (currentStats) return currentStats;
      const sessionDate = new Date(nowMs).toISOString().slice(0, 10);
      const existing = findOpenPaperRuntimeSession(db, sessionDate);
      if (existing) {
        currentStats = emptySessionStats(sessionDate, Number(existing.id));
        currentStats.cycles = Number(existing.cycles) || 0;
        currentStats.freshNewsCount = Number(existing.fresh_news_count) || 0;
        currentStats.classificationCount = Number(existing.classification_count) || 0;
        currentStats.classificationStatus = parseJsonMap(existing.classification_status_json);
        currentStats.skippedReasons = parseJsonMap(existing.skipped_reason_json);
        currentStats.rejectedReasons = parseJsonMap(existing.rejected_reason_json);
        currentStats.ordersSubmitted = Number(existing.orders_submitted) || 0;
        currentStats.orderStatus = parseJsonMap(existing.order_status_json);
        currentStats.modelRequestCount = Number(existing.model_request_count) || 0;
        currentStats.shortsUsed = Number(existing.shorts_used) || 0;
        currentStats.marginUsed = Number(existing.margin_used) || 0;
        currentStats.eodSent = existing.eod_report_status === 'sent';
        console.log(`Paper runtime session resumed: date=${sessionDate} id=${existing.id}`);
        return currentStats;
      }
      const { id } = startPaperRuntimeSession(db, {
        sessionDate,
        startedAt: new Date(nowMs).toISOString(),
      });
      currentStats = emptySessionStats(sessionDate, id);
      console.log(`Paper runtime session opened: date=${sessionDate} id=${id}`);
      return currentStats;
    };

    const runOnce = async ({ nowMs }) => {
      const stats = ensureSession(nowMs);
      const cycle = await runPaperDecisionCycle(
        db,
        { provider, classifier, paperClient, priceSource, providerSkipReason },
        args,
        { nowMs }
      );
      applyCycleStats(stats, cycle, args);
      let performance = null;
      if (paperClient) {
        performance = await recordPerformanceSnapshot(db, {
          paperClient,
          priceSource,
          runtimeSessionId: stats.sessionId,
          nowMs,
          snapshotKind: 'loop',
        });
      }
      persistSessionStats(db, stats, 'open');
      for (const line of buildDecisionCycleReport(cycle, nowMs)) console.log(line);
      if (performance) {
        for (const line of formatBrokerTruthLines(performance)) console.log(`  ${line}`);
      }
      const perfTail = performance
        ? `; broker fills=${performance.broker.orders.filled}/${performance.broker.orders.submitted} ` +
          `exposure=${performance.exposure.grossExposure ?? 'unavailable'}`
        : '';
      return `${oneLineDecisionSummary(cycle, nowMs)}${perfTail}`;
    };

    const sendSessionEod = async ({ nowMs }) => {
      const stats = currentStats;
      if (!stats || stats.eodSent) return;
      const persisted = getPaperRuntimeSession(db, stats.sessionId);
      if (persisted?.eod_report_status === 'sent') {
        stats.eodSent = true;
        console.log(`EOD report already sent for ${stats.sessionDate} session ${stats.sessionId}; skipping duplicate delivery.`);
        currentStats = null;
        return;
      }
      stats.eodSent = true;
      const endedAt = new Date(nowMs).toISOString();
      persistSessionStats(db, stats, 'closed', { endedAt });
      if (paperClient) {
        try {
          const performance = await recordPerformanceSnapshot(db, {
            paperClient,
            priceSource,
            runtimeSessionId: stats.sessionId,
            nowMs,
            snapshotKind: 'eod',
          });
          for (const line of formatBrokerTruthLines(performance)) console.log(line);
        } catch (err) {
          console.error(`Broker-truth EOD snapshot failed (non-fatal): ${err.message}`);
        }
      }
      if (!args.sendDiscordEod) {
        persistSessionStats(db, stats, 'closed', { eodReportStatus: 'skipped' });
        console.log(`EOD report skipped for ${stats.sessionDate} (--send-discord-eod-report not set).`);
        currentStats = null;
        return;
      }
      if (!config.discord.webhookUrl) {
        persistSessionStats(db, stats, 'closed', {
          eodReportStatus: 'failed',
          eodReportError: 'DISCORD_WEBHOOK_URL not configured',
        });
        console.error('EOD report NOT SENT: DISCORD_WEBHOOK_URL is not configured (non-fatal).');
        currentStats = null;
        return;
      }
      try {
        const discordClient = createDiscordWebhookClient(config);
        const eod = await runEodReport(db, {
          day: stats.sessionDate,
          sessionId: stats.sessionId,
          send: true,
          discordClient,
          sessionStats: stats,
        });
        for (const line of eod.lines) console.log(line);
        persistSessionStats(db, stats, 'closed', {
          eodReportStatus: 'sent',
          eodReportSentAt: new Date().toISOString(),
        });
        console.log(`EOD report SENT to Discord for ${stats.sessionDate}.`);
      } catch (err) {
        persistSessionStats(db, stats, 'closed', {
          eodReportStatus: 'failed',
          eodReportError: err.message,
        });
        console.error(`EOD report delivery failed (non-fatal): ${err.message}`);
      } finally {
        currentStats = null;
      }
    };

    const { iterations, stopped } = await runPaperLoop({
      maxIterations: args.maxIterations,
      intervalMs: args.intervalMinutes * 60_000,
      executePaper: args.executePaper,
      symbols: args.symbols,
      runOnce,
      getMarketSession: ({ nowMs }) => resolveMarketSession({
        nowMs,
        getClock: paperClient ? () => paperClient.getClock() : null,
        fallbackIsMarketOpen: isMarketOpen,
        fallbackMarketStatusLabel: marketStatusLabel,
      }),
      isMarketOpen,
      marketStatusLabel,
      onHeartbeat: (line) => console.log(line),
      onStateChange: (line) => console.log(line),
      onSessionClosed: sendSessionEod,
      sleep: sleeper.sleep,
      shouldStop: () => stopRequested,
    });

    console.log(`Loop finished after ${iterations} iteration(s)${stopped ? ' (stopped early)' : ''}.`);

  } catch (err) {
    console.error(`Paper trading loop FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
