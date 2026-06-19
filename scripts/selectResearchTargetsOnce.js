// scripts/selectResearchTargetsOnce.js — MANUAL research-target selection.
//
//   node --env-file=.env scripts/selectResearchTargetsOnce.js --symbols AAPL,MSFT,NVDA --limit 10
//   node --env-file=.env scripts/selectResearchTargetsOnce.js --symbols AAPL --format json
//
// SELECTION-ONLY: chooses which APPROVED, allow-listed sources to research next,
// based on the symbols and the day's trading signals. It performs NO network
// calls and NEVER fetches/scrapes anything in this patch. Gated sources
// (disabled/paywalled/auth-required) are never selected. --fetch is refused.
//
// - READ-ONLY over the DB (for topic hints); sanitized output only.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { collectEodData } from './sendPaperEodReport.js';
import { loadStrategySettings } from '../src/config/strategySettings.js';
import { buildResearchFocus } from '../src/paper/strategyLearning.js';
import { loadResearchSources, EXAMPLE_SOURCES_PATH } from '../src/research/researchSources.js';
import { selectScrapeTargets, formatTargetsReport } from '../src/research/scrapeTargetSelector.js';

const DEFAULT_LIMIT = 10;

/** Parse CLI args. Exported for tests. Selection-only; --fetch is never honored. */
export function parseArgs(argv) {
  const args = {
    symbols: [], limit: DEFAULT_LIMIT, sourceConfig: EXAMPLE_SOURCES_PATH,
    includeDisabled: false, fetch: false, format: 'text',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--symbols' && next) { args.symbols = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); i += 1; }
    else if (flag === '--limit' && next) { const n = Number.parseInt(next, 10); if (Number.isInteger(n) && n > 0) args.limit = Math.min(n, 50); i += 1; }
    else if (flag === '--source-config' && next) { args.sourceConfig = next; i += 1; }
    else if (flag === '--include-disabled' && next) { args.includeDisabled = String(next).trim().toLowerCase() === 'true'; i += 1; }
    else if (flag === '--fetch' && next) { args.fetch = String(next).trim().toLowerCase() === 'true'; i += 1; }
    else if (flag === '--fetch') { args.fetch = true; }
    else if (flag === '--format' && next) { if (next === 'json' || next === 'text') args.format = next; i += 1; }
  }
  return args;
}

/**
 * Core selection, dependency-injected. Derives topic hints from the day's
 * outcomes (read-only) and selects approved targets. NO network/fetch.
 * @returns {{ result: object, topics: string[], symbols: string[], warnings: string[] }}
 */
export function runSelect(db, { args, fsImpl = fs } = {}) {
  const { sources, warnings } = loadResearchSources({ sourcePath: args.sourceConfig, fsImpl });
  let topics = [];
  let symbols = args.symbols;
  if (db) {
    const data = collectEodData(db, { day: null });
    const { settings } = loadStrategySettings({ fsImpl });
    const rf = buildResearchFocus({ data, settings });
    topics = rf.topicsToResearch;
    symbols = symbols.length > 0 ? symbols : rf.symbolsToResearch;
  }
  const result = selectScrapeTargets({ sources, symbols, topics, limit: args.limit, includeDisabled: args.includeDisabled });
  return { result, topics, symbols, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (args.fetch) {
    console.log('NOTE: --fetch is not supported in this patch (selection-only). Nothing will be fetched.');
  }

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);
    const { result, topics } = runSelect(db, { args });
    if (args.format === 'json') {
      console.log(JSON.stringify({ topics, fetch: false, ...result }, null, 2));
    } else {
      for (const line of formatTargetsReport(result, { includeDisabled: args.includeDisabled })) console.log(line);
      console.log(`  topic hints: ${topics.join(', ') || '(none)'}`);
      console.log('  (selection-only: no source was fetched or scraped.)');
    }
  } catch (err) {
    console.error(`Research target selection FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
