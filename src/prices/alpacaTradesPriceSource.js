// src/prices/alpacaTradesPriceSource.js — Real Alpaca historical-trades
// PriceSource (docs/market-data-client-plan.md, step 2 of §16).
//
// This is ONLY a data faucet behind the existing PriceSource contract
// (src/prices/priceSource.js): it returns correct trades or throws sanitized
// errors. ALL measurement semantics (baseline/reaction selection,
// measurement_status, look-ahead rules) stay in measureReactions.js.
//
// Verified API (docs.alpaca.markets, 2026-06):
//   GET https://data.alpaca.markets/v2/stocks/{symbol}/trades
//   GET https://data.alpaca.markets/v2/stocks/{symbol}/trades/latest
//   headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY (same pair as news)
//   params:  start, end (RFC-3339, whole seconds), limit (<=10000),
//            feed ('iex' is the only no-subscription feed), page_token
//   response: { trades: [{ t, p, s, ... }], symbol, next_page_token }
//
// Safety properties (same regime as alpacaNewsHttpTransport):
// - DISABLED BY DEFAULT: exists only when explicitly constructed;
//   construction throws "not configured" without keys. No import-time or
//   startup network path.
// - Keys come ONLY from config (the same ALPACA_API_KEY_ID/SECRET pair the
//   news transport uses, read via config.alpacaNews). Keys go into request
//   headers and NOWHERE else — never thrown, logged, returned, persisted.
// - Errors are sanitized: static text + status codes, defensively redacted.
// - BOUNDED PAGINATION with throw-on-cap: a truncated trade window must
//   never masquerade as a measured one (plan §5). Exceeding the page cap
//   throws; the measurement engine stores source_error.
// - Window discipline: start is floored / end is ceiled to whole seconds
//   for the API (fractional seconds are not accepted), then trades are
//   filtered back to the EXACT requested [fromIso, toIso] window and
//   sorted ascending — never a trade outside the window (look-ahead rule).
// - The injected httpFetch keeps npm test fully offline.

const DEFAULT_BASE_URL = 'https://data.alpaca.markets/v2/stocks';

/** 'iex' is the only feed usable without a paid subscription (verified). */
export const DEFAULT_FEED = 'iex';

/** Per-page item limit; API max is 10000 (verified). */
export const DEFAULT_PAGE_LIMIT = 10_000;

/** Hard page cap (plan §5): beyond this, throw rather than truncate. */
export const DEFAULT_MAX_PAGES = 10;

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Parse an ISO string strictly; return epoch ms or NaN. */
function parseIso(value) {
  return typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : NaN;
}

