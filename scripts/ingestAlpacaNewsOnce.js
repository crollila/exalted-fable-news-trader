// scripts/ingestAlpacaNewsOnce.js — MANUAL one-shot live Alpaca News ingest.
// Persists a tiny capped sample of real Alpaca news into news_events.
//
//   Run:  node --env-file=.env scripts/ingestAlpacaNewsOnce.js [--symbols AAPL,MSFT] [--limit 5]
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked fetch, one batch of inserts, then exit. No polling,
//   no scheduling, no background jobs.
// - Reuses the EXISTING path end to end: explicit
//   createAlpacaNewsHttpTransport(config) → createAlpacaNewsProvider →
//   ingestNews() → insertNewsEvent() → news_events. No separate persistence
//   path; dedup by (provider, provider_event_id) applies as everywhere else.
// - Database: opens the configured SQLite file (config.databasePath from
//   DATABASE_URL) via the existing openDatabase/runMigrations utilities.
// - Credentials ONLY via loadConfig() (src/config.js); this file never reads
//   process.env. Use --env-file=.env (built into Node) to load your .env.
// - SANITIZED OUTPUT ONLY: provider name, counts, inserted row ids, database
//   path, and truncated per-event error messages. Never keys, auth headers,
//   request objects, raw transport errors, or raw payloads.
// - Limit hard-capped at MAX_INGEST_LIMIT (10) via the shared parseArgs.
// - NO sentiment/classification, NO sentiment_scores writes, NO price client,
//   NO price_reactions writes, NO trading, NO paper orders.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createAlpacaNewsHttpTransport } from '../src/providers/alpacaNewsHttpTransport.js';
import { createAlpacaNewsProvider } from '../src/providers/alpacaNewsProvider.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { ingestNews } from '../src/ingestion/ingestNews.js';
// Shared, network-free helpers from the smoke script (its CLI guard makes
// this import side-effect free). Same defaults, same tiny-sample cap.
import { truncate, parseArgs, MAX_SMOKE_LIMIT } from './smokeAlpacaNews.js';

export const MAX_INGEST_LIMIT = MAX_SMOKE_LIMIT; // 10 — tiny manual samples only

/**
 * Format the ingestNews() summary as sanitized printable lines.
 * Whitelist only: provider, counts, inserted ids, database path, and
 * truncated error fields (headline / provider event id / message). The
 * summary contains no raw payloads, keys, or request objects by design,
 * and nothing else is ever rendered here.
 */
export function buildIngestReport(summary, { databasePath } = {}) {
  const lines = [
    `Alpaca News one-shot ingest via provider "${summary.provider}"`,
  ];
  if (databasePath) lines.push(`  database:     ${databasePath}`);
  lines.push(
    `  fetched:      ${summary.fetched}`,
    `  inserted:     ${summary.inserted}`,
    `  duplicates:   ${summary.duplicates}`,
    `  failed:       ${summary.failed}`,
    `  inserted ids: ${summary.insertedIds.length > 0 ? summary.insertedIds.join(', ') : '(none)'}`
  );
  for (const e of summary.errors) {
    lines.push(
      `  - error [id: ${truncate(e.providerEventId ?? '?', 40)}] ` +
        `${truncate(e.headline ?? '(no headline)', 60)}: ${truncate(e.error, 160)}`
    );
  }
  if (summary.fetched === 0) {
    lines.push('  (zero events returned — try different symbols or a wider window)');
  }
  return lines;
}

async function main() {
  const { symbols, limit } = parseArgs(process.argv.slice(2)); // capped at MAX_INGEST_LIMIT
  const config = loadConfig();

  if (!config.alpacaNews.keyId || !config.alpacaNews.secretKey) {
    console.error(
      'Ingest NOT RUN: Alpaca News is not configured.\n' +
        'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your local .env\n' +
        '(see .env.example) and run with:  node --env-file=.env scripts/ingestAlpacaNewsOnce.js'
    );
    process.exit(1);
  }

  let db;
  try {
    // Explicit construction — the only way a real transport is ever enabled.
    const transport = createAlpacaNewsHttpTransport(config);
    const provider = createAlpacaNewsProvider({ fetchRawNews: transport });

    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures news_events exists

    const summary = await ingestNews(db, provider, { symbols, limit });
    for (const line of buildIngestReport(summary, { databasePath: config.databasePath })) {
      console.log(line);
    }
    if (summary.failed === 0) {
      console.log('Ingest PASSED (real events persisted through the existing pipeline).');
    } else {
      console.log('Ingest completed WITH FAILURES (see per-event errors above).');
      process.exitCode = 1;
    }
  } catch (err) {
    // Transport errors are sanitized/key-redacted at the source; print the
    // message only, never the error object (it could embed request config).
    console.error(`Ingest FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
