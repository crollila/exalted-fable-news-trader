// scripts/reportEventStudySummary.js — MANUAL read-only research summary.
// Prints a sanitized snapshot of the local research database: news_events,
// sentiment_scores, price_reactions, measurement_status counts, horizon
// counts, and measured-return averages.
//
//   Run:  node --env-file=.env scripts/reportEventStudySummary.js [--limit 10]
//   (the .env is only used to resolve DATABASE_URL; NO credentials needed.)
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked read, then exit. No polling, no scheduling.
// - READ-ONLY: opens the configured SQLite file and runs SELECTs only. It
//   never writes, never runs migrations, and never makes a network call.
//   No credentials are required (it reads local rows, not any API).
// - SANITIZED / PASTE-SAFE OUTPUT: aggregate counts plus a small capped list
//   of recent measured rows (news_event_id, ticker, horizon, return_pct,
//   measured_at). It NEVER prints headlines, bodies, raw_payload, raw model
//   responses, keys, or any free-text content — only ids, tickers, horizons,
//   statuses, timestamps, and numeric returns. Safe to paste into ChatGPT.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase, listTables } from '../src/database/db.js';
import {
  countPriceReactionsByStatus,
  HORIZONS,
  MEASUREMENT_STATUS,
} from '../src/database/priceReactions.js';

/** Recent-measured-rows list is a small sample, never a full dump. */
export const DEFAULT_RECENT_LIMIT = 10;
export const MAX_RECENT_LIMIT = 50;

/** Parse minimal CLI args: --limit N (recent measured rows). Exported for tests. */
export function parseArgs(argv) {
  const args = { recentLimit: DEFAULT_RECENT_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.recentLimit = Math.min(n, MAX_RECENT_LIMIT);
      i += 1;
    }
  }
  return args;
}

function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

/**
 * Gather all summary statistics from an open database with read-only SELECTs.
 * Reads ONLY aggregate/whitelisted columns — never headline, body,
 * raw_payload, or raw_response.
 *
 * @param {object} db  open database handle
 * @param {object} [opts]
 * @param {number} [opts.recentLimit]  cap on the recent-measured-rows sample
 */
export function collectSummary(db, { recentLimit = DEFAULT_RECENT_LIMIT } = {}) {
  const totalNewsEvents = countRows(db, 'news_events');
  const totalSentimentScores = countRows(db, 'sentiment_scores');
  const totalPriceReactions = countRows(db, 'price_reactions');

  const measurementStatusCounts = countPriceReactionsByStatus(db);

  const horizonCounts = Object.fromEntries(
    db
      .prepare('SELECT horizon, COUNT(*) AS n FROM price_reactions GROUP BY horizon')
      .all()
      .map((r) => [r.horizon, Number(r.n)])
  );

  const avgReturnByHorizon = Object.fromEntries(
    db
      .prepare(
        `SELECT horizon, AVG(return_pct) AS avg_return, COUNT(*) AS n
           FROM price_reactions
          WHERE measurement_status = ? AND return_pct IS NOT NULL
          GROUP BY horizon`
      )
      .all(MEASUREMENT_STATUS.MEASURED)
      .map((r) => [r.horizon, { avgReturn: Number(r.avg_return), n: Number(r.n) }])
  );

  const recentMeasuredEvents = db
    .prepare(
      `SELECT p.news_event_id AS news_event_id, n.ticker AS ticker, p.horizon AS horizon,
              p.return_pct AS return_pct, p.measured_at AS measured_at
         FROM price_reactions p
         JOIN news_events n ON n.id = p.news_event_id
        WHERE p.measurement_status = ?
        ORDER BY p.measured_at DESC, p.id DESC
        LIMIT ?`
    )
    .all(MEASUREMENT_STATUS.MEASURED, Math.min(Math.max(recentLimit, 1), MAX_RECENT_LIMIT))
    .map((r) => ({
      newsEventId: r.news_event_id,
      ticker: r.ticker,
      horizon: r.horizon,
      returnPct: r.return_pct,
      measuredAt: r.measured_at,
    }));

  return {
    totalNewsEvents,
    totalSentimentScores,
    totalPriceReactions,
    measurementStatusCounts,
    horizonCounts,
    avgReturnByHorizon,
    recentMeasuredEvents,
  };
}

/** Format a fraction as a signed percent string, e.g. 0.0123 -> "+1.230%". */
function fmtPct(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return 'n/a';
  const pct = fraction * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%`;
}

/** Render a `key=value` map (in canonical/ sorted order) or "(none)". */
function renderCounts(counts, order) {
  const keys = order ? order.filter((k) => k in counts) : Object.keys(counts).sort();
  if (keys.length === 0) return '(none)';
  return keys.map((k) => `${k}=${counts[k]}`).join('  ');
}

/**
 * Build the full sanitized, paste-safe report as an array of printable lines.
 * Reads ONLY the whitelisted summary fields produced by collectSummary; any
 * extra fields smuggled onto rows are ignored.
 */
export function buildSummaryReport(summary) {
  const lines = [
    'ExaltedFable research summary (local database, read-only)',
    `  news_events:      ${summary.totalNewsEvents}`,
    `  sentiment_scores: ${summary.totalSentimentScores}`,
    `  price_reactions:  ${summary.totalPriceReactions}`,
    `  measurement_status: ${renderCounts(summary.measurementStatusCounts, Object.values(MEASUREMENT_STATUS))}`,
    `  horizon counts:     ${renderCounts(summary.horizonCounts, HORIZONS)}`,
  ];

  const avgHorizons = HORIZONS.filter((h) => h in summary.avgReturnByHorizon);
  if (avgHorizons.length > 0) {
    lines.push('  measured return averages by horizon:');
    for (const h of avgHorizons) {
      const { avgReturn, n } = summary.avgReturnByHorizon[h];
      lines.push(`    ${h.padEnd(4)} ${fmtPct(avgReturn)}  (n=${n})`);
    }
  } else {
    lines.push('  measured return averages by horizon: (no measured rows yet)');
  }

  if (summary.recentMeasuredEvents.length > 0) {
    lines.push(`  recent measured rows (max ${summary.recentMeasuredEvents.length}):`);
    for (const e of summary.recentMeasuredEvents) {
      lines.push(
        `    [${e.measuredAt}] event ${e.newsEventId} ${e.ticker} ${e.horizon} ${fmtPct(e.returnPct)}`
      );
    }
  } else {
    lines.push('  recent measured rows: (none)');
  }
  return lines;
}

async function main() {
  const { recentLimit } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Read-only: do not create a database. If the file is absent, there is
  // nothing to report — say so clearly rather than opening an empty db.
  if (!fs.existsSync(config.databasePath)) {
    console.error(
      `Report NOT RUN: no database found at ${config.databasePath}.\n` +
        'Ingest some news first (scripts/ingestAlpacaNewsOnce.js) or run migrations.'
    );
    process.exit(1);
  }

  let db;
  try {
    db = openDatabase(config.databasePath);
    const tables = listTables(db);
    if (!tables.includes('news_events') || !tables.includes('price_reactions')) {
      console.error(
        'Report NOT RUN: the database has no event-study tables yet.\n' +
          'Run migrations (npm run migrate) and ingest/measure some events first.'
      );
      process.exitCode = 1;
      return;
    }
    const summary = collectSummary(db, { recentLimit });
    for (const line of buildSummaryReport(summary)) console.log(line);
  } catch (err) {
    console.error(`Report FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
