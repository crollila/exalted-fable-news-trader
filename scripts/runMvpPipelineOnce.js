// scripts/runMvpPipelineOnce.js — MANUAL single capped end-to-end MVP loop.
// One human-invoked command that runs the whole research loop on a TINY set:
//
//   (1) optional Alpaca news ingest   → news_events
//   (2) deterministic manual scoring  → sentiment_scores
//   (3) capped price-reaction measure → price_reactions
//   (4) read-only research summary    → printed snapshot
//
//   Run:  node --env-file=.env scripts/runMvpPipelineOnce.js \
//           [--symbols AAPL] [--ingest-limit 5] [--classify-limit 1] \
//           [--measure-limit 1] [--skip-ingest]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One run, then exit. No polling, no scheduling, no background jobs.
// - RESEARCH/MEASUREMENT ONLY. It NEVER trades, submits orders, or calls any
//   trading API. The classifier is the deterministic manual baseline (no
//   model, no network, no keys — see scripts/classifyNewsOnce.js).
// - REUSES EXISTING PATHS ONLY: ingestNews, the manual classifier +
//   classifyAndStore, the measurement engine via measureEvents +
//   insertPriceReaction, and the read-only report's collectSummary. No new
//   write path, no schema change, no measurement/parser/storage semantics
//   change. Every stage is idempotent the same way the underlying paths are.
// - SAFE TO RUN WITHOUT CREDENTIALS: ingest and measure require Alpaca keys;
//   when they are absent (or ingest is skipped via --skip-ingest) those stages
//   are SKIPPED and clearly reported, and the loop still classifies existing
//   events and prints the summary. Nothing is hidden — no_baseline/no_reaction
//   outcomes are reported as data, exactly as the measurement engine records.
// - SANITIZED OUTPUT ONLY: it composes the existing per-stage sanitized
//   reports (ingest/classify/measure/summary). Never keys, headers, request
//   URLs, raw trade payloads, raw news payloads, or raw model responses.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';
import { measureEvents } from '../src/eventStudy/measureReactions.js';
import { collectSummary, buildSummaryReport } from './reportEventStudySummary.js';
import { buildIngestReport } from './ingestAlpacaNewsOnce.js';
import {
  buildClassifyReport,
  buildManualClassifier,
  selectUnscoredEvents,
  DEFAULT_CLASSIFY_LIMIT,
  MAX_CLASSIFY_LIMIT,
} from './classifyNewsOnce.js';
import {
  buildMeasureReport,
  selectEvents,
  DEFAULT_MEASURE_LIMIT,
  MAX_MEASURE_LIMIT,
} from './measureReactionsOnce.js';

/** Capped defaults — tiny manual samples only. */
export const DEFAULT_INGEST_LIMIT = 5;
export const MAX_INGEST_LIMIT = 20;
export {
  DEFAULT_CLASSIFY_LIMIT,
  MAX_CLASSIFY_LIMIT,
  DEFAULT_MEASURE_LIMIT,
  MAX_MEASURE_LIMIT,
};

/** Recent-measured-rows sample size for the closing summary. */
const REPORT_RECENT_LIMIT = 10;

function clampInt(value, fallback, lo, hi) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Parse CLI args. Exported for tests. Every numeric limit is clamped to its
 * hard cap, so the caps can never be exceeded regardless of input.
 *   --symbols A,B   --ingest-limit N   --classify-limit N
 *   --measure-limit N   --skip-ingest
 */
export function parseArgs(argv) {
  const args = {
    symbols: ['AAPL'],
    ingestLimit: DEFAULT_INGEST_LIMIT,
    classifyLimit: DEFAULT_CLASSIFY_LIMIT,
    measureLimit: DEFAULT_MEASURE_LIMIT,
    skipIngest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--symbols' && argv[i + 1]) {
      args.symbols = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (flag === '--ingest-limit' && argv[i + 1]) {
      args.ingestLimit = clampInt(argv[i + 1], DEFAULT_INGEST_LIMIT, 1, MAX_INGEST_LIMIT);
      i += 1;
    } else if (flag === '--classify-limit' && argv[i + 1]) {
      args.classifyLimit = clampInt(argv[i + 1], DEFAULT_CLASSIFY_LIMIT, 1, MAX_CLASSIFY_LIMIT);
      i += 1;
    } else if (flag === '--measure-limit' && argv[i + 1]) {
      args.measureLimit = clampInt(argv[i + 1], DEFAULT_MEASURE_LIMIT, 1, MAX_MEASURE_LIMIT);
      i += 1;
    } else if (flag === '--skip-ingest') {
      args.skipIngest = true;
    }
  }
  if (args.symbols.length === 0) args.symbols = ['AAPL'];
  return args;
}

/**
 * Orchestrate the MVP loop against an OPEN db using INJECTED dependencies.
 * Dependencies are injected so tests can drive the full sequence offline with
 * fakes (mock provider, manual classifier, fixture PriceSource). Stages 1 and
 * 3 are optional: pass `provider: null` / `priceSource: null` (with a reason)
 * to skip them. Returns a structured result; rendering is separate.
 *
 * @param {object} db  open database handle (migrations already run)
 * @param {object} deps
 * @param {import('../src/providers/newsProvider.js').NewsProvider|null} deps.provider
 * @param {string} [deps.providerSkipReason]
 * @param {import('../src/sentiment/classifierContract.js').Classifier} deps.classifier
 * @param {object|null} deps.priceSource  a PriceSource, or null to skip measure
 * @param {string} [deps.priceSkipReason]
 * @param {object} opts  symbols + caps (already clamped by parseArgs)
 */
