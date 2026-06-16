// scripts/measureReactionsOnce.js — MANUAL capped one-shot measurement run
// over EXISTING news_events, using the real Alpaca Trades PriceSource
// (docs/market-data-client-plan.md §15, step 4 of §16).
//
//   Run:  node --env-file=.env scripts/measureReactionsOnce.js [--limit 1] [--ids 1,2,3]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked selection + measurement, then exit. No polling, no
//   scheduling, no background jobs.
// - Reuses the EXISTING measurement path end to end: explicit
//   createAlpacaTradesPriceSource(config) → measureEvents() → measureEvent()
//   → insertPriceReaction(). No separate write path; re-measurement REPLACES
//   by (news_event_id, horizon) exactly as the engine already does.
// - Selects a TINY capped set of existing news_events rows (default 1, hard
//   max MAX_MEASURE_LIMIT = 5). Prefers rows that have both ticker and
//   received_at (the engine requires them to anchor a window).
// - Credentials ONLY via loadConfig() (src/config.js); this file never reads
//   process.env. Use --env-file=.env (built into Node) to load your .env.
// - SANITIZED OUTPUT ONLY: selected count, measured/failed event counts,
//   measurement_status counts, horizons attempted, source name, and a compact
//   per-event line (id, ticker, per-horizon status). Never keys, auth headers,
//   request URLs, raw trade payloads, or raw news payloads.
// - NO sentiment/model calls, NO trading, NO paper orders.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createAlpacaTradesPriceSource } from '../src/prices/alpacaTradesPriceSource.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { measureEvents } from '../src/eventStudy/measureReactions.js';
import { HORIZONS } from '../src/database/priceReactions.js';

/** Tiny manual sample only. Default 1 event; never more than the hard cap. */
export const DEFAULT_MEASURE_LIMIT = 1;
export const MAX_MEASURE_LIMIT = 5;

/**
 * Parse minimal CLI args: --limit N --ids 1,2,3. Exported for tests.
 * The limit is always clamped to [1, MAX_MEASURE_LIMIT]; explicit ids are
 * deduped, kept in order, and truncated to the same hard cap. The cap can
 * never be exceeded regardless of input.
 */
export function parseArgs(argv) {
  const args = { limit: DEFAULT_MEASURE_LIMIT, ids: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.limit = n;
      i += 1;
    } else if (argv[i] === '--ids' && argv[i + 1]) {
      const ids = [];
      for (const token of argv[i + 1].split(',')) {
        const n = Number.parseInt(token.trim(), 10);
        if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
      }
      args.ids = ids;
      i += 1;
    }
  }
  args.limit = Math.min(Math.max(args.limit, 1), MAX_MEASURE_LIMIT);
  if (args.ids) args.ids = args.ids.slice(0, MAX_MEASURE_LIMIT);
  return args;
}

/**
 * Select a tiny capped set of EXISTING news_events rows to measure. Only rows
 * with both ticker and received_at are eligible (the engine needs both to
 * anchor a window). Selection is read-only and deterministic.
 *
 * @param {object} db  open database handle
 * @param {object} opts
 * @param {number} opts.limit  effective cap (already clamped by parseArgs)
 * @param {number[]|null} [opts.ids]  explicit ids; when present, only these
 *   eligible ids are returned (capped), preserving id order
 * @returns {object[]} news_events rows
 */
