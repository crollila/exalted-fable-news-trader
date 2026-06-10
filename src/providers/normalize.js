// src/providers/normalize.js — Canonical news event normalization.
//
// Every provider's raw output is converted to ONE canonical shape here so the
// rest of the system (database, event study, sentiment) never sees
// provider-specific fields. Timestamps are UTC ISO-8601 strings, matching the
// database convention in 001_initial.sql.
//
// No sentiment, no classification, no network — pure data shaping.

/**
 * Convert a date-like value (Date, epoch ms number, or parseable string) to a
 * UTC ISO-8601 string. Throws on invalid input. Returns null for null/undefined
 * only when `required` is false.
 */
export function toUtcIso(value, { required = false, field = 'timestamp' } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`normalizeNewsEvent: missing required ${field}`);
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`normalizeNewsEvent: invalid ${field}: ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

/** Uppercase a ticker-like string, or return null for empty/missing values. */
export function upperOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  return s === '' ? null : s;
}

/** Normalize a symbols list: uppercase, trimmed, de-duplicated, no blanks. */
export function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols)) return [];
  const out = [];
  for (const s of symbols) {
    const u = upperOrNull(s);
    if (u !== null && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Build a canonical, database-ready news event from already-mapped fields.
 * Providers are responsible for mapping their raw item to these input fields;
 * this function enforces the canonical rules.
 *
 * @param {object} input
 * @param {string} input.provider           required, e.g. 'alpaca'
 * @param {string|number|null} [input.providerEventId]
 * @param {string|null} [input.ticker]      defaults to first symbol if absent
 * @param {string} input.headline           required, will be trimmed
 * @param {string|null} [input.summary]
 * @param {string|null} [input.body]
 * @param {string|null} [input.url]
 * @param {string|null} [input.author]
 * @param {Date|string|number} input.publishedAt   required
 * @param {Date|string|number} [input.receivedAt]  defaults to now
 * @param {string|null} [input.rawType]     provider's original type label
 * @param {string[]} [input.symbols]
 * @param {object} [input.raw]              original provider object, preserved as-is
 * @returns {object} normalized news event (see newsProvider.js typedef)
 */
export function normalizeNewsEvent(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('normalizeNewsEvent: input must be an object');
  }

  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!provider) throw new Error('normalizeNewsEvent: provider is required');

  const headline = typeof input.headline === 'string' ? input.headline.trim() : '';
  if (!headline) throw new Error('normalizeNewsEvent: headline is required');

  const symbols = normalizeSymbols(input.symbols);
  // ticker falls back to the first symbol so events stay database-ready
  // (news_events.ticker is NOT NULL); stays null only if neither is present.
  const ticker = upperOrNull(input.ticker) ?? (symbols.length > 0 ? symbols[0] : null);

  const providerEventId =
    input.providerEventId === null || input.providerEventId === undefined
      ? null
      : String(input.providerEventId);

  return {
    provider,
    providerEventId,
    ticker,
    headline,
    summary: input.summary ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
    author: input.author ?? null,
    publishedAt: toUtcIso(input.publishedAt, { required: true, field: 'publishedAt' }),
    receivedAt: toUtcIso(input.receivedAt ?? new Date(), { required: true, field: 'receivedAt' }),
    rawType: input.rawType ?? null,
    newsType: 'other', // classification happens later (Phase 3), never here
    symbols,
    raw: input.raw ?? null,
  };
}
