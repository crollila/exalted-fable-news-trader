// scripts/listMeasurementCandidates.js — MANUAL read-only finder for good
// price-reaction measurement candidates.
//
//   Run:  node --env-file=.env scripts/listMeasurementCandidates.js [--limit 10] \
//           [--ticker AAPL] [--all]
//   (the .env is only used to resolve DATABASE_URL; NO credentials needed.)
//
// WHY: measured returns only appear when an event's window overlaps real
// trading. Past manual runs picked events blindly and produced all-no_baseline
// rows. This helper ranks EXISTING news_events by how likely a measurement is
// to yield a measured return, and prints a ready-to-paste measure command — so
// the loop toward real measured returns is repeatable.
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI. One
//   human-invoked read, then exit. No polling, no scheduling, no background jobs.
// - READ-ONLY: opens the configured SQLite file and runs SELECTs only. It never
//   writes, never runs migrations, never measures, and never makes a network
//   call. No credentials are required (it reads local rows, not any API).
// - NO TRADING, NO MODEL CALLS, NO MARKET-DATA CALLS. It only suggests the
//   existing scripts/measureReactionsOnce.js command; it never runs it.
// - SANITIZED / PASTE-SAFE OUTPUT: per candidate it prints only event id,
//   ticker, provider, received_at, an Eastern-time label, a market-hours flag,
//   whether a real-model (model_v1) score exists, whether it is already
//   measured, and its price_reactions status counts. It NEVER prints headlines,
//   bodies, raw_payload, raw model responses, keys, or any free-text content.
//
// MARKET-HOURS APPROXIMATION: an event's received_at is "market hours" when it
// falls Mon-Fri, 09:30-16:00 America/New_York (DST handled by Intl). This is an
// APPROXIMATION ONLY — it ignores market holidays and half-days. A real session
// calendar is deferred to the market-data client's later session-calendar step
// (docs/market-data-client-plan.md / docs/event-study-plan.md §3).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase, listTables } from '../src/database/db.js';
import { MEASUREMENT_STATUS } from '../src/database/priceReactions.js';
import { MODEL_PROMPT_VERSION } from '../src/sentiment/modelClassifier.js';
import { MAX_MEASURE_LIMIT } from './measureReactionsOnce.js';

/** Candidate list is a small sample, never a full dump. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** US regular session bounds in Eastern minutes-of-day: [09:30, 16:00). */
export const MARKET_OPEN_MINUTE = 9 * 60 + 30;
export const MARKET_CLOSE_MINUTE = 16 * 60;

/** The most ids the suggested combined command may list (measure script cap). */
export const MAX_SUGGESTED_IDS = MAX_MEASURE_LIMIT;

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Decompose a UTC ISO timestamp into Eastern-time parts (DST handled by Intl).
 * Returns null for an unparseable timestamp.
 * @param {string} iso
 * @returns {{ weekday: string, hour: number, minute: number, minutesOfDay: number }|null}
 */
export function easternParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    ET_FORMAT.formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  const hour = Number.parseInt(parts.hour, 10);
  const minute = Number.parseInt(parts.minute, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { weekday: parts.weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

function marketHoursFromParts(parts) {
  return (
    !!parts &&
    WEEKDAYS.has(parts.weekday) &&
    parts.minutesOfDay >= MARKET_OPEN_MINUTE &&
    parts.minutesOfDay < MARKET_CLOSE_MINUTE
  );
}

/**
 * True when a UTC ISO timestamp falls within the US regular-session
 * approximation (Mon-Fri 09:30-16:00 ET). Holidays/half-days are NOT modeled.
 */
export function isMarketHours(iso) {
  return marketHoursFromParts(easternParts(iso));
}

/**
 * Parse minimal CLI args. Exported for tests.
 *   --limit N   cap on listed candidates (default 10, hard max 50)
 *   --ticker S  restrict to one uppercase ticker
 *   --all       list every eligible event (default lists only market-hours,
 *               not-yet-measured candidates)
 */
export function parseArgs(argv) {
  const args = { limit: DEFAULT_LIMIT, ticker: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) args.limit = Math.min(n, MAX_LIMIT);
      i += 1;
    } else if (argv[i] === '--ticker' && argv[i + 1]) {
      args.ticker = argv[i + 1].trim().toUpperCase() || null;
      i += 1;
    } else if (argv[i] === '--all') {
      args.all = true;
    }
  }
  return args;
}

/**
 * Collect ranked measurement candidates with read-only SELECTs. Eligible rows
 * have both ticker and received_at (the engine needs both to anchor a window).
 * Reads ONLY whitelisted columns — never headline, body, raw_payload, or
 * raw_response.
 *
 * Default (all=false) keeps only market-hours, not-yet-successfully-measured
 * events. --all keeps every eligible event. Either way the list is ranked
 * best-first: market-hours, then unmeasured, then newest received_at.
 *
 * @param {object} db  open database handle
 * @param {object} [opts]
 * @param {number} [opts.limit]  cap on returned candidates
 * @param {string|null} [opts.ticker]  uppercase ticker filter
 * @param {boolean} [opts.all]  include off-hours and already-measured events
 */
