// scripts/updateStrategySettingsFromLearning.js — MANUAL learning-based strategy
// update. Reads recent paper outcomes + current strategy settings and recommends
// conservative, BOUNDED changes to data/strategy-settings.json (NON-SECRET).
//
//   Dry run (default; writes nothing):
//     node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100
//
//   Write the runtime strategy file (ONLY data/strategy-settings.json):
//     node --env-file=.env scripts/updateStrategySettingsFromLearning.js --limit 100 --write
//
// - DRY RUN BY DEFAULT. --write writes ONLY data/strategy-settings.json.
// - NEVER edits .env / .env.example / any secret. Never enables live trading.
// - Notes are APPENDED (deduped + capped) to avoid file bloat.
// - READ-ONLY over the DB; sanitized output only; no network/model/order calls.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { collectEodData, currentConstraintsFromConfig } from './sendPaperEodReport.js';
import {
  loadStrategySettings, writeStrategySettings, appendNotes, RUNTIME_SETTINGS_PATH,
} from '../src/config/strategySettings.js';
import {
  buildStrategyRecommendations, applyStrategyChanges, changesToNotes, formatStrategySection,
} from '../src/paper/strategyLearning.js';
import { buildConstraintRecommendations, formatRecommendationsSection } from '../src/paper/constraintRecommendations.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MIN_SAMPLE = 10;

/** Parse CLI args. Exported for tests. Dry-run is the default. */
export function parseArgs(argv) {
  const args = {
    limit: DEFAULT_LIMIT, write: false, settingsPath: null,
    minSampleSize: DEFAULT_MIN_SAMPLE, includeEnv: false, format: 'text',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--limit' && next) { const n = Number.parseInt(next, 10); if (Number.isInteger(n) && n > 0) args.limit = Math.min(n, MAX_LIMIT); i += 1; }
    else if (flag === '--write') { args.write = true; }
    else if (flag === '--dry-run') { args.write = false; }
    else if (flag === '--settings-path' && next) { args.settingsPath = next; i += 1; }
    else if (flag === '--min-sample-size' && next) { const n = Number.parseInt(next, 10); if (Number.isInteger(n) && n > 0) args.minSampleSize = n; i += 1; }
    else if (flag === '--include-env-recommendations') { args.includeEnv = true; }
    else if (flag === '--format' && next) { if (next === 'json' || next === 'text') args.format = next; i += 1; }
  }
  return args;
}

/**
 * Core update logic, dependency-injected (fs) so tests never touch disk and the
 * write path can be exercised offline. NEVER writes .env.
 */
export function runStrategyUpdate(db, {
  config, write = false, settingsPath = null, minSampleSize = DEFAULT_MIN_SAMPLE,
  includeEnv = false, fsImpl = fs, now,
} = {}) {
  const data = collectEodData(db, { day: null });
  const { settings, notes, source } = loadStrategySettings({ runtimePath: settingsPath ?? undefined, fsImpl });
  const strat = buildStrategyRecommendations({ data, settings, minSampleSize });
  const envRecs = includeEnv
    ? buildConstraintRecommendations({ data, current: currentConstraintsFromConfig(config) }).recommendations
    : [];

  let written = false;
  let writtenPath = null;
  if (write && strat.changes.length > 0) {
    const newSettings = applyStrategyChanges(settings, strat.changes);
    const newNotes = appendNotes(notes, changesToNotes(strat.changes, { now }));
    const res = writeStrategySettings({
      path: settingsPath ?? RUNTIME_SETTINGS_PATH, settings: newSettings, notes: newNotes, fsImpl, now,
    });
    written = true;
    writtenPath = res.path;
  }
  return { data, settings, settingsSource: source, strat, envRecs, written, writtenPath };
}

/** Build the sanitized text report. */
export function buildUpdateReport(result, { mode }) {
  const { strat, envRecs, settingsSource, written, writtenPath } = result;
  const lines = [
    `ExaltedFable — strategy learning update (${mode})`,
    `  settings source: ${settingsSource}`,
    `  samples: ${strat.analysis.sampleSize} (wins ${strat.analysis.winningTrades} / losses ${strat.analysis.losingTrades}), ` +
      `orders ${strat.analysis.ordersSubmitted}, rejections ${strat.analysis.rejectedCount}`,
    '',
    ...formatStrategySection(strat),
  ];
  if (envRecs && envRecs.length >= 0) {
    lines.push('', ...formatRecommendationsSection(envRecs));
  }
  lines.push(
    '',
    `  written: ${written ? `yes -> ${writtenPath} (data file only)` : 'no (dry run)'}`,
    '  .env was not edited.'
  );
  return lines;
}

/** Build the JSON report object (sanitized). */
export function buildUpdateJson(result, { mode }) {
  return {
    mode,
    settingsSource: result.settingsSource,
    analysis: result.strat.analysis,
    changes: result.strat.changes,
    researchFocus: result.strat.researchFocus,
    envRecommendations: result.envRecs,
    written: result.written,
    writtenPath: result.writtenPath,
    envEdited: false,
  };
}

async function main() {
  const { write, settingsPath, minSampleSize, includeEnv, format } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const mode = write ? 'write' : 'dry-run';

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);
    const result = runStrategyUpdate(db, { config, write, settingsPath, minSampleSize, includeEnv });
    if (format === 'json') {
      console.log(JSON.stringify(buildUpdateJson(result, { mode }), null, 2));
    } else {
      for (const line of buildUpdateReport(result, { mode })) console.log(line);
    }
  } catch (err) {
    console.error(`Strategy update FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
