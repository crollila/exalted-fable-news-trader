// scripts/classifyNewsOnce.js — MANUAL capped one-shot classification/scoring
// over EXISTING news_events, using a DETERMINISTIC local manual classifier
// (NO model, NO network, NO keys). Phase B step.
//
//   Run:  node --env-file=.env scripts/classifyNewsOnce.js [--limit 1] [--ids 1,2,3]
//   (the .env is only used to resolve DATABASE_URL; NO credentials needed.)
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked selection + classification, then exit. No polling, no
//   scheduling, no background jobs.
// - Reuses the EXISTING path end to end: createFixtureClassifier (with an
//   injected DETERMINISTIC local responder) → classifyAndStore() →
//   insertSentimentScore(). No separate write path, no schema change, no
//   parser/storage semantics change. Reruns are idempotent: an event already
//   scored by this (model, prompt_version) is skipped.
// - DEFAULT CLASSIFIER IS NOT A MODEL. It is a neutral, deterministic baseline
//   that emits a structurally-valid score (sentiment/impact/confidence = 0,
//   direction = "unclear"). It exists to prove the loop carries a score
//   alongside the price reaction — it is a placeholder, NOT trading signal.
//   A real model client remains a later, separately-approved phase.
// - SANITIZED OUTPUT ONLY: selected/classified/stored/skipped/failed counts,
//   parser_status counts, model, and prompt_version. Never raw news payloads,
//   raw model responses, keys, headers, or request objects.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import { NEWS_TYPES } from '../src/sentiment/classifierContract.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';

/** Tiny manual sample only. Default 1 event; never more than the hard cap. */
export const DEFAULT_CLASSIFY_LIMIT = 1;
export const MAX_CLASSIFY_LIMIT = 5;

/** Identity of the deterministic manual scorer. Distinct from a future model. */
export const MANUAL_MODEL_NAME = 'manual_baseline';
export const MANUAL_PROMPT_VERSION = 'manual_v1';

/**
 * Deterministic, model-free responder for one news_events row. Returns raw
 * JSON text exactly as the parser expects (parseModelResponse parses it). It
 * is intentionally NEUTRAL: zero sentiment/impact/confidence and an "unclear"
 * direction, so it never fabricates edge. Reads ONLY whitelisted row fields
 * (ticker, news_type); never echoes headlines, bodies, or raw payloads.
 *
 * @param {object} event  a news_events row
 * @returns {string} raw model-response JSON text
 */
export function manualBaselineResponse(event) {
  const ticker =
    typeof event?.ticker === 'string' && event.ticker.trim() !== ''
      ? event.ticker.trim().toUpperCase()
      : null;
  const newsType = NEWS_TYPES.includes(event?.news_type) ? event.news_type : 'other';
  return JSON.stringify({
    news_type: newsType,
    sentiment_score: 0,
    impact_score: 0,
    confidence: 0,
    direction: 'unclear',
    affected_symbols: ticker ? [ticker] : [],
    rationale: 'manual baseline: neutral placeholder (no model, deterministic)',
  });
}

/**
 * Build the deterministic manual classifier. It wraps the existing fixture
 * classifier with the local responder above — so it goes through the exact
 * same contract/parser/storage path as any other classifier, but cannot call
 * a model or touch the network.
 */
export function buildManualClassifier({
  modelName = MANUAL_MODEL_NAME,
  promptVersion = MANUAL_PROMPT_VERSION,
} = {}) {
  return createFixtureClassifier({ modelName, promptVersion, respond: manualBaselineResponse });
}

/**
 * Parse minimal CLI args: --limit N --ids 1,2,3. Exported for tests. The limit
 * is always clamped to [1, MAX_CLASSIFY_LIMIT]; explicit ids are deduped, kept
 * in order, and truncated to the same hard cap. The cap can never be exceeded.
 */
export function parseArgs(argv) {
  const args = { limit: DEFAULT_CLASSIFY_LIMIT, ids: null };
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
  args.limit = Math.min(Math.max(args.limit, 1), MAX_CLASSIFY_LIMIT);
  if (args.ids) args.ids = args.ids.slice(0, MAX_CLASSIFY_LIMIT);
  return args;
}

