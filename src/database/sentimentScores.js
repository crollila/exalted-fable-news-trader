// src/database/sentimentScores.js — Writer/reader for sentiment_scores.
//
// Persists ClassificationResult objects (src/sentiment/) per the mapping in
// docs/sentiment-storage-plan.md §5. Fixture-only inputs today: nothing in
// this module (or anywhere) calls a model or provider API.
//
// Failures are data: malformed/missing/invalid/model_error results store a
// row with NULL scores and their parser_status, so model drift and parser
// bugs are measurable. The raw model response is always preserved.

import { assertClassificationResult, PARSER_STATUS } from '../sentiment/classifierContract.js';

const OK_STATUSES = new Set([PARSER_STATUS.PARSED, PARSER_STATUS.FALLBACK_USED]);

const INSERT_SQL = `
  INSERT INTO sentiment_scores
    (news_event_id, model, prompt_version, sentiment_score, news_type,
     confidence, raw_response, parse_ok, parser_status, impact_score,
     direction, time_horizon, detail)
  VALUES
    (@news_event_id, @model, @prompt_version, @sentiment_score, @news_type,
     @confidence, @raw_response, @parse_ok, @parser_status, @impact_score,
     @direction, @time_horizon, @detail)
`;

/**
 * Insert one classification result for a news event.
 *
 * @param {object} db  open database handle (from src/database/db.js)
 * @param {number} newsEventId  existing news_events.id (FK enforced)
 * @param {import('../sentiment/classifierContract.js').ClassificationResult} result
 * @returns {{ id: number }}
 * @throws on invalid caller input (bad result shape, missing prompt version,
 *   bad newsEventId, unknown news_event_id via FK). Model-output problems do
 *   NOT throw — they arrive encoded in parser_status and are stored as data.
 */
export function insertSentimentScore(db, newsEventId, result) {
  if (!Number.isInteger(newsEventId) || newsEventId <= 0) {
    throw new Error(`insertSentimentScore: newsEventId must be a positive integer, got ${newsEventId}`);
  }
  // Contract gate: throws on structural problems (missing promptVersion/
  // modelName, invalid parserStatus, missing rawModelResponse, output/status
  // mismatch). This is the caller-bug path, and it fails loudly.
  assertClassificationResult(result);

  const output = result.output; // null unless parsed/fallback_used
  const run = db.prepare(INSERT_SQL).run({
    news_event_id: newsEventId,
    model: result.modelName,
    prompt_version: result.promptVersion,
    sentiment_score: output ? output.sentimentScore : null,
    news_type: output ? output.newsType : null,
    confidence: output ? output.confidence : null,
    raw_response: result.rawModelResponse, // always, byte-for-byte
    parse_ok: OK_STATUSES.has(result.parserStatus) ? 1 : 0, // derived
    parser_status: result.parserStatus,
    impact_score: output ? output.impactScore : null,
    direction: output ? output.direction : null,
    time_horizon: output ? output.timeHorizon : null,
    detail: JSON.stringify({
      affected_symbols: output ? output.affectedSymbols : [],
      rationale: output ? output.rationale : null,
      errors: result.errors,
    }),
  });
  return { id: Number(run.lastInsertRowid) };
}

/** Get one sentiment score row by id, with detail parsed. Null if absent. */
export function getSentimentScoreById(db, id) {
  const row = db.prepare('SELECT * FROM sentiment_scores WHERE id = ?').get(id) ?? null;
  if (!row) return null;
  return { ...row, detail: row.detail === null ? null : JSON.parse(row.detail) };
}

/** List all score rows for a news event (oldest first), detail parsed. */
export function listSentimentScoresForEvent(db, newsEventId) {
  return db
    .prepare('SELECT * FROM sentiment_scores WHERE news_event_id = ? ORDER BY id')
    .all(newsEventId)
    .map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

/** Count rows by parser_status (diagnostics/research helper). */
export function countSentimentScoresByStatus(db) {
  const rows = db
    .prepare('SELECT parser_status, COUNT(*) AS n FROM sentiment_scores GROUP BY parser_status')
    .all();
  return Object.fromEntries(rows.map((r) => [r.parser_status, Number(r.n)]));
}
