// src/providers/alpacaNewsProvider.js — Alpaca News adapter (SKELETON).
//
// NON-NETWORK by design: the transport (the thing that actually talks to
// Alpaca's news API) is injected. No transport is configured by default, so
// this adapter cannot make network calls or require API keys. A real HTTP
// transport will be added as the default in a later phase; the mapping logic
// below will not need to change.
//
// Raw item shape (Alpaca News API v1beta1):
//   { id, headline, author, created_at, updated_at, summary, content,
//     url, symbols, source }

import { normalizeNewsEvent } from './normalize.js';

const PROVIDER_NAME = 'alpaca';

function noTransportConfigured() {
  throw new Error(
    'alpacaNewsProvider: no transport configured. Inject fetchRawNews ' +
      '(e.g. a fixture stub in tests). The real HTTP client is a later phase.'
  );
}

/**
 * Create an Alpaca News provider.
 * @param {object} [options]
 * @param {(fetchOptions: import('./newsProvider.js').FetchNewsOptions) => Promise<object[]>}
 *   [options.fetchRawNews]  injected transport returning raw Alpaca news items.
 *   Defaults to a stub that throws — the skeleton has no network capability.
 * @returns {import('./newsProvider.js').NewsProvider}
 */
export function createAlpacaNewsProvider({ fetchRawNews = noTransportConfigured } = {}) {
  // Sanitized pagination metadata from the most recent fetch. A paginating
  // transport returns { items, pages, truncated }; fixture stubs return a bare
  // array (single page, never truncated). No headlines/payloads/keys here.
  const meta = { truncated: false, pages: 1 };
  function normalizeProviderItem(rawItem) {
    return normalizeNewsEvent({
      provider: PROVIDER_NAME,
      providerEventId: rawItem.id ?? null,
      headline: rawItem.headline,
      summary: rawItem.summary || null,
      body: rawItem.content || null,
      url: rawItem.url ?? null,
      author: rawItem.author || null, // '' -> null
      publishedAt: rawItem.created_at,
      // receivedAt is intentionally omitted: normalize stamps "now", which is
      // when WE received the item (latency = received_at - published_at).
      rawType: null, // Alpaca news items carry no type label; source stays in raw
      symbols: rawItem.symbols ?? [],
      raw: rawItem,
    });
  }

  /** @param {import('./newsProvider.js').FetchNewsOptions} [fetchOptions] */
  async function fetchNews(fetchOptions = {}) {
    const raw = await fetchRawNews(fetchOptions);
    const rawItems = Array.isArray(raw) ? raw : raw?.items ?? [];
    meta.truncated = Array.isArray(raw) ? false : raw?.truncated === true;
    meta.pages = Array.isArray(raw) ? 1 : Number(raw?.pages) || 1;
    return rawItems.map(normalizeProviderItem);
  }

  return {
    name: PROVIDER_NAME,
    fetchNews,
    normalizeProviderItem,
    get lastFetchMeta() { return { ...meta }; },
  };
}
