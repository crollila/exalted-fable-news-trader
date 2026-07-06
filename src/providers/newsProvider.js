// src/providers/newsProvider.js — The provider contract every news source
// must satisfy (Alpaca News, Benzinga, and any future source).
//
// JavaScript has no interfaces, so the contract is documented as JSDoc
// typedefs plus runtime validation helpers. Future providers should be
// checked with validateProvider() in their tests, and every event they
// emit must pass assertNormalizedNewsEvent().

/**
 * @typedef {object} NormalizedNewsEvent
 * Canonical, database-ready news event (see normalize.js for construction).
 * @property {string} provider              e.g. 'alpaca', 'benzinga', 'mock'
 * @property {string|null} providerEventId  provider's own id, stringified
 * @property {string|null} ticker           uppercase primary ticker
 * @property {string} headline              trimmed, non-empty
 * @property {string|null} summary
 * @property {string|null} body
 * @property {string|null} url
 * @property {string|null} author
 * @property {string} publishedAt           UTC ISO-8601
 * @property {string} receivedAt            UTC ISO-8601
 * @property {string|null} rawType          provider's original type label
 * @property {string} newsType              canonical type; 'other' until Phase 3
 * @property {string[]} symbols             uppercase, unique
 * @property {object|null} raw              original provider payload, untouched
 */

/**
 * @typedef {object} FetchNewsOptions
 * @property {string[]} [symbols]  restrict to these tickers (case-insensitive)
 * @property {Date|string|number} [since]  only events published at/after this time
 * @property {Date|string|number} [until]  only events published at/before this time
 * @property {number} [limit]      max number of events to return
 */

/**
 * @typedef {object} NewsProvider
 * @property {string} name  stable lowercase identifier, stored in news_events.provider
 * @property {(options?: FetchNewsOptions) => Promise<NormalizedNewsEvent[]>} fetchNews
 *   Must resolve to ALREADY-NORMALIZED events (run through normalizeNewsEvent).
 * @property {(rawItem: object) => NormalizedNewsEvent} normalizeProviderItem
 *   Maps one raw provider item to the canonical shape. Must be pure (no I/O).
 */

const REQUIRED_EVENT_FIELDS = [
  'provider',
  'providerEventId',
  'ticker',
  'headline',
  'summary',
  'body',
  'url',
  'author',
  'publishedAt',
  'receivedAt',
  'rawType',
  'newsType',
  'symbols',
  'raw',
];

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Throw if an object is not a valid NormalizedNewsEvent.
 * Returns the event unchanged so it can be used inline.
 */
export function assertNormalizedNewsEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('NormalizedNewsEvent must be an object');
  }
  for (const field of REQUIRED_EVENT_FIELDS) {
    if (!(field in event)) throw new Error(`NormalizedNewsEvent missing field: ${field}`);
  }
  if (typeof event.provider !== 'string' || event.provider === '') {
    throw new Error('NormalizedNewsEvent.provider must be a non-empty string');
  }
  if (typeof event.headline !== 'string' || event.headline.trim() === '') {
    throw new Error('NormalizedNewsEvent.headline must be a non-empty string');
  }
  if (event.providerEventId !== null && typeof event.providerEventId !== 'string') {
    throw new Error('NormalizedNewsEvent.providerEventId must be a string or null');
  }
  if (!ISO_UTC_RE.test(event.publishedAt)) {
    throw new Error(`NormalizedNewsEvent.publishedAt must be UTC ISO-8601, got: ${event.publishedAt}`);
  }
  if (!ISO_UTC_RE.test(event.receivedAt)) {
    throw new Error(`NormalizedNewsEvent.receivedAt must be UTC ISO-8601, got: ${event.receivedAt}`);
  }
  if (!Array.isArray(event.symbols)) {
    throw new Error('NormalizedNewsEvent.symbols must be an array');
  }
  if (event.ticker !== null && event.ticker !== event.ticker.toUpperCase()) {
    throw new Error('NormalizedNewsEvent.ticker must be uppercase or null');
  }
  return event;
}

/**
 * Throw if an object does not satisfy the NewsProvider contract shape.
 * Checks structure only — does not call fetchNews.
 */
export function validateProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('NewsProvider must be an object');
  }
  if (typeof provider.name !== 'string' || provider.name.trim() === '') {
    throw new Error('NewsProvider.name must be a non-empty string');
  }
  if (typeof provider.fetchNews !== 'function') {
    throw new Error('NewsProvider.fetchNews must be a function');
  }
  if (typeof provider.normalizeProviderItem !== 'function') {
    throw new Error('NewsProvider.normalizeProviderItem must be a function');
  }
  return provider;
}
