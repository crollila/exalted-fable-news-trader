// src/providers/alpacaNewsHttpTransport.js — Real Alpaca News HTTP transport.
//
// First real-data tier step (docs/real-data-tier-plan.md §8). This is ONLY a
// transport: it fetches raw Alpaca news payloads and returns them. All
// normalization stays in the existing Alpaca adapter
// (createAlpacaNewsProvider({ fetchRawNews: createAlpacaNewsHttpTransport(config) })).
//
// Safety properties:
// - DISABLED BY DEFAULT: never auto-enabled. It exists only when explicitly
//   constructed, and construction throws "not configured" without keys.
// - Keys come ONLY from config (src/config.js reads process.env; nothing
//   here touches process.env). Keys go into request headers and NOWHERE
//   else — never thrown, logged, returned, or persisted.
// - Errors are sanitized: messages are built from static text + status
//   codes, and any accidental key occurrence is redacted defensively.
// - BOUNDED delta pagination: when `maxPages` is provided the transport follows
//   Alpaca's `next_page_token` up to that page bound, sorting ascending so a
//   truncated run (page bound hit with pages remaining) resumes safely from the
//   watermark next cycle. Without `maxPages` it stays a single one-shot GET
//   (legacy behavior, unchanged). A `page_token` NEVER carries a secret and is
//   never logged.
// - The HTTP function is injectable for tests; npm test never hits the network.

const DEFAULT_BASE_URL = 'https://data.alpaca.markets/v1beta1/news';
const HARD_PAGE_CAP = 20; // absolute safety ceiling regardless of caller request

/** Replace any occurrence of the given secrets in text with [redacted]. */
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Create an Alpaca News fetchRawNews transport.
 *
 * @param {object} config  result of loadConfig(); uses config.alpacaNews only
 * @param {object} [options]
 * @param {Function} [options.httpFetch]  injected fetch-compatible function
 *   (tests inject fakes; real use defaults to globalThis.fetch)
 * @param {string} [options.baseUrl]
 * @returns {(fetchOptions?: object) => Promise<object[]|{items: object[], pages: number, truncated: boolean}>}
 * @throws immediately (before any HTTP) if credentials are not configured.
 */
export function createAlpacaNewsHttpTransport(config, { httpFetch, baseUrl = DEFAULT_BASE_URL } = {}) {
  const keyId = config?.alpacaNews?.keyId;
  const secretKey = config?.alpacaNews?.secretKey;
  if (!keyId || !secretKey) {
    throw new Error(
      'alpacaNewsHttpTransport: not configured — set ALPACA_API_KEY_ID and ' +
        'ALPACA_API_SECRET_KEY in .env (see .env.example). No HTTP call was made.'
    );
  }
  const secrets = [keyId, secretKey];
  const doFetch = httpFetch ?? globalThis.fetch;

  /** Build the query URL for one request. `sort`/`page_token` added only when paginating. */
  function buildUrl({ symbols, since, until, limit, sort = null, pageToken = null }) {
    const url = new URL(baseUrl);
    if (Array.isArray(symbols) && symbols.length > 0) {
      url.searchParams.set('symbols', symbols.map((s) => String(s).trim().toUpperCase()).join(','));
    }
    if (since !== undefined && since !== null) url.searchParams.set('start', new Date(since).toISOString());
    if (until !== undefined && until !== null) url.searchParams.set('end', new Date(until).toISOString());
    if (Number.isInteger(limit) && limit > 0) url.searchParams.set('limit', String(limit));
    if (sort) url.searchParams.set('sort', sort);
    if (pageToken) url.searchParams.set('page_token', pageToken);
    return url;
  }

  /** One GET; returns { items, nextPageToken }. Throws sanitized errors only. */
  async function requestPage(url) {
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
      // Network-level failure: never rethrow the raw error (HTTP client
      // errors can embed request config/headers). Sanitized summary only.
      throw new Error(`alpacaNewsHttpTransport: request failed: ${redact(err?.message, secrets)}`);
    }
    if (!response.ok) {
      // Status/statusText only — never the URL object, headers, or body.
      const err = new Error(
        `alpacaNewsHttpTransport: HTTP ${response.status} ${redact(response.statusText ?? '', secrets)}`
      );
      err.status = response.status;
      throw err;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('alpacaNewsHttpTransport: response body was not valid JSON');
    }
    // Alpaca wraps items as { news: [...], next_page_token }; tolerate a bare array.
    const items = Array.isArray(payload) ? payload : payload?.news;
    if (!Array.isArray(items)) {
      throw new Error(
        `alpacaNewsHttpTransport: unexpected payload shape (expected news array, got ${typeof payload})`
      );
    }
    const nextPageToken = Array.isArray(payload) ? null : payload?.next_page_token ?? null;
    return { items, nextPageToken };
  }

  return async function fetchRawNews({ symbols, since, until, limit, maxPages } = {}) {
    // Legacy one-shot path (no maxPages): a single GET, bare URL when no options.
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      const { items } = await requestPage(buildUrl({ symbols, since, until, limit }));
      return items;
    }

    // Bounded delta pagination: ascending sort so a truncated run resumes safely.
    const pageCap = Math.min(maxPages, HARD_PAGE_CAP);
    const all = [];
    let pageToken = null;
    let pages = 0;
    let truncated = false;
    for (;;) {
      const { items, nextPageToken } = await requestPage(
        buildUrl({ symbols, since, until, limit, sort: 'asc', pageToken })
      );
      all.push(...items);
      pages += 1;
      if (!nextPageToken) break;
      if (pages >= pageCap) { truncated = true; break; }
      pageToken = nextPageToken;
    }
    return { items: all, pages, truncated };
  };
}
