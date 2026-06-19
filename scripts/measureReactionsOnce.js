// scripts/measureReactionsOnce.js — MANUAL capped one-shot measurement run
// over EXISTING news_events, using the real Alpaca Trades PriceSource
// (docs/market-data-client-plan.md §15, step 4 of §16).
//
//   Run:  node --env-file=.env scripts/measureReactionsOnce.js [--limit 1] \
//           [--ids 1,2,3] [--baseline-lookback-minutes 60]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked selection + measurement, then exit. No polling, no
//   scheduling, no background jobs.
// - DIAGNOSTICS: for each measured event the report prints a sanitized window
//   block (anchor_at, baseline-lookback start, final reaction-window end,
//   source name, and the COUNT of trades the source returned) so all-no_baseline
//   outcomes on the thin IEX feed can be understood. Counts/timestamps only —
//   never trade prices, raw payloads, or secrets.
// - --baseline-lookback-minutes widens how far back the engine looks for a
//   baseline trade (default unchanged at DEFAULT_BASELINE_LOOKBACK_MINUTES). A
//   wider lookback only changes the REQUESTED price-source window; it never
//   changes measurement semantics or which event is selected.
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
import { measureEvents, DEFAULT_BASELINE_LOOKBACK_MS } from '../src/eventStudy/measureReactions.js';
import { HORIZONS } from '../src/database/priceReactions.js';

/** Tiny manual sample only. Default 1 event; never more than the hard cap. */
export const DEFAULT_MEASURE_LIMIT = 1;
export const MAX_MEASURE_LIMIT = 5;

/**
 * Baseline-lookback CLI bounds. The default mirrors the engine's own default
 * (so omitting the flag leaves behavior unchanged). The hard max is one full
 * regular-session length (6.5h) — generous enough to reach the prior close on
 * a thin feed, while keeping the requested trade window bounded.
 */
export const DEFAULT_BASELINE_LOOKBACK_MINUTES = DEFAULT_BASELINE_LOOKBACK_MS / 60_000;
export const MAX_BASELINE_LOOKBACK_MINUTES = 390;

/**
 * Parse minimal CLI args: --limit N --ids 1,2,3 --baseline-lookback-minutes N.
 * Exported for tests. The limit is always clamped to [1, MAX_MEASURE_LIMIT];
 * explicit ids are deduped, kept in order, and truncated to the same hard cap.
 * baselineLookbackMinutes stays null (engine default, behavior unchanged) unless
 * a positive integer is supplied, in which case it is capped to
 * [1, MAX_BASELINE_LOOKBACK_MINUTES]. No cap can be exceeded regardless of input.
 */
export function parseArgs(argv) {
  const args = { limit: DEFAULT_MEASURE_LIMIT, ids: null, baselineLookbackMinutes: null };
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
    } else if (argv[i] === '--baseline-lookback-minutes' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      // Junk/non-positive input is ignored → null → engine default (unchanged).
      if (Number.isInteger(n) && n > 0) {
        args.baselineLookbackMinutes = Math.min(n, MAX_BASELINE_LOOKBACK_MINUTES);
      }
      i += 1;
    }
  }
  args.limit = Math.min(Math.max(args.limit, 1), MAX_MEASURE_LIMIT);
  if (args.ids) args.ids = args.ids.slice(0, MAX_MEASURE_LIMIT);
  return args;
}

/**
 * Resolve the CLI minutes option to an engine `baselineLookbackMs` value, or
 * null when the flag was omitted (so the engine keeps its own default and the
 * default behavior is unchanged).
 */
export function resolveBaselineLookbackMs(baselineLookbackMinutes) {
  return baselineLookbackMinutes === null || baselineLookbackMinutes === undefined
    ? null
    : baselineLookbackMinutes * 60_000;
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
 * Sanitized per-event WINDOW DIAGNOSTICS lines built from the engine summary's
 * `window` block. Explains the exact measurement window so all-no_baseline
 * outcomes are debuggable. Whitelist only: event id, ticker, anchor_at,
 * baseline-lookback start, reaction-window end, source name, and the COUNT of
 * trades the source returned (n/a on source_error). Never prices or payloads.
 * Returns [] for summaries without window data (older/synthetic shapes).
 */
export function perEventDiagnostics(summary) {
  const w = summary?.window;
  if (!w) return [];
  const lookbackMin = Math.round((w.baselineLookbackMs ?? 0) / 60_000);
  const trades =
    w.tradeCount === null || w.tradeCount === undefined ? 'n/a (source error)' : `${w.tradeCount}`;
  return [
    `    - event ${summary.newsEventId} ${summary.ticker}`,
    `        anchor_at:     ${summary.anchorAt}`,
    `        baseline from: ${w.baselineFromIso}  (lookback ${lookbackMin}m)`,
    `        reaction to:   ${w.reactionToIso}`,
    `        source:        ${summary.priceSource ?? '?'}`,
    `        trades seen:   ${trades}`,
  ];
}

/**
 * Build the full sanitized report as an array of printable lines. Whitelist
 * only: selected count, source name, measured/failed event counts, status
 * counts, horizons attempted, replaced-row count, and per-event id/ticker/
 * status lines. No raw payloads are renderable here by construction.
 */
export function buildMeasureReport(batch, { selectedCount, sourceName, baselineLookbackMs } = {}) {
  const agg = aggregateResults(batch);
  const statusLine =
    Object.keys(agg.statusCounts).length > 0
      ? Object.entries(agg.statusCounts)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([status, n]) => `${status}=${n}`)
          .join('  ')
      : '(none)';
  const lookbackMin = Math.round((baselineLookbackMs ?? DEFAULT_BASELINE_LOOKBACK_MS) / 60_000);
  const lines = [
    `Alpaca Trades one-shot measurement via source "${sourceName ?? '?'}"`,
    `  selected:   ${selectedCount ?? 0} event(s)`,
    `  lookback:   ${lookbackMin}m baseline window`,
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
  // Window diagnostics: only rendered for summaries that carry engine window
  // data, so older/synthetic batch shapes print exactly as before.
  const diagnostics = (batch.summaries ?? []).flatMap(perEventDiagnostics);
  if (diagnostics.length > 0) {
    lines.push('  window diagnostics:');
    lines.push(...diagnostics);
  }
  if ((selectedCount ?? 0) === 0) {
    lines.push('  (no eligible news_events rows — ingest some real events first)');
  }
  return lines;
}

async function main() {
  const { limit, ids, baselineLookbackMinutes } = parseArgs(process.argv.slice(2));
  const baselineLookbackMs = resolveBaselineLookbackMs(baselineLookbackMinutes);
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
        { selectedCount: 0, sourceName: '(not constructed)', baselineLookbackMs }
      )) {
        console.log(line);
      }
      console.log('Measurement SKIPPED (nothing eligible to measure).');
      return;
    }

    // Only pass baselineLookbackMs when explicitly requested; otherwise the
    // engine keeps its own default (default behavior unchanged).
    const measureOptions = baselineLookbackMs ? { baselineLookbackMs } : {};

    // Explicit construction — the only place a real market-data path is enabled.
    const source = createAlpacaTradesPriceSource(config);
    const batch = await measureEvents(db, events, source, measureOptions);
    for (const line of buildMeasureReport(batch, {
      selectedCount: events.length,
      sourceName: source.name,
      baselineLookbackMs: baselineLookbackMs ?? DEFAULT_BASELINE_LOOKBACK_MS,
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
