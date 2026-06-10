// src/ingestion/classifyNews.js — Optional classification stage (Phase 3).
//
// Separate from ingestNews by design: ingestion never depends on
// classification, and a classification failure can never block or delete a
// news_events row. Fixture/injection-only: the classifier passed in is the
// fixture classifier today; nothing here calls a model or provider API.
//
// Idempotency: an event already scored by the same (model, prompt_version)
// is skipped, so reruns do not duplicate sentiment_scores rows. This is an
// existence check, not a schema constraint — sufficient for the current
// single-process writer (see docs/sentiment-storage-plan.md).

import { validateClassifier } from '../sentiment/classifierContract.js';
import { insertSentimentScore } from '../database/sentimentScores.js';
import { ingestNews } from './ingestNews.js';

const ALREADY_SCORED_SQL = `
  SELECT 1 FROM sentiment_scores
  WHERE news_event_id = ? AND model = ? AND prompt_version = ?
  LIMIT 1
`;

/**
 * Classify already-ingested news events (by explicit ids) and store results.
 *
 * @param {object} db  open database handle
 * @param {import('../sentiment/classifierContract.js').Classifier} classifier
 * @param {object} options
 * @param {number[]} options.eventIds  REQUIRED — explicit news_events ids
 * @returns {Promise<{
 *   requested: number,   // ids passed in
 *   classified: number,  // classifier ran (any parser_status)
 *   stored: number,      // sentiment_scores rows created
 *   skipped: number,     // already scored by this model+prompt, or id not found
 *   failed: number,      // classify/store threw (caller-level errors)
 *   statusCounts: Record<string, number>, // parser_status tallies for stored rows
 *   errors: { newsEventId: number, error: string }[],
 * }>}
 */
export async function classifyAndStore(db, classifier, { eventIds } = {}) {
  validateClassifier(classifier);
  if (!Array.isArray(eventIds)) {
    throw new Error('classifyAndStore: options.eventIds must be an array of news_events ids');
  }

  const summary = {
    requested: eventIds.length,
    classified: 0,
    stored: 0,
    skipped: 0,
    failed: 0,
    statusCounts: {},
    errors: [],
  };

  const getRow = db.prepare('SELECT * FROM news_events WHERE id = ?');
  const alreadyScored = db.prepare(ALREADY_SCORED_SQL);

  for (const id of eventIds) {
    try {
      const row = getRow.get(id);
      if (!row) {
        summary.skipped += 1;
        summary.errors.push({ newsEventId: id, error: 'news event not found' });
        continue;
      }
      if (alreadyScored.get(id, classifier.modelName, classifier.promptVersion)) {
        summary.skipped += 1; // idempotent rerun: no duplicate row
        continue;
      }

      // Classifier contract: never throws on bad model output — failures
      // arrive encoded in parserStatus and are stored as data.
      const result = await classifier.classifyEvent(row);
      summary.classified += 1;

      insertSentimentScore(db, id, result);
      summary.stored += 1;
      summary.statusCounts[result.parserStatus] =
        (summary.statusCounts[result.parserStatus] ?? 0) + 1;
    } catch (err) {
      // Caller-level failure (e.g. writer rejection). Observable, never fatal
      // to the batch, and never touches the news_events row.
      summary.failed += 1;
      summary.errors.push({ newsEventId: id, error: err.message });
    }
  }

  return summary;
}

/**
 * Ingest from a provider, then classify ONLY the newly inserted events.
 * Duplicates skipped by ingestion dedup are not re-classified here; use
 * classifyAndStore with explicit ids to (re)score existing events.
 *
 * Without a classifier this is exactly ingestNews (classification: null).
 *
 * @param {object} db
 * @param {import('../providers/newsProvider.js').NewsProvider} provider
 * @param {object} [options]
 * @param {import('../providers/newsProvider.js').FetchNewsOptions} [options.fetchOptions]
 * @param {import('../sentiment/classifierContract.js').Classifier} [options.classifier]
 * @returns {Promise<{ ingestion: object, classification: object|null }>}
 */
export async function ingestAndClassify(db, provider, { fetchOptions = {}, classifier } = {}) {
  const ingestion = await ingestNews(db, provider, fetchOptions);
  if (!classifier) {
    return { ingestion, classification: null };
  }
  const classification = await classifyAndStore(db, classifier, {
    eventIds: ingestion.insertedIds,
  });
  return { ingestion, classification };
}
