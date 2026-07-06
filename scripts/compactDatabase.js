// scripts/compactDatabase.js — MANUAL data retention so the database can learn
// forever without bloating.
//
//   Preview (default; changes NOTHING):
//     node scripts/compactDatabase.js
//   Apply the compaction:
//     node scripts/compactDatabase.js --apply [--days 90] [--vacuum]
//
// What it compacts (older than the cutoff, default RETENTION_RAW_DAYS=90):
// - news_events.raw_payload      -> NULL   (audit copy of provider JSON)
// - sentiment_scores.raw_response-> NULL   (audit copy of raw model output)
// - paper_broker_account_snapshots rows DELETED (baseline lookups are same-day
//   only; daily performance persists in paper_strategy_performance_snapshots)
//
// What it NEVER touches (the learning evidence is immortal):
// - paper_trades, rejected_trades, price_reactions,
//   paper_equity_sizing_decisions, paper_strategy_performance_snapshots,
//   paper_runtime_sessions, risk_state
// - news_events / sentiment_scores ROWS (columns are nulled, rows stay).

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';

export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 7;

export function resolveRetentionDays({ cliDays = null, envDays = null } = {}) {
  const parse = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const days = parse(cliDays) ?? parse(envDays) ?? DEFAULT_RETENTION_DAYS;
  return Math.max(days, MIN_RETENTION_DAYS);
}

export function cutoffIso(days, nowMs = Date.now()) {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

export function parseArgs(argv) {
  const args = { apply: false, days: null, vacuum: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--vacuum') args.vacuum = true;
    else if (flag === '--days' && argv[i + 1]) { args.days = argv[i + 1]; i += 1; }
    else if (flag === '--dry-run') args.apply = false;
  }
  return args;
}

/**
 * Compact old raw/audit data. Dry-run by default: reports would-affect counts
 * and changes nothing unless apply=true.
 */
export function compactDatabase(db, { days = DEFAULT_RETENTION_DAYS, apply = false, nowMs = Date.now() } = {}) {
  const cutoff = cutoffIso(Math.max(days, MIN_RETENTION_DAYS), nowMs);

  const counts = {
    rawPayloads: Number(db.prepare(
      'SELECT COUNT(*) AS n FROM news_events WHERE raw_payload IS NOT NULL AND received_at < ?'
    ).get(cutoff)?.n ?? 0),
    rawResponses: Number(db.prepare(
      'SELECT COUNT(*) AS n FROM sentiment_scores WHERE raw_response IS NOT NULL AND created_at < ?'
    ).get(cutoff)?.n ?? 0),
    accountSnapshots: Number(db.prepare(
      'SELECT COUNT(*) AS n FROM paper_broker_account_snapshots WHERE snapshot_at < ?'
    ).get(cutoff)?.n ?? 0),
  };

  if (apply) {
    db.prepare('UPDATE news_events SET raw_payload = NULL WHERE raw_payload IS NOT NULL AND received_at < ?').run(cutoff);
    db.prepare('UPDATE sentiment_scores SET raw_response = NULL WHERE raw_response IS NOT NULL AND created_at < ?').run(cutoff);
    db.prepare('DELETE FROM paper_broker_account_snapshots WHERE snapshot_at < ?').run(cutoff);
  }

  return { cutoff, days: Math.max(days, MIN_RETENTION_DAYS), applied: apply, counts };
}

export function reportLines(result) {
  const verb = result.applied ? 'compacted' : 'would compact';
  return [
    `Database compaction ${result.applied ? 'APPLIED' : 'DRY RUN (pass --apply to execute)'}`,
    `  retention:  ${result.days} day(s); cutoff ${result.cutoff}`,
    `  ${verb}: news_events.raw_payload nulled          ${result.counts.rawPayloads}`,
    `  ${verb}: sentiment_scores.raw_response nulled    ${result.counts.rawResponses}`,
    `  ${verb}: paper_broker_account_snapshots deleted  ${result.counts.accountSnapshots}`,
    '  evidence tables untouched: paper_trades, rejected_trades, price_reactions,',
    '  paper_equity_sizing_decisions, paper_strategy_performance_snapshots,',
    '  paper_runtime_sessions, risk_state.',
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const days = resolveRetentionDays({ cliDays: args.days, envDays: process.env.RETENTION_RAW_DAYS });

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db);
    const result = compactDatabase(db, { days, apply: args.apply });
    for (const line of reportLines(result)) console.log(line);
    if (args.apply && args.vacuum) {
      db.exec('VACUUM');
      console.log('  VACUUM complete (file space reclaimed).');
    }
  } catch (err) {
    console.error(`Compaction FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
