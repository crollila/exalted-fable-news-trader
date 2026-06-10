// src/database/newsEvents.js — Persistence for canonical normalized news events.
//
// Dedup contract: the schema's unique index on (provider, provider_event_id)
// (when provider_event_id is NOT NULL) is the source of truth. Inserting a
// duplicate never creates a second row; callers learn what happened from the
// return value. Events with a null providerEventId cannot be deduped by id
// and are always inserted.
//
// Column mapping notes (no migration needed):
// - body falls back to summary when the provider sent no body.
// - url/author/symbols/summary have no dedicated columns yet; the original
//   provider payload is preserved in raw_payload (JSON) so nothing is lost.
// - timestamps are UTC ISO-8601 text, as everywhere in this project.

import { assertNormalizedNewsEvent } from '../providers/newsProvider.js';

const INSERT_SQL = `
  INSERT INTO news_events
    (provider, provider_event_id, ticker, headline, body,
     published_at, received_at, dedup_group, news_type, raw_payload)
  VALUES
    (@provider, @provider_event_id, @ticker, @headline, @body,
     @published_at, @received_at, @dedup_group, @news_type, @raw_payload)
  ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL
  DO NOTHING
`;

/**
 * Insert a normalized news event (see newsProvider.js typedef).
 * @returns {{ inserted: boolean, id: number }}
 *   inserted=true  → new row created, id is its rowid.
 *   inserted=false → duplicate (provider + providerEventId already stored),
 *                    id is the EXISTING row's id.
 * @throws if the event fails normalization checks or has no ticker
 *   (news_events.ticker is NOT NULL).
 */
export function insertNewsEvent(db, event) {
  assertNormalizedNewsEvent(event);
  if (event.ticker === null) {
    throw new Error('insertNewsEvent: event has no ticker or symbols; news_events.ticker is NOT NULL');
  }

  const result = db.prepare(INSERT_SQL).run({
    provider: event.provider,
    provider_event_id: event.providerEventId,
    ticker: event.ticker,
    headline: event.headline,
    body: event.body ?? event.summary ?? null,
    published_at: event.publishedAt,
    received_at: event.receivedAt,
    dedup_group: null, // cross-provider dedup grouping is a later phase
    news_type: event.newsType,
    raw_payload: event.raw === null ? null : JSON.stringify(event.raw),
  });

  if (result.changes === 1) {
    return { inserted: true, id: Number(result.lastInsertRowid) };
  }
  // Conflict path: row already existed; fetch its id for the caller.
  const existing = findNewsEvent(db, event.provider, event.providerEventId);
  if (!existing) {
    throw new Error('insertNewsEvent: conflict reported but existing row not found');
  }
  return { inserted: false, id: existing.id };
}

/** Find one event by its dedup key. Returns the row or null. */
export function findNewsEvent(db, provider, providerEventId) {
  if (providerEventId === null || providerEventId === undefined) return null;
  return (
    db
      .prepare('SELECT * FROM news_events WHERE provider = ? AND provider_event_id = ?')
      .get(provider, String(providerEventId)) ?? null
  );
}

/** Get one event by row id. Returns the row or null. */
export function getNewsEventById(db, id) {
  return db.prepare('SELECT * FROM news_events WHERE id = ?').get(id) ?? null;
}

/**
 * List recent events, newest published first.
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {string} [options.ticker]  filter by uppercase ticker
 */
export function listRecentNewsEvents(db, { limit = 50, ticker } = {}) {
  if (ticker) {
    return db
      .prepare(
        'SELECT * FROM news_events WHERE ticker = ? ORDER BY published_at DESC, id DESC LIMIT ?'
      )
      .all(String(ticker).toUpperCase(), limit);
  }
  return db
    .prepare('SELECT * FROM news_events ORDER BY published_at DESC, id DESC LIMIT ?')
    .all(limit);
}

/** Count all stored news events (test/reporting helper). */
export function countNewsEvents(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM news_events').get().n);
}
