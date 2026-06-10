// src/providers/alphaVantageNewsProvider.js — Alpha Vantage News Sentiment
// adapter (SKELETON).
//
// NON-NETWORK by design, same pattern as the Alpaca/Benzinga skeletons:
// injected transport, default throws. No API keys, no HTTP.
//
// Raw item shape (Alpha Vantage NEWS_SENTIMENT feed entries):
//   { title, url, time_published, authors: [..], summary, source,
//     category_within_source, source_domain, topics: [..],
//     overall_sentiment_score, overall_sentiment_label,
//     ticker_sentiment: [{ ticker, relevance_score, ... }] }
//
// Notes:
// - Items have NO dedicated id. providerEventId is derived from the article
//   URL (deterministic, unique per article, human-debuggable). If a raw item
//   somehow lacks a url, the fallback is "<time_published>:<title>" — still
//   deterministic for the same article.
// - time_published is compact UTC: "YYYYMMDDTHHMMSS" — converted to ISO here
//   because Date() cannot parse it.
// - Alpha Vantage's own sentiment fields are provider data, NOT our sentiment
//   engine's output. They stay untouched inside `raw` (and thus raw_payload);
//   nothing here writes to sentiment_scores or interprets the scores.

import { normalizeNewsEvent } from './normalize.js';

const PROVIDER_NAME = 'alpha_vantage';
const COMPACT_TS_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

function noTransportConfigured() {
  throw new Error(
    'alphaVantageNewsProvider: no transport configured. Inject fetchRawNews ' +
      '(e.g. a fixture stub in tests). The real HTTP client is a later phase.'
  );
}

/** "20260609T133000" (UTC) → "2026-06-09T13:30:00Z". Throws on bad input. */
export function compactTimestampToIso(value) {
  const m = COMPACT_TS_RE.exec(String(value ?? ''));
  if (!m) {
    throw new Error(`alphaVantageNewsProvider: unparseable time_published: ${JSON.stringify(value)}`);
  }
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/** Deterministic event id: the article URL, else time+title. */
function deriveEventId(rawItem) {
  if (rawItem.url) return rawItem.url;
  return `${rawItem.time_published}:${rawItem.title}`;
}

/**
 * Create an Alpha Vantage News Sentiment provider.
 * @param {object} [options]
 * @param {(fetchOptions: import('./newsProvider.js').FetchNewsOptions) => Promise<object[]>}
 *   [options.fetchRawNews]  injected transport returning raw feed entries.
 *   Defaults to a stub that throws — the skeleton has no network capability.
 * @returns {import('./newsProvider.js').NewsProvider}
 */
export function createAlphaVantageNewsProvider({ fetchRawNews = noTransportConfigured } = {}) {
  function normalizeProviderItem(rawItem) {
    const authors = Array.isArray(rawItem.authors)
      ? rawItem.authors.filter((a) => typeof a === 'string' && a !== '')
      : [];
    const symbols = Array.isArray(rawItem.ticker_sentiment)
      ? rawItem.ticker_sentiment
          .map((t) => t?.ticker)
          .filter((t) => typeof t === 'string' && t !== '')
      : [];

    return normalizeNewsEvent({
      provider: PROVIDER_NAME,
      providerEventId: deriveEventId(rawItem),
      headline: rawItem.title,
      summary: rawItem.summary || null,
      body: null, // the feed carries no article body
      url: rawItem.url ?? null,
      author: authors.length > 0 ? authors.join(', ') : null,
      publishedAt: compactTimestampToIso(rawItem.time_published),
      // receivedAt omitted: normalize stamps "now" (our receipt time).
      rawType: rawItem.category_within_source || null,
      symbols,
      raw: rawItem, // sentiment fields preserved here, never interpreted
    });
  }

  /** @param {import('./newsProvider.js').FetchNewsOptions} [fetchOptions] */
  async function fetchNews(fetchOptions = {}) {
    const rawItems = await fetchRawNews(fetchOptions);
    return rawItems.map(normalizeProviderItem);
  }

  return { name: PROVIDER_NAME, fetchNews, normalizeProviderItem };
}