export function selectEvents(db, { limit, ids } = {}) {
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_MEASURE_LIMIT, 1), MAX_MEASURE_LIMIT);
  if (ids && ids.length > 0) {
    const capped = ids.slice(0, cap);
    const placeholders = capped.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT * FROM news_events
          WHERE id IN (${placeholders})
            AND ticker IS NOT NULL AND received_at IS NOT NULL
          ORDER BY id ASC`
      )
      .all(...capped);
  }
  return db
    .prepare(
      `SELECT * FROM news_events
        WHERE ticker IS NOT NULL AND received_at IS NOT NULL
        ORDER BY received_at ASC, id ASC
        LIMIT ?`
    )
    .all(cap);
}

/**
 * Aggregate a measureEvents() batch result into sanitized counts. Reads ONLY
 * the engine's own summary shape ({ horizon, status, replaced }); no trade or
 * news payloads are ever touched.
 */
export function aggregateResults(batch) {
  const statusCounts = {};
  const horizonsAttempted = new Set();
  let reactionRows = 0;
  let replacedRows = 0;
  for (const summary of batch.summaries ?? []) {
    for (const r of summary.results ?? []) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      horizonsAttempted.add(r.horizon);
      reactionRows += 1;
      if (r.replaced) replacedRows += 1;
    }
  }
  const horizonsOrdered = HORIZONS.filter((h) => horizonsAttempted.has(h));
  return { statusCounts, horizonsAttempted: horizonsOrdered, reactionRows, replacedRows };
}

/** One compact, sanitized per-event line: id, ticker, per-horizon status. */
function perEventLine(summary) {
  const byHorizon = new Map(summary.results.map((r) => [r.horizon, r.status]));
  const parts = HORIZONS.filter((h) => byHorizon.has(h)).map((h) => `${h}=${byHorizon.get(h)}`);
  return `  - event ${summary.newsEventId} ${summary.ticker}: ${parts.join('  ')}`;
}

/**
 * Build the full sanitized report as an array of printable lines. Whitelist
 * only: selected count, source name, measured/failed event counts, status
 * counts, horizons attempted, replaced-row count, and per-event id/ticker/
 * status lines. No raw payloads are renderable here by construction.
 */
export function buildMeasureReport(batch, { selectedCount, sourceName } = {}) {
  const agg = aggregateResults(batch);
  const statusLine =
    Object.keys(agg.statusCounts).length > 0
      ? Object.entries(agg.statusCounts)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([status, n]) => `${status}=${n}`)
          .join('  ')
      : '(none)';
  const lines = [
    `Alpaca Trades one-shot measurement via source "${sourceName ?? '?'}"`,
    `  selected:   ${selectedCount ?? 0} event(s)`,
    `  measured:   ${batch.measuredEvents} event(s)`,
    `  failed:     ${batch.failedEvents} event(s)`,
    `  horizons:   ${agg.horizonsAttempted.length > 0 ? agg.horizonsAttempted.join(', ') : '(none)'}`,
    `  statuses:   ${statusLine}`,
    `  rows:       ${agg.reactionRows} written (${agg.replacedRows} replaced)`,
  ];
  for (const summary of batch.summaries ?? []) lines.push(perEventLine(summary));
  for (const e of batch.errors ?? []) {
    lines.push(`  - error [event ${e.newsEventId ?? '?'}]: ${e.error}`);
  }
  if ((selectedCount ?? 0) === 0) {
    lines.push('  (no eligible news_events rows — ingest some real events first)');
  }
  return lines;
}

async function main() {
  const { limit, ids } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Same key pair as the news transport (account-level; read via config only).
  if (!config.alpacaNews.keyId || !config.alpacaNews.secretKey) {
    console.error(
      'Measurement NOT RUN: Alpaca market-data credentials are not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env\n' +
        '(see .env.example) and run with:  node --env-file=.env scripts/measureReactionsOnce.js'
    );
    process.exit(1);
  }

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures the event-study schema exists

    const events = selectEvents(db, { limit, ids });
    if (events.length === 0) {
      for (const line of buildMeasureReport(
        { measuredEvents: 0, failedEvents: 0, summaries: [], errors: [] },
        { selectedCount: 0, sourceName: '(not constructed)' }
      )) {
        console.log(line);
      }
      console.log('Measurement SKIPPED (nothing eligible to measure).');
      return;
    }

    // Explicit construction — the only place a real market-data path is enabled.
    const source = createAlpacaTradesPriceSource(config);
    const batch = await measureEvents(db, events, source);
    for (const line of buildMeasureReport(batch, {
      selectedCount: events.length,
      sourceName: source.name,
    })) {
      console.log(line);
    }
    if (batch.failedEvents === 0) {
      console.log('Measurement COMPLETE (rows written through insertPriceReaction).');
    } else {
      console.log('Measurement completed WITH FAILURES (see per-event errors above).');
      process.exitCode = 1;
    }
  } catch (err) {
    // Source errors are already sanitized/redacted at the client; print the
    // message only, never the error object (it could embed request config).
    console.error(`Measurement FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