/**
 * Select a tiny capped set of EXISTING news_events rows to classify. Without
 * explicit ids, only rows that are NOT YET scored by this (model,
 * prompt_version) are returned, so reruns naturally pick up fresh events.
 * With explicit ids, those rows are returned (capped, id order) and
 * classifyAndStore skips any already scored. Selection is read-only.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.limit  effective cap (clamped here too)
 * @param {number[]|null} [opts.ids]
 * @param {string} [opts.modelName]
 * @param {string} [opts.promptVersion]
 * @returns {object[]} news_events rows
 */
export function selectUnscoredEvents(
  db,
  { limit, ids, modelName = MANUAL_MODEL_NAME, promptVersion = MANUAL_PROMPT_VERSION } = {}
) {
  const cap = Math.min(
    Math.max(Number.isInteger(limit) ? limit : DEFAULT_CLASSIFY_LIMIT, 1),
    MAX_CLASSIFY_LIMIT
  );
  if (ids && ids.length > 0) {
    const capped = ids.slice(0, cap);
    const placeholders = capped.map(() => '?').join(', ');
    return db
      .prepare(`SELECT * FROM news_events WHERE id IN (${placeholders}) ORDER BY id ASC`)
      .all(...capped);
  }
  return db
    .prepare(
      `SELECT * FROM news_events n
        WHERE NOT EXISTS (
          SELECT 1 FROM sentiment_scores s
           WHERE s.news_event_id = n.id AND s.model = ? AND s.prompt_version = ?
        )
        ORDER BY received_at ASC, id ASC
        LIMIT ?`
    )
    .all(modelName, promptVersion, cap);
}

/** Truncate display text; never used on secrets (none reach this module). */
function truncate(text, max = 160) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Build the sanitized classification report as printable lines. Whitelist
 * only: model, prompt_version, selected/classified/stored/skipped/failed
 * counts, parser_status counts, and truncated per-event error messages. The
 * classifyAndStore summary holds no raw payloads or model responses, and
 * nothing else is rendered here by construction.
 */
export function buildClassifyReport(summary, { selectedCount, model, promptVersion } = {}) {
  const statusEntries = Object.entries(summary?.statusCounts ?? {});
  const statusLine =
    statusEntries.length > 0
      ? statusEntries
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([status, n]) => `${status}=${n}`)
          .join('  ')
      : '(none)';
  const lines = [
    `Manual classification via model "${model ?? '?'}" prompt "${promptVersion ?? '?'}"`,
    `  selected:   ${selectedCount ?? 0} event(s)`,
    `  classified: ${summary?.classified ?? 0}`,
    `  stored:     ${summary?.stored ?? 0}`,
    `  skipped:    ${summary?.skipped ?? 0}`,
    `  failed:     ${summary?.failed ?? 0}`,
    `  statuses:   ${statusLine}`,
  ];
  for (const e of summary?.errors ?? []) {
    lines.push(`  - error [event ${e.newsEventId ?? '?'}]: ${truncate(e.error)}`);
  }
  if ((selectedCount ?? 0) === 0) {
    lines.push('  (no eligible news_events rows — ingest some events first, or all are already scored)');
  }
  return lines;
}

async function main() {
  const { limit, ids } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures news_events + sentiment_scores exist

    const classifier = buildManualClassifier();
    const events = selectUnscoredEvents(db, {
      limit,
      ids,
      modelName: classifier.modelName,
      promptVersion: classifier.promptVersion,
    });

    const summary = await classifyAndStore(db, classifier, { eventIds: events.map((r) => r.id) });
    for (const line of buildClassifyReport(summary, {
      selectedCount: events.length,
      model: classifier.modelName,
      promptVersion: classifier.promptVersion,
    })) {
      console.log(line);
    }
    if (summary.failed === 0) {
      console.log('Classification COMPLETE (rows written through insertSentimentScore).');
    } else {
      console.log('Classification completed WITH FAILURES (see per-event errors above).');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Classification FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

// CLI guard: importing this module (e.g. from tests) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