export function collectCandidates(db, { limit = DEFAULT_LIMIT, ticker = null, all = false } = {}) {
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const tickerFilter = ticker ? String(ticker).toUpperCase() : null;

  const eligible = tickerFilter
    ? db
        .prepare(
          `SELECT id, ticker, provider, received_at FROM news_events
            WHERE ticker = ? AND ticker IS NOT NULL AND received_at IS NOT NULL
            ORDER BY received_at DESC, id DESC`
        )
        .all(tickerFilter)
    : db
        .prepare(
          `SELECT id, ticker, provider, received_at FROM news_events
            WHERE ticker IS NOT NULL AND received_at IS NOT NULL
            ORDER BY received_at DESC, id DESC`
        )
        .all();

  // Events scored by the real model classifier (prompt_version = model_v1).
  const modelV1Ids = new Set(
    db
      .prepare('SELECT DISTINCT news_event_id AS id FROM sentiment_scores WHERE prompt_version = ?')
      .all(MODEL_PROMPT_VERSION)
      .map((r) => r.id)
  );

  // price_reactions status counts per event, gathered in one pass.
  const reactionsByEvent = new Map();
  for (const r of db
    .prepare(
      `SELECT news_event_id AS id, measurement_status AS status, COUNT(*) AS n
         FROM price_reactions GROUP BY news_event_id, measurement_status`
    )
    .all()) {
    if (!reactionsByEvent.has(r.id)) reactionsByEvent.set(r.id, {});
    reactionsByEvent.get(r.id)[r.status] = Number(r.n);
  }

  const rows = eligible.map((e) => {
    const reactionCounts = reactionsByEvent.get(e.id) ?? {};
    const parts = easternParts(e.received_at);
    return {
      id: e.id,
      ticker: e.ticker,
      provider: e.provider,
      receivedAt: e.received_at,
      et: parts ? `${pad2(parts.hour)}:${pad2(parts.minute)} ${parts.weekday}` : null,
      marketHours: marketHoursFromParts(parts),
      hasModelV1: modelV1Ids.has(e.id),
      measured: (reactionCounts[MEASUREMENT_STATUS.MEASURED] ?? 0) > 0,
      reactionCounts,
    };
  });

  const filtered = all ? rows : rows.filter((r) => r.marketHours && !r.measured);
  filtered.sort(
    (a, b) =>
      Number(b.marketHours) - Number(a.marketHours) ||
      Number(a.measured) - Number(b.measured) ||
      b.receivedAt.localeCompare(a.receivedAt) ||
      a.id - b.id
  );

  return {
    scanned: eligible.length,
    marketHoursOnly: !all,
    ticker: tickerFilter,
    candidates: filtered.slice(0, cap),
  };
}

/** Render an event's price_reactions status counts in canonical order, or "none". */
function formatReactionCounts(counts) {
  const keys = Object.values(MEASUREMENT_STATUS).filter((k) => k in counts);
  if (keys.length === 0) return 'none';
  return keys.map((k) => `${k}=${counts[k]}`).join(' ');
}

/**
 * Build the sanitized, paste-safe candidate report as printable lines. Reads
 * ONLY the whitelisted fields produced by collectCandidates; any extra fields
 * smuggled onto a candidate are ignored.
 */
export function buildCandidatesReport(result) {
  const lines = [
    'ExaltedFable measurement candidates (local DB, read-only)',
    `  scanned:    ${result.scanned} event(s) with ticker + received_at` +
      `${result.ticker ? ` (ticker ${result.ticker})` : ''}`,
    `  filter:     ${
      result.marketHoursOnly ? 'market-hours, not-yet-measured candidates' : 'all eligible (--all)'
    }`,
    `  candidates: ${result.candidates.length}`,
  ];

  for (const c of result.candidates) {
    lines.push(
      `  - event ${c.id} ${c.ticker} [${c.provider}]  received ${c.receivedAt}` +
        `${c.et ? ` (ET ${c.et})` : ''}  market_hours=${c.marketHours ? 'yes' : 'no'}` +
        `  model_v1=${c.hasModelV1 ? 'yes' : 'no'}  measured=${c.measured ? 'yes' : 'no'}` +
        `  reactions: ${formatReactionCounts(c.reactionCounts)}`,
      `      measure: node --env-file=.env scripts/measureReactionsOnce.js --ids ${c.id}`
    );
  }

  if (result.candidates.length === 0) {
    lines.push(
      result.scanned === 0
        ? '  (no eligible news_events rows — ingest some real events first)'
        : '  (no market-hours, unmeasured candidates — try --all to list every eligible event)'
    );
  } else {
    const ids = result.candidates.slice(0, MAX_SUGGESTED_IDS).map((c) => c.id);
    lines.push(
      '',
      `  measure top ${ids.length}: node --env-file=.env scripts/measureReactionsOnce.js --ids ${ids.join(',')}`
    );
  }
  return lines;
}

async function main() {
  const { limit, ticker, all } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Read-only: do not create a database. If the file is absent there is nothing
  // to list — say so clearly rather than opening an empty db.
  if (!fs.existsSync(config.databasePath)) {
    console.error(
      `Candidates NOT LISTED: no database found at ${config.databasePath}.\n` +
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
        'Candidates NOT LISTED: the database has no event-study tables yet.\n' +
          'Run migrations (npm run migrate) and ingest some events first.'
      );
      process.exitCode = 1;
      return;
    }
    const result = collectCandidates(db, { limit, ticker, all });
    for (const line of buildCandidatesReport(result)) console.log(line);
  } catch (err) {
    console.error(`Candidates FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
