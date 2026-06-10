// src/providers/polygonNewsProvider.js — Polygon/Massive News adapter (SKELETON).
//
// NON-NETWORK by design, same pattern as the Alpaca/Benzinga/Alpha Vantage
// skeletons: injected transport, default throws. No API keys, no HTTP.
//
// Raw item shape (Polygon /v2/reference/news results):
//   { id, publisher: { name, ... }, title, author, published_utc,
//     article_url, tickers: [..], image_url, description, keywords: [..],
//     insights: [{ ticker, sentiment, sentiment_reasoning }] }
//
// Notes:
// - `id` is a dedicated string id (long hash) → providerEventId directly.
// - `published_utc` is already UTC ISO; the shared normalizer just validates.
// - Polygon's `insights` sentiment is provider data, NOT our engine's output.
//   It stays untouched inside `raw` (and thus raw_payload); nothing here
//   writes to sentiment_scores or interprets it.

import { normalizeNewsEvent } from './normalize.js';

const PROVIDER_NAME = 'polygon';

function noTransportConfigured() {
  throw new Error(
    'polygonNewsProvider: no transport configured. Inject fetchRawNews ' +
      '(e.g. a fixture stub in tests). The real HTTP client is a later phase.'
  );
}

/**
 * Create a Polygon/Massive News provider.
 * @param {object} [options]
 * @param {(fetchOptions: import('./newsProvider.js').FetchNewsOptions) => Promise<object[]>}
 *   [options.fetchRawNews]  injected transport returning raw Polygon items.
 *   Defaults to a stub that throws — the skeleton has no network capability.
 * @returns {import('./newsProvider.js').NewsProvider}
 */
export function createPolygonNewsProvider({ fetchRawNews = noTransportConfigured } = {}) {
  function normalizeProviderItem(rawItem) {
    const keywords = Array.isArray(rawItem.keywords)
      ? rawItem.keywords.filter((k) => typeof k === 'string' && k !== '')
      : [];

    return normalizeNewsEvent({
      provider: PROVIDER_NAME,
      providerEventId: rawItem.id ?? null,
      headline: rawItem.title,
      summary: rawItem.description || null,
      body: null, // the feed carries no article body
      url: rawItem.article_url ?? null,
      author: rawItem.author || null, // '' -> null; publisher stays in raw
      publishedAt: rawItem.published_utc,
      // receivedAt omitted: normalize stamps "now" (our receipt time).
      rawType: keywords.length > 0 ? keywords.join(',') : null,
      symbols: rawItem.tickers ?? [],
      raw: rawItem, // publisher + insights sentiment preserved, never interpreted
    });
  }

  /** @param {import('./newsProvider.js').FetchNewsOptions} [fetchOptions] */
  async function fetchNews(fetchOptions = {}) {
    const rawItems = await fetchRawNews(fetchOptions);
    return rawItems.map(normalizeProviderItem);
  }

  return { name: PROVIDER_NAME, fetchNews, normalizeProviderItem };
}
