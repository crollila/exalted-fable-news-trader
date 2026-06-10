// src/providers/mockProvider.js — In-memory provider for tests and local dev.
//
// No network. Raw items use a generic shape loosely modeled on real news APIs:
//   { id, symbols, headline, summary, body, url, author, created_at, type }

import { normalizeNewsEvent } from './normalize.js';

/**
 * Create a mock NewsProvider backed by an in-memory array of raw items.
 * @param {object[]} rawItems
 * @returns {import('./newsProvider.js').NewsProvider}
 */
export function createMockProvider(rawItems = []) {
  const items = [...rawItems];

  function normalizeProviderItem(rawItem) {
    return normalizeNewsEvent({
      provider: 'mock',
      providerEventId: rawItem.id ?? null,
      headline: rawItem.headline,
      summary: rawItem.summary ?? null,
      body: rawItem.body ?? null,
      url: rawItem.url ?? null,
      author: rawItem.author ?? null,
      publishedAt: rawItem.created_at,
      receivedAt: rawItem.received_at, // normalize defaults this to now
      rawType: rawItem.type ?? null,
      symbols: rawItem.symbols ?? [],
      raw: rawItem,
    });
  }

  /** @param {import('./newsProvider.js').FetchNewsOptions} [options] */
  async function fetchNews({ symbols, since, until, limit } = {}) {
    let events = items.map(normalizeProviderItem);

    if (Array.isArray(symbols) && symbols.length > 0) {
      const wanted = new Set(symbols.map((s) => String(s).trim().toUpperCase()));
      events = events.filter(
        (e) => e.symbols.some((s) => wanted.has(s)) || (e.ticker && wanted.has(e.ticker))
      );
    }
    if (since !== undefined && since !== null) {
      const sinceIso = new Date(since).toISOString();
      events = events.filter((e) => e.publishedAt >= sinceIso);
    }
    if (until !== undefined && until !== null) {
      const untilIso = new Date(until).toISOString();
      events = events.filter((e) => e.publishedAt <= untilIso);
    }
    if (Number.isInteger(limit) && limit >= 0) {
      events = events.slice(0, limit);
    }
    return events;
  }

  return { name: 'mock', fetchNews, normalizeProviderItem };
}