/** Whole-second RFC-3339 (no fractional seconds), floored. */
function floorToSecondIso(ms) {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** Whole-second RFC-3339 (no fractional seconds), ceiled. */
function ceilToSecondIso(ms) {
  return `${new Date(Math.ceil(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * Create a real Alpaca historical-trades PriceSource.
 *
 * Explicit construction only — this is the single place a live market-data
 * path can come into existence, and only with configured keys.
 *
 * @param {object} config  result of loadConfig(); uses the Alpaca key pair
 *   (config.alpacaNews — same ALPACA_API_KEY_ID/SECRET env names; the
 *   "News" in the config name is historical naming, the keys are
 *   account-level)
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch)
 * @param {string} [options.baseUrl]
 * @param {string} [options.feed]      defaults to 'iex' (free feed)
 * @param {number} [options.pageLimit] per-page item limit (<= API max)
 * @param {number} [options.maxPages]  hard pagination cap
 * @returns {import('./priceSource.js').PriceSource}
 * @throws immediately (before any HTTP) if credentials are not configured.
 */
export function createAlpacaTradesPriceSource(
  config,
  {
    httpFetch,
    baseUrl = DEFAULT_BASE_URL,
    feed = DEFAULT_FEED,
    pageLimit = DEFAULT_PAGE_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
  } = {}
) {
  const keyId = config?.alpacaNews?.keyId;
  const secretKey = config?.alpacaNews?.secretKey;
  if (!keyId || !secretKey) {
    throw new Error(
      'alpacaTradesPriceSource: not configured — set ALPACA_API_KEY_ID and ' +
        'ALPACA_API_SECRET_KEY in .env (see .env.example). No HTTP call was made.'
    );
  }
  const secrets = [keyId, secretKey];
  const doFetch = httpFetch ?? globalThis.fetch;

  /** Fetch one page; returns the parsed payload. Sanitized errors only. */
  async function fetchJson(path, params) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      // Never rethrow raw fetch errors (they can embed request config).
      throw new Error(`alpacaTradesPriceSource: request failed: ${redact(err?.message, secrets)}`);
    }

    if (!response.ok) {
      // Status/statusText only — never the URL, headers, or body.
      throw new Error(
        `alpacaTradesPriceSource: HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('alpacaTradesPriceSource: response body was not valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(
        `alpacaTradesPriceSource: unexpected payload shape (expected object, got ${
          Array.isArray(payload) ? 'array' : typeof payload
        })`
      );
    }
    // trades may be null/absent when the window is empty; [] is equivalent.
    if (payload.trades !== undefined && payload.trades !== null && !Array.isArray(payload.trades)) {
      throw new Error('alpacaTradesPriceSource: unexpected payload shape (trades is not an array)');
    }
    return payload;
  }

  /** Fetch one historical page; returns the parsed payload. */
  async function fetchPage(symbol, params) {
    return fetchJson(`/${encodeURIComponent(symbol)}/trades`, params);
  }

  /** Map one raw item to a Trade, or null if the item is malformed. */
  function mapTrade(item) {
    const ms = parseIso(item?.t);
    const price = item?.p;
    if (!Number.isFinite(ms) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    const trade = { price, at: new Date(ms).toISOString() }; // fixed-width ms UTC ISO
    if (typeof item.s === 'number' && Number.isFinite(item.s)) trade.size = item.s;
    return trade;
  }

  /**
   * PriceSource.getTradesAround — trades for ticker with `at` in
   * [fromIso, toIso] inclusive, ascending. [] when the window is empty.
   */
  async function getTradesAround(ticker, fromIso, toIso) {
    const symbol = String(ticker ?? '').trim().toUpperCase();
    if (!symbol) {
      throw new Error('alpacaTradesPriceSource: ticker must be a non-empty string');
    }
    const fromMs = parseIso(fromIso);
    const toMs = parseIso(toIso);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error('alpacaTradesPriceSource: fromIso/toIso must be valid ISO-8601 timestamps');
    }
    if (fromMs > toMs) {
      throw new Error('alpacaTradesPriceSource: fromIso must not be after toIso');
    }
    // Exact requested bounds, normalized fixed-width for string comparison.
    const fromBound = new Date(fromMs).toISOString();
    const toBound = new Date(toMs).toISOString();

    const rawItems = [];
    let pageToken;
    let malformedSeen = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await fetchPage(symbol, {
        // API accepts whole seconds only: floor start / ceil end (never
        // narrows the window), then post-filter to the exact bounds below.
        start: floorToSecondIso(fromMs),
        end: ceilToSecondIso(toMs),
        limit: pageLimit,
        feed,
        page_token: pageToken,
      });
      rawItems.push(...(payload.trades ?? []));
      pageToken = payload.next_page_token ?? null;
      if (!pageToken) break;
    }
    if (pageToken) {
      // Cap exceeded: more pages remain. NEVER return a silently truncated
      // window — a partial window would corrupt reaction/high/low/volume.
      throw new Error(
        `alpacaTradesPriceSource: trade window too large (more than ${maxPages} pages); ` +
          'refusing to return a truncated window'
      );
    }

    const trades = [];
    for (const item of rawItems) {
      const trade = mapTrade(item);
      if (trade === null) {
        malformedSeen += 1;
        continue;
      }
      // Enforce the EXACT requested window (inclusive) regardless of the
      // second-rounded request bounds — part of the look-ahead guarantee.
      if (trade.at >= fromBound && trade.at <= toBound) trades.push(trade);
    }
    if (rawItems.length > 0 && trades.length === 0 && malformedSeen === rawItems.length) {
      throw new Error('alpacaTradesPriceSource: all trade items in the response were malformed');
    }

    trades.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return trades;
  }

  async function getLatestTrade(ticker) {
    const symbol = String(ticker ?? '').trim().toUpperCase();
    if (!symbol) {
      throw new Error('alpacaTradesPriceSource: ticker must be a non-empty string');
    }
    const payload = await fetchJson(`/${encodeURIComponent(symbol)}/trades/latest`, { feed });
    const raw = payload?.trade ?? payload?.trades?.[symbol] ?? null;
    const trade = mapTrade(raw);
    if (!trade) {
      throw new Error('alpacaTradesPriceSource: latest trade payload was missing or malformed');
    }
    return trade;
  }

  return { name: `alpaca_${feed}`, getTradesAround, getLatestTrade };
}