export async function runPipeline(
  db,
  { provider = null, providerSkipReason = 'skipped', classifier, priceSource = null, priceSkipReason = 'skipped' },
  { symbols = ['AAPL'], ingestLimit = DEFAULT_INGEST_LIMIT, classifyLimit = DEFAULT_CLASSIFY_LIMIT, measureLimit = DEFAULT_MEASURE_LIMIT, reportLimit = REPORT_RECENT_LIMIT } = {}
) {
  const result = { ingest: null, classify: null, measure: null, summary: null };

  // Stage 1 — optional Alpaca news ingest (existing path, dedup applies).
  if (provider) {
    const summary = await ingestNews(db, provider, { symbols, limit: ingestLimit });
    result.ingest = { ran: true, summary };
  } else {
    result.ingest = { ran: false, reason: providerSkipReason };
  }

  // Stage 2 — deterministic manual scoring of a tiny unscored set.
  const toClassify = selectUnscoredEvents(db, {
    limit: classifyLimit,
    modelName: classifier.modelName,
    promptVersion: classifier.promptVersion,
  });
  const classifySummary = await classifyAndStore(db, classifier, {
    eventIds: toClassify.map((r) => r.id),
  });
  result.classify = {
    ran: true,
    selectedCount: toClassify.length,
    model: classifier.modelName,
    promptVersion: classifier.promptVersion,
    summary: classifySummary,
  };

  // Stage 3 — optional capped price-reaction measurement (existing engine).
  if (priceSource) {
    const toMeasure = selectEvents(db, { limit: measureLimit });
    const batch = await measureEvents(db, toMeasure, priceSource);
    result.measure = { ran: true, selectedCount: toMeasure.length, sourceName: priceSource.name, batch };
  } else {
    result.measure = { ran: false, reason: priceSkipReason };
  }

  // Stage 4 — read-only research summary (SELECTs only).
  result.summary = collectSummary(db, { recentLimit: reportLimit });
  return result;
}

/**
 * Render the structured pipeline result into sanitized printable lines by
 * composing the EXISTING per-stage report builders. No report logic is
 * duplicated here, and no field outside those builders' whitelists is ever
 * rendered.
 */
export function buildPipelineReport(result) {
  const lines = ['MVP pipeline (manual, capped, research-only — no trading)'];

  lines.push('', '— stage 1: ingest —');
  if (result.ingest?.ran) {
    lines.push(...buildIngestReport(result.ingest.summary));
  } else {
    lines.push(`  SKIPPED: ${result.ingest?.reason ?? 'skipped'}`);
  }

  lines.push('', '— stage 2: classify / score —');
  const c = result.classify;
  lines.push(
    ...buildClassifyReport(c?.summary, {
      selectedCount: c?.selectedCount,
      model: c?.model,
      promptVersion: c?.promptVersion,
    })
  );

  lines.push('', '— stage 3: measure reactions —');
  if (result.measure?.ran) {
    lines.push(
      ...buildMeasureReport(result.measure.batch, {
        selectedCount: result.measure.selectedCount,
        sourceName: result.measure.sourceName,
      })
    );
  } else {
    lines.push(`  SKIPPED: ${result.measure?.reason ?? 'skipped'}`);
  }

  lines.push('', '— stage 4: research summary (read-only) —');
  lines.push(...buildSummaryReport(result.summary));
  return lines;
}

async function main() {
  const { symbols, ingestLimit, classifyLimit, measureLimit, skipIngest } = parseArgs(
    process.argv.slice(2)
  );
  const config = loadConfig();
  const hasCreds = Boolean(config.alpacaNews.keyId && config.alpacaNews.secretKey);

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures all event-study tables exist

    // Stage 1 dependency: only construct a real transport when explicitly
    // enabled AND credentialed. Otherwise skip with a clear reason.
    let provider = null;
    let providerSkipReason = '';
    if (skipIngest) {
      providerSkipReason = 'ingest disabled via --skip-ingest';
    } else if (!hasCreds) {
      providerSkipReason =
        'Alpaca credentials not configured (set ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY in .env)';
    } else {
      const transport = createAlpacaNewsHttpTransport(config);
      provider = createAlpacaNewsProvider({ fetchRawNews: transport });
    }

    // Stage 3 dependency: real market-data source only when credentialed.
    let priceSource = null;
    let priceSkipReason = '';
    if (!hasCreds) {
      priceSkipReason =
        'Alpaca credentials not configured (set ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY in .env)';
    } else {
      priceSource = createAlpacaTradesPriceSource(config);
    }

    const classifier = buildManualClassifier();
    const result = await runPipeline(
      db,
      { provider, providerSkipReason, classifier, priceSource, priceSkipReason },
      { symbols, ingestLimit, classifyLimit, measureLimit, reportLimit: REPORT_RECENT_LIMIT }
    );

    for (const line of buildPipelineReport(result)) console.log(line);

    const measureFailed = result.measure?.ran ? result.measure.batch.failedEvents > 0 : false;
    const classifyFailed = (result.classify?.summary?.failed ?? 0) > 0;
    if (measureFailed || classifyFailed) {
      console.log('MVP pipeline completed WITH FAILURES (see per-stage details above).');
      process.exitCode = 1;
    } else {
      console.log('MVP pipeline COMPLETE (research-only; no orders placed).');
    }
  } catch (err) {
    // Source/transport errors are sanitized/redacted at their origin; print
    // the message only, never the error object (it could embed request config).
    console.error(`MVP pipeline FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
