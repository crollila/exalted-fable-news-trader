// src/providers/benzingaNewsProvider.js — Benzinga News adapter (SKELETON).
//
// NON-NETWORK by design, same pattern as the Alpaca skeleton: the transport
// is injected, and the default transport throws. No API keys, no HTTP.
// A real client becomes the default transport in a later phase without
// changing the mapping logic here.
//
// Raw item shape (Benzinga newsfeed API):
//   { id, author, created, updated, title, teaser, body, url,
//     channels: [{ name }], stocks: [{ name }], tags: [{ name }] }
// Note: `created` is RFC-2822 with a timezone offset
// (e.g. "Mon, 09 Jun 2026 09:30:00 -0400"); normalization converts to UTC ISO.

import { normalizeNewsEvent } from './normalize.js';

const PROVIDER_NAME = 'benzinga';

function noTransportConfigured() {
  throw new Error(
    'benzingaNewsProvider: no transport configured. Inject fetchRawNews ' +
      '(e.g. a fixture stub in tests). The real HTTP client is a later phase.'
  );
}

/** Benzinga wraps names in objects: [{name:'AAPL'}] → ['AAPL'] */
function namesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => entry?.name).filter((name) => typeof name === 'string' && name !== '');
}

/**
 * Create a Benzinga News provider.
 * @param {object} [options]
 * @param {(fetchOptions: import('./newsProvider.js').FetchNewsOptions) => Promise<object[]>}
 *   [options.fetchRawNews]  injected transport returning raw Benzinga items.
 *   Defaults to a stub that throws — the skeleton has no network capability.
 * @returns {import('./newsProvider.js').NewsProvider}
 */
export function createBenzingaNewsProvider({ fetchRawNews = noTransportConfigured } = {}) {
  function normalizeProviderItem(rawItem) {
    const channels = namesOf(rawItem.channels);
    return normalizeNewsEvent({
      provider: PROVIDER_NAME,
      providerEventId: rawItem.id ?? null,
      headline: rawItem.title,
      summary: rawItem.teaser || null,
      body: rawItem.body || null,
      url: rawItem.url ?? null,
      author: rawItem.author || null, // '' -> null
      publishedAt: rawItem.created,
      // receivedAt omitted: normalize stamps "now" (our receipt time).
      rawType: channels.length > 0 ? channels.join(',') : null,
      symbols: namesOf(rawItem.stocks),
      raw: rawItem,
    });
  }

  /** @param {import('./newsProvider.js').FetchNewsOptions} [fetchOptions] */
  async function fetchNews(fetchOptions = {}) {
    const rawItems = await fetchRawNews(fetchOptions);
    return rawItems.map(normalizeProviderItem);
  }

  return { name: PROVIDER_NAME, fetchNews, normalizeProviderItem };
}
