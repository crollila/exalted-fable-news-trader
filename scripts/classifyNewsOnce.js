// scripts/classifyNewsOnce.js — MANUAL capped one-shot classification/scoring
// over EXISTING news_events, using a DETERMINISTIC local manual classifier
// (NO model, NO network, NO keys). Phase B step.
//
//   Run:  node --env-file=.env scripts/classifyNewsOnce.js [--limit 1] \
//           [--ids 1,2,3] [--classifier manual_baseline|real_model]
//   (with the default classifier the .env is only used to resolve
//   DATABASE_URL; NO credentials needed. --classifier real_model additionally
//   needs ANTHROPIC_API_KEY in .env.)
//
// - MANUAL ONLY: never part of npm test, app startup, schedulers, or CI.
//   One human-invoked selection + classification, then exit. No polling, no
//   scheduling, no background jobs.
// - Reuses the EXISTING path end to end: a Classifier → classifyAndStore() →
//   insertSentimentScore(). No separate write path, no schema change, no
//   parser/storage semantics change. Reruns are idempotent: an event already
//   scored by this (model, prompt_version) is skipped.
// - DEFAULT CLASSIFIER (manual_baseline) IS NOT A MODEL. It is a neutral,
//   deterministic baseline that emits a structurally-valid score
//   (sentiment/impact/confidence = 0, direction = "unclear"). It exists to
//   prove the loop carries a score alongside the price reaction — it is a
//   placeholder, NOT trading signal.
// - --classifier real_model is the EXPLICIT, opt-in real model-backed
//   classifier (Anthropic Messages API via createModelClassifier). It is
//   constructed only when requested, reads its key from config only, and is
//   NEVER exercised by npm test. Without ANTHROPIC_API_KEY it fails clearly.
// - SANITIZED OUTPUT ONLY: selected/classified/stored/skipped/failed counts,
//   parser_status counts, model, and prompt_version. Never raw news payloads,
//   raw model responses, keys, headers, or request objects.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrations.js';
import { createFixtureClassifier } from '../src/sentiment/fixtureClassifier.js';
import { createModelClassifier } from '../src/sentiment/modelClassifier.js';
import { NEWS_TYPES } from '../src/sentiment/classifierContract.js';
import { classifyAndStore } from '../src/ingestion/classifyNews.js';

/** Tiny manual sample only. Default 1 event; never more than the hard cap. */
export const DEFAULT_CLASSIFY_LIMIT = 1;
export const MAX_CLASSIFY_LIMIT = 5;

/** Identity of the deterministic manual scorer. Distinct from a future model. */
export const MANUAL_MODEL_NAME = 'manual_baseline';
export const MANUAL_PROMPT_VERSION = 'manual_v1';

/** Explicit classifier selection. Default stays the safe, model-free baseline. */
export const CLASSIFIERS = Object.freeze(['manual_baseline', 'real_model']);
export const DEFAULT_CLASSIFIER = 'manual_baseline';

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
 * Build the requested classifier. The default (manual_baseline) needs no
 * credentials or network. real_model explicitly constructs the real
 * model-backed classifier, which throws a clear "not configured" error if the
 * API key is absent (config-only credentials). Both go through the identical
 * contract/parser/storage path; the only difference is where the score comes
 * from. Exported and reused by the MVP pipeline script.
 *
 * @param {string} name   one of CLASSIFIERS
 * @param {object} config result of loadConfig() (needed for real_model)
 * @returns {import('../src/sentiment/classifierContract.js').Classifier}
 */
export function buildClassifier(name = DEFAULT_CLASSIFIER, config) {
  if (name === 'manual_baseline') return buildManualClassifier();
  if (name === 'real_model') return createModelClassifier(config);
  throw new Error(`unknown classifier "${name}" (choose: ${CLASSIFIERS.join(', ')})`);
}

/**
 * Parse minimal CLI args: --limit N --ids 1,2,3. Exported for tests. The limit
 * is always clamped to [1, MAX_CLASSIFY_LIMIT]; explicit ids are deduped, kept
 * in order, and truncated to the same hard cap. The cap can never be exceeded.
 */
export function parseArgs(argv) {
  const args = { limit: DEFAULT_CLASSIFY_LIMIT, ids: null, classifier: DEFAULT_CLASSIFIER };
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
    } else if (argv[i] === '--classifier' && argv[i + 1]) {
      args.classifier = argv[i + 1].trim();
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
  const { limit, ids, classifier: classifierName } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  let db;
  try {
    db = openDatabase(config.databasePath);
    runMigrations(db); // idempotent; ensures news_events + sentiment_scores exist

    // Default is the model-free baseline; real_model is explicit + opt-in and
    // throws a clear "not configured" error when ANTHROPIC_API_KEY is absent.
    const classifier = buildClassifier(classifierName, config);
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
