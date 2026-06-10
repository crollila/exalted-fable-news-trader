// src/ingestion/ingestNews.js — Provider → persistence pipeline.
//
// Connects any NewsProvider (mock today; Alpaca/Benzinga/etc. later) to the
// news_events table. Infrastructure only: no API keys, no model calls, no
// trading. Works with whatever provider instance it is given, so swapping in
// a real provider later requires no changes here.

import { validateProvider } from '../providers/newsProvider.js';
import { insertNewsEvent } from '../database/newsEvents.js';

/**
 * Fetch events from a provider and persist them with dedup.
 *
 * One bad event does not abort the batch: failures are recorded per event in
 * `errors` so nothing disappears silently (log-everything rule).
 *
 * @param {object} db  open database handle (from src/database/db.js)
 * @param {import('../providers/newsProvider.js').NewsProvider} provider
 * @param {import('../providers/newsProvider.js').FetchNewsOptions} [fetchOptions]
 * @returns {Promise<{
 *   provider: string,
 *   fetched: number,      // events returned by the provider
 *   inserted: number,     // new rows created
 *   duplicates: number,   // events already stored (dedup key matched)
 *   failed: number,       // events rejected (validation/constraint errors)
 *   insertedIds: number[],
 *   errors: { headline: string|null, providerEventId: string|null, error: string }[],
 * }>}
 */
export async function ingestNews(db, provider, fetchOptions = {}) {
  validateProvider(provider);
  const events = await provider.fetchNews(fetchOptions);

  const summary = {
    provider: provider.name,
    fetched: events.length,
    inserted: 0,
    duplicates: 0,
    failed: 0,
    insertedIds: [],
    errors: [],
  };

  for (const event of events) {
    try {
      const result = insertNewsEvent(db, event);
      if (result.inserted) {
        summary.inserted += 1;
        summary.insertedIds.push(result.id);
      } else {
        summary.duplicates += 1;
      }
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({
        headline: event?.headline ?? null,
        providerEventId: event?.providerEventId ?? null,
        error: err.message,
      });
    }
  }

  return summary;
}
